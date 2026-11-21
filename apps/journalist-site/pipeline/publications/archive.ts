import type { Db, Filter } from "mongodb";
import { AccessPolicyError } from "../accounts/access-policy";
import { resolvedAccountRole, type Account, type Principal } from "../accounts/identity";
import { outputChannels, outputChannelConfigurationHash, type OutputChannelDocument } from "../orchestration/output-channels";
import { COLLECTIONS } from "../storage/mongo";
import { appendPublicationChangeAudit, publicationChangeTransaction } from "./audit";
import { ACTIVE_PUBLICATION_GENERATION_STATUSES } from "./generation-status";

export async function setPublicationArchived(
  db: Db, actor: Principal, publicationId: string, revision: number, archive: boolean,
) {
  if (!["owner", "admin"].includes(actor.role)) throw new AccessPolicyError("Workspace administrator access required", 403);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new AccessPolicyError("A current publication revision is required", 400);
  return publicationChangeTransaction(db, async (session) => {
    const accounts = db.collection<Account>("journalist_admins");
    const issuer = await accounts.findOne({ principalId: actor.id, enabled: true }, { session });
    if (!issuer || !["owner", "admin"].includes(resolvedAccountRole(issuer))) {
      throw new AccessPolicyError("Enabled workspace administrator access required", 403);
    }
    const channels = outputChannels(db);
    const channel = await channels.findOne({ _id: publicationId }, { session });
    if (!channel) throw new AccessPolicyError("Newsroom not found", 404);
    if ((channel.lifecycle_revision ?? 0) !== revision) throw new AccessPolicyError("Newsroom changed; reload before changing its archive state", 409);
    if ((typeof channel.archived_at === "number") === archive) {
      throw new AccessPolicyError(archive ? "Newsroom is already archived" : "Newsroom is not archived", 409);
    }
    const activeGeneration = await db.collection(COLLECTIONS.publicationGenerations).findOne({
      publication_id: publicationId, status: { $in: [...ACTIVE_PUBLICATION_GENERATION_STATUSES] },
    }, { session, projection: { _id: 1 } });
    const activeVideo = await db.collection(COLLECTIONS.videoJobs).findOne({
      publication_id: publicationId, status: { $in: ["submitting", "queued", "processing", "uploading"] },
    }, { session, projection: { _id: 1 } });
    const activeUpload = await db.collection(COLLECTIONS.videoUploadSessions).findOne({
      publication_id: publicationId,
      $or: [{ status: "active", expires_at: { $gt: new Date() } }, { status: "finalizing" }],
    }, { session, projection: { _id: 1 } });
    const activeRelease = await db.collection(COLLECTIONS.publicationDrafts).findOne({
      publication_id: publicationId, editorial_status: { $in: ["approved", "publishing"] },
    }, { session, projection: { _id: 1 } });
    if (channel.reader_manifest_claim || activeGeneration || activeVideo || activeUpload || activeRelease) {
      throw new AccessPolicyError("Resolve active publication work (including approved or publishing drafts) before archiving or restoring", 409);
    }
    // Serialize permission rechecks with account suspension and role changes.
    await accounts.updateOne({ principalId: actor.id }, { $inc: { publicationOwnershipSequence: 1 } }, { session });
    const revisionFilter: Filter<OutputChannelDocument> = revision === 0
      ? { $or: [{ lifecycle_revision: 0 }, { lifecycle_revision: { $exists: false } }] }
      : { lifecycle_revision: revision };
    const updated = await channels.findOneAndUpdate({ _id: publicationId, ...revisionFilter }, archive ? {
      $set: { enabled: false, archived_at: Math.floor(Date.now() / 1000), archived_by: actor.id, archived_was_enabled: channel.enabled === true },
      $inc: { lifecycle_revision: 1 },
    } : {
      $set: { enabled: channel.archived_was_enabled === true },
      $unset: { archived_at: "", archived_by: "", archived_was_enabled: "" },
      $inc: { lifecycle_revision: 1 },
    }, { session, returnDocument: "after" });
    if (!updated) throw new AccessPolicyError("Newsroom changed; reload before changing its archive state", 409);
    const hash = (row: OutputChannelDocument) => outputChannelConfigurationHash({
      id: row._id, name: row.name, destinations: row.destinations ?? [],
      enabled: row.enabled, selectedLocationIds: row.selected_location_ids ?? [],
      allowedLocationIds: row.allowed_location_ids ?? row.selected_location_ids ?? [],
      lifecycleRevision: row.lifecycle_revision ?? 0, driveFolderId: row.drive_folder_id,
      archivedAt: typeof row.archived_at === "number" ? row.archived_at : null,
    });
    await appendPublicationChangeAudit(db, {
      publication_id: publicationId, principal_id: actor.id, principal_email: issuer.email,
      action: archive ? "publication_archived" : "publication_restored", resource_id: publicationId,
      detail: `${archive ? "Archived" : "Restored"} newsroom at lifecycle revision ${revision + 1}; published history retained.`,
      before_hash: hash(channel), after_hash: hash(updated),
    }, session);
    return { id: publicationId, archivedAt: typeof updated.archived_at === "number" ? updated.archived_at : null,
      enabled: updated.enabled, lifecycleRevision: revision + 1 };
  });
}
