import { randomUUID } from "node:crypto";
import { Binary, type Db } from "mongodb";
import { runFolder, type ArtifactStore } from "./storage/artifacts";
import { COLLECTIONS } from "./storage/mongo";
import type { PublicationContext } from "./publications/access";
import { publicationMediaStart } from "./publications/media-start";
import { PublicationAccessDenied } from "./publications/permissions";
import { safeError } from "./core/redaction";
import {
  newReleaseVideoJob,
  newVideoJob,
  type ReleaseVideoScope,
  type VideoContentPackage,
  type VideoJob,
  type VideoStory,
} from "./video-production";

export const VIDEO_UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
export const VIDEO_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;

type UploadSession = {
  _id: string;
  location_id: string;
  story_id: string;
  publication_id?: string;
  release_id?: string;
  owner_id: string;
  size: number;
  status: "active" | "finalizing";
  expires_at: Date;
};
type UploadChunk = { _id: string; data: Binary; expires_at: Date };
const sessions = (db: Db) => db.collection<UploadSession>(COLLECTIONS.videoUploadSessions);
const chunks = (db: Db) => db.collection<UploadChunk>(COLLECTIONS.videoUploadChunks);

export async function startVideoUpload(db: Db, story: VideoStory, ownerId: string, size: number) {
  if (!Number.isSafeInteger(size) || size < 12 || size > VIDEO_UPLOAD_MAX_BYTES) {
    throw new Error("Invalid video size: choose an MP4 no larger than 100 MB");
  }
  const uploadId = randomUUID();
  await sessions(db).insertOne({
    _id: uploadId, location_id: story.locationId, story_id: story.storyId, owner_id: ownerId,
    size, status: "active", expires_at: new Date(Date.now() + UPLOAD_LIFETIME_MS),
  });
  return { uploadId };
}

export async function startReleaseVideoUpload(
  db: Db, scope: ReleaseVideoScope, ownerId: string, size: number, context: PublicationContext,
) {
  if (!context || context.id !== scope.publicationId || context.principalId !== ownerId) throw new PublicationAccessDenied();
  if (!Number.isSafeInteger(size) || size < 12 || size > VIDEO_UPLOAD_MAX_BYTES) {
    throw new Error("Invalid video size: choose an MP4 no larger than 100 MB");
  }
  const uploadId = randomUUID();
  const upload: UploadSession = {
    _id: uploadId,
    publication_id: scope.publicationId,
    release_id: scope.releaseId,
    location_id: scope.item.location_ids[0] ?? scope.publicationId,
    story_id: scope.item.item_id,
    owner_id: ownerId,
    size,
    status: "active",
    expires_at: new Date(Date.now() + UPLOAD_LIFETIME_MS),
  };
  await publicationMediaStart(db, context, "start_publication_video_upload", (session) =>
    sessions(db).insertOne(upload, { session }),
  );
  return { uploadId };
}

async function activeSession(db: Db, story: VideoStory, ownerId: string, uploadId: string) {
  const session = await sessions(db).findOne({
    _id: uploadId, location_id: story.locationId, story_id: story.storyId, owner_id: ownerId,
    status: "active", expires_at: { $gt: new Date() },
  });
  if (!session) throw new Error("Invalid or expired video upload");
  return session;
}

async function activeReleaseSession(db: Db, scope: ReleaseVideoScope, ownerId: string, uploadId: string) {
  const session = await sessions(db).findOne({
    _id: uploadId,
    publication_id: scope.publicationId,
    release_id: scope.releaseId,
    story_id: scope.item.item_id,
    owner_id: ownerId,
    status: "active",
    expires_at: { $gt: new Date() },
  });
  if (!session) throw new Error("Invalid or expired video upload");
  return session;
}

export async function saveVideoChunk(db: Db, story: VideoStory, ownerId: string, uploadId: string, index: number, data: Uint8Array) {
  const session = await activeSession(db, story, ownerId, uploadId);
  const count = Math.ceil(session.size / VIDEO_UPLOAD_CHUNK_BYTES);
  const expected = Math.min(VIDEO_UPLOAD_CHUNK_BYTES, session.size - index * VIDEO_UPLOAD_CHUNK_BYTES);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count || data.length !== expected) {
    throw new Error("Invalid video upload chunk");
  }
  await chunks(db).updateOne({ _id: `${uploadId}:${index}` }, {
    $set: { data: new Binary(Buffer.from(data)), expires_at: session.expires_at },
  }, { upsert: true });
}

export async function saveReleaseVideoChunk(
  db: Db,
  scope: ReleaseVideoScope,
  ownerId: string,
  uploadId: string,
  index: number,
  data: Uint8Array,
) {
  const session = await activeReleaseSession(db, scope, ownerId, uploadId);
  const count = Math.ceil(session.size / VIDEO_UPLOAD_CHUNK_BYTES);
  const expected = Math.min(VIDEO_UPLOAD_CHUNK_BYTES, session.size - index * VIDEO_UPLOAD_CHUNK_BYTES);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count || data.length !== expected) {
    throw new Error("Invalid video upload chunk");
  }
  await chunks(db).updateOne({ _id: `${uploadId}:${index}` }, {
    $set: { data: new Binary(Buffer.from(data)), expires_at: session.expires_at },
  }, { upsert: true });
}

