import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { principalById, type Principal } from "../accounts/identity";
import { COLLECTIONS } from "../storage/mongo";
import { appendPublicationAccessAudit } from "./audit";
import { PublicationAccessDenied } from "./permissions";

const SUPPORT = "publication_support_sessions";
const DURATION_MS = 30 * 60 * 1000;

export type PublicationSupport = {
  _id: string;
  publication_id: string;
  principal_id: string;
  principal_email: string;
  reason: string;
  entered_at: number;
  expires_at: number;
  ended_at: number | null;
};

async function operator(db: Db, principal: Principal) {
  const current = await principalById(db, principal.id);
  if (!current || (current.role !== "owner" && current.role !== "admin")) throw new PublicationAccessDenied();
  return current;
}

async function expireSupport(db: Db, principalId: string, publicationId: string) {
  const expired = await db.collection<PublicationSupport>(SUPPORT).find({
    principal_id: principalId, publication_id: publicationId, ended_at: null,
    expires_at: { $lte: Date.now() },
  }).toArray();
  for (const support of expired) {
    // Evidence is durable before closing; a crash may duplicate evidence, never erase it.
    await appendPublicationAccessAudit(db, {
      publication_id: publicationId, principal_id: principalId, principal_email: support.principal_email,
      capability: "publication:write", action: "support_expired",
      reason: `Support ${support._id} expired at ${support.expires_at}: ${support.reason}`,
    });
    await db.collection<PublicationSupport>(SUPPORT).updateOne(
      { _id: support._id, ended_at: null }, { $set: { ended_at: support.expires_at } },
    );
  }
}

export async function activePublicationSupport(db: Db, principal: Principal, publicationId: string) {
  await operator(db, principal);
  await expireSupport(db, principal.id, publicationId);
  return db.collection<PublicationSupport>(SUPPORT).findOne({
    principal_id: principal.id, publication_id: publicationId, ended_at: null,
    entered_at: { $lte: Date.now() }, expires_at: { $gt: Date.now() },
  });
}

export async function enterPublicationSupport(db: Db, principal: Principal, publicationId: string, rawReason: string) {
  const current = await operator(db, principal);
  const reason = rawReason.trim().replace(/\s+/g, " ");
  if (reason.length < 10 || reason.length > 300) throw new Error("Support reason must contain 10 to 300 characters.");
  if (!await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId } as never)) throw new PublicationAccessDenied();
  await exitPublicationSupport(db, current, publicationId);
  const enteredAt = Date.now();
  const support: PublicationSupport = {
    _id: randomUUID(), publication_id: publicationId, principal_id: current.id,
    principal_email: current.email, reason, entered_at: enteredAt, expires_at: enteredAt + DURATION_MS, ended_at: null,
  };
  await appendPublicationAccessAudit(db, {
    publication_id: publicationId, principal_id: current.id, principal_email: current.email,
    capability: "publication:write", action: "support_entered",
    reason: `Support ${support._id}; expires ${support.expires_at}: ${reason}`,
  });
  await db.collection<PublicationSupport>(SUPPORT).insertOne(support);
  return support;
}

export async function exitPublicationSupport(db: Db, principal: Principal, publicationId: string) {
  const current = await operator(db, principal);
  await expireSupport(db, principal.id, publicationId);
  const open = await db.collection<PublicationSupport>(SUPPORT).find({
    principal_id: principal.id, publication_id: publicationId, ended_at: null,
  }).toArray();
  for (const support of open) {
    await appendPublicationAccessAudit(db, {
      publication_id: publicationId, principal_id: current.id, principal_email: current.email,
      capability: "publication:write", action: "support_exited",
      reason: `Support ${support._id} exited: ${support.reason}`,
    });
    await db.collection<PublicationSupport>(SUPPORT).updateOne(
      { _id: support._id, ended_at: null }, { $set: { ended_at: Date.now() } },
    );
  }
}
