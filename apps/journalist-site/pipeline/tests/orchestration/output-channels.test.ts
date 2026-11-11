import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readerData } from "../../../../reader-site/src/lib/reader-data";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { ArtifactStore } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";
import { channelArtifactStore, driveChannelFolderOrMongo } from "../../storage/mongo-channel-artifacts";
import { mongoChannelFolderId } from "../../../../../shared/reader-folder";
import { videoStoriesForLocation } from "../../video-production";
import {
  createOutputChannel,
  createOutputChannelEdition,
  clearOutputChannelEditions,
  clearOutputChannelFeed,
  listOutputChannelEditions,
  listOutputChannels,
  outputChannels,
  publishToOutputChannels,
  removeLocationFromOutputChannels,
  syncOutputChannelLocations,
} from "../../orchestration/output-channels";

const LOCATION = "town-wa";
let server: MongoMemoryServer, client: MongoClient, db: Db;
let saved: Array<{ folder: string; name: string; value: unknown }>;
let removed: Array<{ folder: string; name: string }>;
const store: ArtifactStore = {
  kind: "local", ensureFolder: async () => "folder", saveText: async () => "file",
  saveJson: async (folder: string, name: string, value: unknown) => { saved.push({ folder, name, value }); return name; },
  readText: async () => "", readJson: async <T>() => ({} as T), list: async () => [], findFolder: async () => null,
  removeFile: async (folder: string, name: string) => { removed.push({ folder, name }); return 1; },
};

beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("output-channels"); });
beforeEach(async () => {
  await db.dropDatabase(); saved = []; removed = [];
  await db.collection(COLLECTIONS.locations).insertOne({ _id: LOCATION, id: LOCATION, name: "Town, WA", state: "WA", systems: [] } as never);
});
afterAll(async () => { await client?.close(); await server?.stop(); });

