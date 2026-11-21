import { createHash } from "node:crypto";
import type { Db, Filter } from "mongodb";
import { AccessPolicyError } from "../accounts/access-policy";
import { isConfiguredOwner, resolvedAccountRole, type Account, type Principal } from "../accounts/identity";
import { COLLECTIONS } from "../storage/mongo";
import type { PublicationRecord } from "./access";
import { appendPublicationChangeAudit, publicationChangeTransaction } from "./audit";
import { ACTIVE_PUBLICATION_GENERATION_STATUSES } from "./generation-status";

type GovernedPublication = PublicationRecord & {
  lifecycle_revision?: number;
  reader_manifest_claim?: { token: string; claimed_at: number };
};

function assertWorkspaceOwner(actor: Principal) {
  if (!isConfiguredOwner(actor)) throw new AccessPolicyError("Workspace owner access required", 403);
}

export async function publicationOwnership(db: Db, actor: Principal, publicationId: string) {
  assertWorkspaceOwner(actor);
  const publication = await db.collection<GovernedPublication>(COLLECTIONS.outputChannels).findOne({ _id: publicationId });
  if (!publication) throw new AccessPolicyError("Publication not found", 404);
  const assigned = (publication.members ?? []).map((member) => member.principal_id);
  const candidates = await db.collection<Account>("journalist_admins")
    .find({ principalId: { $in: assigned }, enabled: true }, { projection: { principalId: 1, email: 1, role: 1 } })
    .sort({ email: 1 }).limit(1000).toArray();
  return {
    revision: publication.lifecycle_revision ?? 0,
    ownerId: publication.owner_id,
    candidates: candidates.filter((account) => resolvedAccountRole(account) !== "owner")
      .map((account) => ({ principalId: account.principalId!, email: account.email })),
  };
}

export async function transferPublicationOwnership(
  db: Db,
  actor: Principal,
  publicationId: string,
  input: { revision: number; successorId: string; formerOwnerMembership: "retain" | "remove"; reason: string },
) {
  assertWorkspaceOwner(actor);
  if (!input || !Number.isSafeInteger(input.revision) || input.revision < 0
    || typeof input.successorId !== "string" || !input.successorId || input.successorId.length > 200
    || !["retain", "remove"].includes(input.formerOwnerMembership)
    || typeof input.reason !== "string" || !input.reason.trim() || input.reason.trim().length > 150) {
    throw new AccessPolicyError("A revision, assigned successor, former-owner membership choice and concise reason are required", 400);
  }
  return publicationChangeTransaction(db, async (session) => {
    const accounts = db.collection<Account>("journalist_admins");
    const issuer = await accounts.findOne({ principalId: actor.id, enabled: true }, { session });
    if (!issuer || resolvedAccountRole(issuer) !== "owner") throw new AccessPolicyError("Enabled workspace owner required", 403);
    const publications = db.collection<GovernedPublication>(COLLECTIONS.outputChannels);
    const publication = await publications.findOne({ _id: publicationId }, { session });
    if (!publication) throw new AccessPolicyError("Publication not found", 404);
    if ((publication.lifecycle_revision ?? 0) !== input.revision) throw new AccessPolicyError("Publication changed; reload before transferring ownership", 409);
    if (publication.reader_manifest_claim) throw new AccessPolicyError("Resolve the active publication release before transferring ownership", 409);
    if (publication.owner_id === input.successorId) throw new AccessPolicyError("Choose a different publication owner", 400);
    if (!publication.members?.some((member) => member.principal_id === input.successorId)) {
      throw new AccessPolicyError("The successor must first be deliberately assigned to this publication", 409);
    }
    const successor = await accounts.findOne({ principalId: input.successorId, enabled: true }, { session });
    if (!successor || !["admin", "editor"].includes(resolvedAccountRole(successor))) {
      throw new AccessPolicyError("Choose an enabled assigned journalist or admin", 409);
    }
    const formerOwner = await accounts.findOne({ principalId: publication.owner_id }, { session, projection: { email: 1 } });
    const activeGeneration = await db.collection(COLLECTIONS.publicationGenerations).findOne({
      publication_id: publicationId,
      status: { $in: [...ACTIVE_PUBLICATION_GENERATION_STATUSES] },
    }, { session, projection: { _id: 1 } });
    const activeVideo = await db.collection(COLLECTIONS.videoJobs).findOne({
      publication_id: publicationId, status: { $in: ["submitting", "queued", "processing", "uploading"] },
    }, { session, projection: { _id: 1 } });
    const activeUpload = await db.collection(COLLECTIONS.videoUploadSessions).findOne({
      publication_id: publicationId,
      $or: [{ status: "active", expires_at: { $gt: new Date() } }, { status: "finalizing" }],
    }, { session, projection: { _id: 1 } });
    if (activeGeneration || activeVideo || activeUpload) throw new AccessPolicyError("Resolve active publication work before transferring ownership", 409);

    // Account writes conflict with suspension, deletion and assignment transactions.
    for (const principalId of [...new Set([actor.id, input.successorId, publication.owner_id])]) {
      await db.collection("journalist_admins").updateOne({ principalId }, { $inc: { publicationOwnershipSequence: 1 } }, { session });
    }
    const members = (publication.members ?? []).filter((member) => member.principal_id !== publication.owner_id);
    if (input.formerOwnerMembership === "retain") members.push({ principal_id: publication.owner_id, role: "editor" });
    const revisionFilter: Filter<GovernedPublication> = input.revision === 0
      ? { $or: [{ lifecycle_revision: 0 }, { lifecycle_revision: { $exists: false } }] }
      : { lifecycle_revision: input.revision };
    const changed = await publications.updateOne({ _id: publicationId, ...revisionFilter }, {
      $set: { owner_id: input.successorId, members, publication_scope_version: 1 },
      $inc: { lifecycle_revision: 1 },
    }, { session });
    if (changed.modifiedCount !== 1) throw new AccessPolicyError("Publication changed; reload before transferring ownership", 409);
    // Anchor legacy scope while the old owner is still known; immutable releases are untouched.
    await db.collection(COLLECTIONS.outputChannelEditions).updateMany({
      publication_id: { $exists: false }, channel_id: publicationId, owner_id: publication.owner_id,
    }, { $set: { publication_id: publicationId } }, { session });
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    await appendPublicationChangeAudit(db, {
      publication_id: publicationId, principal_id: actor.id, principal_email: issuer.email,
      action: "ownership_transferred", resource_id: input.successorId,
      target_principal_id: input.successorId, target_email: successor.email,
      previous_owner_id: publication.owner_id,
      ...(formerOwner ? { previous_owner_email: formerOwner.email } : {}),
      former_owner_membership: input.formerOwnerMembership,
      detail: `Transfer to ${successor.email}; former owner ${input.formerOwnerMembership}: ${input.reason.trim()}`,
      before_hash: hash({ owner_id: publication.owner_id, members: publication.members ?? [] }),
      after_hash: hash({ owner_id: input.successorId, members }),
    }, session);
    return { ownerId: input.successorId, revision: input.revision + 1, formerOwnerMembership: input.formerOwnerMembership };
  });
}
