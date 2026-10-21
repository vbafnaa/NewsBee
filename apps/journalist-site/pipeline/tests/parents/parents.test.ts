import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { athleticsConnector, headlineProblem } from "../../connectors/athletics";
import { civicCalendarConnector, locationTier, MEETING_CATEGORY } from "../../connectors/civiccalendar";
import { developmentConnector, portalDomain } from "../../connectors/development";
import { Fetcher } from "../../connectors/fetcher";
import { homeSafetyConnector } from "../../connectors/homesafety";
import { housingConnector, parsePlace } from "../../connectors/housing";
import { CONNECTORS } from "../../connectors/registry";
import { type Connector, type ConnectorContext, type LocationProfile, type SourceTask } from "../../connectors/types";
import { resolveRegion, validateStateSources } from "../../connectors/wider/regions";
import { publishedKeys, reportingSince } from "../../connectors/parents/shared";
import { publishedViolationKeys, staleReason } from "../../connectors/homesafety";
import { logger } from "../../core/log";
import { COLLECTIONS } from "../../storage/mongo";
import { fixture, ReplayTransport } from "../support/replay";
import { withMongo } from "../support/mongo";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34" }]) }));

const TODAY = "2026-10-19";
const ROOT = path.resolve(__dirname, "../fixtures");
const STATES = JSON.parse(fixture("parents-state-sources.json").toString("utf8"));
const government = (website: string) => ({ status: "found", platform: null, tenant: null, website, wikidata_id: null, pages_checked: [], detail: "" });
const REDMOND: LocationProfile = { id: "redmond-wa", name: "Redmond, WA", state: "WA", census_geoid: "5357535", latitude: 47.674, longitude: -122.1215, systems: [], government: government("https://www.redmond.gov/") };
const SILVERDALE: LocationProfile = { id: "silverdale-wa", name: "Silverdale, WA", state: "WA", latitude: 47.6448, longitude: -122.6946, systems: [] };
const SEATTLE: LocationProfile = { id: "seattle-wa", name: "Seattle, WA", state: "WA", census_geoid: "5363000", latitude: 47.6062, longitude: -122.3321, systems: [], government: government("https://www.seattle.gov") };

const mongo = withMongo();
beforeEach(async () => {
  await mongo.db.collection<{ _id: string; config_path: string; data: Record<string, unknown> }>("source_configs").insertOne({ _id: "state-sources", config_path: "config/state-sources.json", data: structuredClone(STATES) });
});
function context(transport: ReplayTransport, location: LocationProfile, extra: Partial<ConnectorContext> = {}): ConnectorContext {
  const settings = { mode: "local" as const, root: ROOT, localDataDir: ROOT, modelProviders: [], aiLinkDiscovery: false, widerSources: false, pipelineDriveFolderId: null, cronSecret: null };
  const linkCache = { async get() { return null; }, async put() {}, async invalidate() {} };
  return { location, today: TODAY, window: ["2026-10-20", "2026-10-26"], transport: transport.transport, fetcher: new Fetcher(transport.transport), settings,
    db: mongo.db, linkCache, log: logger("parents-test"), ...extra } as ConnectorContext;
}
function only(connector: Connector, location: LocationProfile): SourceTask {
  const [source] = connector.sources(location);
  expect(source).toBeDefined();
  return { type: connector.type, source_id: source.source_id, name: source.name };
}
const allText = (value: unknown) => JSON.stringify(value);
let editionCount = 0;
/** Seeds a published edition (and optionally a draft or held entry) that ran these source items. */
async function publish(locationId: string, today: string, sourceId: string, eventIds: string[], options: { status?: string; disposition?: string } = {}) {
  const id = `edition-${(editionCount += 1)}`;
  await mongo.db.collection(COLLECTIONS.editions).insertOne({ id, location_id: locationId, status: options.status ?? "published", today, published_at: Date.parse(`${today}T12:00:00Z`) });
  await mongo.db.collection(COLLECTIONS.editionEntries).insertOne({ edition_id: id, disposition: options.disposition ?? "included", source_id: sourceId,
    result: { story: { occurrences: eventIds.map((source_event_id) => ({ source_id: sourceId, source_event_id })) } } });
}

