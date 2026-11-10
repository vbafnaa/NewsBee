import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import sheet from "../../../../../shared/source-sheet-inventory.json";
import { importSheetInventory, SHEET_CATALOG, type SheetEntry, type SheetInventory } from "../../sourcemap/sheet-import";
import { collectableSources, reviewedLocationSources, setSourceStatus, sourceMap, taskFor, upsertCandidates } from "../../sourcemap/store";
import { applyReviewedContentPolicy, reviewedSourceTransport } from "../../sourcemap/source-review";
import { sourceInventory } from "../../../lib/map-data";
import { libraryConnector } from "../../connectors/library";
import { Fetcher } from "../../connectors/fetcher";
import type { CollectedEvent, ConnectorContext, LocationProfile } from "../../connectors/types";
import type { HttpTransport } from "../../core/http";
import { loadSettings } from "../../core/config";
import { logger } from "../../core/log";
import { newRun, runs } from "../../orchestration/runs";
import { resumeRun, tick } from "../../orchestration/orchestrator";
import { CONNECTORS } from "../../connectors/registry";
import { FakeModel } from "../support/fake-model";
import type { ArtifactStore } from "../../storage/artifacts";
import { assemble, collectedItems } from "../../editions/assemble";
import { finishAuthoring } from "../../editions/authoring";

let server: MongoMemoryServer, client: MongoClient, db: Db;
const today = new Date().toISOString().slice(0, 10);
const feed = "https://www.trumba.com/calendars/kalendaro.rss";
const location: LocationProfile = { id: "fixture-wa", name: "Fixture, WA", state: "WA", systems: [{
  fscskey: "WA0064", name: "SPL", website: "https://www.spl.org", branches: [
    { name: "Ballard Branch Library", address: "Ballard" }, { name: "Beacon Hill Branch Library", address: "Beacon Hill" },
  ],
}] };
function entry(overrides: Partial<SheetEntry> = {}): SheetEntry {
  return { id: "one", number: 1, name: "Library", url: "https://www.spl.org/events", communities: ["fixture"],
    scope: "community", section: "events", checked_at: today, review_expires: "2099-12-31", decision: "approved_feed",
    reason: "Supported RSS; selected branch facts only", evidence: ["https://www.spl.org/policies", feed],
    collection: { source_id: "library:WA0064", reader: "library", params: { fscskey: "WA0064", reviewed_feed_url: feed,
      reviewed_branches: ["Ballard Branch Library"] }, allowed_urls: [feed] }, ...overrides };
}
function inventory(entries = [entry()]): SheetInventory {
  return { version: 1, spreadsheet_url: "https://docs.google.com/spreadsheets/d/fixture", spreadsheet_sha256: "fixture",
    communities: { fixture: { id: location.id, name: location.name } }, sources: entries };
}
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("source-review-tests"); });
beforeEach(async () => { await db.dropDatabase(); await db.collection<{ _id: string }>("locations").insertOne({ ...location, _id: location.id }); });
afterAll(async () => { await client?.close(); await server?.stop(); });

it("dry-runs without writes, imports every spreadsheet row, and deduplicates source/location records", async () => {
  const full = structuredClone(sheet) as SheetInventory;
  // Keep this historical review fixture runnable after its deliberately short approval expiry.
  full.sources.forEach((row) => { row.checked_at = today; row.review_expires = "2099-12-31"; });
  await db.collection<{ _id: string }>("locations").insertMany(Object.values(full.communities).map((value) => ({ _id: value.id })));
  expect(await importSheetInventory(db, full)).toMatchObject({ applied: false, catalog_entries: 125 });
  expect(await sourceMap(db).countDocuments()).toBe(0);
  expect(await db.collection(SHEET_CATALOG).countDocuments()).toBe(0);
  const result = await importSheetInventory(db, full, true);
  expect(result.enabled).toBe(14);
  expect(await db.collection(SHEET_CATALOG).countDocuments()).toBe(125);
  const count = await sourceMap(db).countDocuments();
  expect(count).toBe(result.added);
  expect(await importSheetInventory(db, full, true)).toMatchObject({ added: 0, updated: count });
  expect(await sourceMap(db).countDocuments()).toBe(count);
  for (const community of Object.values(full.communities)) {
    for (const source of await collectableSources(db, community.id, today)) expect(source.access_review?.collection_allowed).toBe(true);
  }
});

