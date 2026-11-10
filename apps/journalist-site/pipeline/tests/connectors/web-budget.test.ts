import { afterEach, expect, it, vi } from "vitest";
import { FetchDeadlineExceededError, Fetcher } from "../../connectors/fetcher";
import * as fetchState from "../../connectors/fetch-state";
import { readSite, SOURCE_BUDGET_MS, SOURCE_REQUEST_TIMEOUT_MS } from "../../connectors/web";
import { sourceResult, type ConnectorContext } from "../../connectors/types";
import type { HttpRequest, HttpTransport } from "../../core/http";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("stops after a working feed within the source deadline while honoring crawl delay", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
  const started = Date.now();
  const site = "https://slow-crawl-budget.example.com/";
  const requests: Array<{ url: string; at: number; timeout: number | undefined }> = [];
  const transport: HttpTransport = async (request) => {
    requests.push({ url: request.url, at: Date.now(), timeout: request.timeoutMs });
    const body = request.url.endsWith("robots.txt") ? "User-agent: *\nCrawl-delay: 5\n"
      : request.url === site ? '<title>Town News</title><a href="/news/park-opens-for-our-neighbors">Park</a>'
      : request.url === `${site}feed` ? `<rss><channel><item><title>Park opens</title><link>${site}news/park</link><pubDate>2026-10-31T12:00:00Z</pubDate></item></channel></rss>` : "";
    return { url: request.url, status: body ? 200 : 404, headers: {}, body: new TextEncoder().encode(body) };
  };
  const sourceBudget = 20_000;
  const context = { today: "2026-11-01", transport, fetcher: new Fetcher(transport), deadline: started + sourceBudget } as unknown as ConnectorContext;
  const record = sourceResult("web:slow", "Slow source", "ingested", "");
  const collection = readSite({ type: "web", source_id: "web:slow", name: "Slow source", params: { url: site, feed_url: `${site}feed`, inside_area: true } }, context, record);
  await vi.advanceTimersByTimeAsync(SOURCE_BUDGET_MS + 1000);
  expect(await collection).toHaveLength(1);
  expect(record.status).toBe("ingested");
  expect(record.detail).toContain("stopped before speculative page crawling");
  for (let i = 1; i < requests.length; i++) expect(requests[i].at - requests[i - 1].at).toBeGreaterThanOrEqual(5_000);
  expect(requests.every((request) => request.at < started + sourceBudget)).toBe(true);
  expect(requests.every((request) => request.timeout! <= SOURCE_REQUEST_TIMEOUT_MS)).toBe(true);
  expect(requests.some((request) => request.url === `${site}feed`)).toBe(true);
  expect(requests.some((request) => request.url.includes("park-opens"))).toBe(false);
});

it("keeps main's policy of skipping sites whose requested crawl delay exceeds the supported maximum", async () => {
  const site = "https://long-crawl-budget.example.com/";
  const urls: string[] = [];
  const transport: HttpTransport = async request => {
    urls.push(request.url);
    return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode("User-agent: *\nCrawl-delay: 30\n") };
  };
  const context = { today: "2026-11-01", transport, fetcher: new Fetcher(transport) } as unknown as ConnectorContext;
  await expect(readSite({ type: "web", source_id: "web:long", name: "Long delay", params: { url: site } }, context,
    sourceResult("web:long", "Long delay", "ingested", ""))).rejects.toThrow("crawl-delay of 30s is longer than 10s");
  expect(urls).toEqual([site + "robots.txt"]);
});

it("refuses a shared host reservation that exceeds the source deadline", async () => {
  vi.spyOn(fetchState, "reserveHost").mockResolvedValue(10_000);
  const transport = vi.fn<HttpTransport>();
  const fetcher = new Fetcher(transport, undefined, true, Date.now() + 5_000);
  await expect(fetcher.get("https://shared-budget.example.com/data", 1024, "application/json"))
    .rejects.toBeInstanceOf(FetchDeadlineExceededError);
  expect(transport).not.toHaveBeenCalled();
});

it("caps a redirected homepage's network timeout by the remaining source budget", async () => {
  let clock = new Date("2026-11-01T12:00:00Z").getTime();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const site = "https://redirect-budget.example.com/";
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    if (request.url.endsWith("robots.txt")) return { url: request.url, status: 404, headers: {}, body: new Uint8Array() };
    if (request.url === site) {
      clock += SOURCE_BUDGET_MS - 4000;
      return { url: request.url, status: 302, headers: { location: "/slow" }, body: new Uint8Array() };
    }
    expect(request.timeoutMs).toBe(4000);
    clock += request.timeoutMs!;
    throw new Error("Request timed out");
  };
  const context = { today: "2026-11-01", transport, fetcher: new Fetcher(transport, undefined, false) } as unknown as ConnectorContext;
  await expect(readSite({ type: "web", source_id: "web:redirect", name: "Slow source", params: { url: site } }, context,
    sourceResult("web:redirect", "Slow source", "ingested", ""))).rejects.toThrow("time budget reached");
  expect(requests).toHaveLength(3);
});
