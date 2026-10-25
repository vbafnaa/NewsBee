import { describe, expect, it, vi } from "vitest";
import { currentDiscovery, discoverSources, overpassQuery, pageFeeds, type DiscoveredSource } from "../../communities/source-discovery";
import { calendarFacts, collectNeighborhood, newsFacts } from "../../connectors/neighborhood";
import { Fetcher } from "../../connectors/fetcher";
import type { ConnectorContext, LocationProfile } from "../../connectors/types";
import { loadSettings } from "../../core/config";
import { logger } from "../../core/log";
import { MongoLinkCache } from "../../storage/link-cache";
import { COLLECTIONS } from "../../storage/mongo";
import { withMongo } from "../support/mongo";
import { ReplayTransport } from "../support/replay";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34" }]) }));

const mongo = withMongo();
const ballard = {
  id: "ballard-seattle-wa", name: "Ballard, WA", state: "WA", systems: [], latitude: 47.669, longitude: -122.385,
  community: { name: "Ballard", state: "WA", state_name: "Washington", parent_id: "seattle-wa", parent_name: "Seattle", latitude: 47.669, longitude: -122.385,
    aliases: [], coverage_terms: ["Ballard"], library_branches: [], newsrooms: [] },
} as unknown as LocationProfile;

const rss = (items: Array<[string, string]>) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items.map(([title, date], index) =>
  `<item><title>${title}</title><link>https://school.example/news/${index}</link><guid>${index}</guid><pubDate>${date}</pubDate><description>${title} details.</description></item>`).join("")}</channel></rss>`;
const ics = (events: Array<[string, string, string]>) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flatMap(([uid, start, place]) =>
  ["BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:Event ${uid}`, `DTSTART:${start}`, `LOCATION:${place}`, `URL:https://church.example/events/${uid}`, "END:VEVENT"]), "END:VCALENDAR", ""].join("\r\n");

const places = { elements: [
  { tags: { amenity: "school", name: "Ballard High School", website: "https://school.example/" } },
  { tags: { amenity: "library", name: "Ballard Branch", website: "https://library.example/branch" } },
  { tags: { amenity: "place_of_worship", name: "St. Luke's", website: "http://church.example/" } },
  { tags: { leisure: "park", name: "Ballard Commons Park", website: "https://park.example/commons" } },
  { tags: { amenity: "school", name: "No website school" } },
] };
const wikipedia = `<h2 id="External_links">External links</h2><ul><li><a rel="nofollow" class="external text" href="http://news.example/">Ballard News</a></li><li><a class="external text" href="https://en.wikipedia.org/x">self</a></li></ul>`;

function replay() {
  return new ReplayTransport()
    .on(/overpass-api\.de\/api\/interpreter\?data=/, { body: places })
    .on("https://en.wikipedia.org/wiki/Ballard%2C_Seattle", { body: wikipedia })
    .on("https://school.example/", { body: `<link rel="alternate" type="application/rss+xml" href="/feed/"><link rel="alternate" type="application/rss+xml" href="/comments/feed/">` })
    .on("https://library.example/branch", { body: `<script>$Trumba.addSpud({ webName: "citylib", spudType: "main" });</script>` })
    .on("https://church.example/", { body: `<a href="/events/?ical=1">Export</a>` })
    .on("https://park.example/commons", { body: "<p>No feeds here.</p>" })
    .on("https://news.example/", { body: `<link rel="alternate" type="application/atom+xml" href="https://news.example/feed/">` })
    .on("https://school.example/feed/", { body: rss([["Fall concert", "Thu, 22 Oct 2026 12:00:00 GMT"], ["Old news", "Tue, 01 Sep 2026 12:00:00 GMT"]]) })
    .on("https://news.example/feed/", { body: rss([["Bridge opens", "Fri, 23 Oct 2026 12:00:00 GMT"]]) })
    .on("https://church.example/events/?ical=1", { body: ics([["a", "20261027T103000", "Fellowship Hall"], ["b", "20261120T103000", "Fellowship Hall"]]) })
    .on("https://www.trumba.com/calendars/citylib.rss", { status: 404, body: "" });
}

