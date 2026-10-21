import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../../core/config";
import { logger } from "../../core/log";
import { Fetcher } from "../../connectors/fetcher";
import { libraryConnector, findFeed, candidatePages } from "../../connectors/library";
import { MongoLinkCache } from "../../storage/link-cache";
import { withMongo } from "../support/mongo";
import { ReplayTransport } from "../support/replay";
import { FakeModel } from "../support/fake-model";
import type { ConnectorContext, LocationProfile } from "../../connectors/types";
import { parseIcal, parseJsonLd, parseTrumba } from "../../connectors/library/parsers";
import { findSlug, parse as parseBiblio } from "../../connectors/library/bibliocommons";

const mongo = withMongo();
const HOMEPAGE = "https://library.example/";
const CALENDAR = "https://library.example/event-calendar";
const FEED = "https://www.trumba.com/calendars/example.rss?weeks=1";
const system = { fscskey: "WA0001", name: "Example Library", website: HOMEPAGE, branches: [{ name: "Capitol Hill Branch", address: "425 Harvard Ave E" }] };
const profile: LocationProfile = { id: "seattle-wa", name: "Seattle, WA", state: "WA", systems: [system] };
const settings = loadSettings({ ...process.env, NEWSBEE_ROOT: process.cwd() });
const context = (replay: ReplayTransport, model?: FakeModel): ConnectorContext => ({
  location: profile, today: "2026-10-31", window: ["2026-11-01", "2026-11-07"], transport: replay.transport,
  fetcher: new Fetcher(replay.transport), settings, db: mongo.db, linkCache: new MongoLinkCache(mongo.db), model,
  log: logger("test"),
});
const homepage = `<a href="/event-calendar">Calendar</a><a href="/events">Events</a><a href="/about">About</a>`;
const jsonld = (title: string, id: string) => `<script type="application/ld+json">${JSON.stringify({ "@type": "Event", "@id": id, name: title, startDate: "2026-11-04T15:00:00-07:00", url: `https://library.example/${id}`, location: { "@type": "Place", name: "Capitol Hill Branch" } })}</script>`;
const ruleReplay = () => new ReplayTransport()
  .on(HOMEPAGE, { file: "library/discovery_homepage.html" })
  .on(CALENDAR, { file: "library/trumba_calendar.html" })
  .on(FEED, { file: "library/library_events.xml" });

it("finds supported feed formats in Python precedence order and bounds candidate pages", () => {
  expect(findFeed('<script>Trumba.addSpud({webName: "cal"});</script><link type="text/calendar" href="/x.ics">', HOMEPAGE)?.kind).toBe("trumba_rss");
  expect(findFeed('<link type="text/calendar" href="/x.ics">', HOMEPAGE)).toMatchObject({ kind: "ical", url: "https://library.example/x.ics" });
  expect(candidatePages('<a href="/about">About</a><a href="/whats-on">Calendar</a><a href="/events">Events</a><a href="http://library.example/old">Old</a><a href="https://elsewhere.example/events">Other</a>', HOMEPAGE)).toEqual(["https://library.example/events", "https://library.example/whats-on"]);
});

it("collects, window-filters and branch-matches RSS events; reports hash and link cache", async () => {
  const replay = ruleReplay();
  const [task] = libraryConnector.sources(profile, settings);
  const result = await libraryConnector.collect(task, context(replay));
  expect(result.result).toMatchObject({ source_id: "library:WA0001", status: "ingested", feed_kind: "trumba_rss", feed_url: FEED,
    event_count: 1, skipped_other_venues: 1, unmatched_venues: { "Central Library": 1 }, pages_checked: [HOMEPAGE, CALENDAR], link_discovery: { method: "rules" } });
  expect(result.result.response_sha256).toBe(createHash("sha256").update((await import("node:fs")).readFileSync("pipeline/tests/fixtures/library/library_events.xml")).digest("hex"));
  expect(result.events[0]).toMatchObject({ title: "Example neighborhood workshop", branch: "Capitol Hill Branch", room: "Meeting Room" });
  const second = await libraryConnector.collect(task, context(new ReplayTransport().on(FEED, { file: "library/library_events.xml" })));
  expect(second.result.link_discovery?.method).toBe("cache");
  expect(second.events).toHaveLength(1);
});

it("marks systems without websites unresolved and creates one task per library system", async () => {
  const location = { ...profile, systems: [system, { ...system, fscskey: "WA0002", website: null }] };
  expect(libraryConnector.sources(location, settings)).toHaveLength(2);
  const [, task] = libraryConnector.sources(location, settings);
  const result = await libraryConnector.collect(task, { ...context(new ReplayTransport()), location });
  expect(result.result.status).toBe("unresolved_website");
  expect(result.events).toEqual([]);
});

