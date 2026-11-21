import { createHash, randomUUID } from "node:crypto";
import type { ClientSession, Db, Filter } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import type { PublicationMember, PublicationRecord } from "../publications/access";
import {
  blockSponsoredRuns,
  isOperator,
  normalizedEmail,
  ownerEmail,
  principalForEmail,
  resolvedAccountRole,
  type Account,
  type GlobalRole,
  type Principal,
} from "./identity";
import { createInvitation, createPasswordReset, ensurePasswordAuthIndexes, passwordSetupStatus, type PasswordStatus } from "./password-auth";

type AccessPublicationDocument = PublicationRecord & {
  enabled?: boolean;
  archived_at?: number;
  lifecycle_revision?: number;
};

export type AccessPublication = {
  id: string;
  name: string;
  enabled: boolean;
  archivedAt: number | null;
};

export type AccessAccount = {
  principalId: string;
  email: string;
  role: GlobalRole;
  enabled: boolean;
  revision: number;
  publicationIds: string[];
  passwordStatus?: PasswordStatus;
  recoveryStatus?: "pending" | "expired" | null;
};

export type AccessPolicySnapshot = {
  actor: Pick<Principal, "id" | "email" | "role">;
  accounts: AccessAccount[];
  publications: AccessPublication[];
};

type AccessState = Pick<AccessAccount, "role" | "enabled" | "revision" | "publicationIds">;

export type AccessPolicyAuditEvent = {
  _id: string;
  actor_principal_id: string;
  actor_email: string;
  actor_role: "owner" | "admin";
  target_principal_id: string;
  target_email: string;
  action: "account_created" | "invitation_created" | "password_reset_created" | "role_changed" | "status_changed" | "publication_assignments_changed" | "account_deleted";
  before: AccessState | null;
  after: AccessState | null;
  at: number;
  record_hash: string;
};

export class AccessPolicyError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 503) {
    super(message);
  }
}

const indexPromises = new WeakMap<Db, Promise<void>>();

async function ensureAccessPolicyIndexes(db: Db) {
  let pending = indexPromises.get(db);
  if (!pending) {
    pending = Promise.all([
      db.collection<Account>("journalist_admins").createIndexes([
        { key: { email: 1 }, unique: true, name: "email_1" },
        { key: { principalId: 1 }, unique: true, sparse: true, name: "journalist_account_principal" },
      ]),
      db.collection<AccessPolicyAuditEvent>(COLLECTIONS.accessPolicyAudit).createIndexes([
        { key: { target_principal_id: 1, at: -1, _id: -1 }, name: "access_policy_target_audit" },
        { key: { actor_principal_id: 1, at: -1, _id: -1 }, name: "access_policy_actor_audit" },
      ]),
    ]).then(() => undefined).catch((error: unknown) => {
      indexPromises.delete(db);
      throw error;
    });
    indexPromises.set(db, pending);
  }
  await pending;
}

function assertOperator(actor: Principal): asserts actor is Principal & { role: "owner" | "admin" } {
  if (!isOperator(actor)) throw new AccessPolicyError("Newsbee operator access required", 403);
}

