/**
 * Port of the Python library_events.Fetcher: HTTPS-only GETs with bounded size, bounded
 * redirects and robots.txt checks. Every source connector fetches through this.
 */
import robotsParser from "robots-parser";
import { COMMUNITY_USER_AGENT } from "../../../../shared/geography";
import { type HttpTransport, HttpStatusError, isRedirect } from "../core/http";
import { FeedFormatError, httpsLink } from "./common";

export const USER_AGENT = COMMUNITY_USER_AGENT;
export const MAX_REDIRECTS = 3;

export class DiscoveryBlockedError extends Error {}

type Robots = { isAllowed(url: string, ua?: string): boolean | undefined };

export class Fetcher {
  private readonly robots = new Map<string, Robots>();

  constructor(readonly transport: HttpTransport, readonly userAgent: string = USER_AGENT) {}

  async allowed(url: string): Promise<boolean> {
    const origin = `https://${new URL(url).host}`;
    let rules = this.robots.get(origin);
    if (!rules) {
      const robotsUrl = `${origin}/robots.txt`;
      let response;
      try {
        response = await this.transport({
          url: robotsUrl,
          headers: { "User-Agent": this.userAgent },
          maxBytes: 512 * 1024,
        });
      } catch {
        response = null;
      }
      if (!response || response.status >= 300) {
        // Python RobotFileParser: 401/403 or 5xx disallow everything; other failures allow.
        const blocked = response !== null && ([401, 403].includes(response.status) || response.status >= 500);
        rules = { isAllowed: () => !blocked };
      } else {
        rules = robotsParser(robotsUrl, new TextDecoder().decode(response.body));
      }
      this.robots.set(origin, rules);
    }
    return rules.isAllowed(url, this.userAgent) !== false;
  }

  /** Returns the final URL and body after vetting every redirect hop. */
  async get(url: string, limit: number, accept: string): Promise<[string, Uint8Array]> {
    const response = await this.getResponse(url, limit, accept);
    return [response.url, response.body];
  }

  /** Like get, but also returns the final response's (lower-cased) headers. */
  async getResponse(url: string, limit: number, accept: string): Promise<{ url: string; body: Uint8Array; headers: Record<string, string> }> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (httpsLink(current) === null) throw new FeedFormatError(`Refusing non-HTTPS URL: ${current}`);
      if (!(await this.allowed(current))) throw new DiscoveryBlockedError(`robots.txt disallows ${current}`);
      const response = await this.transport({
        url: current,
        headers: { "User-Agent": this.userAgent, Accept: accept },
        maxBytes: limit,
      }).catch((error: unknown) => {
        if (error instanceof Error && error.name === "ResponseTooLargeError") {
          throw new FeedFormatError(`Response exceeds ${Math.floor(limit / (1024 * 1024))} MiB`);
        }
        throw error;
      });
      if (isRedirect(response.status)) {
        current = new URL(response.headers.location ?? "", current).toString();
        continue;
      }
      if (response.status >= 400) throw new HttpStatusError(response.status, current);
      if (response.body.byteLength > limit) {
        throw new FeedFormatError(`Response exceeds ${Math.floor(limit / (1024 * 1024))} MiB`);
      }
      return { url: current, body: response.body, headers: response.headers ?? {} };
    }
    throw new FeedFormatError(`More than ${MAX_REDIRECTS} redirects`);
  }

  async getText(url: string, limit: number, accept: string): Promise<[string, string]> {
    const [finalUrl, body] = await this.get(url, limit, accept);
    return [finalUrl, new TextDecoder().decode(body)];
  }
}
