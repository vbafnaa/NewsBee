import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Fetcher } from "../../connectors/fetcher";
import type { LocationProfile } from "../../connectors/types";
import type { HttpTransport } from "../../core/http";
import { deepSites, FIXED_METHODS, FIXED_READERS, METHODS, methodDefinition, type DiscoveryContext } from "../../discovery/methods";
import { countByCategory } from "../../discovery/run";
import { LEGACY_OPTIONS } from "../../core/run-options";
import { runFunnel } from "../../trace/funnel";
import { RUN_DECISIONS } from "../../trace/decisions";
import type { SourceCandidate } from "../../sourcemap/store";

// The made-up sites have no DNS, and nothing here needs pacing.
vi.mock("../../connectors/public-http", async (original) => ({ ...await original<object>(), publicSourceTransport: (transport: HttpTransport) => transport }));
vi.mock("../../connectors/fetch-state", async (original) => ({ ...await original<object>(), reserveHost: async () => 0 }));

const TODAY = "2026-11-06";
const anchors = (links: Array<[string, string]>) => links.map(([href, text]) => `<a href="${href}">${text}</a>`).join("\n");
const listing = (title: string, links: Array<[string, string]> = []) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${"Lakeside residents' notices and news. ".repeat(30)}</p><ul><li>November 2, 2026</li><li>October 19, 2026</li><li>October 5, 2026</li></ul>${anchors(links)}</main></body></html>`;
const LOCATION = { id: "loc", name: "Lakeside, WA", state: "WA", latitude: 47.6, longitude: -122.3, systems: [], government: null } as unknown as LocationProfile;

describe("one list of fixed readers", () => {
  it("has the plan's readers, in one list, and no fixed batch of operator searches", () => {
    expect(FIXED_READERS.map((entry) => entry.reader)).toEqual(["City and county", "Open data", "Schools", "Local groups", "Local institutions", "News and wider sources", "Home sales"]);
    expect(FIXED_READERS.flatMap((entry) => entry.methods.map((method) => method.method))).toEqual(["government", "meetings", "opendata", "schools", "groups", "institutions", "newsrooms", "publishers", "athletics", "national", "homesales"]);
    // Operator search is one of the agent's tools now, not a method.
    expect(METHODS.map((method) => method.method)).toEqual([...FIXED_METHODS]);
    expect(methodDefinition("dork")).toBeUndefined();
  });

  it("no longer runs Gemini suggestions, the home-page-only map method or the one-city directories", () => {
    for (const method of ["llm", "osm", "directories"]) expect(methodDefinition(method), method).toBeUndefined();
  });

  it("adds ATTOM only when a key is set", async () => {
    const context = (attomKey: string | null) => ({ settings: { integrations: { attomKey } }, transport: async (request: { url: string }) => ({ url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ address: { postcode: "98001-1234" } })) }), location: LOCATION }) as unknown as DiscoveryContext;
    expect(await methodDefinition("homesales")!.run(context(null))).toEqual({ candidates: [], detail: "No ATTOM key set" });
    const { candidates } = await methodDefinition("homesales")!.run(context("key"));
    expect(candidates).toMatchObject([{ source_id: "property:attom:98001", reader: "property", section: "real_estate", found_by: { method: "homesales" } }]);
    // Discovery adds the source and pays nothing: only collection calls ATTOM, in a run that ticks it.
    expect(candidates[0].status).toBeUndefined();
  });
});

describe("choosing institution sites to read in depth", () => {
  const known = [
    { name: "Lakeside Library", kind: "library", website: "https://library.example.org/", inside: true },
    { name: "Lakeside Elementary", kind: "school", website: "https://elem.example.org/", inside: true },
    { name: "Far High School", kind: "school", website: "https://high.example.org/", inside: false },
    { name: "Rowing Club", kind: "club", website: "https://rowing.example.org/", inside: false },
    { name: "Chapel", kind: "funeral_directors", website: "https://chapel.example.org/", inside: false },
    { name: "Fire Station 2", kind: "fire_station", website: null, inside: true },
  ];

  it("takes libraries, police, fire and community centres, and the clubs and high schools serving the place from outside", () => {
    // Schools inside are the schools reader's, and funeral homes the groups reader's.
    expect(deepSites(known, [])).toEqual([
      { name: "Lakeside Library", kind: "library", url: "https://library.example.org/", inside: true },
      { name: "Far High School", kind: "school", url: "https://high.example.org/", inside: false },
      { name: "Rowing Club", kind: "club", url: "https://rowing.example.org/", inside: false },
    ]);
  });

  it("adds those the map of the area has, once per address, within the cap", () => {
    const places = [{ name: "Lakeside Police", url: "https://city.example.gov/police", kind: "police", section: "safety" as const }, { name: "Library again", url: "https://library.example.org", kind: "library", section: "events" as const }, { name: "Museum", url: "https://museum.example.org/", kind: "museum", section: "events" as const }];
    expect(deepSites(known, places).map((site) => site.name)).toEqual(["Lakeside Library", "Far High School", "Rowing Club", "Lakeside Police"]);
    expect(deepSites(known, places, 2)).toHaveLength(2);
  });
});

describe("with a database", () => {
  let server: MongoMemoryServer, client: MongoClient, db: Db;
  beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("fixed-pipeline"); });
  afterAll(async () => { await client.close(); await server.stop(); });
  beforeEach(async () => {
    await db.dropDatabase();
    await db.collection("census_places").insertOne({ name: "Lakeside", state: "WA", latitude: 47.6, longitude: -122.3, name_lower: "lakeside" });
  });

  const pages: Record<string, string> = {
    "library.example.org/": listing("Lakeside Library", [["/events", "Library Events"], ["/news", "News"]]),
    "library.example.org/events": listing("Lakeside Library events"),
    "library.example.org/news": listing("Lakeside Library news"),
    "high.example.org/": listing("Far High School", [["/calendar", "School Calendar"]]),
    "high.example.org/calendar": listing("Far High School calendar"),
    "theatre.example.org/": listing("Lakeside Theatre"),
    "museum.example.org/": listing("Lakeside Museum"),
    "elem.example.org/": listing("Lakeside Elementary"),
    "fine.example.com/": listing("Lakeside Ledger"),
    "optout.example.com/": listing("Lakeside Gazette"),
  };
  function web(seen: string[]): HttpTransport {
    return async (request) => {
      const url = new URL(request.url);
      seen.push(request.url);
      const send = (status: number, text: string, headers: Record<string, string> = { "content-type": "text/html" }) => ({ url: request.url, status, headers, body: new TextEncoder().encode(text) });
      if (url.pathname === "/robots.txt") return send(200, url.hostname === "museum.example.org" ? "User-agent: *\nDisallow: /\n" : "User-agent: *\nDisallow:\n", { "content-type": "text/plain" });
      if (url.hostname.includes("overpass")) return send(200, JSON.stringify({ elements: [
        { lat: 47.6, lon: -122.3, tags: { name: "Lakeside Library", amenity: "library", website: "https://library.example.org/" } },
        { lat: 47.6, lon: -122.3, tags: { name: "Lakeside Elementary", amenity: "school", website: "https://elem.example.org/" } },
        { lat: 47.68, lon: -122.3, tags: { name: "Far High School", amenity: "school", website: "https://high.example.org/" } },
        { lat: 47.6, lon: -122.3, tags: { name: "Lakeside Theatre", amenity: "theatre", website: "https://theatre.example.org/" } },
        { lat: 47.6, lon: -122.3, tags: { name: "Lakeside Museum", tourism: "museum", website: "https://museum.example.org/" } },
      ] }), { "content-type": "application/json" });
      if (url.hostname === "optout.example.com") return send(200, pages["optout.example.com/"], { "content-type": "text/html", "x-robots-tag": "noai" });
      const page = pages[`${url.hostname}${url.pathname}`];
      return page ? send(200, page) : send(404, "not here");
    };
  }
  const contextFor = (transport: HttpTransport) => ({ db, settings: { integrations: {} }, transport, fetcher: new Fetcher(transport, undefined, false), location: LOCATION, today: TODAY, log: { info() {}, warn() {} } }) as unknown as DiscoveryContext;

  it("reads a library's site in depth, and an outside high school's, as checked sources in the right sections", async () => {
    const seen: string[] = [];
    const result = await methodDefinition("institutions")!.run(contextFor(web(seen)));
    const byUrl = Object.fromEntries(result.candidates.map((candidate) => [candidate.url, candidate]));
    expect(byUrl["https://library.example.org/"]).toMatchObject({ section: "events", found_by: { method: "institutions" }, status: "active", checks: { locality: { outcome: "pass", found_by_location: true }, freshness: { outcome: "pass" } } });
    expect(byUrl["https://library.example.org/events"]).toMatchObject({ section: "events", status: "active", link_only: false, checks: { locality: { outcome: "pass" } } });
    expect(byUrl["https://library.example.org/news"]).toMatchObject({ section: "news", status: "active" });
    expect(byUrl["https://high.example.org/calendar"]).toMatchObject({ section: "schools", scope: "city" });
    // The school inside the place is the schools reader's, and not checked here at all.
    expect(seen.some((url) => url.startsWith("https://elem.example.org/"))).toBe(false);
    expect(result.detail).toContain("2 of 2 institution sites read in depth (library, school)");
  });

  it("checks every other place's home page instead of saving it unread", async () => {
    const result = await methodDefinition("institutions")!.run(contextFor(web([])));
    const byUrl = Object.fromEntries(result.candidates.map((candidate) => [candidate.url, candidate]));
    expect(byUrl["https://theatre.example.org/"]).toMatchObject({ section: "events", scope: "place", checks: { locality: { outcome: "pass", found_by_location: true } } });
    // Access: robots shuts the museum out, so it is a link only, and says why.
    expect(byUrl["https://museum.example.org/"]).toMatchObject({ link_only: true, access: { robots: "blocked" } });
    expect(byUrl["https://museum.example.org/"].checks).toBeUndefined();
  });

  it("puts publishers' pages through the same checks: an AI opt-out keeps one out, and an unreadable one isn't added", async () => {
    await db.collection("news_publishers").insertMany([
      { location_id: "loc", url: "https://fine.example.com/", host: "fine.example.com", name: "Lakeside Ledger", hits: 6 },
      { location_id: "loc", url: "https://optout.example.com/", host: "optout.example.com", name: "Lakeside Gazette", hits: 5 },
      { location_id: "loc", url: "https://gone.example.com/", host: "gone.example.com", name: "Gone", hits: 4 },
    ]);
    const result = await methodDefinition("publishers")!.run(contextFor(web([])));
    expect(result.candidates.map((candidate) => candidate.url)).toEqual(["https://fine.example.com/"]);
    expect(result.candidates[0]).toMatchObject({ section: "news", scope: "city", params: { kind: "news_report" }, checks: { freshness: { outcome: "pass" } } });
    expect(result.detail).toBe("3 publishers with 2+ results; 3 checked, 1 added");
  });

  it("reports, per category, what the fixed pipeline found in a run, without the operator search", async () => {
    await db.collection("pipeline_runs").insertOne({ _id: "run-1" as never, location_id: "loc", created_at: 1, status: "mapped", options: { ...LEGACY_OPTIONS, flow: "agentic" }, trigger: { kind: "manual", by: "test" } });
    const method = (name: string, byCategory: Record<string, { found: number; link_only: number }> | null) => ({ run_id: "run-1", location_id: "loc", at: 1, stage: "source", actor: "rule", subject: `method:${name}`, decision: "ran", reason: "", evidence: { found: 0, added: 0, ...(byCategory ? { by_category: byCategory } : {}) } });
    await db.collection(RUN_DECISIONS).insertMany([
      method("government", { civic: { found: 3, link_only: 1 }, safety: { found: 1, link_only: 0 } }),
      method("institutions", { events: { found: 2, link_only: 0 }, safety: { found: 2, link_only: 1 } }),
      method("dork", { events: { found: 9, link_only: 0 } }),
    ]);
    const funnel = await runFunnel(db, "loc", "run-1");
    const row = (category: string) => funnel!.fixed_coverage!.find((item) => item.category === category);
    expect(funnel!.fixed_coverage).toHaveLength(10);
    expect(row("safety")).toEqual({ category: "safety", label: "Police, fire and safety", found: 3, readable: 2, link_only: 1, methods: [{ method: "institutions", found: 2 }, { method: "government", found: 1 }] });
    expect(row("events")).toMatchObject({ found: 2, methods: [{ method: "institutions", found: 2 }] });
    expect(row("obituaries")).toMatchObject({ found: 0, methods: [] });
  });
});

describe("coverage per category", () => {
  it("counts what a method found in each of the ten categories, and its links only, leaving weather out", () => {
    const candidate = (section: string, linkOnly = false) => ({ section, link_only: linkOnly }) as unknown as SourceCandidate;
    expect(countByCategory([candidate("events"), candidate("events", true), candidate("safety"), candidate("weather")])).toEqual({ events: { found: 2, link_only: 1 }, safety: { found: 1, link_only: 0 } });
  });
});