function validEmail(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function auditHash(event: Omit<AccessPolicyAuditEvent, "record_hash">) {
  return createHash("sha256").update(JSON.stringify([
    event._id,
    event.actor_principal_id,
    event.actor_email,
    event.actor_role,
    event.target_principal_id,
    event.target_email,
    event.action,
    event.before,
    event.after,
    event.at,
  ])).digest("hex");
}

async function appendAccessPolicyAudit(
  db: Db,
  actor: Principal & { role: "owner" | "admin" },
  target: Pick<AccessAccount, "principalId" | "email">,
  action: AccessPolicyAuditEvent["action"],
  before: AccessState | null,
  after: AccessState | null,
  session: ClientSession,
) {
  const immutable = {
    _id: randomUUID(),
    actor_principal_id: actor.id,
    actor_email: actor.email,
    actor_role: actor.role,
    target_principal_id: target.principalId,
    target_email: target.email,
    action,
    before,
    after,
    at: Date.now(),
  };
  const event: AccessPolicyAuditEvent = { ...immutable, record_hash: auditHash(immutable) };
  await db.collection<AccessPolicyAuditEvent>(COLLECTIONS.accessPolicyAudit).insertOne(event, { session });
  return event;
}

async function accessPolicyTransaction<T>(db: Db, handler: (session: ClientSession) => Promise<T>) {
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

async function ensureConfiguredOwner(db: Db) {
  const email = ownerEmail();
  if (!email) throw new AccessPolicyError("NEWSBEE_OWNER_EMAIL must be configured before access policies can be managed", 503);
  const owner = await principalForEmail(db, email);
  if (!owner || owner.role !== "owner") throw new AccessPolicyError("The configured owner account could not be initialized", 503);
  return owner;
}

async function accountsWithStableIds(db: Db) {
  const accounts = db.collection<Account>("journalist_admins");
  const rows = await accounts.find({}).sort({ email: 1 }).toArray();
  for (const row of rows) {
    if (row.principalId) continue;
    await accounts.updateOne(
      { _id: row._id, principalId: { $exists: false } },
      { $set: { principalId: randomUUID(), updatedAt: new Date() }, $setOnInsert: { revision: 0 } },
    );
  }
  return accounts.find({}).sort({ email: 1 }).toArray();
}

async function assignmentsFor(db: Db, principalId: string, session?: ClientSession) {
  const rows = await db.collection<AccessPublicationDocument>(COLLECTIONS.outputChannels)
    .find({ "members.principal_id": principalId }, { projection: { _id: 1 }, ...(session ? { session } : {}) })
    .sort({ _id: 1 })
    .toArray();
  return rows.map(({ _id }) => _id);
}

async function ownedPublicationsFor(db: Db, principalId: string) {
  const rows = await db.collection<AccessPublicationDocument>(COLLECTIONS.outputChannels)
    .find({ owner_id: principalId }, { projection: { _id: 1 } })
    .sort({ _id: 1 })
    .toArray();
  return rows.map(({ _id }) => _id);
}

function accountView(account: Account & { principalId: string }, publicationIds: string[]): AccessAccount {
  return {
    principalId: account.principalId,
    email: normalizedEmail(account.email),
    role: resolvedAccountRole(account),
    enabled: account.email === ownerEmail() ? true : account.enabled === true,
    revision: account.revision ?? 0,
    publicationIds: [...publicationIds].sort(),
  };
}

export async function listAccessPolicy(db: Db, actor: Principal): Promise<AccessPolicySnapshot> {
  assertOperator(actor);
  await ensureAccessPolicyIndexes(db);
  await ensureConfiguredOwner(db);
  const [accounts, publications] = await Promise.all([
    accountsWithStableIds(db),
    db.collection<AccessPublicationDocument>(COLLECTIONS.outputChannels)
      .find({}, { projection: { _id: 1, name: 1, enabled: 1, archived_at: 1 } })
      .sort({ name: 1, _id: 1 })
      .toArray(),
  ]);
  const views = await Promise.all(accounts.map(async (account) => {
    if (!account.principalId) throw new AccessPolicyError("An account identity could not be initialized", 503);
    const role = resolvedAccountRole(account);
    const publicationIds = role === "owner"
      ? await ownedPublicationsFor(db, account.principalId)
      : await assignmentsFor(db, account.principalId);
    const stable = account as Account & { principalId: string };
    return { ...accountView(stable, publicationIds), ...await passwordSetupStatus(db, stable) };
  }));
  const order: Record<GlobalRole, number> = { owner: 0, admin: 1, editor: 2 };
  views.sort((left, right) => order[left.role] - order[right.role] || left.email.localeCompare(right.email));
  return {
    actor: { id: actor.id, email: actor.email, role: actor.role },
    accounts: views,
    publications: publications.map((publication) => ({
      id: publication._id,
      name: publication.name,
      enabled: publication.enabled !== false,
      archivedAt: typeof publication.archived_at === "number" ? publication.archived_at : null,
    })),
  };
}

export async function createEditorInvitation(db: Db, actor: Principal, rawEmail: string) {
  assertOperator(actor);
  await ensureAccessPolicyIndexes(db);
  await ensurePasswordAuthIndexes(db);
  await ensureConfiguredOwner(db);
  const email = normalizedEmail(rawEmail);
  if (!validEmail(email)) throw new AccessPolicyError("Enter a valid email address", 400);
  if (email === ownerEmail()) throw new AccessPolicyError("The configured owner already exists and cannot be reassigned", 403);

  return accessPolicyTransaction(db, async (session) => {
    const accounts = db.collection<Account>("journalist_admins");
    if (await accounts.findOne({ email }, { session })) {
      throw new AccessPolicyError("This account already exists; update its current access instead", 409);
    }
    const now = new Date();
    const account: Account & { principalId: string; role: "editor"; revision: number } = {
      email,
      principalId: randomUUID(),
      role: "editor",
      enabled: true,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await accounts.insertOne(account, { session });
    const after = accountView(account, []);
    await appendAccessPolicyAudit(db, actor, after, "account_created", null, after, session);
    const invitation = await createInvitation(db, actor, account, session);
    await appendAccessPolicyAudit(db, actor, after, "invitation_created", after, after, session);
    return { account: after, invitation };
  });
}

export async function createEditorAccount(db: Db, actor: Principal, rawEmail: string) {
  return (await createEditorInvitation(db, actor, rawEmail)).account;
}

export async function renewEditorInvitation(
  db: Db,
  actor: Principal,
  input: { targetPrincipalId: string; expectedRevision: number },
) {
  assertOperator(actor);
  await ensureAccessPolicyIndexes(db);
  await ensurePasswordAuthIndexes(db);
  await ensureConfiguredOwner(db);
  return accessPolicyTransaction(db, async (session) => {
    const stored = await db.collection<Account>("journalist_admins")
      .findOne({ principalId: input.targetPrincipalId }, { session });
    if (!stored?.principalId) throw new AccessPolicyError("Account not found", 404);
    const account = accountView(
      stored as Account & { principalId: string },
      await assignmentsFor(db, stored.principalId, session),
    );
    if (account.role !== "editor") throw new AccessPolicyError("Signup invitations apply only to editors", 403);
    if (actor.role === "admin" && account.role !== "editor") {
      throw new AccessPolicyError("Admins can invite editors only", 403);
    }
    if (account.revision !== input.expectedRevision) {
      throw new AccessPolicyError("Access changed since this page loaded; reload and try again", 409);
    }
    if (stored.username || stored.passwordHash) {
      throw new AccessPolicyError("This editor already has username and password credentials", 409);
    }
    if (!stored.enabled) throw new AccessPolicyError("Enable this account before issuing a signup link", 409);
    const renewed = await db.collection<Account>("journalist_admins").updateOne(
      revisionFilter(stored.principalId, account.revision),
      { $inc: { revision: 1 }, $set: { updatedAt: new Date() } },
      { session },
    );
    if (renewed.modifiedCount !== 1) throw new AccessPolicyError("Access changed; reload and try again", 409);
    await db.collection("journalist_account_invitations").deleteMany({
      principal_id: stored.principalId,
      used_at: null,
    }, { session });
    const invitation = await createInvitation(db, actor, stored as Account & { principalId: string }, session);
    const after = { ...account, revision: account.revision + 1 };
    await appendAccessPolicyAudit(db, actor, account, "invitation_created", account, after, session);
    return { account: after, invitation };
  });
}

export async function issueAccountPasswordReset(
  db: Db,
  actor: Principal,
  input: { targetPrincipalId: string; expectedRevision: number },
) {
  assertOperator(actor);
  if (!input.targetPrincipalId || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new AccessPolicyError("A valid account and revision are required", 400);
  }
  await ensureAccessPolicyIndexes(db);
  await ensurePasswordAuthIndexes(db);
  return accessPolicyTransaction(db, async (session) => {
    const accounts = db.collection<Account>("journalist_admins");
    const issuer = await accounts.findOne({ principalId: actor.id, enabled: true }, { session });
    const issuerRole = issuer && resolvedAccountRole(issuer);
    if (!issuer || (issuerRole !== "owner" && issuerRole !== "admin")) {
      throw new AccessPolicyError("Active operator access required", 403);
    }
    const stored = await accounts.findOne({ principalId: input.targetPrincipalId }, { session });
    if (!stored?.principalId) throw new AccessPolicyError("Account not found", 404);
    const before = accountView(stored as Account & { principalId: string }, await assignmentsFor(db, stored.principalId, session));
    if (before.role === "owner" || (issuerRole === "admin" && before.role !== "editor")) {
      throw new AccessPolicyError("Owners may recover admins and editors; admins may recover editors only", 403);
    }
    if (!before.enabled) throw new AccessPolicyError("Enable this account before issuing a recovery link", 409);
    if (before.revision !== input.expectedRevision) throw new AccessPolicyError("Access changed; reload and try again", 409);
    // Serialize issuance with issuer suspension/demotion and the per-issuer limit.
    await db.collection("journalist_admins").updateOne(
      { _id: issuer._id, enabled: true }, { $inc: { passwordResetIssueSequence: 1 } }, { session },
    );
    const recovery = await createPasswordReset(db, actor, stored as Account & { principalId: string }, session);
    const changed = await accounts.updateOne(revisionFilter(stored.principalId, before.revision), {
      $inc: { revision: 1 },
      $set: { passwordSetupExpiresAt: recovery.expiresAt, updatedAt: new Date() },
    }, { session });
    if (changed.modifiedCount !== 1) throw new AccessPolicyError("Access changed; reload and try again", 409);
    const after = { ...before, revision: before.revision + 1 };
    await appendAccessPolicyAudit(db, { ...actor, email: normalizedEmail(issuer.email), role: issuerRole },
      after, "password_reset_created", before, after, session);
    return { account: after, recovery };
  });
}

function revisionFilter(principalId: string, revision: number): Filter<Account> {
  return revision === 0
    ? { principalId, $or: [{ revision: 0 }, { revision: { $exists: false } }] }
    : { principalId, revision };
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export type AccessPolicyUpdate = {
  targetPrincipalId: string;
  expectedRevision: number;
  role?: "admin" | "editor";
  enabled?: boolean;
  publicationIds?: string[];
};

export async function updateAccessPolicy(db: Db, actor: Principal, input: AccessPolicyUpdate) {
  assertOperator(actor);
  await ensureAccessPolicyIndexes(db);
  await ensureConfiguredOwner(db);
  if (!input.targetPrincipalId || input.targetPrincipalId.length > 200) {
    throw new AccessPolicyError("Select a valid account", 400);
  }

  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new AccessPolicyError("A valid account revision is required", 400);
  }
  if (input.role !== undefined && input.role !== "admin" && input.role !== "editor") {
    throw new AccessPolicyError("Choose Admin or Editor", 400);
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new AccessPolicyError("Invalid enabled state", 400);
  }
  if (input.publicationIds !== undefined && (
    !Array.isArray(input.publicationIds)
    || input.publicationIds.length > 1000
    || input.publicationIds.some((id) => typeof id !== "string" || !id || id.length > 256)
  )) {
    throw new AccessPolicyError("Choose valid publication assignments", 400);
  }

  return accessPolicyTransaction(db, async (session) => {
    const accounts = db.collection<Account>("journalist_admins");
    const stored = await accounts.findOne({ principalId: input.targetPrincipalId }, { session });
    if (!stored?.principalId) throw new AccessPolicyError("Account not found", 404);
    const beforePublications = await assignmentsFor(db, stored.principalId, session);
    const before = accountView(stored as Account & { principalId: string }, beforePublications);
    if (before.role === "owner") throw new AccessPolicyError("The configured owner is immutable", 403);
    if (before.revision !== input.expectedRevision) throw new AccessPolicyError("Access changed since this page loaded; reload and try again", 409);
    if (actor.role === "admin" && before.role !== "editor") {
      throw new AccessPolicyError("Admins can manage editors but cannot modify the owner or other admins", 403);
    }
    if (input.role !== undefined && actor.role !== "owner") {
      throw new AccessPolicyError("Only the owner may promote or demote global admins", 403);
    }
    if (input.role !== undefined && (input.enabled !== undefined || input.publicationIds !== undefined)) {
      throw new AccessPolicyError("Change the global role separately from status or publication assignments", 400);
    }

    const nextRole = input.role ?? before.role;
    const promotingToAdmin = before.role === "editor" && nextRole === "admin";
    if (promotingToAdmin && !before.enabled) {
      throw new AccessPolicyError("Enable this editor before promoting them to Admin", 409);
    }

    let nextPublications = input.publicationIds === undefined
      ? before.publicationIds
      : [...new Set(input.publicationIds)].sort();
    if (promotingToAdmin) nextPublications = [];
    if (input.publicationIds !== undefined && nextRole !== "editor" && actor.role !== "owner") {
      throw new AccessPolicyError("Only the workspace owner may deliberately assign admins", 403);
    }
    if (input.publicationIds !== undefined && !before.enabled && !sameIds(before.publicationIds, nextPublications)) {
      throw new AccessPolicyError("Disabled accounts cannot receive publication assignments; re-enable the account first", 409);
    }
    if (input.publicationIds !== undefined) {
      const count = await db.collection<AccessPublicationDocument>(COLLECTIONS.outputChannels)
        .countDocuments({ _id: { $in: nextPublications } }, { session });
      if (count !== nextPublications.length) {
        throw new AccessPolicyError("One or more publications no longer exist; reload and try again", 409);
      }
    }

    const nextEnabled = input.enabled ?? before.enabled;
    const roleChanged = nextRole !== before.role;
    const statusChanged = nextEnabled !== before.enabled;
    const assignmentsChanged = !sameIds(before.publicationIds, nextPublications);
    if (!roleChanged && !statusChanged && !assignmentsChanged) {
      throw new AccessPolicyError("No access changes were requested", 400);
    }

    const revision = before.revision + 1;
    const result = await accounts.updateOne(revisionFilter(stored.principalId, before.revision), {
      $set: { role: nextRole, enabled: nextEnabled, revision, updatedAt: new Date() },
    }, { session });
    if (result.modifiedCount !== 1) {
      throw new AccessPolicyError("Access changed since this page loaded; reload and try again", 409);
    }

    if (roleChanged) {
      await db.collection("journalist_password_resets").deleteMany({ principal_id: stored.principalId }, { session });
      await db.collection("journalist_account_invitations").deleteMany({ principal_id: stored.principalId }, { session });
    }
    if (assignmentsChanged) {
      const publications = db.collection<AccessPublicationDocument>(COLLECTIONS.outputChannels);
      await publications.updateMany(
        { "members.principal_id": stored.principalId },
        { $pull: { members: { principal_id: stored.principalId } as PublicationMember }, $inc: { lifecycle_revision: 1 } },
        { session },
      );
      if (nextPublications.length) {
        await publications.updateMany(
          { _id: { $in: nextPublications } },
          { $addToSet: { members: { principal_id: stored.principalId, role: "editor" } }, $inc: { lifecycle_revision: 1 } },
          { session },
        );
      }
    }
    if (statusChanged && !nextEnabled) {
      await blockSponsoredRuns(
        db,
        stored.principalId,
        "The sponsoring account was disabled. Reenabling access does not reconnect this run.",
        false,
        session,
      );
    }

    const after: AccessState = { role: nextRole, enabled: nextEnabled, revision, publicationIds: nextPublications };
    const target = { principalId: stored.principalId, email: before.email };
    if (roleChanged) await appendAccessPolicyAudit(db, actor, target, "role_changed", before, after, session);
    if (statusChanged) await appendAccessPolicyAudit(db, actor, target, "status_changed", before, after, session);
    if (assignmentsChanged) {
      await appendAccessPolicyAudit(db, actor, target, "publication_assignments_changed", before, after, session);
    }
    return { ...target, ...after };
  });
}

const principalOwnedCollections: Array<{ name: string; filter: (principalId: string) => Record<string, string> }> = [
  { name: "journalist_credentials", filter: (principalId: string) => ({ _id: principalId }) },
  { name: "youtube_location_settings", filter: (principalId: string) => ({ principal_id: principalId }) },
];

export async function deleteAccessAccount(
  db: Db,
  actor: Principal,
  input: { targetPrincipalId: string; expectedRevision: number },
) {
  assertOperator(actor);
  await ensureAccessPolicyIndexes(db);
  await ensureConfiguredOwner(db);
  if (!input.targetPrincipalId || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new AccessPolicyError("A valid account and revision are required", 400);
  }
  return accessPolicyTransaction(db, async (session) => {
    const accounts = db.collection<Account>("journalist_admins");
    const stored = await accounts.findOne({ principalId: input.targetPrincipalId }, { session });
    if (!stored?.principalId) throw new AccessPolicyError("Account not found", 404);
    const before = accountView(
      stored as Account & { principalId: string },
      await assignmentsFor(db, stored.principalId, session),
    );
    if (before.role === "owner" || before.email === ownerEmail()) {
      throw new AccessPolicyError("The configured owner cannot be deleted", 403);
    }
    if (actor.role === "admin" && before.role !== "editor") {
      throw new AccessPolicyError("Admins can delete editors but cannot delete other admins", 403);
    }
    if (before.revision !== input.expectedRevision) {
      throw new AccessPolicyError("Access changed since this page loaded; reload and try again", 409);
    }
    const ownedPublications = await db.collection<AccessPublicationDocument>(COLLECTIONS.outputChannels)
      .find({ owner_id: stored.principalId }, { projection: { _id: 1 }, session })
      .toArray();
    if (ownedPublications.length) {
      throw new AccessPolicyError(
        `This account owns ${ownedPublications.length} publication${ownedPublications.length === 1 ? "" : "s"}; transfer or delete them before deleting the account`,
        409,
      );
    }

    await blockSponsoredRuns(
      db,
      stored.principalId,
      "The sponsoring account was permanently deleted. This run cannot be reconnected.",
      false,
      session,
    );
    await db.collection(COLLECTIONS.videoJobs).updateMany({
      requested_by: stored.principalId,
      status: { $in: ["submitting", "queued", "processing", "uploading"] },
    }, {
      $set: {
        status: "failed",
        error: "The requesting account was permanently deleted.",
        updated_at: Date.now(),
      },
    }, { session });
    await db.collection<AccessPublicationDocument>(COLLECTIONS.outputChannels).updateMany(
      { "members.principal_id": stored.principalId },
      { $pull: { members: { principal_id: stored.principalId } as PublicationMember }, $inc: { lifecycle_revision: 1 } },
      { session },
    );
    const uploads = await db.collection<{ _id: string }>(COLLECTIONS.videoUploadSessions)
      .find({ owner_id: stored.principalId } as Record<string, string>, { projection: { _id: 1 }, session })
      .toArray();
    if (uploads.length) {
      await db.collection<{ _id: string }>(COLLECTIONS.videoUploadChunks).deleteMany({
        _id: { $regex: `^(?:${uploads.map(({ _id }) => _id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}):` },
      }, { session });
    }
    await db.collection(COLLECTIONS.videoUploadSessions).deleteMany({ owner_id: stored.principalId }, { session });
    for (const owned of principalOwnedCollections) {
      await db.collection(owned.name).deleteMany(owned.filter(stored.principalId), { session });
    }
    await db.collection<{ _id: string }>("google_drive_consents").deleteMany({ _id: before.email }, { session });
    await db.collection("journalist_account_invitations").deleteMany({ principal_id: stored.principalId }, { session });
    await db.collection("journalist_password_resets").deleteMany({ principal_id: stored.principalId }, { session });
    const result = await accounts.deleteOne(revisionFilter(stored.principalId, before.revision), { session });
    if (result.deletedCount !== 1) {
      throw new AccessPolicyError("Access changed since this page loaded; reload and try again", 409);
    }
    await appendAccessPolicyAudit(db, actor, before, "account_deleted", before, null, session);
    return { principalId: before.principalId, email: before.email };
  });
}

export function accessPolicyAuditIsIntact(event: AccessPolicyAuditEvent) {
  const { record_hash: recordHash, ...immutable } = event;
  return recordHash === auditHash(immutable);
}