it("uses AI-picked page only when it is a real homepage link and finds more events", async () => {
  const page = `<a href="/event-calendar">Calendar</a><a href="/events">Events</a>`;
  const replay = new ReplayTransport().on(HOMEPAGE, { body: page })
    .on(CALENDAR, { body: '<script>Trumba.addSpud({webName:"example"});</script>' })
    .on(FEED, { file: "library/library_events.xml" })
    .on("https://library.example/events", { body: jsonld("AI event one", "ai-1") + jsonld("AI event two", "ai-2") });
  const model = new FakeModel(({ prompt }) => ({ urls: prompt.includes("https://library.example/events") ? ["https://library.example/events", "https://invented.example/events"] : [] }));
  const [task] = libraryConnector.sources(profile, settings);
  const result = await libraryConnector.collect(task, context(replay, model));
  expect(result.result.link_discovery?.method).toBe("ai");
  expect(result.events.map((item) => item.title)).toEqual(["AI event one", "AI event two"]);
  expect(replay.requests.some((request) => request.url === "https://invented.example/events")).toBe(false);
});

it("invalidates a cache that yields no local events and rediscovers in the same call", async () => {
  const replay = new ReplayTransport().on("https://library.example/empty.rss", { body: "<rss><channel><item><title>Empty</title><guid>empty</guid><category>2026/11/03 (Tue)</category><description>No branch</description></item></channel></rss>" })
    .on(HOMEPAGE, { body: '<a href="/event-calendar">Calendar</a>' })
    .on(CALENDAR, { body: '<script>Trumba.addSpud({webName:"example"});</script>' })
    .on(FEED, { file: "library/library_events.xml" });
  const [task] = libraryConnector.sources(profile, settings);
  await mongo.db.collection("connector_link_cache").insertOne({ location_id: profile.id, source_id: task.source_id, kind: "trumba_rss", url: "https://library.example/empty.rss", page: CALENDAR, method: "rules", discovered_at: "now" });
  const result = await libraryConnector.collect(task, context(replay));
  expect(result.result.link_discovery?.method).toBe("rules");
  expect(result.events).toHaveLength(1);
  expect(replay.requests.filter((request) => request.url === FEED)).toHaveLength(1);
  expect(replay.requests.filter((request) => request.url === "https://library.example/empty.rss")).toHaveLength(1);
});

it("parsers enforce malformed-input and unsafe-feed rules", () => {
  expect(() => parseTrumba(new TextEncoder().encode('<!DOCTYPE rss [<!ENTITY x "bad">]><rss/>'))).toThrow(/DTD|NUL/);
  expect(() => parseIcal(new TextEncoder().encode("<html></html>"))).toThrow(/not an HTML/);
  expect(() => parseJsonLd(new TextEncoder().encode('<script type="application/ld+json">{}'))).toThrow(/no schema.org Event/);
  const parsed = parseIcal(new TextEncoder().encode("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:one\r\nSUMMARY:Story time\r\nDTSTART;TZID=America/Chicago:20261103T100000\r\nLOCATION:Capitol Hill Branch\\nRoom B\r\nURL:https://library.example/event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"));
  expect(parsed.events[0]).toMatchObject({ event_date: "2026-11-03", room: "Room B" });
});

it("skips cancelled library events in every supported feed format", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const vevent = (uid: string, summary: string, extra = "") => `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\n${extra}DTSTART:20261103T100000\r\nLOCATION:Main Branch\r\nURL:https://library.example/${uid}\r\nEND:VEVENT\r\n`;
  const ical = parseIcal(encode(`BEGIN:VCALENDAR\r\n${vevent("ok", "Story time")}${vevent("status", "Book club", "STATUS:CANCELLED\r\n")}${vevent("title", "CANCELLED: Lego Club")}${vevent("us", "Canceled - Teen Art")}END:VCALENDAR\r\n`));
  expect(ical.events.map((event) => event.source_event_id)).toEqual(["ok"]);
  expect(ical.skipped).toEqual({ cancelled: 3 });

  const ld = (name: string, extra = "") => `{"@type":"Event","name":"${name}","url":"https://library.example/${encodeURIComponent(name)}","startDate":"2026-11-03T10:00","location":"Main Branch"${extra}}`;
  const jsonLd = parseJsonLd(encode(`<script type="application/ld+json">[${ld("Story time")},${ld("Book club", ',"eventStatus":"https://schema.org/EventCancelled"')},${ld("Cancelled Craft Hour")}]</script>`));
  expect(jsonLd.events.map((event) => event.title)).toEqual(["Story time"]);
  expect(jsonLd.skipped).toEqual({ cancelled: 2 });

  const item = (id: string, title: string) => `<item><title>${title}</title><guid>${id}</guid><link>https://library.example/${id}</link><category>2026/11/03 (Tue)</category><description>Tue, Nov 3, 10am&lt;br/&gt;Location Link: Main Branch&lt;br/&gt;</description></item>`;
  const trumba = parseTrumba(encode(`<rss><channel>${item("ok", "Story time")}${item("gone", "CANCELLED - Book club")}</channel></rss>`));
  expect(trumba.events.map((event) => event.source_event_id)).toEqual(["ok"]);
  expect(trumba.skipped).toEqual({ cancelled: 1 });
  expect(parseTrumba(encode(`<rss><channel>${item("gone", "Cancelled: Book club")}</channel></rss>`)).events).toEqual([]);

  const biblio = parseBiblio(encode(JSON.stringify({ events: { results: ["x"], pagination: { count: 1 } },
    entities: { events: { x: { definition: { title: "CANCELED: Lego Club", start: "2026-11-03T10:30", branchLocationId: "1" } } } } })), "kcls", { "1": "Main Branch" });
  expect(biblio).toEqual({ events: [], skipped: { cancelled: 1 } });
});