describe("automatic source discovery", () => {
  it("queries OpenStreetMap for organizations with websites around the area", () => {
    const query = overpassQuery(47.669, -122.385, 1500);
    expect(query).toContain('nwr(around:1500,47.669,-122.385)["website"]["amenity"~"^(school|college)$"]');
    expect(query).toContain('["leisure"~"^(park)$"]');
  });

  it("finds RSS, iCalendar and Trumba links on a page and skips comment and podcast feeds", () => {
    const feeds = pageFeeds(`<link rel="alternate" type="application/rss+xml" href="/feed/"><link rel="alternate" type="application/rss+xml" href="/comments/feed/">
      <a href="webcal://site.example/?post_type=tribe_events&#038;ical=1">Sync</a><a href="/cal/events.ics">ICS</a>
      <script src="https://www.trumba.com/scripts/spuds.js"></script><script>$Trumba.addSpud({webName: "kalendaro"})</script>`, "https://site.example/");
    expect(feeds).toEqual(expect.arrayContaining([
      { url: "https://site.example/feed/", kind: "rss" },
      { url: "https://site.example/?post_type=tribe_events&ical=1", kind: "ical" },
      { url: "https://site.example/cal/events.ics", kind: "ical" },
      { url: "https://www.trumba.com/calendars/kalendaro.rss", kind: "trumba" },
    ]));
    expect(feeds.some(({ url }) => url.includes("comments"))).toBe(false);
  });

  it("discovers, validates and stores every readable feed from places and Wikipedia links", async () => {
    const transport = replay();
    const discovery = await discoverSources(mongo.db, transport.transport, ballard);
    expect(discovery.sources.map((source) => [source.category, source.name, source.feed_kind, source.scope, source.found_via])).toEqual([
      ["Faith communities", "St. Luke's", "ical", "local", "openstreetmap"],
      ["Local news & history", "news.example", "rss", "local", "wikipedia"],
      ["Schools", "Ballard High School", "rss", "local", "openstreetmap"],
    ]);
    expect(discovery.places.map((place) => place.name)).toEqual(expect.arrayContaining(["Ballard Commons Park", "Ballard Branch", "news.example"]));
    expect(discovery.places.some((place) => place.name === "No website school")).toBe(false);
    expect(discovery.area_terms).toEqual(expect.arrayContaining(["Ballard", "Ballard Branch", "Ballard Commons Park"]));
    expect(transport.requests.some(({ url }) => url.includes("comments/feed"))).toBe(false);
    const stored = await mongo.db.collection(COLLECTIONS.discoveredSources).findOne({ _id: ballard.id as never });
    expect(stored?.sources).toHaveLength(3);
    expect(discovery.complete).toBe(true);
    const again = await currentDiscovery(mongo.db, transport.transport, ballard);
    expect(again.checked_at).toBe(discovery.checked_at);
    const stale = await currentDiscovery(mongo.db, transport.transport, ballard, { now: Date.now() + 8 * 86_400_000 });
    expect(stale.checked_at).not.toBe(discovery.checked_at);
  });

  it("records a gap instead of failing when OpenStreetMap is unavailable", async () => {
    const transport = replay().on(/overpass/, { status: 502, body: "busy" });
    const discovery = await discoverSources(mongo.db, transport.transport, ballard, { retryDelayMs: 0 });
    expect(discovery.gaps.join(" ")).toContain("OpenStreetMap places unavailable");
    expect(discovery.complete).toBe(false);
    expect(transport.requests.filter(({ url }) => url.includes("/api/interpreter")).length).toBe(9);
    expect(discovery.sources.map((source) => source.name)).toEqual(["news.example"]);
    const retried = await currentDiscovery(mongo.db, replay().transport, ballard);
    expect(retried.complete).toBe(true);
    expect(retried.sources.length).toBeGreaterThan(1);
  });
});

describe("neighborhood connector", () => {
  const source = (overrides: Partial<DiscoveredSource>): DiscoveredSource => ({
    id: "s1", name: "Ballard High School", category: "Schools", site: "https://school.example/", feed_url: "https://school.example/feed/",
    feed_kind: "rss", scope: "local", found_via: "openstreetmap", items_at_discovery: 2, ...overrides,
  });

  it("keeps the last two weeks of an organization's news as local, without needing the place name", () => {
    const facts = newsFacts(source({}), new TextEncoder().encode(rss([["Fall concert", "Thu, 22 Oct 2026 12:00:00 GMT"], ["Old news", "Tue, 01 Sep 2026 12:00:00 GMT"]])), "2026-10-25");
    expect(facts.map((fact) => [fact.title, fact.kind, fact.tier, fact.section, fact.venue])).toEqual([["Fall concert", "state_news", "local", "Schools", "Ballard High School"]]);
  });

  it("gives an organization's own calendar events without a location or link the organization's name and site", () => {
    const bytes = new TextEncoder().encode(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:x", "SUMMARY:Curriculum night", "DTSTART;VALUE=DATE:20261028", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n"));
    const facts = calendarFacts(source({ feed_kind: "ical", scope: "local" }), bytes, ["2026-10-26", "2026-11-01"], ["Ballard"]);
    expect(facts.map((fact) => [fact.title, fact.venue, fact.source_url])).toEqual([["Curriculum night", "Ballard High School", "https://school.example/"]]);
  });

  it("keeps calendar events in the window, and only events naming the area from shared calendars", () => {
    const bytes = new TextEncoder().encode(ics([["a", "20261027T103000", "Ballard Branch"], ["b", "20261027T110000", "Central Library"], ["c", "20261201T100000", "Ballard Branch"]]));
    const window: [string, string] = ["2026-10-26", "2026-11-01"];
    expect(calendarFacts(source({ feed_kind: "ical", scope: "local" }), bytes, window, ["Ballard"]).map((fact) => fact.title)).toEqual(["Event a", "Event b"]);
    const shared = calendarFacts(source({ feed_kind: "ical", scope: "shared", name: "Seattle Public Library" }), bytes, window, ["Ballard"]);
    expect(shared.map((fact) => [fact.title, fact.kind, fact.tier])).toEqual([["Event a", "event", "local"]]);
  });

  it("collects every discovered feed in one run and reports each feed", async () => {
    const transport = replay();
    await discoverSources(mongo.db, transport.transport, ballard);
    const context = {
      location: ballard, today: "2026-10-25", window: ["2026-10-26", "2026-11-01"], transport: transport.transport, fetcher: new Fetcher(transport.transport),
      settings: loadSettings({ NEWSBEE_ROOT: "C:\\newsbee-test" } as unknown as NodeJS.ProcessEnv), db: mongo.db, linkCache: new MongoLinkCache(mongo.db), log: logger("test"),
    } as ConnectorContext;
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const collected = await collectNeighborhood(context, "neighborhood:discovered", "Neighborhood sites found automatically");
    const output = print.mock.calls.map((call) => String(call[0])).join("\n");
    print.mockRestore();
    expect(collected.result).toMatchObject({ status: "ingested", feed_kind: "discovered" });
    expect(collected.events.map((event) => event.title).sort()).toEqual(["Bridge opens", "Event a", "Fall concert"]);
    expect(output).toContain("neighborhood feeds collected");
    expect(output).toContain("Faith communities");
  });
});
