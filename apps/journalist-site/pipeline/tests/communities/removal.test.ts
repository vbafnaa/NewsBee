import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { removeLocation } from "../../communities/removal";
import { getLocation, listLocations, LocationBusy } from "../../communities/locations";
import { LocalArtifacts } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";
import { ACTIVE_RUN_STATUSES } from "../../orchestration/runs";
import { acquireWorker, releaseWorker } from "../../orchestration/jobs";
import { writeReaderDirectory } from "../../orchestration/publish";
import { reassemble, recollectSource, setOverride } from "../../orchestration/inspect";
import { retryFailedStep } from "../../orchestration/retry-step";
import { startRun, resumeRun, triggerStage } from "../../orchestration/orchestrator";
import { loadSettings } from "../../core/config";
import { FakeModel } from "../support/fake-model";
import { usageSummary } from "../../analytics/usage";

let server: MongoMemoryServer, client: MongoClient, db: Db, root: string, store: LocalArtifacts;
const reader = "fixture-reader-root";
const pipeline = "fixture-pipeline-root";
const locationId = "fixture-town-wa";
const otherId = "other-town-wa";
const collection = (name: string) => db.collection<{ _id: string; [key: string]: unknown }>(name);
const scoped = [COLLECTIONS.manualLinks, COLLECTIONS.linkCache, COLLECTIONS.sourceResults, COLLECTIONS.shortlists,
  COLLECTIONS.storyCache, COLLECTIONS.withdrawals, COLLECTIONS.videoPackages, "source_map", "discovery_state", "collected_items", "story_decisions", "story_reviews",
  COLLECTIONS.youtubeLocationSettings, "edition_maps", "news_publishers", "source_suggestions", "photo_catalog_sources", "photo_catalog_cache", "photo_supply_invites", "photo_supply_submissions", "edition_photo_claims"];
const retained = [COLLECTIONS.places, COLLECTIONS.libraryOutlets, COLLECTIONS.directorySetup, COLLECTIONS.wideCache,
  COLLECTIONS.publishedStories, COLLECTIONS.modelUsage, "reader_interest_signups", "reader_engagement",
  "neighbour_stories", "remembrance_notices", "reader_reports", "story_details", "story_text"];