it("validates all communities and approval evidence before changing any source", async () => {
  const missing = inventory(); missing.communities.other = { id: "not-onboarded", name: "Missing" };
  await expect(importSheetInventory(db, missing, true)).rejects.toThrow(/every community/);
  await expect(importSheetInventory(db, inventory([entry({ evidence: [] })]), true)).rejects.toThrow(/approval evidence/);
  await expect(importSheetInventory(db, inventory([entry({ review_expires: "2000-01-01" })]), true)).rejects.toThrow(/approval evidence/);
  expect(await sourceMap(db).countDocuments()).toBe(0);
});

it("keeps permission holds after discovery or a direct status change and prevents activation", async () => {
  await importSheetInventory(db, inventory([entry({ decision: "permission_required" })]), true);
  const original = (await sourceMap(db).findOne({ location_id: location.id }))!;
  await expect(setSourceStatus(db, location.id, original.source_id, "pinned")).rejects.toThrow(/access review/);
  await upsertCandidates(db, location.id, [{ ...original, params: { url: "https://unreviewed.example/new" }, link_only: false }]);
  await sourceMap(db).updateOne({ _id: original._id }, { $set: { status: "active" } });
  expect(await collectableSources(db, location.id, today)).toEqual([]);
  expect(() => taskFor((original))).toThrow(/access review/);
});

it("preserves selected branches, editor notes and paused status on repeated imports and rediscovery", async () => {
  await importSheetInventory(db, inventory(), true);
  let original = (await sourceMap(db).findOne({ location_id: location.id }))!;
  await upsertCandidates(db, location.id, [{ ...original, params: { fscskey: "WA0064" } }]);
  original = (await sourceMap(db).findOne({ _id: original._id }))!;
  expect(taskFor(original).params).toMatchObject({ reviewed_feed_url: feed, reviewed_branches: ["Ballard Branch Library"], images_allowed: false });
  await setSourceStatus(db, location.id, original.source_id, "paused", "Editorial reason");
  await importSheetInventory(db, inventory(), true); await importSheetInventory(db, inventory(), true);
  const paused = (await sourceMap(db).findOne({ _id: original._id }))!;
  expect(paused.status).toBe("paused");
  expect(paused.note?.match(/Spreadsheet review/g)).toHaveLength(1);
  expect(paused.note?.startsWith("Editorial reason\n")).toBe(true);
  const view = await sourceInventory(db, location.id);
  expect(JSON.stringify(view)).not.toContain("collection_params");
  expect(JSON.stringify(await sourceInventory(db))).not.toContain("collection_params");
});

it.each(["canonical", "alias"])("rechecks reviews on previously queued %s tasks before any connector or HTTP call", async (kind) => {
  await importSheetInventory(db, inventory(), true);
  let record = (await sourceMap(db).findOne({ location_id: location.id }))!;
  if (kind === "alias") {
    await upsertCandidates(db, location.id, [{ ...record, source_id: "web:queued-alias", reader: "web", url: feed,
      params: { url: feed }, access_review: undefined, status: "active" }]);
    record = (await sourceMap(db).findOne({ source_id: "web:queued-alias" }))!;
  }
  const task = taskFor(record);
  const run = newRun(location, { kind: "manual", by: "test" }, today, [today, today], [task]);
  await runs(db).insertOne(run);
  if (kind === "canonical") await sourceMap(db).updateOne({ _id: record._id }, { $set: { "access_review.collection_allowed": false } });
  const collect = vi.fn(); const transport = vi.fn();
  const store = { kind: "local", ensureFolder: async (parent: string, name: string) => `${parent}/${name}`,
    saveText: async (_parent: string, name: string) => name } as ArtifactStore;
  const deps = { db, store, settings: loadSettings({ NEWSBEE_ROOT: process.cwd() }),
    model: new FakeModel(() => { throw new Error("No model calls"); }), transport,
    connectors: { ...CONNECTORS, library: { ...libraryConnector, collect }, web: { ...CONNECTORS.web, collect } } };
  await resumeRun(deps, run._id, "test"); await tick(deps, { budgetMs: 1000 });
  expect(collect).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
});

