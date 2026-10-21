import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addManualLink, collectManualLink, manualLinks, manualTask } from "../../connectors/manual-links";
import { connectorInventory } from "../../connectors/inventory";
import { Fetcher } from "../../connectors/fetcher";
import type { Connector, ConnectorContext, LocationProfile, SourceType } from "../../connectors/types";
import { loadSettings } from "../../core/config";
import { logger } from "../../core/log";
import { localToday } from "../../core/time";
import { addDays } from "../../connectors/common";
import { startRun, runOne } from "../../orchestration/orchestrator";
import { getRun } from "../../orchestration/runs";
import { LocalArtifacts } from "../../storage/artifacts";
import { MongoLinkCache } from "../../storage/link-cache";
import { COLLECTIONS } from "../../storage/mongo";
import { FakeModel } from "../support/fake-model";
import { fixture, ReplayTransport } from "../support/replay";
import { withMongo } from "../support/mongo";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34" }]) }));

const mongo = withMongo();
const location: LocationProfile = { id: "auburn-wa", name: "Auburn, WA", state: "WA", latitude: 47.3073, longitude: -122.2285,
  systems: [{ fscskey: "WA001", name: "Town Library", branches: [{ name: "Town Branch", address: "1 Main Street" }], website: "https://library.example/" }], government: null };
const url = "https://library.example/extra.ics";
const settings = loadSettings({ ...process.env, NEWSBEE_ROOT: process.cwd(), NEWSBEE_WIDER_SOURCES: "1" });
const input = { connector: "library", name: "Extra calendar", url, system_id: "WA001" };
const empty = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
function context(replay: ReplayTransport): ConnectorContext {
  const today = localToday("WA");
  return { db: mongo.db, settings, location, transport: replay.transport, fetcher: new Fetcher(replay.transport), today,
    window: [addDays(today, 1), addDays(today, 7)], linkCache: new MongoLinkCache(mongo.db), log: logger("manual-link-test") };
}
const calendar = () => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:extra-1\r\nSUMMARY:Robot Lab\r\nDTSTART;VALUE=DATE:${addDays(localToday("WA"), 1).replaceAll("-", "")}\r\nLOCATION:Town Branch\r\nURL:https://library.example/event\r\nDESCRIPTION:Build small robots.\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