describe("edition window", () => {
  it("starts at the last published edition, or one window back, and remembers what ran", async () => {
    const base = context(new ReplayTransport(), REDMOND);
    expect(await reportingSince(base)).toBe("2026-10-12");
    await publish("redmond-wa", "2026-10-01", "x", ["old"]);
    expect(await reportingSince(base)).toBe("2026-10-12");
    await publish("redmond-wa", "2026-10-15", "x", ["a", "b"]);
    await publish("redmond-wa", "2026-10-17", "x", ["held"], { disposition: "held" });
    await publish("redmond-wa", "2026-10-18", "x", ["draft"], { status: "draft" });
    await publish("seattle-wa", "2026-10-18", "x", ["elsewhere"]);
    await publish("redmond-wa", "2026-10-15", "y", ["other-source"]);
    expect(await reportingSince(base)).toBe("2026-10-17");
    expect([...await publishedKeys(base, "x")].sort()).toEqual(["a", "b", "old"]);
  });
});

it("registers all five parent-and-homeowner connectors", () => {
  expect(Object.keys(CONNECTORS)).toEqual(expect.arrayContaining(["civiccalendar", "homesafety", "housing", "development", "athletics"]));
  expect(validateStateSources(STATES).WA.athletics).toHaveLength(1);
  expect(() => validateStateSources({ WA: { name: "Washington", athletics: [{ name: "Bad", feed: "http://insecure.example/feed" }] } })).toThrow(/athletics feed/);
});

