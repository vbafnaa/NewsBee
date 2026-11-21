import type { Db, Document } from "mongodb";
import { AccessPolicyError, accessPolicyAuditIsIntact, type AccessPolicyAuditEvent } from "../accounts/access-policy";
import { isConfiguredOwner, principalById, type Principal } from "../accounts/identity";
import { COLLECTIONS } from "../storage/mongo";
import { publicationAccessAuditIsIntact, type PublicationAccessAuditEvent, type PublicationChangeAuditEvent } from "./audit";
import { boundedRestoreEvidence } from "./restore-evidence";
import { safeError } from "../core/redaction";

const indexes = new WeakMap<Db, Promise<void>>();

async function ensureAuditIndexes(db: Db) {
  let pending = indexes.get(db);
  if (!pending) {
    pending = Promise.all([COLLECTIONS.accessPolicyAudit, COLLECTIONS.publicationAccessAudit].map((collection) =>
      db.collection(collection).createIndex({ at: -1, _id: -1 }, { name: "governance_audit_recent" }),
    )).then(() => undefined).catch((error: unknown) => { indexes.delete(db); throw error; });
    indexes.set(db, pending);
  }
  await pending;
}

type Kind = "access_policy" | "publication";
type Position = { at: number; id: string; kind: Kind };
export type GovernanceAuditFilter = {
  limit?: number; cursor?: string; publicationId?: string; actorId?: string;
  targetId?: string; action?: string; from?: number; to?: number; kind?: Kind;
};

function cursorPosition(cursor?: string): Position | null {
  if (!cursor) return null;
  if (cursor.length > 1000) throw new AccessPolicyError("Invalid audit cursor", 400);
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Position;
    if (!Number.isSafeInteger(value.at) || value.at < 0 || typeof value.id !== "string"
      || !value.id || value.id.length > 200 || !["access_policy", "publication"].includes(value.kind)) throw new Error();
    return value;
  } catch { throw new AccessPolicyError("Invalid audit cursor", 400); }
}

function safeState(value: AccessPolicyAuditEvent["before"]) {
  if (!value) return null;
  return {
    role: ["owner", "admin", "editor"].includes(value.role) ? value.role : null,
    enabled: typeof value.enabled === "boolean" ? value.enabled : null,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : null,
    publicationIds: Array.isArray(value.publicationIds)
      ? value.publicationIds.filter((id) => typeof id === "string" && id.length <= 200).slice(0, 1000) : [],
  };
}

function integrityStatus(hash: unknown, intact: boolean) {
  return typeof hash !== "string" || !hash ? "legacy_unknown" as const : intact ? "verified" as const : "mismatch" as const;
}

