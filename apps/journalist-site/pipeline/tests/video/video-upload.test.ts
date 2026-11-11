import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLECTIONS } from "../../storage/mongo";
import type { ArtifactStore } from "../../storage/artifacts";
import { finishVideoUpload, saveVideoChunk, startVideoUpload, VIDEO_UPLOAD_CHUNK_BYTES, VIDEO_UPLOAD_MAX_BYTES } from "../../video-upload";
import { saveVideoPackage, videoStoryManagement, type VideoStory } from "../../video-production";

const story: VideoStory = {
  locationId: "local", locationName: "Local", storyId: "story", editionId: "edition",
  title: "Story", summary: "", whenWhere: "", eventDate: "", sourceUrl: null, story: null,
};
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 12]), Buffer.from("ftypisom"), Buffer.alloc(10)]);
let server: MongoMemoryServer, client: MongoClient, db: Db;
const saveBinary = vi.fn(async () => "stored-file");
const store: ArtifactStore = {
  kind: "local", ensureFolder: async () => "folder", saveText: async () => "", saveJson: async () => "",
  saveBinary, readText: async () => "", readJson: async <T>() => ({} as T), list: async () => [],
  findFolder: async () => null, removeFile: async () => 0,
};
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("video-upload-test"); });
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
});