it("limits feed access, blocks expired reviews and strips photos without inventing a license", async () => {
  await importSheetInventory(db, inventory(), true);
  const review = (await sourceMap(db).findOne({ location_id: location.id }))!.access_review!;
  const transport = vi.fn<HttpTransport>(async ({ url }) => ({ url, status: 200, headers: {}, body: new Uint8Array() }));
  const guarded = reviewedSourceTransport(transport, review);
  await guarded({ url: feed }); await guarded({ url: "https://www.trumba.com/robots.txt" });
  await expect(guarded({ url: "https://www.spl.org/events/one" })).rejects.toThrow(/only the reviewed feed/);
  await expect(guarded({ url: `${feed}?all=true` })).rejects.toThrow(/only the reviewed feed/);
  await expect(reviewedSourceTransport(transport, { ...review, expires_on: "2000-01-01" })({ url: feed })).rejects.toThrow(/prevents collection/);
  expect(transport).toHaveBeenCalledTimes(2);
  const events = [{ details: { image: "https://example.com/person.jpg", image_credit: "Someone", cost: "Free" } }] as unknown as CollectedEvent[];
  applyReviewedContentPolicy(events, review);
  expect(events[0]).toMatchObject({ no_page_fetch: true, image_blocked: true, details: { cost: "Free" } });
  expect(events[0].details).not.toHaveProperty("image");
});

it("uses only the approved library feed and rejects unselected branch coverage", async () => {
  await importSheetInventory(db, inventory(), true);
  const record = (await sourceMap(db).findOne({ location_id: location.id }))!;
  const xml = `<rss><channel>${["Ballard", "Beacon Hill"].map((place) => `<item><title>${place} workshop</title><guid>${place}</guid><link>https://www.spl.org/event/${place.replaceAll(" ", "-")}</link><category>2026/11/02</category><description><![CDATA[Monday 2 pm<br/>Location Link: ${place} Branch<br/>Free workshop]]></description></item>`).join("")}</channel></rss>`;
  const requested: string[] = [];
  const raw: HttpTransport = async ({ url }) => { requested.push(url); return { url, status: 200, headers: { "content-type": url.endsWith("robots.txt") ? "text/plain" : "application/rss+xml" }, body: new TextEncoder().encode(url.endsWith("robots.txt") ? "User-agent: *\nAllow: /" : xml) }; };
  const transport = reviewedSourceTransport(raw, record.access_review);
  const context = { location, today: "2026-11-01", window: ["2026-11-01", "2026-11-08"], transport,
    fetcher: new Fetcher(transport, undefined, false), log: logger("test") } as ConnectorContext;
  const result = await libraryConnector.collect(taskFor(record), context);
  expect(result.events.map((event) => event.title)).toEqual(["Ballard workshop"]);
  expect(requested.every((url) => url === feed || url.endsWith("/robots.txt"))).toBe(true);
  const blocked = await libraryConnector.collect({ ...taskFor(record), params: { ...taskFor(record).params, reviewed_branches: ["Unselected Branch"] } }, context);
  expect(blocked.result.status).toBe("blocked");
});

it("holds discovered feed aliases without broadening a scoped library approval", async () => {
  await importSheetInventory(db, inventory(), true);
  const original = (await sourceMap(db).findOne({ location_id: location.id }))!;
  await upsertCandidates(db, location.id, [{ ...original, source_id: "web:feed-alias", reader: "web", url: feed,
    params: { url: feed }, access_review: undefined }, { ...original, source_id: "web:independent", reader: "web",
    url: "https://other.example/news", params: { url: "https://other.example/news" }, access_review: undefined }]);
  const allowed = await collectableSources(db, location.id, today);
  expect(allowed.map((source) => source.source_id).sort()).toEqual(["library:WA0064", "web:independent"]);
  const alias = (await sourceMap(db).findOne({ source_id: "web:feed-alias" }))!;
  expect(alias).toMatchObject({ status: "paused", access_review: { collection_allowed: false, inherited_from: original.source_id } });
  await expect(setSourceStatus(db, location.id, alias.source_id, "pinned")).rejects.toThrow(/access review/);
});