describe("civiccalendar", () => {
  const empty = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
  const extra = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:9001", "SUMMARY:Kirkland family movie night", "DTSTART;TZID=America/Los_Angeles:20261023T190000", "LOCATION:Heritage Park - 111 Waverly Way  Kirkland WA 98033", "DESCRIPTION: https://www.redmond.gov/calendar.aspx?EID=9001", "END:VEVENT",
    "BEGIN:VEVENT", "UID:9002", "SUMMARY:Spokane business expo", "DTSTART;TZID=America/Los_Angeles:20261023T100000", "LOCATION:Convention Center - 334 W Spokane Falls Blvd  Spokane WA 99201", "END:VEVENT",
    "BEGIN:VEVENT", "UID:9003", "SUMMARY:Salem trade fair", "DTSTART;TZID=America/Los_Angeles:20261023T100000", "LOCATION:Fairgrounds - 2330 17th St NE  Salem OR 97301", "END:VEVENT",
    "BEGIN:VEVENT", "UID:9004", "SUMMARY:Small business webinar", "DTSTART;TZID=America/Los_Angeles:20261023T100000", "LOCATION:Online via Zoom", "END:VEVENT",
    "BEGIN:VEVENT", "UID:9005", "SUMMARY:Weekly market", "RRULE:FREQ=WEEKLY", "DTSTART;TZID=America/Los_Angeles:20261023T100000", "LOCATION:Downtown Park", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
  const replay = () => new ReplayTransport()
    .on("https://www.redmond.gov/Calendar.aspx", { file: "civiccalendar/calendar.html" })
    .on(/iCalendar\.aspx\?catID=\d+/, { body: empty })
    .on(/iCalendar\.aspx\?catID=22&/, { file: "civiccalendar/community-22.ics" })
    .on(/iCalendar\.aspx\?catID=43&/, { body: extra });

  it("reads only community categories and keeps in-window events in or near the city", async () => {
    const transport = replay();
    const { result, events } = await civicCalendarConnector.collect(only(civicCalendarConnector, REDMOND), context(transport, REDMOND));
    expect(result.status).toBe("ingested");
    expect(result.skipped_unusable).toMatchObject({ meeting_category: 3, category_limit: 3, outside_area: 2, virtual_only: 1, recurring: 1 });
    expect(transport.requests.map((request) => request.url).filter((url) => /catID=(32|35|34)&/.test(url))).toEqual([]);
    expect(events.map((event) => [event.title, event.event_date, event.tier])).toEqual(expect.arrayContaining([
      ["Haunted House at Redmond Community Center at Marymoor Village", "2026-10-24", "local"],
      ["Spooky Spectacular at the Redmond Senior & Community Center", "2026-10-26", "local"],
      ["Kirkland family movie night", "2026-10-23", "nearby"],
    ]));
    expect(events.every((event) => event.event_date >= "2026-10-20" && event.event_date <= "2026-10-26")).toBe(true);
    expect(events.every((event) => String(event.source_url).startsWith("https://www.redmond.gov/") && /EID=\d+/i.test(String(event.source_url)))).toBe(true);
    expect(events.find((event) => event.title.startsWith("Haunted"))).toMatchObject({ venue: "Redmond Community Center at Marymoor Village", kind: "event", category: "Community Events" });
  });

  it("drops events an earlier published edition already listed", async () => {
    const task = only(civicCalendarConnector, REDMOND);
    await publish("redmond-wa", "2026-10-12", task.source_id, ["9001"]);
    const { result, events } = await civicCalendarConnector.collect(task, context(replay(), REDMOND));
    expect(result.skipped_unusable).toMatchObject({ already_published: 1 });
    expect(events.map((event) => event.title)).not.toContain("Kirkland family movie night");
    expect(events.length).toBeGreaterThan(0);
  });

  it("matches meeting categories and place tiers", () => {
    expect(["City Council", "Boards & Commissions", "Community Meetings"].every((name) => MEETING_CATEGORY.test(name))).toBe(true);
    expect(["Community Events", "Parks & Recreation", "Welcoming Week"].some((name) => MEETING_CATEGORY.test(name))).toBe(false);
    const region = resolveRegion(REDMOND, validateStateSources(STATES));
    expect(locationTier(region, "Farrel-McWhirter Park - 19545 Redmond Road Redmond WA 98052")).toBe("local");
    expect(locationTier(region, "City Hall - 123 Main St Bellevue WA 98004")).toBe("nearby");
    expect(locationTier(region, "Expo - 1 Main St Redmond OR 97756")).toBeNull();
    expect(locationTier(region, "Redmond City Hall")).toBe("local");
  });

  it("reports a blocked robots.txt as blocked, and a site with no calendar as no_feed", async () => {
    const blocked = replay().on("https://www.redmond.gov/robots.txt", { status: 403, body: "" });
    expect((await civicCalendarConnector.collect(only(civicCalendarConnector, REDMOND), context(blocked, REDMOND))).result.status).toBe("blocked");
    const missing = new ReplayTransport().on("https://www.redmond.gov/Calendar.aspx", { status: 404, body: "" });
    expect((await civicCalendarConnector.collect(only(civicCalendarConnector, REDMOND), context(missing, REDMOND))).result.status).toBe("no_feed");
  });
});

