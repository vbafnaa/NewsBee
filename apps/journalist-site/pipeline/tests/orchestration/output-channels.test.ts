import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readerData } from "../../../../reader-site/src/lib/reader-data";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { ArtifactStore } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";
import { channelArtifactStore, driveChannelFolderOrMongo } from "../../storage/mongo-channel-artifacts";
import { mongoChannelFolderId } from "../../../../../shared/reader-folder";
import { videoStoriesForLocation } from "../../video-production";
import { ensurePublicationGovernance, PublicationLifecycleConflict } from "../../publications/lifecycle";
import { enterPublicationSupport } from "../../publications/support";
import * as publicationAudit from "../../publications/audit";
import { PublicationAccessDenied } from "../../publications/permissions";
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
  resolveOutputChannel,
  resolveOutputChannelForPrincipal,
  syncOutputChannelLocations,
  updateOutputChannel,
} from "../../orchestration/output-channels";

const LOCATION = "town-wa";
const REMOVAL_ACTOR = { id: "workspace-admin", email: "workspace-admin@example.test", role: "admin" as const };
let server: MongoMemoryReplSet, client: MongoClient, db: Db;
let saved: Array<{ folder: string; name: string; value: unknown }>;
let removed: Array<{ folder: string; name: string }>;
const store: ArtifactStore = {
  kind: "local", ensureFolder: async () => "folder", saveText: async () => "file",
  saveJson: async (folder: string, name: string, value: unknown) => { saved.push({ folder, name, value }); return name; },
  readText: async () => "", readJson: async <T>() => ({} as T), list: async () => [], findFolder: async () => null,
  removeFile: async (folder: string, name: string) => { removed.push({ folder, name }); return 1; },
};

beforeAll(async () => { server = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); client = await MongoClient.connect(server.getUri()); db = client.db("output-channels"); });
beforeEach(async () => {
  await db.dropDatabase(); saved = []; removed = [];
  await db.collection("journalist_admins").insertMany([
    { email: "journalist@example.test", principalId: "journalist-1", enabled: true, role: "editor" },
    { email: REMOVAL_ACTOR.email, principalId: REMOVAL_ACTOR.id, enabled: true, role: REMOVAL_ACTOR.role },
  ]);
  await db.collection(COLLECTIONS.locations).insertOne({ _id: LOCATION, id: LOCATION, name: "Town, WA", state: "WA", systems: [] } as never);
});
afterAll(async () => { await client?.close(); await server?.stop(); });

