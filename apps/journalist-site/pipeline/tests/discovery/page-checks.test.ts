import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Fetcher } from "../../connectors/fetcher";
import type { LocationProfile } from "../../connectors/types";
import type { HttpTransport } from "../../core/http";
import { resolveRunOptions, runContext, withRunContext, type RunOptions } from "../../core/run-options";
import { CHECK_GROUPS, freshnessFacts, headerDay, localityFacts, nameFacts, otherPlace } from "../../discovery/checks";
import { evaluateLeads, type Lead } from "../../discovery/evaluate";
import { inspectPage } from "../../discovery/inspect";
import type { DiscoveryContext } from "../../discovery/methods";
import { RUN_DECISIONS } from "../../trace/decisions";

// The made-up sites have no DNS; the address check itself has its own tests.
vi.mock("../../connectors/public-http", async (original) => ({ ...await original<object>(), publicSourceTransport: (transport: HttpTransport) => transport }));

const TODAY = "2026-11-06";
const words = (place: string) => `${place} news and notices for residents. `.repeat(20);
const page = (title: string, body: string) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p><ul><li>November 2, 2026</li><li>October 19, 2026</li><li>October 5, 2026</li></ul></main></body></html>`;

describe("the four check groups", () => {
  it("names each group, with the never-read list under Access", () => {
    expect(Object.keys(CHECK_GROUPS)).toEqual(["safety", "quality", "access", "evidence"]);
    expect(CHECK_GROUPS.access.rules).toContain("never_read");
    expect(CHECK_GROUPS.quality.rules).toEqual(["repost_hosts", "aggregators", "other_place"]);
    expect(CHECK_GROUPS.evidence.rules).toEqual(["locality", "freshness"]);
  });
});

describe("locality facts", () => {
  const base = { names: [], officialSite: false, foundByLocation: false, addresses: [], otherPlace: null, place: "Lakeside" };

  it("passes a page that names nothing but sits on the city's confirmed site", () => {
    expect(localityFacts({ ...base, scope: "city", officialSite: true })).toMatchObject({ outcome: "pass", reason: "on the city's confirmed site" });
  });

  it("passes a page that lists an address inside the area", () => {
    expect(localityFacts({ ...base, scope: "place", addresses: [{ address: "100 Main St", inside: true }] })).toMatchObject({ outcome: "pass", reason: expect.stringContaining("100 Main St") });
  });

  it("fails a page clearly about another place, and leaves one with no evidence unclear", () => {
    expect(localityFacts({ ...base, scope: null, otherPlace: "Brookfield" })).toMatchObject({ outcome: "fail", reason: "clearly about Brookfield, not Lakeside" });
    expect(localityFacts({ ...base, scope: null, addresses: [{ address: "9 Elm St", inside: false }] })).toMatchObject({ outcome: "fail" });
    expect(localityFacts({ ...base, scope: null, addresses: [{ address: "9 Elm St", inside: null }] })).toMatchObject({ outcome: "unclear", reason: "no evidence it concerns Lakeside" });
  });

  it("records where each name appears: title, text or an address", () => {
    expect(nameFacts([{ name: "Lakeside", level: "place" }, { name: "Grant County", level: "county" }], "Lakeside Library", `Visit us at 100 Main Street, Lakeside. ${"Open every day. ".repeat(8)}Grant County residents welcome.`)).toEqual([
      { name: "Lakeside", level: "place", where: ["title", "text", "address"] },
      { name: "Grant County", level: "county", where: ["text"] },
    ]);
  });

  it("finds a nearby place the title names instead of ours, and not one that contains our name", () => {
    expect(otherPlace("Brookfield events calendar", ["Lakeside"], ["Lakeside", "Brookfield"])).toBe("Brookfield");
    expect(otherPlace("Lakeside and Brookfield events", ["Lakeside"], ["Brookfield"])).toBeNull();
    expect(otherPlace("North Lakeside news", ["Lakeside"], ["North Lakeside"])).toBeNull();
  });
});

describe("freshness facts", () => {
  it("records each date's source, including the server's Last-Modified and the sitemap", () => {
    const inspection = inspectPage('<html><body><time datetime="2026-10-30">Oct 30</time><p>November 2, 2026</p></body></html>', "https://a.example.org/", TODAY, null);
    const facts = freshnessFacts(inspection, { url: "https://a.example.org/feed", format: "rss", latest: "2026-11-01", items: 12 }, { "last-modified": "Wed, 04 Nov 2026 10:00:00 GMT" }, "2026-11-03", 3);
    expect(facts.outcome).toBe("pass");
    expect(facts.dates).toEqual([
      { source: "markup", latest: "2026-10-30", count: 1 },
      { source: "text", latest: "2026-11-02", count: 2 },
      { source: "feed", latest: "2026-11-01", count: 12 },
      { source: "last_modified", latest: "2026-11-04", count: 1 },
      { source: "sitemap", latest: "2026-11-03", count: 1 },
    ]);
  });

  it("fails plenty of old dates, and leaves few or none unclear", () => {
    const old = inspectPage("<p>January 2, 2024</p><p>February 3, 2024</p><p>March 4, 2024</p>", "https://a.example.org/", TODAY, null);
    expect(freshnessFacts(old, null, {}, null, 3)).toMatchObject({ outcome: "fail", reason: "nothing newer than 2024-03-04" });
    expect(freshnessFacts(inspectPage("<p>No dates</p>", "https://a.example.org/", TODAY, null), null, {}, null, 3)).toMatchObject({ outcome: "unclear", reason: "no dates found" });
    // A fresh-looking server date alone doesn't make a page current: many servers stamp every page with today.
    expect(freshnessFacts(old, null, { "last-modified": "Thu, 05 Nov 2026 10:00:00 GMT" }, null, 3).outcome).toBe("fail");
    expect(headerDay("not a date")).toBeNull();
  });
});

describe("discovery's page checks", () => {
  let server: MongoMemoryServer, client: MongoClient, db: Db;
  beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("checks"); });
  afterAll(async () => { await client.close(); await server.stop(); });
  beforeEach(async () => {
    await db.dropDatabase();
    await db.collection("census_places").insertMany([
      { name: "Lakeside", state: "WA", latitude: 47.6, longitude: -122.3, name_lower: "lakeside" },
      { name: "Brookfield", state: "WA", latitude: 47.65, longitude: -122.35, name_lower: "brookfield" },
    ]);
  });

  const location = { id: "loc", name: "Lakeside, WA", state: "WA", latitude: 47.6, longitude: -122.3, systems: [] } as unknown as LocationProfile;
  const web = (pages: Record<string, { html: string; headers?: Record<string, string> }>, seen: string[]): HttpTransport => async (request) => {
    seen.push(request.url);
    const url = new URL(request.url);
    const send = (status: number, text: string, headers: Record<string, string> = {}) => ({ url: request.url, status, headers: { "content-type": "text/html", ...headers }, body: new TextEncoder().encode(text) });
    if (url.pathname === "/robots.txt") return send(200, "User-agent: *\nDisallow:\n");
    const found = pages[`${url.hostname}${url.pathname}`];
    return found ? send(200, found.html, found.headers) : send(404, "not here");
  };
  async function check(leads: Lead[], pages: Record<string, { html: string; headers?: Record<string, string> }>, choices: Partial<RunOptions> = {}) {
    const seen: string[] = [];
    const transport = web(pages, seen);
    const context = { db, settings: { integrations: {}, modelProviders: [] }, transport, fetcher: new Fetcher(transport), location, today: TODAY, log: { info() {}, warn() {}, error() {} }, model: null } as unknown as DiscoveryContext;
    let overrides: string[] = [];
    const result = await withRunContext({ db, runId: "run", locationId: "loc", options: resolveRunOptions(choices) }, async () => {
      const out = await evaluateLeads(context, leads, { method: "dork", seen: new Set() });
      overrides = [...runContext()!.overrides];
      return out;
    });
    const decisions = await db.collection(RUN_DECISIONS).find({ run_id: "run" }).toArray();
    return { result, seen, decisions, overrides };
  }
  const lead = (url: string, title: string, extra: Partial<Lead> = {}): Lead => ({ url, title, snippet: "", topic: "events", family: "test", ...extra });

  it("keeps the facts on the candidate and in the decision log", async () => {
    const { result, decisions } = await check(
      [lead("https://lakeside-arts.example.org/events", "Lakeside Arts events", { lastmod: "2026-11-03" })],
      { "lakeside-arts.example.org/events": { html: page("Lakeside Arts events", words("Lakeside")), headers: { "last-modified": "Wed, 04 Nov 2026 10:00:00 GMT" } } },
    );
    const [candidate] = result.candidates;
    expect(candidate.checks?.locality).toMatchObject({ outcome: "pass", names: [{ name: "Lakeside", level: "place", where: ["title", "text"] }] });
    expect(candidate.checks?.freshness.outcome).toBe("pass");
    expect(candidate.checks?.freshness.dates.map((item) => item.source)).toEqual(["text", "last_modified", "sitemap"]);
    const kept = decisions.find((row) => row.decision === "fetch" && row.evidence?.outcome === "kept");
    expect(kept?.evidence?.checks).toEqual(JSON.parse(JSON.stringify(candidate.checks)));
  });

  it("keeps a page whose site's crawl delay wouldn't fit in the job's time as a link-only lead, for the model check", async () => {
    const seen: string[] = [];
    const transport: HttpTransport = async (request) => {
      seen.push(request.url);
      const robots = new URL(request.url).pathname === "/robots.txt";
      return { url: request.url, status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode(robots ? "User-agent: *\nCrawl-delay: 10\nDisallow:\n" : page("Lakeside notices", words("Lakeside"))) };
    };
    const context = { db, settings: { integrations: {}, modelProviders: [] }, transport, fetcher: new Fetcher(transport), location, today: TODAY, log: { info() {}, warn() {}, error() {} }, model: null } as unknown as DiscoveryContext;
    const result = await withRunContext({ db, runId: "run", locationId: "loc", options: resolveRunOptions({}) }, () =>
      evaluateLeads(context, [lead("https://slow-county.example.org/notices", "Lakeside notices")], { method: "dork", seen: new Set(), deadline: Date.now() + 3_000 }));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ link_only: true, why: "Blocked from reading, kept as a link-only lead" });
    // Only its robots.txt was read: the page itself was never asked for.
    expect(seen.filter((url) => url.includes("slow-county"))).toEqual(["https://slow-county.example.org/robots.txt"]);
    const logged = await db.collection(RUN_DECISIONS).findOne({ run_id: "run", decision: "fetch" });
    expect(logged).toMatchObject({ evidence: { outcome: "blocked" }, reason: expect.stringMatching(/^blocked: waiting 10s for slow-county\.example\.org's turn/) });
  });

  it("rejects a page clearly about another place, even with quality guardrails off", async () => {
    const { result, decisions } = await check([lead("https://brook-arts.example.org/", "Brookfield events")], { "brook-arts.example.org/": { html: page("Brookfield events", words("Brookfield")) } }, { guardrails: "exploration" });
    expect(result.candidates).toEqual([]);
    expect(result.rejected).toEqual([{ url: "https://brook-arts.example.org/", reason: "clearly about Brookfield, not Lakeside" }]);
    expect(decisions.find((row) => row.subject === "https://brook-arts.example.org/" && row.decision === "fetch")).toMatchObject({ rule: "quality:other_place", evidence: { outcome: "other_place", checks: { locality: { outcome: "fail", other_place: "Brookfield" } } } });
  });

  it("sends a page with no local evidence on to the model check, marked unclear", async () => {
    const pages = { "nowhere.example.org/": { html: page("Events", words("Our town")) } };
    const { result, decisions } = await check([lead("https://nowhere.example.org/", "Events")], pages, { guardrails_off: ["quality"] });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ checks: { locality: { outcome: "unclear" } }, inside_area: false, why: expect.stringContaining("for the model check to decide") });
    expect(result.candidates[0].scope).toBeUndefined();
    expect(result.candidates[0].judge_input?.text).toContain("Our town");
    // Not yet shown to be local, so its site isn't followed.
    expect(result.links).toEqual([]);
    expect(decisions.find((row) => row.subject === "https://nowhere.example.org/" && row.decision === "fetch")?.evidence?.checks.locality.outcome).toBe("unclear");
  });

  it("rejects it as before when a baseline test switches the model check off", async () => {
    const { result } = await check([lead("https://nowhere.example.org/", "Events")], { "nowhere.example.org/": { html: page("Events", words("Our town")) } }, { guardrails_off: ["quality"], gemini_check: false });
    expect(result.candidates).toEqual([]);
    expect(result.rejected[0].reason).toBe("no evidence it concerns Lakeside");
  });

  it("never fetches a repost site in discovery, whatever the guardrails", async () => {
    const { seen, result } = await check([lead("https://www.newsbreak.com/lakeside", "Lakeside news")], {}, { guardrails: "exploration" });
    expect(seen.filter((url) => url.includes("newsbreak"))).toEqual([]);
    expect(result.candidates.every((candidate) => candidate.link_only)).toBe(true);
  });

  it("keeps the never-read list under Respect, and reads past it under Relaxed, recording the override", async () => {
    const pages = { "www.facebook.com/lakesidelibrary": { html: page("Lakeside Library", words("Lakeside")) } };
    const facebook = lead("https://www.facebook.com/lakesidelibrary", "Lakeside Library");
    const respect = await check([facebook], pages);
    expect(respect.seen.filter((url) => url.includes("facebook"))).toEqual([]);
    expect(respect.result.candidates[0]).toMatchObject({ link_only: true });

    for (const access_ignore of [[], ["never_read"]] as const) {
      await db.collection(RUN_DECISIONS).deleteMany({});
      const relaxed = await check([facebook], pages, { access: "relaxed", access_ignore: [...access_ignore] });
      expect(relaxed.seen).toContain("https://www.facebook.com/lakesidelibrary");
      expect(relaxed.overrides).toContain("never_read");
      expect(relaxed.result.candidates[0]).toMatchObject({ link_only: false, access_overrides: expect.arrayContaining(["never_read"]) });
    }
    // Relaxed with other rules ticked still keeps the never-read list.
    const other = await check([facebook], pages, { access: "relaxed", access_ignore: ["robots"] });
    expect(other.seen.filter((url) => url.includes("facebook"))).toEqual([]);
  });
});