describe("homesafety", () => {
  const replay = () => {
    const transport = new ReplayTransport().on(/\/VIOLATION\/PRIMACY_AGENCY_CODE\/WA\/IS_HEALTH_BASED_IND\/Y\/COMPL_PER_BEGIN_DATE\/%3E\/2026-04-22\/JSON$/, { file: "homesafety/violations.json" });
    for (const id of ["WA5305345", "WA5333489", "WA5386470", "WA5318750"]) transport.on(`https://data.epa.gov/efservice/WATER_SYSTEM/PWSID/${id}/JSON`, { file: `homesafety/system-${id}.json` });
    return transport;
  };

  it("keeps community water systems registered in the town or a place within 50 km, without contact details", async () => {
    const { result, events } = await homeSafetyConnector.collect(only(homeSafetyConnector, SILVERDALE), context(replay(), SILVERDALE));
    expect(result.status).toBe("ingested");
    expect(events.map((event) => [event.title, event.tier])).toEqual([
      ["Drinking water: health-based violation recorded for Jackson Park Naval Hospital", "local"],
      ["Drinking water: health-based violation recorded for Lakeside Park", "nearby"],
    ]);
    expect(result.skipped_unusable).toMatchObject({ not_community_water_system: 1, outside_area: 2 });
    expect(events[0]).toMatchObject({ kind: "safety_notice", source_url: "https://data.epa.gov/efservice/VIOLATION/PWSID/WA5305345/HTML", signals: { health_based: 1, open: 1, population_served: 2277 } });
    expect(String(events[0].description)).toContain("does not yet show a return to compliance");
    expect(allText(events)).not.toMatch(/PLACEHOLDER|placeholder@|555-0100/);
  });

  it("reports a water system again only for a new violation or a new return to compliance", async () => {
    const task = only(homeSafetyConnector, SILVERDALE);
    const first = await homeSafetyConnector.collect(task, context(replay(), SILVERDALE));
    await publish("silverdale-wa", "2026-10-12", task.source_id, [first.events[0].source_event_id]);
    const again = await homeSafetyConnector.collect(task, context(replay(), SILVERDALE));
    expect(again.result.skipped_unusable).toMatchObject({ already_published: 1 });
    expect(again.events.map((event) => event.title)).toEqual(["Drinking water: health-based violation recorded for Lakeside Park"]);

    const published = publishedViolationKeys(new Set(["WA5305345:3439032", "WA1:7~2026-10-01"]));
    expect([...published]).toEqual(["3439032", "7~2026-10-01"]);
    const row = (violation_id: string, rtc_date: string | null) => ({ pwsid: "WA1", violation_id, rtc_date });
    expect(staleReason(row("3439032", null), published, "2026-10-12")).toBe("already_published");
    expect(staleReason(row("3439032", "2026-06-01"), published, "2026-10-12")).toBeNull();
    expect(staleReason(row("7", "2026-10-01"), published, "2026-10-12")).toBe("already_published");
    expect(staleReason(row("8", "2026-06-01"), published, "2026-10-12")).toBe("returned_before_window");
    expect(staleReason(row("9", "2026-10-14"), published, "2026-10-12")).toBeNull();
    expect(staleReason(row("10", null), published, "2026-10-12")).toBeNull();
  });

  it("finds nothing relevant for a town with no affected systems within 50 km", async () => {
    const spokane: LocationProfile = { id: "spokane-wa", name: "Spokane, WA", state: "WA", latitude: 47.6588, longitude: -117.426, systems: [] };
    const { result, events } = await homeSafetyConnector.collect(only(homeSafetyConnector, spokane), context(replay(), spokane));
    expect(result.status).toBe("ingested");
    expect(events).toEqual([]);
  });
});

describe("housing", () => {
  const released = (day: string) => ({ "Last-Modified": new Date(`${day}T15:00:00Z`).toUTCString() });
  const replay = (release = "2026-10-14") => new ReplayTransport()
    .on(/we2609c\.txt$/, { status: 404, body: "" })
    .on(/we2608c\.txt$/, { file: "housing/we2608c.txt", headers: released(release) })
    .on(/we2608y\.txt$/, { file: "housing/we2608y.txt" })
    .on(/we2508y\.txt$/, { file: "housing/we2508y.txt" });

  it("matches the Census place by state and place code, never by name", () => {
    const text = fixture("housing/we2608c.txt").toString("utf8");
    expect(parsePlace(text, "53", "57535")).toMatchObject({ name: "Redmond", units: 10, single: 10 });
    expect(parsePlace(text, "41", "61200")).toMatchObject({ name: "Redmond", units: 12 });
    expect(parsePlace(fixture("housing/we2608y.txt").toString("utf8"), "53", "57535")).toMatchObject({ units: 637, multi: 598 });
  });

  it("reports the latest month and the year-to-date change for the location's own place", async () => {
    const transport = replay();
    const { result, events } = await housingConnector.collect(only(housingConnector, REDMOND), context(transport, REDMOND));
    expect(result.status).toBe("ingested");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: "New home permits in Redmond are up 9% this year", kind: "housing_market", tier: "local", event_date: "2026-08-31",
      source_url: "https://www2.census.gov/econ/bps/Place/West%20Region/we2608c.txt", signals: { units: 10, ytd_units: 637, change_pct: 9 } });
    expect(String(events[0].description)).toContain("compared with 584 by the same point in 2025");
    expect(housingConnector.sources({ ...REDMOND, census_geoid: null })).toEqual([]);
  });

  it("runs a month's figures once: only when released in this period and not already published", async () => {
    const task = only(housingConnector, REDMOND);
    const old = await housingConnector.collect(task, context(replay("2026-09-24"), REDMOND));
    expect(old.events).toEqual([]);
    expect(old.result.skipped_unusable).toMatchObject({ released_before_window: 1 });
    await publish("redmond-wa", "2026-10-15", task.source_id, ["bps:5357535:202608"]);
    const repeat = await housingConnector.collect(task, context(replay("2026-10-16"), REDMOND));
    expect(repeat.events).toEqual([]);
    expect(repeat.result.skipped_unusable).toMatchObject({ already_published: 1 });
  });
});