it("parses BiblioCommons slugs and approved event fields", () => {
  expect(findSlug('<a href="https://kcls.bibliocommons.com/v2/events">events</a>')).toBe("kcls");
  expect(findSlug('"gateway.bibliocommons.com\\/v2\\/libraries\\/krl"')).toBe("krl");
  expect(findSlug("//one.bibliocommons.com //two.bibliocommons.com")).toBeNull();
  const body = new TextEncoder().encode(JSON.stringify({
    events: { results: ["ok", "cancelled", "remote", "allday"], pagination: { count: 4 } },
    entities: { events: {
      ok: { definition: { title: "  Lego   Club ", start: "2026-11-03T10:30", end: "2026-11-03T11:15", branchLocationId: "1" }, description: "PRIVATE" },
      cancelled: { definition: { title: "Cancelled", isCancelled: true } },
      remote: { definition: { title: "Remote", start: "2026-11-03T12:00", branchLocationId: "2" } },
      allday: { definition: { title: "All day", start: "2026-11-03", branchLocationId: "1" } },
    } },
  }));
  const parsed = parseBiblio(body, "kcls", { "1": "Lake Example, 1 Example Way" });
  expect(parsed.events[0]).toMatchObject({ source_event_id: "ok", title: "Lego Club", event_date: "2026-11-03", venue: "Lake Example, 1 Example Way", source_url: "https://kcls.bibliocommons.com/events/ok" });
  expect(parsed.skipped).toEqual({ cancelled: 1, no_venue: 1, unsupported_time: 1 });
  expect(JSON.stringify(parsed.events)).not.toContain("PRIVATE");
});
it("discovers and collects confirmed BiblioCommons events at matched branches", async () => {
  const gateway = "https://gateway.bibliocommons.com/v2/libraries/exco";
  const replay = new ReplayTransport().on(HOMEPAGE, { body: '<a href="https://exco.bibliocommons.com/v2/search">Catalog</a>' })
    .on(`${gateway}/events/search?limit=1`, { file: "library/biblio_probe.json" })
    .on(`${gateway}/locations?limit=100`, { file: "library/biblio_locations.json" })
    .on(`${gateway}/events/search?startDate=2026-11-01&endDate=2026-11-07&locations=1&limit=100&page=1`, { file: "library/biblio_events.json" });
  const library = { ...system, branches: [{ name: "Lake Example", address: "1 Example Way" }] };
  const location = { ...profile, systems: [library] };
  const [task] = libraryConnector.sources(location, settings);
  const result = await libraryConnector.collect(task, { ...context(replay), location });
  expect(result.result).toMatchObject({ status: "ingested", feed_kind: "bibliocommons", detail: "bibliocommons feed (1 of 1 locations in town)", event_count: 1 });
  expect(result.events[0]).toMatchObject({ title: "Lego Club", branch: "Lake Example", source_url: "https://exco.bibliocommons.com/events/ev1" });
});
it("collects an iCalendar link through the rule-only connector path", async () => {
  const replay = new ReplayTransport().on(HOMEPAGE, { body: '<a href="/events.ics">Subscribe</a>' })
    .on("https://library.example/events.ics", { file: "library/one_event.ics" });
  const [task] = libraryConnector.sources(profile, settings);
  const result = await libraryConnector.collect(task, context(replay));
  expect(result.result).toMatchObject({ status: "ingested", feed_kind: "ical", feed_url: "https://library.example/events.ics", event_count: 1 });
  expect(result.events[0]).toMatchObject({ title: "Library class", event_date: "2026-11-03", branch: "Capitol Hill Branch" });
});