it("keeps an arrest dataset hold when discovery selects a native adapter on Seattle's mirror", async () => {
  await importSheetInventory(db, inventory([entry({ name: "Arrests", decision: "integration_required", url: "https://data.seattle.gov/Public-Safety/Arrests/9bjs-7a7w",
    collection: { source_id: "web:arrests", reader: "web", params: { url: "https://data.seattle.gov/Public-Safety/Arrests/9bjs-7a7w" }, allowed_urls: [] } })]), true);
  const original = (await sourceMap(db).findOne({ source_id: "web:arrests" }))!;
  await upsertCandidates(db, location.id, ["9bjs-7a7w", "kzjm-xkqj"].map((dataset) => ({ ...original,
    source_id: `opendata:cos-data.seattle.gov:${dataset}`, reader: "opendata" as const, url: `https://cos-data.seattle.gov/d/${dataset}`,
    params: { domain: "cos-data.seattle.gov", dataset, topic: "police" }, access_review: undefined, link_only: false, status: "active" as const })));
  const records = await reviewedLocationSources(db, location.id);
  expect(records.find((source) => source.source_id.endsWith(":9bjs-7a7w"))?.access_review?.collection_allowed).toBe(false);
  expect(records.find((source) => source.source_id.endsWith(":kzjm-xkqj"))?.access_review).toBeUndefined();
  expect((await collectableSources(db, location.id, today)).map((source) => source.source_id)).toEqual(["opendata:cos-data.seattle.gov:kzjm-xkqj"]);
});

it("excludes already collected aliases before locality, ranking or publication", async () => {
  await importSheetInventory(db, inventory([entry({ decision: "permission_required", url: "https://example.org/events",
    collection: { source_id: "web:original", reader: "web", params: { url: "https://example.org/events" }, allowed_urls: [] } })]), true);
  const original = (await sourceMap(db).findOne({ source_id: "web:original" }))!;
  await upsertCandidates(db, location.id, [{ ...original, source_id: "web:alias", reader: "web", url: "https://www.example.org/events/?feed=rss",
    params: { url: "https://www.example.org/events/?feed=rss" }, access_review: undefined, link_only: false, status: "active" }]);
  const facts: CollectedEvent = { source_event_id: "one", title: "Community workshop", event_date: today,
    schedule_text: "Today", venue: "Town Hall", source_url: "https://example.org/events/one", needs_locality: false };
  await collectedItems(db).insertOne({ _id: "held-input", run_id: "held-run", location_id: location.id, source_id: "web:alias", source_name: "Alias",
    created_at: Date.now() / 1000, title: facts.title, url: facts.source_url, event_date: today, status: "collected", reason: null, step: "reader", facts });
  const transport: HttpTransport = async ({ url }) => ({ url, status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode("{}") });
  await assemble({ db, settings: loadSettings({ NEWSBEE_ROOT: process.cwd() }), transport, fetcher: new Fetcher(transport, undefined, false),
    location, today, log: logger("test"), runId: "held-run" });
  expect(await collectedItems(db).findOne({ _id: "held-input" })).toMatchObject({ status: "dropped", step: "reader", reason: expect.stringContaining("Source access review") });
});

it("rechecks an alias hold at finish even when its story was validated before review", async () => {
  await importSheetInventory(db, inventory(), true);
  const original = (await sourceMap(db).findOne({ location_id: location.id }))!;
  await upsertCandidates(db, location.id, [{ ...original, source_id: "web:late-alias", reader: "web", url: feed,
    params: { url: feed }, access_review: undefined, status: "active" }]);
  const id = "late-review-draft";
  await db.collection("editions").insertOne({ id, location_id: location.id, status: "ready" });
  await db.collection("edition_entries").insertOne({ edition_id: id, story_id: "late-story", source_id: "web:late-alias",
    disposition: "checks_passed", section: "events", position: 1, result: { checks_passed: true,
      validation_errors: [], draft: { headline: "A valid headline", summary: "Source-supported wording." } } });
  const model = new FakeModel(() => { throw new Error("Held sources must not invoke a model or publish"); });
  await expect(finishAuthoring({ db, model, settings: loadSettings({ NEWSBEE_ROOT: process.cwd() }), log: logger("test") }, id))
    .rejects.toThrow(/Source access review prevents publication/);
  expect(model.calls).toHaveLength(0);
  expect(await db.collection("edition_entries").findOne({ story_id: "late-story" })).toMatchObject({ disposition: "held",
    result: { checks_passed: false, validation_errors: [expect.stringContaining("source_access_review:")],
      draft: { headline: "A valid headline", summary: "Source-supported wording." } } });
});
