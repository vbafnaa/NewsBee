import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLECTIONS } from "../../storage/mongo";
import type { ArtifactStore } from "../../storage/artifacts";
import { resolvePublicationContext } from "../../publications/access";
import {
  finishReleaseVideoUpload,
  finishVideoUpload,
  saveReleaseVideoChunk,
  saveVideoChunk,
  startReleaseVideoUpload,
  startVideoUpload,
  VIDEO_UPLOAD_CHUNK_BYTES,
  VIDEO_UPLOAD_MAX_BYTES,
} from "../../video-upload";
import {
  saveVideoPackage,
  videoStoryManagement,
  type ReleaseVideoScope,
  type VideoContentPackage,
  type VideoStory,
} from "../../video-production";

const story: VideoStory = {
  locationId: "local", locationName: "Local", storyId: "story", editionId: "edition",
  title: "Story", summary: "", whenWhere: "", eventDate: "", sourceUrl: null, story: null,
};
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 12]), Buffer.from("ftypisom"), Buffer.alloc(10)]);
const releaseScope = {
  publicationId: "publication",
  releaseId: "release",
  releaseHash: "release-hash",
  item: {
    item_id: "release-story",
    location_ids: ["local"],
    location_names: ["Local"],
    headline: "Release story",
    blurb: "Release summary",
    when_where: "Local",
    event_date: "2026-11-17",
    source_url: null,
  },
  release: {
    publication: { display_name: "Fixture publication" },
  },
} as ReleaseVideoScope;
const releasePackage = {
  youtubeTitle: "Release story",
  youtubeDescription: "Release description",
  youtubeTags: ["local"],
  tiktokCaption: "Release caption",
  spokenScript: "Release script",
  videoPrompt: "Release prompt",
  subtitlesSrt: "",
  generatedAt: 1,
  updatedAt: 1,
} satisfies VideoContentPackage;
let server: MongoMemoryReplSet, client: MongoClient, db: Db;
const saveBinary = vi.fn(async () => "stored-file");
const store: ArtifactStore = {
  kind: "local", ensureFolder: async () => "folder", saveText: async () => "", saveJson: async () => "",
  saveBinary, readText: async () => "", readJson: async <T>() => ({} as T), list: async () => [],
  findFolder: async () => null, removeFile: async () => 0,
};
beforeAll(async () => { server = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); client = await MongoClient.connect(server.getUri()); db = client.db("video-upload-test"); });
beforeEach(async () => { await db.dropDatabase(); saveBinary.mockClear(); });
afterAll(async () => { await client?.close(); await server?.stop(); });

