import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { ArtifactStore } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";
import { ACTIVE_RUN_STATUSES } from "../../orchestration/runs";
import { finishedEditions, PublishConflict, publishEdition, publishToReader } from "../../orchestration/publish";
import { outputChannels } from "../../orchestration/output-channels";
import { sourceMap } from "../../sourcemap/store";
import { runFunnel, stageDetail } from "../../trace/funnel";

const LOCATION = "town-wa";
let server: MongoMemoryServer, client: MongoClient, db: Db;
let saved: Array<{ folder: string; name: string; value: unknown }>;
const store: ArtifactStore = {
  kind: "local", ensureFolder: async () => "folder", saveText: async () => "file",
  saveJson: async (folder: string, name: string, value: unknown) => { saved.push({ folder, name, value }); return name; },
  readText: async () => "", readJson: async <T>() => ({} as T), list: async () => [], findFolder: async () => null, removeFile: async () => 0,
};

const item = (id: string) => ({ story_id: id, headline: `Story ${id}`, blurb: "Blurb", when_where: "Today", event_date: "2026-11-01", source_url: null, rank: 1, kind: "news", source_name: "Source", section: "News", section_id: "news", local: true, also_from: [] });
async function seedEdition(id: string, at: number, options: { count_history?: boolean } = {}) {
  const published = { id, location_id: LOCATION, location_name: "Town, WA", window_start: "2026-11-01", window_end: "2026-11-08", published_at: at, headline: `Edition ${id}`, intro: "Intro", items: [item(`${id}-a`)], coverage: [], corrections: [] };
  await db.collection(COLLECTIONS.editions).insertOne({ id, run_id: id, location_id: LOCATION, location_name: "Town, WA", today: "2026-11-08", window_start: "2026-11-01", window_end: "2026-11-08", status: "built", created_at: at, built_at: at, published_at: at, published, tokens: { [`${id}-a`]: ["town", "story"] }, source_counts: { "src-1": 1 }, summary: { held: 0 } });
  await db.collection("pipeline_runs").insertOne({ _id: id, kind: "edition", location_id: LOCATION, location_name: "Town, WA", status: "built", today: "2026-11-08", window: ["2026-11-01", "2026-11-08"], trigger: { by: "editor@example.test", kind: "manual" }, sources: [], created_at: at, completed_at: at, edition_id: id, options: { count_history: options.count_history ?? true }, published: { items: 1, held: 0 } } as never);
}

beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("publish-edition"); });
beforeEach(async () => {
  await db.dropDatabase(); saved = [];
  await db.collection(COLLECTIONS.locations).insertOne({ _id: LOCATION, id: LOCATION, name: "Town, WA", state: "WA", systems: [] } as never);
  await sourceMap(db).insertOne({ _id: `${LOCATION}:src-1`, location_id: LOCATION, source_id: "src-1", status: "active", health: { items_published: 0 } } as never);
});
afterAll(async () => { await client?.close(); await server?.stop(); });