describe("development", () => {
  const TODAY_DEV = "2026-10-21";
  const replay = () => new ReplayTransport()
    .on(/^https:\/\/api\.us\.socrata\.com\/api\/catalog\/v1\?q=permits&only=dataset&domains=data\.seattle\.gov&/, { file: "development/catalog.json" })
    .on(/^https:\/\/data\.seattle\.gov\/resource\/76t5-zqzr\.json\?/, { file: "development/permits.json" });

  it("keeps new construction, demolition and multi-unit permits within the radius, without contractors or single-family addresses", async () => {
    const transport = replay();
    expect(portalDomain(SEATTLE)).toBe("data.seattle.gov");
    const { result, events } = await developmentConnector.collect(only(developmentConnector, SEATTLE), context(transport, SEATTLE, { today: TODAY_DEV }));
    expect(result.status).toBe("ingested");
    const query = decodeURIComponent(transport.requests.find((request) => request.url.includes("/resource/"))!.url).replaceAll("+", " ");
    expect(query).toContain("within_circle(location1, 47.6062, -122.3321, 15000) AND issueddate >= '2026-10-14'");
    expect(query).not.toContain("contractor");
    expect(events.map((event) => event.source_event_id)).toEqual(["76t5-zqzr:7046346-CN", "76t5-zqzr:7118487-CN", "76t5-zqzr:7118769-CN", "76t5-zqzr:7149057-DM"]);
    expect(result.skipped_unusable).toMatchObject({ minor_permit: 2, outside_area: 1 });
    expect(result.skipped_outside_window).toBe(1);
    expect(events[0]).toMatchObject({ title: "Permit issued for 241 new homes at 2929 27TH AVE S", kind: "development", tier: "local", signals: { units: 241 } });
    expect(String(events[0].source_url)).toMatch(/^https:\/\/services\.seattle\.gov\//);
    const house = events.find((event) => event.source_event_id === "76t5-zqzr:7118769-CN")!;
    expect(house.title).toBe("Permit issued for new construction");
    expect(String(house.description)).toContain("exact address is withheld");
    expect(allText(events)).not.toMatch(/3045 4TH AVE W|PLACEHOLDER CONTRACTOR/);
    expect(events.find((event) => event.source_event_id.endsWith("-DM"))!.title).toBe("Permit issued for a demolition at 13225 1ST AVE NW");
  });

  it("starts at the last published edition and drops permits it already ran", async () => {
    const task = only(developmentConnector, SEATTLE);
    await publish("seattle-wa", "2026-10-17", task.source_id, ["76t5-zqzr:7149057-DM"]);
    await publish("seattle-wa", "2026-10-17", task.source_id, ["76t5-zqzr:7118769-CN"], { disposition: "held" });
    const transport = replay();
    const { result, events } = await developmentConnector.collect(task, context(transport, SEATTLE, { today: TODAY_DEV }));
    const query = decodeURIComponent(transport.requests.find((request) => request.url.includes("/resource/"))!.url).replaceAll("+", " ");
    expect(query).toContain("issueddate >= '2026-10-17'");
    expect(events.map((event) => event.source_event_id)).toEqual(["76t5-zqzr:7118769-CN"]);
    expect(result.skipped_unusable).toMatchObject({ already_published: 1 });
    expect(result.skipped_outside_window).toBe(3);
  });

  it("reports no_feed when the portal has no mappable permits dataset", async () => {
    const transport = new ReplayTransport().on(/api\.us\.socrata\.com/, { body: { results: [] } });
    expect((await developmentConnector.collect(only(developmentConnector, SEATTLE), context(transport, SEATTLE))).result.status).toBe("no_feed");
  });
});

describe("athletics", () => {
  const item = (title: string, day: string, summary = "") => `<item><title>${title}</title><link>https://www.wiaa.com/news/${encodeURIComponent(title)}</link><guid>${encodeURIComponent(title)}</guid><pubDate>${day}</pubDate><description>${summary}</description></item>`;
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>WIAA</title>${[
    item("Redmond girls soccer advances to state semifinals", "Sat, 17 Oct 2026 18:00:00 GMT", "Jane Placeholder scored twice for the Mustangs."),
    item("Bellevue football wins KingCo league title", "Fri, 16 Oct 2026 18:00:00 GMT"),
    item("Redmond senior named Athlete of the Week", "Fri, 16 Oct 2026 18:00:00 GMT"),
    item("Spokane volleyball sweeps league opener", "Fri, 16 Oct 2026 18:00:00 GMT"),
    item("Redmond basketball wins season opener", "Tue, 01 Sep 2026 18:00:00 GMT"),
    item("2026-27 Tickets - Welcome", "Thu, 15 Oct 2026 18:00:00 GMT"),
  ].join("")}</channel></rss>`;

  it("keeps team headlines naming the town or a nearby place, and never republishes summaries", async () => {
    const transport = new ReplayTransport().on("https://www.wiaa.com/feed/", { body: feed });
    const { result, events } = await athleticsConnector.collect(only(athleticsConnector, REDMOND), context(transport, REDMOND));
    expect(result.status).toBe("ingested");
    expect(events.map((event) => [event.title, event.tier, event.section])).toEqual([
      ["Redmond girls soccer advances to state semifinals", "local", "Soccer"],
      ["Bellevue football wins KingCo league title", "nearby", "Football"],
    ]);
    expect(result.skipped_unusable).toMatchObject({ individual_student: 1, outside_area: 1, administrative: 1 });
    expect(result.skipped_outside_window).toBe(1);
    expect(events[0]).toMatchObject({ kind: "school_sports", description: "Washington Interscholastic Activities Association (WIAA) published this update on Saturday, October 17, 2026." });
    expect(allText(events)).not.toContain("Placeholder");
  });

  it("never repeats a headline an earlier published edition ran", async () => {
    const task = only(athleticsConnector, REDMOND);
    const first = await athleticsConnector.collect(task, context(new ReplayTransport().on("https://www.wiaa.com/feed/", { body: feed }), REDMOND));
    await publish("redmond-wa", "2026-10-12", task.source_id, [first.events[0].source_event_id]);
    const { result, events } = await athleticsConnector.collect(task, context(new ReplayTransport().on("https://www.wiaa.com/feed/", { body: feed }), REDMOND));
    expect(events.map((event) => event.title)).toEqual(["Bellevue football wins KingCo league title"]);
    expect(result.skipped_unusable).toMatchObject({ already_published: 1 });
  });

  it("drops individual-student and administrative headlines", () => {
    expect(headlineProblem("Smith signs letter of intent to play baseball")).toBe("individual_student");
    expect(headlineProblem("Tennis player of the week")).toBe("individual_student");
    expect(headlineProblem("2026-27 Football Handbook")).toBe("administrative");
    expect(headlineProblem("City council approves budget")).toBe("not_sports");
    expect(headlineProblem("Eastlake softball wins district championship")).toBeNull();
  });

  it("reads the recorded WIAA feed without errors and reports no_feed for unreviewed states", async () => {
    const transport = new ReplayTransport().on("https://www.wiaa.com/feed/", { file: "athletics/wiaa-feed.xml" });
    expect((await athleticsConnector.collect(only(athleticsConnector, REDMOND), context(transport, REDMOND))).result.status).toBe("ingested");
    const bend: LocationProfile = { id: "bend-or", name: "Bend, OR", state: "OR", systems: [] };
    expect((await athleticsConnector.collect(only(athleticsConnector, bend), context(new ReplayTransport(), bend))).result.status).toBe("no_feed");
  });
});