describe("manual story video uploads", () => {
  it("preserves the prompt used for title and description when editing the package", async () => {
    const content = {
      youtubeTitle: "News title", youtubeDescription: "News description", youtubeTags: ["local"],
      tiktokCaption: "Local update", spokenScript: "Spoken update", videoPrompt: "Video prompt", subtitlesSrt: "",
      generationPrompt: "Original AI prompt with source details",
    };
    await saveVideoPackage(db, story, content, content.generationPrompt);
    await saveVideoPackage(db, story, { ...content, youtubeTitle: "Edited title", generationPrompt: "Client-injected prompt" });
    const management = await videoStoryManagement(db, story);
    expect(management.package?.youtubeTitle).toBe("Edited title");
    expect(management.packagePrompt).toBe(content.generationPrompt);

    expect((await videoStoryManagement(db, story, "channel-b")).package?.videoPrompt).toBe(content.videoPrompt);
    await saveVideoPackage(db, story, { ...content, videoPrompt: "Channel A's edited prompt" }, undefined, "channel-a");
    expect((await videoStoryManagement(db, story, "channel-a")).package?.videoPrompt).toBe("Channel A's edited prompt");
    expect((await videoStoryManagement(db, story, "channel-b")).package?.videoPrompt).toBe(content.videoPrompt);
    expect((await videoStoryManagement(db, { ...story, storyId: "other" }, "channel-a")).package).toBeNull();
  });

  it("assembles multiple chunks and saves an MP4 in the story's video list for optional YouTube publishing", async () => {
    const video = Buffer.concat([mp4, Buffer.alloc(VIDEO_UPLOAD_CHUNK_BYTES)]);
    const { uploadId } = await startVideoUpload(db, story, "owner", video.length);
    await saveVideoChunk(db, story, "owner", uploadId, 0, video.subarray(0, VIDEO_UPLOAD_CHUNK_BYTES));
    await saveVideoChunk(db, story, "owner", uploadId, 1, video.subarray(VIDEO_UPLOAD_CHUNK_BYTES));
    const job = await finishVideoUpload(db, store, story, "owner", uploadId);
    expect(job).toMatchObject({ source: "upload", status: "complete", drive_file_id: "stored-file", prompt: "", story_id: story.storyId });
    expect(saveBinary).toHaveBeenCalledWith("folder", `${job._id}.mp4`, video, "video/mp4");
    expect(await db.collection(COLLECTIONS.videoJobs).findOne({ _id: job._id })).toMatchObject({ source: "upload", status: "complete" });
    expect(await db.collection(COLLECTIONS.videoUploadChunks).countDocuments()).toBe(0);
    expect(await db.collection(COLLECTIONS.videoUploadSessions).countDocuments()).toBe(0);
  });

  it("requires the right owner, story, valid chunks and a complete MP4 before saving", async () => {
    await expect(startVideoUpload(db, story, "owner", VIDEO_UPLOAD_MAX_BYTES + 1)).rejects.toThrow("Invalid video size");
    const { uploadId } = await startVideoUpload(db, story, "owner", VIDEO_UPLOAD_CHUNK_BYTES + mp4.length);
    await expect(saveVideoChunk(db, story, "other", uploadId, 0, Buffer.alloc(VIDEO_UPLOAD_CHUNK_BYTES))).rejects.toThrow();
    await expect(saveVideoChunk(db, { ...story, storyId: "other" }, "owner", uploadId, 0, Buffer.alloc(VIDEO_UPLOAD_CHUNK_BYTES))).rejects.toThrow();
    await expect(saveVideoChunk(db, story, "owner", uploadId, 1, Buffer.alloc(3))).rejects.toThrow("Invalid video upload chunk");
    await saveVideoChunk(db, story, "owner", uploadId, 1, mp4);
    await expect(finishVideoUpload(db, store, story, "owner", uploadId)).rejects.toThrow("incomplete");
    await saveVideoChunk(db, story, "owner", uploadId, 0, Buffer.alloc(VIDEO_UPLOAD_CHUNK_BYTES));
    await expect(finishVideoUpload(db, store, story, "owner", uploadId)).rejects.toThrow("Invalid MP4");
    expect(saveBinary).not.toHaveBeenCalled();
  });

  it("scopes a manually uploaded release MP4 to its publication, release, story and submitting principal", async () => {
    await db.collection(COLLECTIONS.outputChannels).insertOne({
      _id: releaseScope.publicationId, owner_id: "editor", name: "Fixture", publication_scope_version: 1,
    });
    const context = (await resolvePublicationContext(db, "editor", releaseScope.publicationId))!;
    const { uploadId } = await startReleaseVideoUpload(db, releaseScope, "editor", mp4.length, context);
    await expect(saveReleaseVideoChunk(
      db,
      { ...releaseScope, releaseId: "other-release" },
      "editor",
      uploadId,
      0,
      mp4,
    )).rejects.toThrow("Invalid or expired");
    await saveReleaseVideoChunk(db, releaseScope, "editor", uploadId, 0, mp4);
    const job = await finishReleaseVideoUpload(
      db,
      store,
      releaseScope,
      releasePackage,
      "Fixture {{dialogue}}",
      "editor",
      uploadId,
      (await resolvePublicationContext(db, "editor", releaseScope.publicationId))!,
    );
    expect(job).toMatchObject({
      source: "upload",
      status: "complete",
      requested_by: "editor",
      publication_id: releaseScope.publicationId,
      release_id: releaseScope.releaseId,
      story_id: releaseScope.item.item_id,
      drive_file_id: "stored-file",
    });
    expect(saveBinary).toHaveBeenCalledWith("folder", `${job._id}.mp4`, mp4, "video/mp4");
    expect(await db.collection(COLLECTIONS.videoUploadChunks).countDocuments()).toBe(0);
    expect(await db.collection(COLLECTIONS.videoUploadSessions).countDocuments()).toBe(0);
  });
});