describe("journalist output channels", () => {
  it("uses every story from the latest published location edition for a channel edition", async () => {
    await db.collection(COLLECTIONS.editions).insertMany([
      { id: "old", location_id: LOCATION, status: "published", published_at: 1,
        published: { items: [{ story_id: "old-story", headline: "Old story" }] } },
      { id: "latest", location_id: LOCATION, status: "published", published_at: 2,
        published: { items: [{ story_id: "story-1", headline: "First" }, { story_id: "story-2", headline: "Second" }] } },
    ]);
    const { stories } = await videoStoriesForLocation(db, LOCATION, 1);
    expect(stories.map(({ storyId }) => storyId)).toEqual(["story-1", "story-2"]);
  });

  it("defaults to a writable Drive folder, but falls back on missing authorization or Drive errors", async () => {
    const id = "b".repeat(32);
    const createFolder = vi.fn(async () => "drive-folder-123");
    const failed = vi.fn();
    const drive: ArtifactStore = { ...store, kind: "drive" };
    expect(await driveChannelFolderOrMongo(drive, id, true, createFolder, failed)).toBe("drive-folder-123");
    expect(saved).toMatchObject([{ folder: "drive-folder-123", name: "locations.json" }]);
    expect(await driveChannelFolderOrMongo(drive, id, false, createFolder, failed)).toBe(`mongo:${id}`);
    expect(createFolder).toHaveBeenCalledTimes(1);
    createFolder.mockRejectedValueOnce(new Error("Drive unavailable"));
    expect(await driveChannelFolderOrMongo(drive, id, true, createFolder, failed)).toBe(`mongo:${id}`);
    expect(failed).toHaveBeenCalledTimes(1);
    const unwritable: ArtifactStore = { ...drive, saveJson: async () => { throw new Error("Service account cannot write"); } };
    expect(await driveChannelFolderOrMongo(unwritable, id, true, createFolder, failed)).toBe(`mongo:${id}`);
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it("persists MongoDB fallback feeds without calling Drive and cleans them up", async () => {
    const id = "a".repeat(32);
    const folder = mongoChannelFolderId(id);
    const drive: ArtifactStore = { ...store, kind: "drive", saveJson: async () => { throw new Error("Drive must not be used"); } };
    const channel = await createOutputChannel(db, "journalist-1", id, folder, {
      name: "Fallback", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: [LOCATION],
    });
    await syncOutputChannelLocations(db, drive, "journalist-1", id, [LOCATION], async () => ({ id: "edition-1", location_id: LOCATION }));
    const files = channelArtifactStore(db, drive, folder);
    expect(channel.driveFolderId).toBe(folder);
    expect((await files.list(folder)).map((file) => file.name).sort()).toEqual(["edition-1.json", "locations.json"]);
    expect(await files.readJson(`${folder}/edition-1.json`)).toMatchObject({ id: "edition-1" });
    await files.saveJson(folder, "edition-1.json", {
      id: "edition-1", location_id: LOCATION, location_name: "Town, WA", window_start: "2026-11-01",
      window_end: "2026-11-08", published_at: 1, headline: "Local", intro: "Intro", items: [],
    });
    vi.stubEnv("MONGODB_URI", server.getUri());
    vi.stubEnv("MONGODB_DATABASE", "output-channels");
    vi.stubEnv("NEWSBEE_MODE", "cloud");
    try {
      expect(await readerData(folder)).toMatchObject({ locations: [{ id: LOCATION }], editions: [{ id: "edition-1" }] });
    } finally {
      vi.unstubAllEnvs();
    }
    await db.collection(COLLECTIONS.editions).insertOne({ id: "edition-1", location_id: LOCATION });
    await clearOutputChannelFeed(db, drive, (await outputChannels(db).findOne({ _id: id }))!);
    expect(await files.list(folder)).toEqual([]);
  });

  it("keeps each journalist's settings private", async () => {
    await createOutputChannel(db, "journalist-1", "1".repeat(32), "folder-1", { name: "First", destinations: [{ type: "reader", url: "https://first.example" }], enabled: true, selectedLocationIds: [] });
    await createOutputChannel(db, "journalist-2", "2".repeat(32), "folder-2", { name: "Second", destinations: [{ type: "reader", url: "https://second.example" }], enabled: true, selectedLocationIds: [] });

    expect(await listOutputChannels(db, "journalist-1")).toMatchObject([{ name: "First", driveFolderId: "folder-1" }]);
    expect(await listOutputChannels(db, "journalist-2")).toMatchObject([{ name: "Second", driveFolderId: "folder-2" }]);
  });

  it("writes curated channel editions as reader-compatible per-location editions", async () => {
    const channel = await createOutputChannel(db, "journalist-1", "7".repeat(32), "channel-folder", {
      name: "Weekly digest", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: [LOCATION],
    });
    const document = await outputChannels(db).findOne({ _id: channel.id })!;
    const edition = await createOutputChannelEdition(db, store, document!, "journalist-1", "Town this week", [{
      location_id: LOCATION, location_name: "Town, WA", edition_id: "source-edition", story_id: "story-1",
      headline: "Local update", blurb: "A brief update", event_date: "2026-11-09", source_url: null,
    }], ["reader"], [], [{
      id: `${channel.id}-1`, location_id: LOCATION, location_name: "Town, WA",
      window_start: "2026-11-02", window_end: "2026-11-09", published_at: 1_800_000_000,
      headline: "Town this week", intro: "A curated edition prepared for Weekly digest.",
      items: [{ story_id: "story-1", headline: "Local update", blurb: "A brief update", when_where: "", event_date: "2026-11-09", source_url: null, rank: 1 }],
      coverage: [], corrections: [],
    }]);

    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({ name: "locations.json", value: { locations: [{ id: LOCATION }] } });
    expect(saved[0]).toMatchObject({
      folder: "channel-folder",
      name: `channel-edition-${edition._id}-1.json`,
      value: {
        id: edition.edition_ids[0],
        location_id: LOCATION,
        headline: "Town this week",
        items: [{ story_id: "story-1", source_url: null }],
      },
    });
    expect(await listOutputChannelEditions(db, "journalist-1", channel.id)).toMatchObject([
      { title: "Town this week", output_modes: ["reader"], edition_ids: [edition.edition_ids[0]] },
    ]);
    expect(await listOutputChannelEditions(db, "journalist-2", channel.id)).toEqual([]);
  });

  it("removes curated edition files when a channel loses Reader output", async () => {
    const channel = await createOutputChannel(db, "journalist-1", "8".repeat(32), "channel-folder", {
      name: "Weekly digest", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: [LOCATION],
    });
    const document = await outputChannels(db).findOne({ _id: channel.id });
    const edition = await createOutputChannelEdition(db, store, document!, "journalist-1", "Town this week", [], ["reader"], [], [{
      id: `${channel.id}-1`, location_id: LOCATION, location_name: "Town, WA",
      window_start: "2026-11-02", window_end: "2026-11-09", published_at: 1_800_000_000,
      headline: "Town this week", intro: "", items: [], coverage: [], corrections: [],
    }]);

    await clearOutputChannelEditions(db, store, document!);

    expect(removed).toContainEqual({ folder: "channel-folder", name: `channel-edition-${edition._id}-1.json` });
    expect(await listOutputChannelEditions(db, "journalist-1", channel.id)).toEqual([]);
  });

  it("supports video-only channel editions with selected stories for video generation", async () => {
    const channel = await createOutputChannel(db, "journalist-1", "9".repeat(32), "video-folder", {
      name: "Video desk", destinations: [{ type: "video", url: "" }], enabled: true, selectedLocationIds: [LOCATION],
    });
    const document = await outputChannels(db).findOne({ _id: channel.id });
    const edition = await createOutputChannelEdition(db, store, document!, "journalist-1", "Town videos", [{
      location_id: LOCATION, location_name: "Town, WA", edition_id: "source-edition", story_id: "story-1",
      headline: "Local update", blurb: "A brief update", event_date: "", source_url: null,
    }], ["video"], [{ location_id: LOCATION, story_id: "story-1" }], []);

    expect(saved).toEqual([]);
    expect(edition).toMatchObject({ output_modes: ["video"], edition_ids: [], video_stories: [{ location_id: LOCATION, story_id: "story-1" }] });
  });

  it("publishes only to enabled channels that selected the edition's location", async () => {
    await outputChannels(db).insertMany([
      { _id: "selected", owner_id: "one", name: "Selected", url: "https://selected.example", drive_folder_id: "selected-folder", enabled: true, selected_location_ids: [LOCATION], published_location_ids: [] },
      { _id: "other-location", owner_id: "one", name: "Other", url: "https://other.example", drive_folder_id: "other-folder", enabled: true, selected_location_ids: ["other-wa"], published_location_ids: [] },
      { _id: "paused", owner_id: "two", name: "Paused", url: "https://paused.example", drive_folder_id: "paused-folder", enabled: false, selected_location_ids: [LOCATION], published_location_ids: [] },
      { _id: "video-only", owner_id: "one", name: "Video only", destination: "video", url: "", drive_folder_id: "video-folder", enabled: true, selected_location_ids: [LOCATION], published_location_ids: [] },
    ]);

    await expect(publishToOutputChannels(db, store, { id: "edition-1", location_id: LOCATION, headline: "Local story" })).resolves.toEqual(["selected"]);
    expect(saved.map(({ folder, name }) => [folder, name])).toEqual([
      ["selected-folder", "edition-1.json"],
      ["selected-folder", "locations.json"],
    ]);
    expect(saved[1].value).toEqual({ locations: [{ id: LOCATION, name: "Town, WA", system_count: 0, branch_count: 0 }] });
  });

  it("copies the latest selected edition and removes deleted locations from channel feeds", async () => {
    const channel = await createOutputChannel(db, "journalist-1", "3".repeat(32), "channel-folder", {
      name: "Neighbourhoods", destinations: [{ type: "reader", url: "https://news.example" }], enabled: true, selectedLocationIds: [LOCATION],
    });
    await syncOutputChannelLocations(db, store, "journalist-1", channel.id, [LOCATION], async (id) => ({
      id: "edition-2", location_id: id, headline: "Latest",
    }));

    expect(saved.map(({ name }) => name)).toEqual(["edition-2.json", "locations.json"]);
    expect(await outputChannels(db).findOne({ _id: channel.id })).toMatchObject({ published_location_ids: [LOCATION] });
    await removeLocationFromOutputChannels(db, store, LOCATION);
    expect(await outputChannels(db).findOne({ _id: channel.id })).toMatchObject({ selected_location_ids: [], published_location_ids: [] });
    expect(saved.at(-1)?.value).toEqual({ locations: [] });
  });

  it("allows video channels without a website and does not write reader edition feeds to them", async () => {
    const channel = await createOutputChannel(db, "journalist-1", "4".repeat(32), "video-folder", {
      name: "Short videos", destinations: [{ type: "video", url: "" }], enabled: true, selectedLocationIds: [LOCATION],
    });

    await expect(publishToOutputChannels(db, store, { id: "edition-video", location_id: LOCATION })).resolves.toEqual([]);
    await expect(syncOutputChannelLocations(db, store, "journalist-1", channel.id, [LOCATION], async () => ({
      id: "edition-video", location_id: LOCATION,
    }))).resolves.toEqual([]);
    expect(saved).toEqual([]);
    expect(await listOutputChannels(db, "journalist-1")).toMatchObject([{ destinations: [{ type: "video", url: "" }] }]);
  });

  it("publishes editions to a reader destination on a multi-destination channel", async () => {
    await createOutputChannel(db, "journalist-1", "6".repeat(32), "mixed-folder", {
      name: "Reader and video", destinations: [{ type: "reader", url: "" }, { type: "video", url: "" }],
      enabled: true, selectedLocationIds: [LOCATION],
    });

    await expect(publishToOutputChannels(db, store, { id: "edition-mixed", location_id: LOCATION })).resolves.toEqual(["6".repeat(32)]);
    expect(saved.map(({ name }) => name)).toEqual(["edition-mixed.json", "locations.json"]);
  });

  it("removes a channel's old edition feed when reader delivery is removed", async () => {
    const channel = await createOutputChannel(db, "journalist-1", "5".repeat(32), "reader-folder", {
      name: "Community reader", destinations: [{ type: "reader", url: "" }, { type: "video", url: "" }],
      enabled: true, selectedLocationIds: [LOCATION],
    });
    await outputChannels(db).updateOne({ _id: channel.id }, { $set: { published_location_ids: [LOCATION] } });
    await db.collection(COLLECTIONS.editions).insertOne({ id: "old-edition", location_id: LOCATION });

    await clearOutputChannelFeed(db, store, await outputChannels(db).findOne({ _id: channel.id })!);

    expect(saved).toEqual([]);
    expect(removed).toEqual([["reader-folder", "old-edition.json"], ["reader-folder", "locations.json"]].map(([folder, name]) => ({ folder, name })));
    expect(await outputChannels(db).findOne({ _id: channel.id })).toMatchObject({ published_location_ids: [] });
  });
});