async function uploadedContent(db: Db, session: UploadSession, uploadId: string) {
  const count = Math.ceil(session.size / VIDEO_UPLOAD_CHUNK_BYTES);
  const parts = await chunks(db).find({ _id: { $regex: `^${uploadId}:` } }).toArray();
  if (parts.length !== count) throw new Error("Video upload is incomplete");
  const byId = new Map(parts.map((part) => [part._id, part.data.buffer]));
  const ordered = Array.from({ length: count }, (_, index) => byId.get(`${uploadId}:${index}`));
  if (ordered.some((part) => !part) || ordered.reduce((total, part) => total + (part?.length ?? 0), 0) !== session.size) {
    throw new Error("Video upload is incomplete");
  }
  const content = Buffer.concat(ordered as Buffer[]);
  if (content.toString("ascii", 4, 8) !== "ftyp") throw new Error("Invalid MP4 video file");
  return content;
}

async function finishUpload(
  db: Db,
  store: ArtifactStore,
  session: UploadSession,
  uploadId: string,
  job: VideoJob,
  folderParts: string[],
  context?: PublicationContext,
) {
  const content = await uploadedContent(db, session, uploadId);
  if (context) {
    await publicationMediaStart(db, context, "finish_publication_video_upload", async (transaction) => {
      const claimed = await sessions(db).updateOne({
        _id: uploadId, publication_id: context.id, owner_id: context.principalId,
        status: "active", expires_at: { $gt: new Date() },
      }, { $set: { status: "finalizing", expires_at: new Date(Date.now() + UPLOAD_LIFETIME_MS) } }, { session: transaction });
      if (!claimed.modifiedCount) throw new Error("Video upload is already being saved or expired");
      await db.collection<VideoJob>(COLLECTIONS.videoJobs).insertOne({ ...job, status: "uploading" }, { session: transaction });
    });
  } else {
    const claimed = await sessions(db).updateOne({ _id: uploadId, status: "active" }, { $set: { status: "finalizing" } });
    if (!claimed.modifiedCount) throw new Error("Video upload is already being saved");
  }
  try {
    if (!store.saveBinary) throw new Error("The configured artifact store cannot save video files");
    const folder = await runFolder(store, "video-production", ...folderParts);
    const fileId = await store.saveBinary(folder, `${job._id}.mp4`, content, "video/mp4");
    job.drive_file_id = fileId;
    job.drive_url = store.kind === "drive" ? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view` : undefined;
    if (context) {
      await db.collection<VideoJob>(COLLECTIONS.videoJobs).updateOne(
        { _id: job._id, publication_id: context.id, status: "uploading" },
        { $set: { status: job.status, drive_file_id: job.drive_file_id, ...(job.drive_url ? { drive_url: job.drive_url } : {}) } },
      );
    } else await db.collection<VideoJob>(COLLECTIONS.videoJobs).insertOne(job);
    await Promise.all([
      sessions(db).deleteOne({ _id: uploadId }),
      chunks(db).deleteMany({ _id: { $regex: `^${uploadId}:` } }),
    ]);
    return job;
  } catch (error) {
    if (context) await db.collection<VideoJob>(COLLECTIONS.videoJobs).updateOne(
      { _id: job._id, publication_id: context.id, status: "uploading" },
      { $set: { status: "failed", error: safeError(error), updated_at: Date.now() } },
    );
    await sessions(db).updateOne({ _id: uploadId }, { $set: { status: "active" } });
    throw error;
  }
}

export async function finishVideoUpload(db: Db, store: ArtifactStore, story: VideoStory, ownerId: string, uploadId: string): Promise<VideoJob> {
  const session = await activeSession(db, story, ownerId, uploadId);
  return finishUpload(
    db,
    store,
    session,
    uploadId,
    { ...newVideoJob(story, ""), source: "upload", status: "complete", requested_by: ownerId },
    [story.locationId, story.storyId],
  );
}

export async function finishReleaseVideoUpload(
  db: Db,
  store: ArtifactStore,
  scope: ReleaseVideoScope,
  content: VideoContentPackage,
  template: string | undefined,
  ownerId: string,
  uploadId: string,
  context: PublicationContext,
): Promise<VideoJob> {
  if (!context || context.id !== scope.publicationId || context.principalId !== ownerId) throw new PublicationAccessDenied();
  const session = await activeReleaseSession(db, scope, ownerId, uploadId);
  return finishUpload(
    db,
    store,
    session,
    uploadId,
    {
      ...newReleaseVideoJob(scope, content, template),
      source: "upload",
      status: "complete",
      requested_by: ownerId,
    },
    [scope.publicationId, scope.releaseId, scope.item.item_id],
    context,
  );
}
