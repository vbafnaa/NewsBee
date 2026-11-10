import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseIcal } from "../../connectors/library/parsers";
import { calendarLinks, trumbaFeeds } from "../../connectors/web/page";
import { readSite } from "../../connectors/web";
import { newsSearchConnector } from "../../connectors/newssearch";
import { sourceResult, type ConnectorContext, type SourceTask } from "../../connectors/types";
import { reserveHost, deferHost } from "../../connectors/fetch-state";
import type { HttpTransport } from "../../core/http";
vi.mock("../../connectors/fetch-state", async original => ({ ...await original<object>(), reserveHost: vi.fn(async () => 0), deferHost: vi.fn(async () => {}) }));
const bytes = (s: string) => new TextEncoder().encode(s);
function fixtureTransport(fetcher: ConnectorContext["fetcher"]): HttpTransport {
  return async request => request.url.endsWith("robots.txt")
    ? { url: request.url, status: 200, headers: {}, body: bytes("User-agent: *\nAllow: /\n") }
    : { status: 200, ...await fetcher.getResponse(request.url) };
}
const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:closure
DTSTART;VALUE=DATE:20261111
SUMMARY:Veterans Day — no school
URL:https://school.example/events/closure/
END:VEVENT
END:VCALENDAR`;
const task: SourceTask = { source_id: "newssearch:gdelt", name: "GDELT", type: "newssearch", params: { backend: "gdelt" } };
const context = (transport = vi.fn()): ConnectorContext => ({ today: "2026-11-06", location: { id: "test", name: "Seattle, WA", state: "WA", community: { name: "Wedgwood" } }, transport, db: { collection: () => ({ updateOne: vi.fn() }) }, log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } } as unknown as ConnectorContext);
beforeEach(() => vi.clearAllMocks());
describe("reader repairs", () => {
  it("accepts explicit school dates without inventing a venue; library default remains strict", () => {
    expect(parseIcal(bytes(ics)).skipped).toEqual({ no_venue: 1 });
    expect(parseIcal(bytes(ics), { allowMissingVenue: true }).events[0]).toMatchObject({ event_date: "2026-11-11", venue: "" });
  });
  it("finds direct ICS exports and preserves Trumba branch filters", () => {
    expect(calendarLinks('<a href="/events/ics/">Download</a>', "https://school.example/")).toContain("https://school.example/events/ics/");
    expect(trumbaFeeds('$Trumba.addSpud({webName: "kalendaro", url: {filterview: "LocationNET"}});')).toEqual(["https://www.trumba.com/calendars/kalendaro.rss?weeks=4&filterview=LocationNET"]);
  });
  it("website reader retains a dated school event with locality still pending", async () => {
    const ctx = context();
    ctx.settings = { integrations: {} } as ConnectorContext["settings"];
    ctx.fetcher = { getResponse: vi.fn(async (url: string) => ({ url, headers: {}, body: bytes(url.endsWith('/ics/') ? ics : '<a href="/events/ics/">Calendar</a>') })), sitemaps: async () => [] } as unknown as ConnectorContext["fetcher"];
    ctx.transport = fixtureTransport(ctx.fetcher);
    const events = await readSite({ ...task, type: "web", params: { url: "https://school.example/", inside_area: false } }, ctx, sourceResult("test", "test", "ingested", ""));
    expect(events).toHaveLength(1);
    expect(ctx.fetcher.getResponse).toHaveBeenCalledTimes(2); // homepage plus the advertised calendar, no speculative crawling
    expect(events[0]).toMatchObject({ event_date: "2026-11-11", venue: "", needs_locality: true });
  });
  it("marks non-JSON provider refusals failed, never successful empty", async () => {
    const transport = vi.fn(async () => ({ status: 200, headers: {}, body: bytes("Please slow down") }));
    const result = await newsSearchConnector.collect(task, context(transport));
    expect(result.result.status).toBe("failed");
    expect(result.result.pages_checked).toHaveLength(3);
  });
  it("recognizes valid empty responses", async () => {
    const result = await newsSearchConnector.collect(task, context(vi.fn(async () => ({ status: 200, headers: {}, body: bytes('{"articles":[]}') }))));
    expect(result.result.status).toBe("ingested");
    expect(result.events).toEqual([]);
  });
  it("retains incomplete status if one topic fails", async () => {
    const transport = vi.fn().mockResolvedValueOnce({ status: 200, headers: {}, body: bytes('{"articles":[]}') }).mockRejectedValue(new Error("network failed"));
    expect((await newsSearchConnector.collect(task, context(transport))).result.status).toBe("partial");
  });
  it("defers 429 using Retry-After and does not request the other topics", async () => {
    const transport = vi.fn(async () => ({ status: 429, headers: { "retry-after": "120" }, body: bytes("") }));
    await expect(newsSearchConnector.collect(task, context(transport))).rejects.toMatchObject({ status: 429, retryAfterSeconds: 120 });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(deferHost).toHaveBeenCalledWith("api.gdeltproject.org", 120000);
  });
  it("does not send requests during a shared provider cooldown", async () => {
    vi.mocked(reserveHost).mockResolvedValueOnce(60000);
    const transport = vi.fn();
    await expect(newsSearchConnector.collect(task, context(transport))).rejects.toMatchObject({ status: 429, retryAfterSeconds: 60 });
    expect(transport).not.toHaveBeenCalled();
  });
});

it("the durable queue respects HTTP Retry-After without consuming an ordinary attempt", async () => {
  const { fail } = await import("../../orchestration/jobs");
  const { HttpStatusError } = await import("../../core/http");
  const updateOne = vi.fn(async () => ({ modifiedCount: 1 }));
  const db = { collection: () => ({ updateOne }) } as unknown as import("mongodb").Db;
  const job = { _id: "test", kind: "collect_source", attempts: 1, claim_token: "lease", rate_limit_retries: 0 } as import("../../orchestration/jobs").Job;
  const before = Date.now() / 1000;
  expect(await fail(db, job, new HttpStatusError(429, "https://api.gdeltproject.org", 120), true)).toBe("retry");
  const update = (updateOne.mock.calls as unknown as Array<[unknown, { $set: Record<string, number | string> }]>)[0][1].$set;
  expect(update).toMatchObject({ status: "pending", attempts: 0, rate_limit_retries: 1 });
  expect(Number(update.available_at)).toBeGreaterThanOrEqual(Math.floor(before) + 120);
});

it("rejects other library branches even if a filtered Trumba export includes them", async () => {
  const ctx = context();
  ctx.settings = { integrations: {} } as ConnectorContext["settings"];
  const site = "https://www.spl.org/hours-and-locations/northeast-branch/northeast-branch-events";
  const item = (branch: string) => `<item><title>Story time</title><guid>${branch}</guid><link>https://www.spl.org/events/${branch}</link><category>2026/11/10</category><description><![CDATA[Tuesday, November 10, 2026, 10am<br/><b>Location Link</b>: <a href="https://www.spl.org/hours-and-locations/${branch}">${branch}</a><br/>]]></description></item>`;
  ctx.fetcher = { getResponse: vi.fn(async (url: string) => ({ url, headers: {}, body: bytes(url.includes('trumba.com') ? `<rss><channel>${item('northeast-branch')}${item('ballard-branch')}</channel></rss>` : url === site ? '<script>$Trumba.addSpud({webName:"kalendaro",url:{filterview:"LocationNET"}});</script>' : '<html/>') })), sitemaps: async () => [] } as unknown as ConnectorContext["fetcher"];
  ctx.transport = fixtureTransport(ctx.fetcher);
  const dropped: import("../../connectors/types").DroppedItem[] = [];
  const events = await readSite({ ...task, type: "web", params: { url: site, inside_area: false } }, ctx, sourceResult("test", "test", "ingested", ""), dropped);
  expect(events).toHaveLength(1);
  expect(events[0].venue).toBe("northeast-branch");
  expect(dropped.some((item) => item.reason === "different_or_unknown_branch")).toBe(true);
});
