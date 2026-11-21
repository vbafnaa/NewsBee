import { createHash, randomUUID } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";

export type PublicationAccessAuditEvent = {
  _id: string;
  publication_id: string;
  principal_id: string;
  principal_email: string;
  capability: "publication:inspect" | "publication:write";
  action: "privileged_inspection" | "privileged_write_access" | "support_entered" | "support_exited" | "support_expired";
  reason: string;
  at: number;
  record_hash: string;
};

type AuditInput = Omit<PublicationAccessAuditEvent, "_id" | "at" | "record_hash">;

export type PublicationChangeAuditEvent = {
  _id: string;
  publication_id: string;
  principal_id: string;
  principal_email: string;
  action:
    | "ownership_transferred"
    | "publication_created"
    | "coverage_updated"
    | "allowed_communities_updated"
    | "publication_updated"
    | "publication_deleted"
    | "publication_archived"
    | "publication_restored"
    | "profile_updated"
    | "generation_preferences_updated"
    | "sponsor_placements_updated"
    | "source_feedback_submitted"
    | "source_feedback_decided"
    | "release_approved"
    | "manual_draft_created"
    | "story_inclusion_changed"
    | "release_published"
    | "release_correction_created"
    | "release_withdrawn"
    | "release_restored"
    | "email_campaign_created"
    | "email_campaign_processed"
    | "video_package_prepared"
    | "video_generation_submitted"
    | "video_generation_polled"
    | "video_generation_completed"
    | "video_generation_replaced"
    | "video_uploaded";
  resource_id: string;
  detail: string;
  before_hash: string | null;
  after_hash: string | null;
  target_principal_id?: string;
  target_email?: string;
  previous_owner_id?: string;
  previous_owner_email?: string;
  former_owner_membership?: "retain" | "remove";
  at: number;
  record_hash: string;
};

type ChangeAuditInput = Omit<PublicationChangeAuditEvent, "_id" | "at" | "record_hash">;

function auditHash(event: Omit<PublicationAccessAuditEvent, "record_hash">) {
  return createHash("sha256").update(JSON.stringify([
    event._id,
    event.publication_id,
    event.principal_id,
    event.principal_email,
    event.capability,
    event.action,
    event.reason,
    event.at,
  ])).digest("hex");
}

function changeAuditHash(event: Omit<PublicationChangeAuditEvent, "record_hash">) {
  return createHash("sha256").update(JSON.stringify([
    event._id,
    event.publication_id,
    event.principal_id,
    event.principal_email,
    event.action,
    event.resource_id,
    event.detail,
    event.before_hash,
    event.after_hash,
    event.at,
    ...(["target_principal_id", "target_email", "previous_owner_id", "previous_owner_email", "former_owner_membership"]
      .some((key) => key in event) ? [[
        event.target_principal_id ?? null, event.target_email ?? null,
        event.previous_owner_id ?? null, event.previous_owner_email ?? null,
        event.former_owner_membership ?? null,
      ]] : []),
  ])).digest("hex");
}

export async function appendPublicationAccessAudit(db: Db, input: AuditInput, session?: ClientSession) {
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new Error("Privileged publication access requires a concise reason");
  const immutable = {
    ...input,
    reason,
    _id: randomUUID(),
    at: Date.now(),
  };
  const event: PublicationAccessAuditEvent = {
    ...immutable,
    record_hash: auditHash(immutable),
  };
  await db.collection<PublicationAccessAuditEvent>(COLLECTIONS.publicationAccessAudit).insertOne(event, session ? { session } : undefined);
  return event;
}

export async function appendPublicationChangeAudit(db: Db, input: ChangeAuditInput, session?: ClientSession) {
  const detail = input.detail.replace(/\s+/g, " ").trim();
  if (!detail || detail.length > 500) throw new Error("Publication audit detail must be concise");
  const immutable = { ...input, detail, _id: randomUUID(), at: Date.now() };
  const event: PublicationChangeAuditEvent = { ...immutable, record_hash: changeAuditHash(immutable) };
  await db.collection<PublicationChangeAuditEvent>(COLLECTIONS.publicationAccessAudit)
    .insertOne(event, session ? { session } : undefined);
  return event;
}

export async function publicationChangeTransaction<T>(
  db: Db,
  handler: (session: ClientSession) => Promise<T>,
) {
  const session = db.client.startSession();
  try {
    return await session.withTransaction(() => handler(session), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    }) as T;
  } finally {
    await session.endSession();
  }
}

export function publicationAccessAuditIsIntact(event: PublicationAccessAuditEvent | PublicationChangeAuditEvent) {
  const { record_hash: recordHash, ...immutable } = event;
  return recordHash === ("capability" in immutable
    ? auditHash(immutable as Omit<PublicationAccessAuditEvent, "record_hash">)
    : changeAuditHash(immutable as Omit<PublicationChangeAuditEvent, "record_hash">));
}
