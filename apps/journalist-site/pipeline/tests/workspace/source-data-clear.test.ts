import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { clearSourceData, exportReviews, sourceClearPreview } from "../../sourcemap/source-data-clear";
import { cancelLeftoverJobs } from "../../orchestration/dispatch";
import { COLLECTIONS } from "../../storage/mongo";

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("isolated-source-data-clear");
});
afterAll(async () => { await client?.close(); await server?.stop(); });

const health = { runs: 2, last_run_at: 1, last_status: "ingested", last_detail: null, items_found: 3, items_local: 2, items_published: 1, consecutive_failures: 0, empty_runs: 0, last_new_item_day: null };
beforeEach(async () => {
  await db.dropDatabase();
  await db.collection(COLLECTIONS.locations).insertMany([{ _id: "here" as never, id: "here", name: "Here, WA" }, { _id: "there" as never, id: "there", name: "There, WA" }]);
  for (const location of ["here", "there"]) {
    await db.collection("source_map").insertMany([
      { _id: `${location}:found` as never, location_id: location, source_id: "found", status: "pinned", found_by: { method: "dork" }, review: { decision: "accept" }, health, window: { back: { days: 30 } } },
      { _id: `${location}:mine` as never, location_id: location, source_id: "mine", status: "dormant", found_by: { method: "editor" }, health },
    ]);
    await db.collection("discovery_state").insertOne({ _id: `${location}:osm` as never, location_id: location });
    await db.collection(COLLECTIONS.linkCache).insertOne({ location_id: location, source_id: "meetings" });
    await db.collection("source_health").insertOne({ _id: `${location}:found` as never, location_id: location });
    await db.collection("discovered_sources").insertOne({ _id: `${location}:newsrooms` as never, scope: location });
  }
  await db.collection("editions").insertOne({ id: "kept", location_id: "here" });
});

it("counts each category per location", async () => {
  const preview = await sourceClearPreview(db);
  const here = preview.locations.find((row) => row.id === "here")!;
  expect(here).toMatchObject({ discovered: 1, editor_added: 1, reviews: 1, settings: 1, discovery_history: 1, cached_discovery: 1, saved_addresses: 1 });
  expect(preview.totals.discovered).toBe(2);
});

it("clears only the chosen categories for the chosen location", async () => {
  const record = await clearSourceData(db, { location_id: "here", data_types: ["discovered", "reviews"] }, "owner@example.test");
  expect(record.deleted).toMatchObject({ discovered: 1, reviews: 1, editor_added: 0, settings: 0 });
  expect(await db.collection("source_map").countDocuments({ location_id: "here" })).toBe(1);
  expect(await db.collection("source_map").findOne({ _id: "here:mine" as never })).toMatchObject({ status: "dormant", found_by: { method: "editor" } });
  expect(await db.collection("source_map").countDocuments({ location_id: "there" })).toBe(2);
  expect(await db.collection("discovery_state").countDocuments()).toBe(2);
  expect(await db.collection(COLLECTIONS.linkCache).countDocuments()).toBe(2);
  expect(await db.collection("editions").countDocuments()).toBe(1);
  expect((await sourceClearPreview(db)).recent[0]).toMatchObject({ by: "owner@example.test", status: "completed", data_types: ["discovered", "reviews"] });
});

it("resets settings and health without deleting the sources", async () => {
  await clearSourceData(db, { location_id: "here", data_types: ["settings", "source_health"] }, "owner");
  const rows = await db.collection("source_map").find({ location_id: "here" }).toArray();
  expect(rows).toHaveLength(2);
  for (const row of rows) { expect(row.status).toBe("active"); expect(row.window).toBeUndefined(); expect(row.health.runs).toBe(0); }
  expect(await db.collection("source_health").countDocuments({ location_id: "here" })).toBe(0);
});

it("refuses an empty choice, an unknown location and a location with an open run", async () => {
  await expect(clearSourceData(db, { location_id: "here", data_types: [] }, "owner")).rejects.toThrow(/select/);
  await expect(clearSourceData(db, { location_id: "nowhere", data_types: ["discovered"] }, "owner")).rejects.toThrow(/Unknown location/);
  await db.collection(COLLECTIONS.runs).insertOne({ _id: "open" as never, location_id: "here", status: "collecting" });
  await expect(clearSourceData(db, { location_id: "here", data_types: ["discovered"] }, "owner")).rejects.toThrow(/run is open/);
  expect(await db.collection("source_map").countDocuments({ location_id: "here" })).toBe(2);
});

it("exports reviews before they're cleared", async () => {
  const copy = await exportReviews(db, "here");
  expect(copy.sources).toHaveLength(1);
  expect(copy.sources[0]).toMatchObject({ source_id: "found", review: { decision: "accept" } });
});

it("cancels jobs left waiting by a run that has ended, and only those", async () => {
  await db.collection(COLLECTIONS.runs).insertMany([{ _id: "ended" as never, location_id: "here", status: "published" }, { _id: "live" as never, location_id: "there", status: "collecting" }]);
  await db.collection(COLLECTIONS.jobs).insertMany([{ _id: "a" as never, run_id: "ended", status: "pending" }, { _id: "b" as never, run_id: "live", status: "pending" }]);
  expect(await cancelLeftoverJobs(db)).toBe(1);
  expect(await db.collection(COLLECTIONS.jobs).findOne({ _id: "a" as never })).toMatchObject({ status: "cancelled" });
  expect(await db.collection(COLLECTIONS.jobs).findOne({ _id: "b" as never })).toMatchObject({ status: "pending" });
});

it("clears the source-run data the new pipeline keeps: page decisions, Gemini verdicts and test-mode stores", async () => {
  await db.collection("source_map").updateOne({ _id: "here:found" as never }, { $set: { gemini: { verdict: "accept" }, review_flags: { strength: "strong" } } });
  await db.collection("page_decisions").insertMany([{ _id: "here:a" as never, location_id: "here", key: "a" }, { _id: "there:a" as never, location_id: "there", key: "a" }]);
  await db.collection(COLLECTIONS.runs).insertOne({ _id: "test-run" as never, location_id: "here", kind: "map", isolated: true, status: "mapped" });
  await db.collection("source_run_test-run").insertMany([{ _id: "here:x" as never }, { _id: "here:y" as never }]);
  const here = (await sourceClearPreview(db)).locations.find((row) => row.id === "here")!;
  expect(here).toMatchObject({ page_decisions: 1, gemini_checks: 1, test_runs: 2 });
  const record = await clearSourceData(db, { location_id: "here", data_types: ["page_decisions", "gemini_checks", "test_runs"] }, "owner");
  expect(record.deleted).toMatchObject({ page_decisions: 1, gemini_checks: 1, test_runs: 2, discovered: 0 });
  expect(await db.collection("page_decisions").countDocuments()).toBe(1);
  expect(await db.collection("source_map").findOne({ _id: "here:found" as never })).not.toHaveProperty("gemini");
  expect((await db.listCollections({ name: "source_run_test-run" }).toArray())).toHaveLength(0);
  expect(await db.collection("source_map").countDocuments({ location_id: "here" })).toBe(2);
});
