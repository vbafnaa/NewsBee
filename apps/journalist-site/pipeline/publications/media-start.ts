import type { ClientSession, Db } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import type { VideoJob } from "../video-production";
import { assertPublicationWrite, type PublicationContext } from "./access";
import { appendPublicationAccessAudit, publicationChangeTransaction } from "./audit";
import { publicationLifecycleFilter, PublicationLifecycleConflict } from "./lifecycle";
import { PublicationAccessDenied } from "./permissions";
import type { PublicationSupport } from "./support";

/** Commit the publication fence and its active work together, before any provider/storage call. */
export async function publicationMediaStart<T>(
  db: Db,
  context: PublicationContext,
  action: string,
  insertActive: (session: ClientSession) => Promise<T>,
) {
  if (!context) throw new PublicationAccessDenied();
  const authority = await assertPublicationWrite(db, context, action, { audit: false });
  return publicationChangeTransaction(db, async (session) => {
    const claimed = await db.collection(COLLECTIONS.outputChannels).updateOne({
      $and: [
        publicationLifecycleFilter(context, context.publication.lifecycle_revision ?? 0),
        { owner_id: context.ownerId },
      ],
    }, { $inc: { lifecycle_revision: 1 } }, { session });
    if (!claimed.matchedCount) throw new PublicationLifecycleConflict();
    if (authority) {
      const support = await db.collection<PublicationSupport>("publication_support_sessions").findOne({
        _id: authority.supportId, publication_id: context.id, principal_id: context.principalId,
        ended_at: null, expires_at: { $gt: Date.now() },
      }, { session, projection: { _id: 1 } });
      if (!support || authority.expiresAt <= Date.now()) throw new PublicationAccessDenied();
      await appendPublicationAccessAudit(db, authority.evidence, session);
    }
    return insertActive(session);
  });
}

export async function createPublicationVideoJob(
  db: Db,
  context: PublicationContext,
  job: VideoJob,
  replacementId?: string,
) {
  if (job.publication_id !== context.id || job.requested_by !== context.principalId || job.status !== "submitting") {
    throw new PublicationAccessDenied();
  }
  return publicationMediaStart(db, context, "start_publication_video", async (session) => {
    await db.collection<VideoJob>(COLLECTIONS.videoJobs).insertOne(job, { session });
    if (replacementId) {
      const replaced = await db.collection<VideoJob>(COLLECTIONS.videoJobs).updateOne({
        _id: replacementId, publication_id: context.id, release_id: job.release_id, story_id: job.story_id,
        replaced_by: { $exists: false },
      }, { $set: { replaced_by: job._id, updated_at: Date.now() } }, { session });
      if (!replaced.modifiedCount) throw new PublicationLifecycleConflict();
    }
    return job;
  });
}