describe("journalist output channels", () => {
  it("migrates only current selected coverage once, never published history or all available locations", async () => {
    await outputChannels(db).insertOne({
      _id: "legacy", owner_id: "journalist-1", name: "Legacy", drive_folder_id: "folder", enabled: true,
      selected_location_ids: [LOCATION], published_location_ids: ["historic-wa"],
    });
    await Promise.all([ensurePublicationGovernance(db, "legacy"), ensurePublicationGovernance(db, "legacy")]);
    expect(await outputChannels(db).findOne({ _id: "legacy" })).toMatchObject({
      allowed_location_ids: [LOCATION], lifecycle_revision: 0,
    });
    await outputChannels(db).updateOne({ _id: "legacy" }, { $set: { selected_location_ids: ["other-wa"], allowed_location_ids: [] } });
    await ensurePublicationGovernance(db, "legacy");
    expect(await outputChannels(db).findOne({ _id: "legacy" })).toMatchObject({
      allowed_location_ids: [], lifecycle_revision: 0,
    });
  });

  it("compare-and-swaps lifecycle revisions so exactly one concurrent coverage writer succeeds", async () => {
    const channel = await createOutputChannel(db, "journalist-1", "f".repeat(32), "folder", {
      name: "Initial", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: [LOCATION],
    });
    const access = (await resolveOutputChannel(db, "journalist-1", channel.id))!;
    const outcomes = await Promise.allSettled(["First writer", "Second writer"].map((name) =>
      updateOutputChannel(db, access, { ...channel, name }, 0)));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.any(PublicationLifecycleConflict),
    });
    expect(await outputChannels(db).findOne({ _id: channel.id })).toMatchObject({
      lifecycle_revision: 1, allowed_location_ids: [LOCATION],
    });
  });

  it("never syncs or automatically publishes selected locations outside an explicit allowed boundary", async () => {
    const channel = await createOutputChannel(db, "journalist-1", "e".repeat(32), "folder", {
      name: "Limited", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: [LOCATION],
    });
    await outputChannels(db).updateOne({ _id: channel.id }, { $set: { allowed_location_ids: [] } });
    const latest = vi.fn(async () => ({ id: "edition", location_id: LOCATION }));
    expect(await syncOutputChannelLocations(db, store, "journalist-1", channel.id, [LOCATION], latest)).toEqual([]);
    expect(latest).not.toHaveBeenCalled();
    expect(await publishToOutputChannels(db, store, { id: "edition", location_id: LOCATION })).toEqual([]);
    expect(saved.every((file) => file.name === "locations.json")).toBe(true);
  });

  it("audits an elevated service write only after successful lifecycle CAS", async () => {
    const principal = { id: "support", email: "support@example.test", role: "admin" as const };
    await db.collection("journalist_admins").insertOne({
      email: principal.email, principalId: principal.id, enabled: true, role: principal.role,
    });
    const channel = await createOutputChannel(db, "another-owner", "d".repeat(32), "folder", {
      name: "Initial", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: [],
    });
    await enterPublicationSupport(db, principal, channel.id, "Correct the requested publication name");
    const access = (await resolveOutputChannelForPrincipal(db, principal, channel.id, "Publication support", "write"))!;
    await updateOutputChannel(db, access, { ...channel, name: "Corrected" }, 0);
    const events = await db.collection(COLLECTIONS.publicationAccessAudit).find().toArray();
    expect(events.filter((event) => event.action === "privileged_write_access")).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("Correct the requested publication name") }),
    ]);
    await expect(updateOutputChannel(db, access, { ...channel, name: "Stale" }, 0)).rejects.toBeInstanceOf(PublicationLifecycleConflict);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(events.length);
  });

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
    const access = await resolveOutputChannel(db, "journalist-1", channel.id);
    const edition = await createOutputChannelEdition(db, store, document!, access!.context, "Town this week", [{
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
    expect(edition.publication_id).toBe(channel.id);
    expect(await listOutputChannelEditions(db, access!.context)).toMatchObject([
      { title: "Town this week", output_modes: ["reader"], edition_ids: [edition.edition_ids[0]] },
    ]);
    expect(await resolveOutputChannel(db, "journalist-2", channel.id)).toBeNull();
  });

  it("removes curated edition files when a channel loses Reader output", async () => {
    const channel = await createOutputChannel(db, "journalist-1", "8".repeat(32), "channel-folder", {
      name: "Weekly digest", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: [LOCATION],
    });
    const document = await outputChannels(db).findOne({ _id: channel.id });
    const access = await resolveOutputChannel(db, "journalist-1", channel.id);
    const edition = await createOutputChannelEdition(db, store, document!, access!.context, "Town this week", [], ["reader"], [], [{
      id: `${channel.id}-1`, location_id: LOCATION, location_name: "Town, WA",
      window_start: "2026-11-02", window_end: "2026-11-09", published_at: 1_800_000_000,
      headline: "Town this week", intro: "", items: [], coverage: [], corrections: [],
    }]);

    await clearOutputChannelEditions(db, store, document!);

    expect(removed).toContainEqual({ folder: "channel-folder", name: `channel-edition-${edition._id}-1.json` });
    expect(await listOutputChannelEditions(db, access!.context)).toEqual([]);
  });

  it("supports video-only channel editions with selected stories for video generation", async () => {
    const channel = await createOutputChannel(db, "journalist-1", "9".repeat(32), "video-folder", {
      name: "Video desk", destinations: [{ type: "video", url: "" }], enabled: true, selectedLocationIds: [LOCATION],
    });
    const document = await outputChannels(db).findOne({ _id: channel.id });
    const access = await resolveOutputChannel(db, "journalist-1", channel.id);
    const edition = await createOutputChannelEdition(db, store, document!, access!.context, "Town videos", [{
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
    await removeLocationFromOutputChannels(db, store, LOCATION, REMOVAL_ACTOR);
    expect(await outputChannels(db).findOne({ _id: channel.id })).toMatchObject({
      selected_location_ids: [], allowed_location_ids: [], published_location_ids: [], lifecycle_revision: 1,
    });
    expect(saved.at(-1)?.value).toEqual({ locations: [] });
    const audit = await db.collection<publicationAudit.PublicationChangeAuditEvent>(COLLECTIONS.publicationAccessAudit)
      .findOne({ publication_id: channel.id, action: "allowed_communities_updated" });
    expect(audit).toMatchObject({
      principal_id: REMOVAL_ACTOR.id, principal_email: REMOVAL_ACTOR.email,
      before_hash: expect.stringMatching(/^[a-f0-9]{64}$/), after_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(publicationAudit.publicationAccessAuditIsIntact(audit!)).toBe(true);
  });

  it("requires a real operator for governance-affecting removal but keeps actor-free no-op calls compatible", async () => {
    await expect(removeLocationFromOutputChannels(db, store, "not-covered")).resolves.toBeUndefined();
    const channel = await createOutputChannel(db, "journalist-1", "c".repeat(32), "folder", {
      name: "Coverage", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: [LOCATION],
    });
    for (const actor of [undefined, { id: "missing", email: "invented@example.test", role: "owner" as const }]) {
      await expect(removeLocationFromOutputChannels(db, store, LOCATION, actor)).rejects.toBeInstanceOf(PublicationAccessDenied);
    }
    expect(await outputChannels(db).findOne({ _id: channel.id })).toMatchObject({
      selected_location_ids: [LOCATION], allowed_location_ids: [LOCATION], lifecycle_revision: 0,
    });
    expect(saved).toEqual([]);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(0);
  });

  it("rolls back publication removal scope and revision when its audit cannot be saved, before artifact writes", async () => {
    const channel = await createOutputChannel(db, "journalist-1", "b".repeat(32), "folder", {
      name: "Coverage", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: [LOCATION],
    });
    const audit = vi.spyOn(publicationAudit, "appendPublicationChangeAudit").mockRejectedValueOnce(new Error("Audit unavailable"));
    try {
      await expect(removeLocationFromOutputChannels(db, store, LOCATION, REMOVAL_ACTOR)).rejects.toThrow("Audit unavailable");
    } finally { audit.mockRestore(); }
    expect(await outputChannels(db).findOne({ _id: channel.id })).toMatchObject({
      selected_location_ids: [LOCATION], allowed_location_ids: [LOCATION], lifecycle_revision: 0,
    });
    expect(saved).toEqual([]);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(0);
  });

  it("rejects a stale community-removal CAS before changing scope, auditing or writing artifacts", async () => {
    const channel = await createOutputChannel(db, "journalist-1", "a".repeat(32), "folder", {
      name: "Coverage", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: [LOCATION],
    });
    const transaction = publicationAudit.publicationChangeTransaction;
    const race = vi.spyOn(publicationAudit, "publicationChangeTransaction").mockImplementationOnce(async (database, handler) => {
      await outputChannels(database).updateOne({ _id: channel.id }, { $inc: { lifecycle_revision: 1 } });
      return transaction(database, handler);
    });
    try {
      await expect(removeLocationFromOutputChannels(db, store, LOCATION, REMOVAL_ACTOR)).rejects.toBeInstanceOf(PublicationLifecycleConflict);
    } finally { race.mockRestore(); }
    expect(await outputChannels(db).findOne({ _id: channel.id })).toMatchObject({
      selected_location_ids: [LOCATION], allowed_location_ids: [LOCATION], lifecycle_revision: 1,
    });
    expect(saved).toEqual([]);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(0);
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
