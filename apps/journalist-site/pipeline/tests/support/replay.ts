/** Replays recorded source responses keyed by URL; unknown URLs fail the test loudly. */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { HttpRequest, HttpResponse, HttpTransport } from "../../core/http";

export type Recorded = {
  status?: number;
  headers?: Record<string, string>;
  /** Inline body, or `file` relative to tests/fixtures. */
  body?: string | object;
  file?: string;
};

export const FIXTURES = path.resolve(__dirname, "..", "fixtures");

export function fixture(name: string) {
  return readFileSync(path.join(FIXTURES, name));
}

export type Route = string | RegExp | ((request: HttpRequest) => boolean);

export class ReplayTransport {
  readonly requests: HttpRequest[] = [];
  private readonly routes: Array<[Route, Recorded | ((request: HttpRequest) => Recorded)]> = [];

  /** Robots.txt is allowed everywhere unless a test registers its own. */
  constructor(private readonly allowRobots = true) {}

  on(route: Route, response: Recorded | ((request: HttpRequest) => Recorded)) {
    this.routes.push([route, response]);
    return this;
  }

  private match(route: Route, request: HttpRequest) {
    if (typeof route === "string") return request.url === route;
    if (route instanceof RegExp) return route.test(request.url);
    return route(request);
  }

  readonly transport: HttpTransport = async (request) => {
    this.requests.push(request);
    for (const [route, recorded] of [...this.routes].reverse()) {
      if (!this.match(route, request)) continue;
      const value = typeof recorded === "function" ? recorded(request) : recorded;
      return respond(request, value);
    }
    if (this.allowRobots && request.url.endsWith("/robots.txt")) return respond(request, { status: 404, body: "" });
    throw new Error(`No recorded response for ${request.method ?? "GET"} ${request.url}`);
  };
}

function respond(request: HttpRequest, recorded: Recorded): HttpResponse {
  let body: Uint8Array;
  if (recorded.file) body = new Uint8Array(fixture(recorded.file));
  else if (typeof recorded.body === "string") body = new TextEncoder().encode(recorded.body);
  else body = new TextEncoder().encode(JSON.stringify(recorded.body ?? ""));
  if (request.maxBytes !== undefined && body.byteLength > request.maxBytes) {
    const error = new Error(`Response exceeds ${request.maxBytes} bytes`);
    error.name = "ResponseTooLargeError";
    throw error;
  }
  const headers = Object.fromEntries(Object.entries(recorded.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  return { url: request.url, status: recorded.status ?? 200, headers, body };
}