describe("creating an edition and publishing it are separate steps", () => {
  it("leaves a built edition off the reader, out of the ledger, and frees the newsroom slot", async () => {
    await seedEdition("ed-1", 100);
    expect(ACTIVE_RUN_STATUSES).not.toContain("built");
    expect(saved).toEqual([]);
    expect(await db.collection(COLLECTIONS.publishedStories).countDocuments()).toBe(0);
    expect((await finishedEditions(db, LOCATION))[0]).toMatchObject({ id: "ed-1", status: "built", live: false, items: 1 });
  });

  it("publishes it on request: the reader file, the ledger and source counts, once", async () => {
    await seedEdition("ed-1", 100);
    const result = await publishEdition(db, store, LOCATION, "ed-1", "editor@example.test", "reader-folder");
    expect(result).toMatchObject({ edition_id: "ed-1", first: true, reader_folder: "reader-folder" });
    expect(saved.map((file) => file.name)).toEqual(["ed-1.json", "locations.json"]);
    expect(saved[0].value).toMatchObject({ id: "ed-1", published_at: result.published_at });
    expect(await db.collection(COLLECTIONS.editions).findOne({ id: "ed-1" })).toMatchObject({ status: "published", published_by: "editor@example.test" });
    expect(await db.collection("pipeline_runs").findOne({ _id: "ed-1" } as never)).toMatchObject({ status: "published", published: { by: "editor@example.test", reader_folder: "reader-folder" } });
    expect(await db.collection(COLLECTIONS.publishedStories).countDocuments()).toBe(1);
    expect((await sourceMap(db).findOne({ _id: `${LOCATION}:src-1` } as never))?.health).toEqual({ items_published: 1 });
    // Publishing again only makes it live again: no second ledger entry or source count.
    const again = await publishEdition(db, store, LOCATION, "ed-1", "owner@example.test", "reader-folder");
    expect(again.first).toBe(false);
    expect(await db.collection(COLLECTIONS.publishedStories).countDocuments()).toBe(1);
    expect((await sourceMap(db).findOne({ _id: `${LOCATION}:src-1` } as never))?.health).toEqual({ items_published: 1 });
  });

  it("publishes to the default reader without automatically publishing to journalist channels", async () => {
    await seedEdition("ed-1", 100);
    await outputChannels(db).insertOne({
      _id: "channel-1", owner_id: "journalist-1", name: "Neighbourhoods", url: "https://news.example",
      drive_folder_id: "channel-folder", enabled: true, selected_location_ids: [LOCATION], published_location_ids: [],
    });

    await db.collection<{ _id: string; enabled: boolean; drive_folder_id: string }>(COLLECTIONS.outputChannels)
      .insertOne({ _id: "reader-site", enabled: true, drive_folder_id: "reader-channel-folder" });
    const result = await publishEdition(db, store, LOCATION, "ed-1", "editor@example.test");

    expect(result.reader_folder).toBe("reader-channel-folder");
    expect(saved.map(({ folder, name }) => [folder, name])).toContainEqual(["reader-channel-folder", "ed-1.json"]);
    expect(saved.map(({ folder }) => folder)).not.toContain("channel-folder");
    expect(await outputChannels(db).findOne({ _id: "channel-1" })).toMatchObject({ published_location_ids: [] });
  });

  it("does not mark an edition published or count history when the Reader channel is disabled", async () => {
    await seedEdition("ed-1", 100);
    await db.collection<{ _id: string; enabled: boolean; drive_folder_id: string }>(COLLECTIONS.outputChannels)
      .insertOne({ _id: "reader-site", enabled: false, drive_folder_id: "reader-channel-folder" });
    await expect(publishEdition(db, store, LOCATION, "ed-1", "editor@example.test")).rejects.toThrow("disabled");
    expect(await db.collection(COLLECTIONS.editions).findOne({ id: "ed-1" })).toMatchObject({ status: "built" });
    expect(await db.collection(COLLECTIONS.publishedStories).countDocuments()).toBe(0);
    expect(saved).toEqual([]);
  });

  it("keeps image publication safeguards and illustration metadata in the resolved Reader folder", async () => {
    await db.collection<{ _id: string; enabled: boolean; drive_folder_id: string }>(COLLECTIONS.outputChannels)
      .insertOne({ _id: "reader-site", enabled: true, drive_folder_id: "reader-channel-folder" });
    const photo = { image: "https://photos.example/event.jpg", image_credit: "Fixture photographer" };
    const first = { ...item("first"), ...photo };
    const duplicate = item("duplicate");
    const conflicting = { ...item("conflicting"), kind: "event", blurb: "Meet at Georgetown Studios." };
    const illustration = { ...item("illustration"), illustration_id: "fixture-illustration", illustration_asset_id: "fixture-asset" };
    await expect(publishToReader(db, store, {
      id: "image-edition", location_id: LOCATION, items: [
        first,
        { ...duplicate, ...photo },
        { ...conflicting, ...photo, image_role: "venue", image_place: "Gum Wall" },
        illustration,
      ],
    })).resolves.toBe("reader-channel-folder");
    expect(saved.map(({ folder }) => folder)).toEqual(["reader-channel-folder", "reader-channel-folder"]);
    expect(saved[0].value).toMatchObject({ items: [first, duplicate, conflicting, illustration] });
    const payload = saved[0].value as { items: Array<Record<string, unknown>> };
    expect(payload.items[1]).not.toHaveProperty("image");
    expect(payload.items[2]).not.toHaveProperty("image");
  });

  it("makes whichever edition was published last the live one, including an older one", async () => {
    await seedEdition("ed-1", 100);
    await seedEdition("ed-2", 200);
    await publishEdition(db, store, LOCATION, "ed-1", "editor@example.test", "f");
    await publishEdition(db, store, LOCATION, "ed-2", "editor@example.test", "f");
    expect((await finishedEditions(db, LOCATION)).map((row) => [row.id, row.live])).toEqual([["ed-2", true], ["ed-1", false]]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await publishEdition(db, store, LOCATION, "ed-1", "editor@example.test", "f");
    expect((await finishedEditions(db, LOCATION)).map((row) => [row.id, row.live])).toEqual([["ed-2", false], ["ed-1", true]]);
  });

  it("keeps a run that left history alone out of the ledger, and refuses an unfinished edition", async () => {
    await seedEdition("ed-1", 100, { count_history: false });
    await publishEdition(db, store, LOCATION, "ed-1", "editor@example.test", "f");
    expect(await db.collection(COLLECTIONS.publishedStories).countDocuments()).toBe(0);
    await db.collection(COLLECTIONS.editions).insertOne({ id: "ed-3", run_id: "ed-3", location_id: LOCATION, status: "authoring", created_at: 300 });
    await expect(publishEdition(db, store, LOCATION, "ed-3", "editor@example.test", "f")).rejects.toBeInstanceOf(PublishConflict);
    await expect(publishEdition(db, store, "elsewhere-wa", "ed-1", "editor@example.test", "f")).rejects.toBeInstanceOf(PublishConflict);
  });
});

describe("videos are the last step of an edition's funnel", () => {
  it("counts the videos made from a published edition's stories, and lists them with their headlines", async () => {
    await seedEdition("ed-1", 100);
    let funnel = await runFunnel(db, LOCATION, "ed-1");
    expect(funnel?.stages.find((stage) => stage.id === "videos")).toMatchObject({ phase: "Share", count: 0, note: "Publish the edition to make videos" });
    await publishEdition(db, store, LOCATION, "ed-1", "owner@example.test", "f");
    await db.collection(COLLECTIONS.videoJobs).insertMany([
      { _id: "video-1", location_id: LOCATION, story_id: "ed-1-a", edition_id: "ed-1", status: "complete", prompt: "p", created_at: 110, updated_at: 111, drive_url: "https://drive.example.test/v1" },
      { _id: "video-2", location_id: LOCATION, story_id: "ed-1-a", edition_id: "ed-1", status: "processing", prompt: "p", created_at: 120, updated_at: 121 },
      { _id: "video-3", location_id: LOCATION, story_id: "other", edition_id: "ed-other", status: "complete", prompt: "p", created_at: 130, updated_at: 131 },
    ] as never);
    funnel = await runFunnel(db, LOCATION, "ed-1");
    expect(funnel?.stages.at(-1)).toMatchObject({ id: "videos", count: 1, note: "2 started" });
    const detail = await stageDetail(db, "ed-1", "videos");
    expect(detail?.rows.map((row) => [row.title, row.status, row.url])).toEqual([["Story ed-1-a", "processing", null], ["Story ed-1-a", "complete", "https://drive.example.test/v1"]]);
  });
});