describe("validated location links", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "newsbee-links-"));
    await mongo.db.collection<LocationProfile & { _id: string }>(COLLECTIONS.locations).insertOne({ _id: location.id, ...location });
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it("persists an empty but valid feed, exposes it in inventory and collects its later items in a real queued run", async () => {
    const replay = new ReplayTransport().on(url, { body: empty });
    const saved = await addManualLink(mongo.db, settings, location.id, input, replay.transport);
    expect(saved).toMatchObject({ validated_events: 0, feed_kind: "ical", location_id: location.id });
    await new MongoLinkCache(mongo.db).invalidate(location.id);
    expect(await manualLinks(mongo.db).countDocuments({})).toBe(1);
    const inventory = await connectorInventory(mongo.db, settings);
    expect(inventory.connectors.map(({ id }) => id)).toEqual(["library", "meetings", "hazards", "statenews", "trending", "civiccalendar", "homesafety", "housing", "development", "athletics"]);
    expect(inventory.sources.some(({ source_id }) => source_id === "library:WA001")).toBe(true);
    expect(inventory.sources.some(({ source_id }) => source_id === manualTask(saved).source_id)).toBe(true);

    replay.on(url, { body: calendar() });
    const none = (type: SourceType): Connector => ({ type, sources: () => [], collect: async () => { throw new Error("Only the retained manual link should run"); } });
    const deps = { db: mongo.db, settings, transport: replay.transport, store: new LocalArtifacts(dir), model: new FakeModel(() => ({})),
      connectors: { library: none("library"), meetings: none("meetings"), hazards: none("hazards"), statenews: none("statenews"), trending: none("trending"), civiccalendar: none("civiccalendar"), homesafety: none("homesafety"), housing: none("housing"), development: none("development"), athletics: none("athletics") } };
    const { run } = await startRun(deps, location.id, { by: "test", kind: "manual" });
    expect(run.sources.map(({ source_id }) => source_id)).toEqual([manualTask(saved).source_id]);
    expect(await runOne(deps)).toBe(true);
    expect((await getRun(mongo.db, run._id))?.sources[0]).toMatchObject({ status: "completed", event_count: 1, result_status: "ingested" });
    const other = { ...location, id: "other-wa", name: "Other, WA" };
    await mongo.db.collection<LocationProfile & { _id: string }>(COLLECTIONS.locations).insertOne({ _id: other.id, ...other });
    expect((await startRun(deps, other.id, { by: "test", kind: "manual" })).run.sources).toHaveLength(0);
  });

  it.each([
    ["unsupported format", { ...input, url: "https://library.example/not-events" }, "<html><body>About the library</body></html>"],
    ["incomplete calendar", input, "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"],
    ["unknown library", { ...input, system_id: "not-onboarded" }, empty],
    ["unknown connector", { ...input, connector: "new-connector" }, empty],
  ])("rejects %s before saving anything", async (_name, value, body) => {
    const replay = new ReplayTransport().on(value.url, { body });
    await expect(addManualLink(mongo.db, settings, location.id, value, replay.transport)).rejects.toThrow();
    expect(await manualLinks(mongo.db).countDocuments({})).toBe(0);
  });

  it("rejects private URLs and private redirect targets before fetching them", async () => {
    const replay = new ReplayTransport().on(url, { status: 302, headers: { location: "https://127.0.0.1/private" } });
    await expect(addManualLink(mongo.db, settings, location.id, input, replay.transport)).rejects.toThrow("non-public");
    await expect(addManualLink(mongo.db, settings, location.id, { ...input, url: "https://127.0.0.1/feed" }, replay.transport)).rejects.toThrow("non-public");
    expect(replay.requests.some((request) => request.url.includes("127.0.0.1"))).toBe(false);
    expect(await manualLinks(mongo.db).countDocuments({})).toBe(0);
  });

  it("does not save duplicates or drop a retained feed when subsequent queries fail", async () => {
    const replay = new ReplayTransport().on(url, { body: empty });
    const saved = await addManualLink(mongo.db, settings, location.id, input, replay.transport);
    await expect(addManualLink(mongo.db, settings, location.id, input, replay.transport)).rejects.toThrow("already saved");
    replay.on(url, { status: 503 });
    await expect(collectManualLink(saved, context(replay))).rejects.toThrow();
    expect(await manualLinks(mongo.db).findOne({ _id: saved._id })).not.toBeNull();
  });
  it("accepts a BiblioCommons gateway link by querying its supported API endpoints, not the gateway root", async () => {
    const gateway = "https://gateway.bibliocommons.com/v2/libraries/town";
    const replay = new ReplayTransport()
      .on(`${gateway}/locations?limit=100`, { body: { entities: { locations: { "1": { name: "Town Branch", address: { number: "1", street: "Main Street" } } } } } })
      .on(new RegExp(`${gateway}/events/search\\?`), { body: { events: { results: [], pagination: { count: 0, pages: 1 } }, entities: { events: {} } } });
    const saved = await addManualLink(mongo.db, settings, location.id, { ...input, url: gateway }, replay.transport);
    expect(saved).toMatchObject({ feed_kind: "bibliocommons", feed_url: gateway, validated_events: 0 });
    expect(replay.requests.some((request) => request.url === gateway)).toBe(false);
  });

  it.each([
    ["https://sample.legistar.com/", /https:\/\/webapi\.legistar\.com\/v1\/sample\/events\?/i, []],
    ["https://sample.portal.civicclerk.com/", /https:\/\/sample\.api\.civicclerk\.com\/v1\/Events\?/i, { value: [] }],
  ])("validates a meeting tenant without changing the primary government: %s", async (link, route, body) => {
    const replay = new ReplayTransport().on(route, { body });
    const saved = await addManualLink(mongo.db, settings, location.id, { connector: "meetings", name: "Council", url: link }, replay.transport);
    expect(saved).toMatchObject({ validated_events: 0, connector: "meetings", government: { tenant: "sample", status: "override" } });
    expect((await mongo.db.collection<LocationProfile & { _id: string }>(COLLECTIONS.locations).findOne({ _id: location.id }))?.government).toBeNull();
    expect((await collectManualLink(saved, context(replay))).result.status).toBe("ingested");
  });

  it("validates an RSS link only for its location without editing statewide configuration; rejects HTML", async () => {
    const stateData = JSON.parse(fixture("wider/config/state-sources.json").toString("utf8"));
    await mongo.db.collection<{ _id: string; data: unknown }>("source_configs").insertOne({ _id: "state-sources", data: stateData });
    const feed = "https://agency.example/local.xml";
    const replay = new ReplayTransport().on(feed, { body: "<rss><channel><title>Agency</title></channel></rss>" });
    const saved = await addManualLink(mongo.db, settings, location.id, { connector: "statenews", name: "Agency", url: feed }, replay.transport);
    expect(saved.validated_events).toBe(0);
    expect((await mongo.db.collection<{ _id: string; data: unknown }>("source_configs").findOne({ _id: "state-sources" }))?.data).toEqual(stateData);
    await expect(addManualLink(mongo.db, settings, location.id, { connector: "statenews", name: "Not a feed", url: feed + "?bad" },
      new ReplayTransport().on(feed + "?bad", { body: "<html><body>Error</body></html>" }).transport)).rejects.toThrow("not usable");
    expect(await manualLinks(mongo.db).countDocuments({})).toBe(1);
  });
});
