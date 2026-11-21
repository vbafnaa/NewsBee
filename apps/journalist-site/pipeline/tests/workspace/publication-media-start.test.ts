import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { principalForEmail, type Principal } from "../../accounts/identity";
import { resolvePrivilegedPublicationContext, resolvePublicationContext } from "../../publications/access";
import { enterPublicationSupport } from "../../publications/support";
import { createPublicationVideoJob } from "../../publications/media-start";
import { transferPublicationOwnership } from "../../publications/ownership";
import { COLLECTIONS } from "../../storage/mongo";
import type { ArtifactStore } from "../../storage/artifacts";
import type { ReleaseVideoScope, VideoContentPackage, VideoJob } from "../../video-production";
import { finishReleaseVideoUpload, saveReleaseVideoChunk, startReleaseVideoUpload } from "../../video-upload";

let server: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let owner: Principal;
const publicationId = "publication";
const transfer = { revision: 0, successorId: "successor", formerOwnerMembership: "retain" as const, reason: "Editorial handoff" };
const scope = {
  publicationId, releaseId: "release", releaseHash: "release-hash",
  item: { item_id: "story", location_ids: ["town"], location_names: ["Town"], headline: "Story", blurb: "", when_where: "", event_date: "", source_url: null },
  release: { publication: { display_name: "Fixture" } },
} as ReleaseVideoScope;
const content: VideoContentPackage = {
  youtubeTitle: "Story", youtubeDescription: "", youtubeTags: [], tiktokCaption: "",
  spokenScript: "", videoPrompt: "Fixture prompt", subtitlesSrt: "", generatedAt: 1, updatedAt: 1,
};
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 12]), Buffer.from("ftypisom"), Buffer.alloc(10)]);
const context = async () => (await resolvePublicationContext(db, "former", publicationId))!;
const job = (): VideoJob => ({
  _id: "video-job", publication_id: publicationId, release_id: "release", story_id: "story",
  requested_by: "former", status: "submitting",
} as VideoJob);

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = await MongoClient.connect(server.getUri());
  db = client.db("publication-media-start");
});
beforeEach(async () => {
  await db.dropDatabase();
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "workspace-owner@example.test");
  owner = (await principalForEmail(db, "workspace-owner@example.test"))!;
  await db.collection("journalist_admins").insertMany([
    { principalId: "former", email: "former@example.test", role: "editor", enabled: true },
    { principalId: "successor", email: "successor@example.test", role: "editor", enabled: true },
  ]);
  await db.collection(COLLECTIONS.outputChannels).insertOne({
    _id: publicationId, owner_id: "former", name: "Fixture", publication_scope_version: 1,
    members: [{ principal_id: "successor", role: "editor" }], lifecycle_revision: 0,
  });
});
afterAll(async () => { await client?.close(); await server?.stop(); vi.unstubAllEnvs(); });

it.each(["assigned", "support"])("serializes concurrent %s generated-video start against ownership transfer in the publication transaction", async (mode) => {
  let current = await context();
  const starting = job();
  if (mode === "support") {
    await enterPublicationSupport(db, owner, publicationId, "Investigate the publication video issue");
    current = (await resolvePrivilegedPublicationContext(db, owner, publicationId, "Start video support", "write"))!;
    starting.requested_by = owner.id;
  }
  const outcomes = await Promise.allSettled([
    transferPublicationOwnership(db, owner, publicationId, transfer),
    createPublicationVideoJob(db, current, starting),
  ]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const transferred = outcomes[0].status === "fulfilled";
  expect(await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId }))
    .toMatchObject({ owner_id: transferred ? "successor" : "former", lifecycle_revision: 1 });
  expect(await db.collection(COLLECTIONS.videoJobs).countDocuments()).toBe(transferred ? 0 : 1);
  if (mode === "support") expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments({
    action: "privileged_write_access",
  })).toBe(transferred ? 0 : 1);
});

it("rolls back the lifecycle touch when active-job insertion fails", async () => {
  await db.createCollection(COLLECTIONS.videoJobs, { validator: { blocked: { $exists: true } }, validationLevel: "strict" });
  await expect(createPublicationVideoJob(db, await context(), job())).rejects.toThrow();
  expect(await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId }))
    .toMatchObject({ lifecycle_revision: 0, owner_id: "former" });
  await expect(transferPublicationOwnership(db, owner, publicationId, transfer)).resolves.toMatchObject({ ownerId: "successor" });
});

it("atomically registers upload starts, blocks transfer while active, and rejects stale post-transfer starts", async () => {
  const stale = await context();
  await startReleaseVideoUpload(db, scope, "former", mp4.length, stale);
  await expect(transferPublicationOwnership(db, owner, publicationId, { ...transfer, revision: 1 }))
    .rejects.toMatchObject({ status: 409 });
  await db.collection(COLLECTIONS.videoUploadSessions).updateMany({}, { $set: { expires_at: new Date(Date.now() - 1) } });
  await transferPublicationOwnership(db, owner, publicationId, { ...transfer, revision: 1 });
  await expect(startReleaseVideoUpload(db, scope, "former", mp4.length, stale)).rejects.toThrow();
  expect(await db.collection(COLLECTIONS.videoUploadSessions).countDocuments()).toBe(1);
});

it("commits an uploading job before external storage and holds no transaction across that call", async () => {
  const { uploadId } = await startReleaseVideoUpload(db, scope, "former", mp4.length, await context());
  await saveReleaseVideoChunk(db, scope, "former", uploadId, 0, mp4);
  const store: ArtifactStore = {
    kind: "local", ensureFolder: async () => "folder", saveText: async () => "", saveJson: async () => "",
    readText: async () => "", readJson: async <T>() => ({} as T), list: async () => [], findFolder: async () => null, removeFile: async () => 0,
    saveBinary: async () => {
      expect(await db.collection(COLLECTIONS.videoJobs).findOne({ publication_id: publicationId, status: "uploading" })).toBeTruthy();
      await expect(transferPublicationOwnership(db, owner, publicationId, { ...transfer, revision: 2 }))
        .rejects.toMatchObject({ status: 409 });
      return "stored-file";
    },
  };
  const saved = await finishReleaseVideoUpload(db, store, scope, content, undefined, "former", uploadId, await context());
  expect(saved).toMatchObject({ status: "complete", drive_file_id: "stored-file" });
  expect(await db.collection(COLLECTIONS.videoUploadSessions).countDocuments()).toBe(0);
  await expect(transferPublicationOwnership(db, owner, publicationId, { ...transfer, revision: 2 })).resolves.toMatchObject({ ownerId: "successor" });
});
