/**
 * Port of the Python library_events.Fetcher: HTTPS-only GETs with bounded size and bounded
 * redirects. Every source connector fetches through this, so the crawling guardrails live
 * here (ported from the exploration app's "guardrails"):
 *
 *   - Public data APIs (requests that ask for JSON, GeoJSON or SPARQL results) skip the
 *     robots.txt check: their robots.txt files are aimed at crawlers, and each API's own
 *     usage policy governs.
 *   - Website content (pages, feeds, calendars, sitemaps): robots.txt is checked for our
 *     agent, and a site that disallows the page to AI crawlers (ClaudeBot, GPTBot and
 *     similar) is skipped too. Crawl-delay is honoured up to `general.stop.max_crawl_delay`
 *     (10 s); a site asking for longer is skipped this run, like a block. A fetcher with a
 *     `deadline` (its job's) refuses a request whose wait for the host's turn wouldn't fit
 *     before it, so a slow site makes a link-only lead instead of stalling the job. An unreadable robots.txt (5xx, 401/403) is treated as a "no".
 *   - Platforms whose terms forbid scraping (DO_NOT_SCRAPE, the never-read list) aren't fetched.
 *     It is an Access rule: a relaxed run may skip it, and the page records that it did.
 *   - One request at a time per host in this process, and requests to one host are paced
 *     (at least `general.stop.fetch_seconds_per_host`, longer for a crawl delay), across
 *     workers. A host that answers 429/503 three times is stopped for this fetcher's job.
 *   - A page read in the last half hour is reused, and an older one is asked for conditionally.
 *   - Login or subscribe redirects, and 401/403/407 answers, are skipped as "login required".
 *
 * Every skip throws DiscoveryBlockedError with the reason, which connectors report as a
 * "blocked" status so it shows on the source's health.
 */
import robotsParser from "robots-parser";
import { COMMUNITY_USER_AGENT } from "../../../../shared/geography";
import { type HttpTransport, HttpStatusError, isRedirect } from "../core/http";
import { accessIgnored } from "../core/run-options";
import { limit } from "../playbook";
import { FeedFormatError, httpsLink } from "./common";
import { PAGE_REUSE_MS, reserveHost, savedPage, savedRobots, savePage, saveRobots, touchPage } from "./fetch-state";

export const USER_AGENT = COMMUNITY_USER_AGENT;
export const AGENT_NAME = "Newsbee";
export const MAX_REDIRECTS = 3;
export const MIN_SECONDS_PER_HOST = limit("general.stop.fetch_seconds_per_host");
export const MAX_CRAWL_DELAY = limit("general.stop.max_crawl_delay");
/** Pages and feeds; public JSON APIs keep the transport's longer default. */
export const PAGE_TIMEOUT_MS = 10_000;
export const ROBOTS_TTL_MS = 24 * 3600_000;
export const MAX_SLOW_DOWNS = 3;
export const AI_AGENTS = ["ClaudeBot", "Claude-Web", "anthropic-ai", "GPTBot", "ChatGPT-User", "CCBot", "Google-Extended", "PerplexityBot", "Applebot-Extended", "Bytespider", "cohere-ai", "meta-externalagent", "Amazonbot"] as const;
export const DO_NOT_SCRAPE = ["facebook.com", "nextdoor.com", "instagram.com", "x.com", "twitter.com", "reddit.com", "tiktok.com", "legacy.com",
  // Publishers whose terms forbid automated or AI use.
  "seattletimes.com", "kuow.org", "mynorthwest.com"] as const;

export class DiscoveryBlockedError extends Error {
  /** The HTTP status that refused us, when a site rather than a rule blocked the page. */
  constructor(message: string, readonly status: number | null = null) { super(message); }
}
export class FetchDeadlineExceededError extends Error {}

/** A data-API request rather than website content: the client asks for JSON-family results. */
export function isApiRequest(accept: string) {
  return /json/i.test(accept) && !/html/i.test(accept);
}