export async function listGovernanceAudit(db: Db, actor: Principal, input: GovernanceAuditFilter = {}) {
  const current = await principalById(db, actor.id);
  if (!current || !isConfiguredOwner(current)) throw new AccessPolicyError("Enabled workspace owner required", 403);
  const limit = input.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AccessPolicyError("Audit limit must be 1 to 100", 400);
  for (const value of [input.publicationId, input.actorId, input.targetId, input.action]) {
    if (value !== undefined && (typeof value !== "string" || !value || value.length > 200)) {
      throw new AccessPolicyError("Invalid audit filter", 400);
    }
  }
  for (const value of [input.from, input.to]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new AccessPolicyError("Audit times must be epoch milliseconds", 400);
  }
  if (input.kind && !["access_policy", "publication"].includes(input.kind)) throw new AccessPolicyError("Invalid audit kind", 400);
  if (input.from !== undefined && input.to !== undefined && input.from > input.to) throw new AccessPolicyError("Invalid audit time range", 400);
  const cursor = cursorPosition(input.cursor);
  const query = (kind: Kind): Document => {
    const clauses: Document[] = [];
    if (input.from !== undefined) clauses.push({ at: { $gte: input.from } });
    if (input.to !== undefined) clauses.push({ at: { $lte: input.to } });
    if (input.actorId) clauses.push({ [kind === "access_policy" ? "actor_principal_id" : "principal_id"]: input.actorId });
    if (input.targetId) clauses.push(kind === "access_policy" ? { target_principal_id: input.targetId } : {
      $or: [{ resource_id: input.targetId }, { target_principal_id: input.targetId }, { previous_owner_id: input.targetId }],
    });
    if (input.action) clauses.push({ action: input.action });
    if (input.publicationId) clauses.push(kind === "publication" ? { publication_id: input.publicationId } : {
      $or: [{ "before.publicationIds": input.publicationId }, { "after.publicationIds": input.publicationId }],
    });
    if (cursor) clauses.push({ $or: [
      { at: { $lt: cursor.at } },
      { at: cursor.at, _id: { $lt: cursor.id } },
      ...(kind < cursor.kind ? [{ at: cursor.at, _id: cursor.id }] : []),
    ] });
    return clauses.length ? { $and: clauses } : {};
  };
  await ensureAuditIndexes(db);
  const [accounts, publications] = await Promise.all([
    input.kind === "publication" ? [] : db.collection<AccessPolicyAuditEvent>(COLLECTIONS.accessPolicyAudit)
      .find(query("access_policy"), { projection: {
        _id: 1, actor_principal_id: 1, actor_email: 1, actor_role: 1,
        target_principal_id: 1, target_email: 1, action: 1,
        // Historical hashes include the entire stored snapshots, including field order.
        before: 1, after: 1,
        at: 1, record_hash: 1,
      } }).sort({ at: -1, _id: -1 }).limit(limit + 1).toArray(),
    input.kind === "access_policy" ? [] : db.collection<PublicationAccessAuditEvent | PublicationChangeAuditEvent>(COLLECTIONS.publicationAccessAudit)
      .find(query("publication"), { projection: {
        _id: 1, publication_id: 1, principal_id: 1, principal_email: 1, capability: 1,
        action: 1, reason: 1, resource_id: 1, detail: 1, before_hash: 1, after_hash: 1, at: 1, record_hash: 1,
        target_principal_id: 1, target_email: 1, previous_owner_id: 1, previous_owner_email: 1, former_owner_membership: 1,
      } }).sort({ at: -1, _id: -1 }).limit(limit + 1).toArray(),
  ]);
  const records = [
    ...accounts.map((event) => {
      const entryIntegrity = accessPolicyAuditIsIntact(event);
      return {
        kind: "access_policy" as const, id: event._id, at: event.at, action: event.action,
        actor: { principalId: event.actor_principal_id, email: event.actor_email, role: event.actor_role },
        target: { principalId: event.target_principal_id, email: event.target_email },
        before: safeState(event.before), after: safeState(event.after),
        entryIntegrity, integrityStatus: integrityStatus(event.record_hash, entryIntegrity),
      };
    }),
    ...publications.map((event) => {
      const entryIntegrity = publicationAccessAuditIsIntact(event);
      return {
        kind: "publication" as const, recordType: "capability" in event ? "access" as const : "change" as const,
        id: event._id, at: event.at, action: event.action, publicationId: event.publication_id,
        actor: { principalId: event.principal_id, email: event.principal_email },
        ...("capability" in event
          ? { capability: event.capability, reason: safeError(event.reason) }
          : {
            resourceId: event.resource_id, detail: safeError(event.detail), beforeHash: event.before_hash, afterHash: event.after_hash,
            ...(event.target_principal_id ? { target: { principalId: event.target_principal_id, email: event.target_email ?? "" } } : {}),
            ...(event.previous_owner_id ? { previousOwner: { principalId: event.previous_owner_id, email: event.previous_owner_email ?? "" } } : {}),
            ...(event.former_owner_membership ? { formerOwnerMembership: event.former_owner_membership } : {}),
          }),
        entryIntegrity, integrityStatus: integrityStatus(event.record_hash, entryIntegrity),
      };
    }),
  ].sort((a, b) => b.at - a.at || (a.id === b.id
    ? a.kind === b.kind ? 0 : a.kind > b.kind ? -1 : 1
    : a.id > b.id ? -1 : 1));
  const page = records.slice(0, limit);
  const last = page.at(-1);
  // Deliberately no publication-list service call: rendering audit must never generate read-audit recursion.
  return {
    records: page,
    nextCursor: records.length > limit && last
      ? Buffer.from(JSON.stringify({ at: last.at, id: last.id, kind: last.kind })).toString("base64url") : null,
    integrityScope: "per_entry" as const,
    timeUnit: "milliseconds" as const,
    restoreEvidence: await boundedRestoreEvidence(db),
  };
}