const artifactFolder = (kind: string, id = locationId) => `${pipeline}/.newsbee-pipeline/${kind}/${id}`;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("isolated-location-removal");
});
beforeEach(async () => {
  vi.stubEnv("NEWSBEE_READER_DRIVE_FOLDER_ID", reader);
  vi.stubEnv("NEWSBEE_PIPELINE_DRIVE_FOLDER_ID", pipeline);
  await db.dropDatabase();
  const parent = path.resolve(".local");
  await mkdir(parent, { recursive: true });
  root = await mkdtemp(path.join(parent, "removal-test-"));
  store = new LocalArtifacts(root);
  for (const id of [locationId, otherId]) {
    await collection(COLLECTIONS.locations).insertOne({ _id: id, id, name: id, state: "WA", systems: [] });
    await collection(COLLECTIONS.editions).insertOne({ _id: `${id}-edition`, id: `${id}-edition`, location_id: id, status: "published" });
    await collection(COLLECTIONS.runs).insertOne({ _id: `${id}-run`, location_id: id, edition_id: `${id}-edition`, status: "published", published: { artifacts: { arbitrary: "shared-folder-do-not-delete" } } });
    await collection(COLLECTIONS.jobs).insertOne({ _id: `${id}-job`, location_id: id, run_id: `${id}-run`, status: "completed", log_file: `${reader}/locations.json` });
    await collection(COLLECTIONS.editionEntries).insertOne({ _id: `${id}-entry`, edition_id: `${id}-edition` });
    for (const name of scoped) await collection(name).insertOne({ _id: id, location_id: id });
    await store.saveJson(reader, `${id}-edition.json`, { id: `${id}-edition`, location_id: id });
    await store.saveJson(artifactFolder("editions", id), `${id}-edition.json`, { location_id: id });
    await store.saveText(artifactFolder("email-previews", id), `${id}-edition.html`, "preview");
    await store.saveText(artifactFolder("email-previews", id), `${id}-edition.txt`, "preview");
    await store.saveJson(artifactFolder("sources", id), `${id}-run.json`, { run_id: `${id}-run` });
    await store.saveText(artifactFolder("logs", `${id}-run`), `${id}-job.jsonl`, "log");
    await collection(COLLECTIONS.videoJobs).insertOne({ _id: `${id}-video`, location_id: id, story_id: `${id}-story`, status: "complete" });
    const videoFolder = await store.ensureFolder(artifactFolder("video-production", id), `${id}-story`);
    await store.saveBinary(videoFolder, `${id}-video.mp4`, new Uint8Array([1, 2, 3]), "video/mp4");
  }
  for (const name of retained) await collection(name).insertOne({ _id: "retained", location_id: locationId });
  await store.saveText(artifactFolder("editions"), "untracked.txt", "keep");
  await store.saveText(reader, "shared.txt", "keep");
  await writeReaderDirectory(db, store);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => { await client?.close(); await server?.stop(); });

it("removes only the chosen location's records and owned video, preserving shared folders, config and reader data", async () => {
  const result = await removeLocation(db, store, locationId);
  expect(result.removed_files).toBe(7);
  expect(result.removed.edition_entries).toBe(1);
  expect(result.removed.video_packages).toBe(1);
  expect(result.removed.video_jobs).toBe(1);
  expect(result.removed.youtube_location_settings).toBe(1);
  expect(await collection(COLLECTIONS.locations).findOne({ _id: locationId })).toBeNull();
  for (const name of [...scoped, COLLECTIONS.runs, COLLECTIONS.jobs, COLLECTIONS.editions]) {
    expect(await collection(name).countDocuments({ location_id: locationId })).toBe(0);
    expect(await collection(name).countDocuments({ location_id: otherId })).toBe(1);
  }
  expect(await collection(COLLECTIONS.editionEntries).findOne({ _id: `${otherId}-entry` })).not.toBeNull();
  for (const name of retained) expect(await collection(name).countDocuments()).toBe(1);
  expect(await store.readJson(`${reader}/locations.json`)).toMatchObject({ locations: [{ id: otherId }] });
  expect(await store.list(reader)).toEqual(expect.arrayContaining([{ id: `${reader}/${otherId}-edition.json`, name: `${otherId}-edition.json` }, { id: `${reader}/shared.txt`, name: "shared.txt" }]));
  expect(await store.list(artifactFolder("editions"))).toEqual([{ id: `${artifactFolder("editions")}/untracked.txt`, name: "untracked.txt" }]);
  expect(await store.findFolder(`${pipeline}/.newsbee-pipeline/email-previews`, locationId)).toBe(artifactFolder("email-previews"));
  expect(await store.readText(`${artifactFolder("logs", `${otherId}-run`)}/${otherId}-job.jsonl`)).toBe("log");
  expect(await store.list(`${artifactFolder("video-production", otherId)}/${otherId}-story`)).toHaveLength(1);
});

it("keeps historical map counts and saved geography after removing a location workspace", async () => {
  const at = new Date("2026-10-02T12:00:00Z");
  await collection(COLLECTIONS.places).insertOne({ _id: locationId, name: "Fixture Town", state: "WA", latitude: 47.6, longitude: -122.3 });
  await collection("reader_engagement").updateOne({ _id: "retained" }, { $set: { action: "view", at } });
  await collection("reader_interest_signups").updateOne({ _id: "retained" }, {
    $set: { subscription_signup_at: at, interest_signup_at: at, legacy_signup: false },
  });
  const before = await usageSummary(db);
  expect(before.totals).toEqual({ reads: 1, subscriptions: 1, interest: 1 });
  await removeLocation(db, store, locationId);
  const after = await usageSummary(db);
  expect(after.totals).toEqual(before.totals);
  expect(after.history).toEqual(before.history);
  expect(after.rows).toEqual([{
    id: locationId, name: "Fixture Town, WA", latitude: 47.6, longitude: -122.3,
    onboarded: false, reads: 1, subscriptions: 1, interest: 1,
  }]);
});

it.each(ACTIVE_RUN_STATUSES)("refuses active %s runs without changing files or records", async (status) => {
  await collection(COLLECTIONS.runs).updateOne({ _id: `${locationId}-run` }, { $set: { status } });
  await expect(removeLocation(db, store, locationId)).rejects.toBeInstanceOf(LocationBusy);
  expect((await collection(COLLECTIONS.locations).findOne({ _id: locationId }))?.removal).toBeUndefined();
  expect(await store.readJson(`${reader}/${locationId}-edition.json`)).toMatchObject({ location_id: locationId });
});

it("refuses a still-executing job after cancellation, and a live worker lease", async () => {
  await collection(COLLECTIONS.runs).updateOne({ _id: `${locationId}-run` }, { $set: { status: "cancelled" } });
  await collection(COLLECTIONS.jobs).updateOne({ _id: `${locationId}-job` }, { $set: { status: "running" } });
  await expect(removeLocation(db, store, locationId)).rejects.toThrow("running job");
  await collection(COLLECTIONS.jobs).updateOne({ _id: `${locationId}-job` }, { $set: { status: "cancelled" } });
  const token = await acquireWorker(db);
  await expect(removeLocation(db, store, locationId)).rejects.toThrow("worker or cleanup");
  await releaseWorker(db, token!);
  await expect(removeLocation(db, store, locationId)).resolves.toMatchObject({ removed_files: 7 });
});

it("refuses to remove a location while a video generation is active", async () => {
  await collection(COLLECTIONS.videoJobs).updateOne({ _id: `${locationId}-video` }, { $set: { status: "processing" } });
  await expect(removeLocation(db, store, locationId)).rejects.toThrow("active video generation");
  expect((await collection(COLLECTIONS.locations).findOne({ _id: locationId }))?.removal).toBeUndefined();
  expect(await store.list(`${artifactFolder("video-production", locationId)}/${locationId}-story`)).toHaveLength(1);
});

it("surfaces partial file cleanup, retains its manifest, blocks new work and retries idempotently", async () => {
  const original = store.removeFile.bind(store);
  const remove = vi.spyOn(store, "removeFile").mockImplementation(async (parent, name) => {
    if (name.endsWith(".html")) throw new Error("fixture permission denied");
    return original(parent, name);
  });
  await expect(removeLocation(db, store, locationId)).rejects.toThrow("Removal incomplete while removing generated files: fixture permission denied");
  expect(await store.readJson(`${reader}/locations.json`)).toMatchObject({ locations: [{ id: otherId }] });
  expect((await collection(COLLECTIONS.locations).findOne({ _id: locationId }))?.removal).toMatchObject({ plan: { editionIds: [`${locationId}-edition`] }, error: expect.stringContaining("retry removal") });
  await expect(getLocation(db, locationId)).rejects.toBeInstanceOf(LocationBusy);
  const deps = { db, store, settings: loadSettings(), model: new FakeModel(() => { throw new Error("No model calls are allowed in cleanup tests"); }) };
  await expect(startRun(deps, locationId, { by: "fixture", kind: "manual" })).rejects.toBeInstanceOf(LocationBusy);
  await expect(resumeRun(deps, `${locationId}-run`, "fixture")).rejects.toBeInstanceOf(LocationBusy);
  await expect(triggerStage(deps, `${locationId}-run`, "authoring", "fixture")).rejects.toBeInstanceOf(LocationBusy);
  await expect(reassemble(db, `${locationId}-run`, "fixture")).rejects.toBeInstanceOf(LocationBusy);
  await expect(recollectSource(db, `${locationId}-run`, "source", "fixture")).rejects.toBeInstanceOf(LocationBusy);
  await expect(setOverride(db, `${locationId}-run`, "include", "item")).rejects.toBeInstanceOf(LocationBusy);
  await expect(retryFailedStep(db, `${locationId}-run`, `${locationId}-job`, "fixture")).rejects.toBeInstanceOf(LocationBusy);
  expect(await listLocations(db)).toEqual(expect.arrayContaining([expect.objectContaining({ id: locationId, removal_pending: true })]));
  expect(await getLocation(db, locationId, true)).not.toHaveProperty("removal");
  remove.mockRestore();
  const retry = vi.spyOn(store, "removeFile");
  await expect(removeLocation(db, store, locationId)).resolves.toMatchObject({ removed_files: 5 });
  expect(retry).toHaveBeenCalledTimes(5);
});

it.each([1, 2])("never reports success when reader-directory write %s fails, and keeps cleanup retryable", async (failedWrite) => {
  const original = store.saveJson.bind(store);
  let writes = 0;
  const save = vi.spyOn(store, "saveJson").mockImplementation(async (parent, name, value) => {
    if (name === "locations.json" && ++writes === failedWrite) throw new Error("directory write failed");
    return original(parent, name, value);
  });
  await expect(removeLocation(db, store, locationId)).rejects.toThrow("Removal incomplete");
  expect(await collection(COLLECTIONS.locations).findOne({ _id: locationId })).not.toBeNull();
  if (failedWrite === 1) expect(await store.readJson(`${reader}/${locationId}-edition.json`)).toMatchObject({ location_id: locationId });
  save.mockRestore();
  await expect(removeLocation(db, store, locationId)).resolves.toBeDefined();
  expect(await store.readJson(`${reader}/locations.json`)).toMatchObject({ locations: [{ id: otherId }] });
});

it("retains the plan when database cleanup fails after files have been removed", async () => {
  const entries = db.collection(COLLECTIONS.sourceResults);
  const remove = vi.spyOn(Object.getPrototypeOf(entries), "deleteMany").mockImplementationOnce(async () => { throw new Error("fixture database unavailable"); });
  await expect(removeLocation(db, store, locationId)).rejects.toThrow("removing location pipeline records");
  remove.mockRestore();
  await expect(removeLocation(db, store, locationId)).resolves.toMatchObject({ removed_files: 0 });
});

it("refuses traversal, directory-name editions, conflicting ownership and changed storage configuration", async () => {
  await collection(COLLECTIONS.editions).updateOne({ _id: `${locationId}-edition` }, { $set: { id: "../shared" } });
  await expect(removeLocation(db, store, locationId)).rejects.toThrow("Unsafe artifact path");
  await collection(COLLECTIONS.editions).updateOne({ _id: `${locationId}-edition` }, { $set: { id: "locations" } });
  await expect(removeLocation(db, store, locationId)).rejects.toThrow("shared locations.json");
  await collection(COLLECTIONS.editions).updateOne({ _id: `${locationId}-edition` }, { $set: { id: `${otherId}-edition` } });
  await expect(removeLocation(db, store, locationId)).rejects.toThrow("ownership is ambiguous");
  expect(await store.readJson(`${reader}/${otherId}-edition.json`)).toMatchObject({ location_id: otherId });
  await collection(COLLECTIONS.editions).updateOne({ _id: `${locationId}-edition` }, { $set: { id: `${locationId}-edition` } });
  const remove = vi.spyOn(store, "removeFile").mockRejectedValue(new Error("pause for retry"));
  await expect(removeLocation(db, store, locationId)).rejects.toThrow("pause for retry");
  remove.mockRestore();
  vi.stubEnv("NEWSBEE_READER_DRIVE_FOLDER_ID", "different-reader-root");
  await expect(removeLocation(db, store, locationId)).rejects.toThrow("configuration changed");
});

it("does not delete an edition file whose content belongs to another location", async () => {
  await store.saveJson(reader, `${locationId}-edition.json`, { location_id: otherId });
  await expect(removeLocation(db, store, locationId)).rejects.toThrow("Reader file ownership does not match");
  expect(await store.readJson(`${reader}/${locationId}-edition.json`)).toMatchObject({ location_id: otherId });
});

it("cleans up the resolved Reader channel instead of the environment fallback", async () => {
  const channelRoot = "channel-reader-root";
  await collection(COLLECTIONS.outputChannels).insertOne({
    _id: "reader-site", enabled: true, drive_folder_id: channelRoot,
  });
  for (const id of [locationId, otherId]) {
    await store.saveJson(channelRoot, `${id}-edition.json`, { id: `${id}-edition`, location_id: id });
  }
  await writeReaderDirectory(db, store);
  await removeLocation(db, store, locationId);
  expect(await store.list(channelRoot)).not.toContainEqual({
    id: `${channelRoot}/${locationId}-edition.json`, name: `${locationId}-edition.json`,
  });
  expect(await store.readJson(`${channelRoot}/locations.json`)).toMatchObject({ locations: [{ id: otherId }] });
  expect(await store.readJson(`${reader}/${locationId}-edition.json`)).toMatchObject({ location_id: locationId });
});

it("local cleanup refuses directories, path traversal and junctions outside the artifact tree", async () => {
  await expect(store.removeFile(reader, "..")).rejects.toThrow("Unsafe artifact path");
  await store.ensureFolder(reader, "folder.json");
  await expect(store.removeFile(reader, "folder.json")).rejects.toThrow("non-regular artifact path");
  await symlink(path.join(root, reader), path.join(root, "linked-reader"), "junction");
  await expect(store.removeFile("linked-reader", "shared.txt")).rejects.toThrow("non-regular artifact path");
  expect(await store.readText(`${reader}/shared.txt`)).toBe("keep");
});