export function blockedPlatform(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return DO_NOT_SCRAPE.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

type Robots = { isAllowed(url: string, ua?: string): boolean | undefined; getCrawlDelay?(ua?: string): number | undefined; getSitemaps?(): string[] };
type RobotsEntry = { at: number; rules: Robots | "disallow-all" | null };

/** robots.txt per origin, shared across fetchers in this process for 24 hours, and across calls by fetch-state. */
const robotsCache = new Map<string, RobotsEntry>();
/** Last request time per host, shared across fetchers so parallel jobs stay polite. */
const lastRequest = new Map<string, number>();
const hostInterval = new Map<string, number>();
/** The request in flight per host in this process: one page at a time per site. */
const inFlight = new Map<string, Promise<void>>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function oneAtATime<T>(host: string, work: () => Promise<T>): Promise<T> {
  const before = inFlight.get(host) ?? Promise.resolve();
  let release!: () => void;
  const turn = before.then(() => new Promise<void>((resolve) => { release = resolve; }));
  inFlight.set(host, turn);
  await before;
  try { return await work(); } finally {
    release();
    if (inFlight.get(host) === turn) inFlight.delete(host);
  }
}

const LOGIN_PATH = /\/(login|log-in|signin|sign-in|account\/login|subscribe|register)(\/|$|\?)/i;

export class Fetcher {
  private readonly slowDowns = new Map<string, number>();
  /** Why each host was skipped in this job, for the source's health detail. */
  readonly skips = new Map<string, string>();
  private stopped = false;
  /** When the job that owns this fetcher must be done (ms since the epoch): no host's turn is waited for past it. */
  deadline: number | null = null;

  constructor(readonly transport: HttpTransport, readonly userAgent: string = USER_AGENT, readonly pace = true,
    readonly deadlineAt: number | null = null) {}

  private checkDeadline(waitMs = 0) {
    if (this.deadlineAt !== null && Date.now() + Math.max(0, waitMs) >= this.deadlineAt) {
      throw new FetchDeadlineExceededError("Website collection time budget reached");
    }
  }

  private async robotsFor(url: string): Promise<RobotsEntry["rules"]> {
    const origin = `https://${new URL(url).host}`;
    const cached = robotsCache.get(origin);
    if (cached && Date.now() - cached.at < ROBOTS_TTL_MS) return cached.rules;
    const robotsUrl = `${origin}/robots.txt`;
    const noteDelay = (parsed: Robots) => {
      const delay = parsed.getCrawlDelay?.(AGENT_NAME) ?? parsed.getCrawlDelay?.("*");
      if (typeof delay === "number" && delay > 0) hostInterval.set(new URL(url).host, delay);
    };
    const saved = await savedRobots(origin);
    if (saved) {
      const parsed = saved.kind === "rules" ? robotsParser(robotsUrl, saved.text ?? "") as Robots : saved.kind === "disallow-all" ? "disallow-all" as const : null;
      if (parsed && parsed !== "disallow-all") noteDelay(parsed);
      robotsCache.set(origin, { at: Date.now(), rules: parsed });
      return parsed;
    }
    let response;
    try {
      response = await this.turn(robotsUrl, () => this.transport({ url: robotsUrl, headers: { "User-Agent": this.userAgent }, maxBytes: 512 * 1024, timeoutMs: PAGE_TIMEOUT_MS }));
    } catch (error) {
      // No time for the host's turn says nothing about its rules: nothing is cached, and the page is refused.
      if (error instanceof DiscoveryBlockedError) throw error;
      response = null;
    }
    let rules: RobotsEntry["rules"];
    if (!response) rules = null;
    else if (response.status >= 300) {
      // Python RobotFileParser / RFC 9309: 401/403 or 5xx disallow everything; other failures allow.
      rules = [401, 403].includes(response.status) || response.status >= 500 ? "disallow-all" : null;
      // A server error is passing; only a clear answer is worth keeping for a day.
      if (response.status < 500) await saveRobots(origin, { kind: rules ? "disallow-all" : "none", text: null });
    } else {
      const text = new TextDecoder().decode(response.body);
      rules = robotsParser(robotsUrl, text) as Robots;
      noteDelay(rules);
      await saveRobots(origin, { kind: "rules", text });
    }
    robotsCache.set(origin, { at: Date.now(), rules });
    return rules;
  }

  /** Why robots.txt rules this URL out ('' when allowed). */
  async robotsReason(url: string): Promise<string> {
    const rules = await this.robotsFor(url);
    // A relaxed run may ignore a site's stated preferences. Crawl delay is politeness, and stays.
    if (rules === "disallow-all" && !accessIgnored("robots", true)) return "robots.txt couldn't be read, treated as a no";
    const delay = hostInterval.get(new URL(url).host) ?? 0;
    if (delay > MAX_CRAWL_DELAY) return `crawl-delay of ${delay}s is longer than ${MAX_CRAWL_DELAY}s`;
    if (!rules || rules === "disallow-all") return "";
    if ((rules.isAllowed(url, this.userAgent) === false || rules.isAllowed(url, AGENT_NAME) === false) && !accessIgnored("robots", true)) return "robots.txt disallows";
    const optOut = AI_AGENTS.find((agent) => rules.isAllowed(url, agent) === false);
    return optOut && !accessIgnored("ai_optout", true) ? `site opts out of AI crawlers in robots.txt (${optOut})` : "";
  }

  async allowed(url: string): Promise<boolean> {
    return !(await this.robotsReason(url));
  }

  /** Sitemaps listed in the site's robots.txt. */
  async sitemaps(url: string): Promise<string[]> {
    const rules = await this.robotsFor(url);
    return rules && rules !== "disallow-all" ? rules.getSitemaps?.() ?? [] : [];
  }

  private async wait(url: string) {
    this.checkDeadline();
    if (!this.pace) return;
    const host = new URL(url).host;
    const interval = Math.max(MIN_SECONDS_PER_HOST, Math.min(hostInterval.get(host) ?? 0, MAX_CRAWL_DELAY)) * 1000;
    const late = (wait: number) => this.deadline !== null && Date.now() + wait > this.deadline;
    const tooLong = (wait: number) => this.block(url, `waiting ${Math.ceil(wait / 1000)}s for ${host}'s turn (crawl delay ${Math.round(interval / 1000)}s) wouldn't fit in this job's time`);
    // Not even one interval fits: don't take a turn the job can't use.
    if (late(interval)) tooLong(interval);
    const turn = await reserveHost(host, interval);
    if (turn !== null) {
      if (late(turn)) tooLong(turn);
      this.checkDeadline(turn);
      if (turn > 0) await sleep(turn);
      this.checkDeadline();
      return;
    }
    const last = lastRequest.get(host) ?? 0;
    const due = last + interval - Date.now();
    if (due > 0 && late(due)) tooLong(due);
    this.checkDeadline(due);
    if (due > 0) await sleep(due);
    this.checkDeadline();
    lastRequest.set(host, Date.now());
  }

  /** Wait for the host's turn, then make the request, with no other request to that host in flight. */
  private turn<T>(url: string, request: () => Promise<T>): Promise<T> {
    const go = async () => { await this.wait(url); return request(); };
    return this.pace ? oneAtATime(new URL(url).host, go) : go();
  }

  /** Refuse further requests: the job that owns this fetcher has moved on without it. */
  stop() { this.stopped = true; }

  private block(url: string, reason: string, status: number | null = null): never {
    try { this.skips.set(new URL(url).host, reason); } catch { /* ignore */ }
    throw new DiscoveryBlockedError(`${reason}: ${url}`, status);
  }

  /** Returns the final URL and body after vetting every redirect hop. */
  async get(url: string, limit: number, accept: string): Promise<[string, Uint8Array]> {
    const response = await this.getResponse(url, limit, accept);
    return [response.url, response.body];
  }

  /** Like get, but also returns the final response's (lower-cased) headers. */
  async getResponse(url: string, limit: number, accept: string): Promise<{ url: string; body: Uint8Array; headers: Record<string, string> }> {
    const api = isApiRequest(accept);
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (this.stopped) throw new FeedFormatError(`Stopped before reading ${current}: out of time`);
      if (httpsLink(current) === null) throw new FeedFormatError(`Refusing non-HTTPS URL: ${current}`);
      const host = new URL(current).host;
      if (blockedPlatform(current) && !accessIgnored("never_read", true)) this.block(current, "this platform's terms don't allow scraping");
      if ((this.slowDowns.get(host) ?? 0) >= MAX_SLOW_DOWNS) this.block(current, `${host} asked us to slow down; stopped for this run`);
      if (!api) {
        const reason = await this.robotsReason(current);
        if (reason) this.block(current, reason);
      }
      const saved = api ? null : await savedPage(current, accept);
      if (saved && saved.body.byteLength <= limit && Date.now() - saved.fetchedAt < PAGE_REUSE_MS) return { url: current, body: saved.body, headers: saved.headers };
      const response = await this.turn(current, () => this.transport({
        url: current,
        headers: { "User-Agent": this.userAgent, Accept: accept, ...(saved?.etag ? { "If-None-Match": saved.etag } : {}), ...(saved?.lastModified ? { "If-Modified-Since": saved.lastModified } : {}) },
        maxBytes: limit,
        ...(api ? {} : { timeoutMs: PAGE_TIMEOUT_MS }),
      })).catch((error: unknown) => {
        if (error instanceof Error && error.name === "ResponseTooLargeError") {
          throw new FeedFormatError(`Response exceeds ${Math.floor(limit / (1024 * 1024))} MiB`);
        }
        throw error;
      });
      if (response.status === 304 && saved && saved.body.byteLength <= limit) {
        await touchPage(current, accept);
        return { url: current, body: saved.body, headers: saved.headers };
      }
      if (isRedirect(response.status)) {
        const next = new URL(response.headers.location ?? "", current);
        if (!api && LOGIN_PATH.test(next.pathname)) this.block(current, "redirected to a login or subscribe page");
        current = next.toString();
        continue;
      }
      if (response.status === 429 || response.status === 503) {
        this.slowDowns.set(host, (this.slowDowns.get(host) ?? 0) + 1);
        hostInterval.set(host, Math.min(MAX_CRAWL_DELAY, Math.max(hostInterval.get(host) ?? MIN_SECONDS_PER_HOST, MIN_SECONDS_PER_HOST) * 2));
      }
      if (!api && [401, 403, 407].includes(response.status)) this.block(current, "login or permission required", response.status);
      if (response.status >= 400) throw new HttpStatusError(response.status, current);
      if (response.body.byteLength > limit) {
        throw new FeedFormatError(`Response exceeds ${Math.floor(limit / (1024 * 1024))} MiB`);
      }
      if (!api && response.status === 200) await savePage(current, accept, response.body, response.headers ?? {});
      return { url: current, body: response.body, headers: response.headers ?? {} };
    }
    throw new FeedFormatError(`More than ${MAX_REDIRECTS} redirects`);
  }

  async getText(url: string, limit: number, accept: string): Promise<[string, string]> {
    const [finalUrl, body] = await this.get(url, limit, accept);
    return [finalUrl, new TextDecoder().decode(body)];
  }
}
