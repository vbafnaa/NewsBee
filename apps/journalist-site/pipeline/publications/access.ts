import { MongoServerError, type ClientSession, type Db, type Document, type Filter } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import { appendPublicationAccessAudit } from "./audit";
import { activePublicationSupport } from "./support";
import { principalById } from "../accounts/identity";
import {
  PublicationAccessDenied,
  requirePublicationCapability,
  type PublicationCapability,
} from "./permissions";

export type PublicationMember = {
  principal_id: string;
  role: "editor";
};

export type PublicationRecord = {
  _id: string;
  owner_id: string;
  members?: PublicationMember[];
  name: string;
  selected_location_ids?: string[];
  allowed_location_ids?: string[];
  lifecycle_revision?: number;
  publication_scope_version?: 1;
};

export type PublicationContext<T extends PublicationRecord = PublicationRecord> = {
  id: string;
  ownerId: string;
  principalId: string;
  role: "owner" | "editor" | "privileged";
  publication: T;
  support?: { id: string; expiresAt: number; reason: string };
};

const indexPromises = new WeakMap<Db, Promise<void>>();
const privilegedContexts = new WeakMap<PublicationContext, {
  db: Db; id: string; principalId: string; ownerId: string; access: "read" | "write"; supportId?: string;
}>();

function issuedContext(context: PublicationContext) {
  const issued = privilegedContexts.get(context);
  return issued && issued.id === context.id && issued.principalId === context.principalId && issued.ownerId === context.ownerId
    ? issued : null;
}

async function ensureReleaseIdentityIndex(db: Db) {
  const collection = db.collection(COLLECTIONS.publicationDrafts);
  // A compound sparse index also indexes unpublished drafts because publication_id exists.
  await collection.createIndex({ publication_id: 1, "release.release_id": 1 }, {
    name: "publication_release_identity_v2",
    unique: true,
    partialFilterExpression: { "release.release_id": { $type: "string" } },
  });
  if (await collection.indexExists("publication_release_identity")) {
    try {
      await collection.dropIndex("publication_release_identity");
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 27)) throw error;
    }
  }
}

/**
 * Publishing channels are the publication records. This preserves existing feeds and URLs while
 * giving private child records a stable publication_id that is independent of the current login.
 */
export async function ensurePublicationIndexes(db: Db, force = false) {
  if (force) indexPromises.delete(db);
  let pending = indexPromises.get(db);
  if (!pending) {
    pending = Promise.all([
      db.collection(COLLECTIONS.outputChannels).createIndexes([
        { key: { owner_id: 1, name: 1, _id: 1 }, name: "publication_owner_list" },
        { key: { "members.principal_id": 1, name: 1, _id: 1 }, name: "publication_member_list" },
        { key: { enabled: 1, selected_location_ids: 1, _id: 1 }, name: "publication_location_publish" },
        { key: { drive_folder_id: 1, enabled: 1 }, name: "publication_reader_folder" },
        { key: { enabled: 1, "reader_publication.latest_published_at": -1, _id: 1 }, name: "publication_reader_recent" },
        { key: { enabled: 1, "reader_publication.location_ids": 1, "reader_publication.latest_published_at": -1, _id: 1 }, name: "publication_reader_location" },
      ]),
      db.collection(COLLECTIONS.outputChannelEditions).createIndexes([
        { key: { publication_id: 1, created_at: -1, _id: -1 }, name: "publication_editions_recent" },
        { key: { publication_id: 1, "stories.edition_id": 1 }, name: "publication_edition_stories" },
        { key: { owner_id: 1, channel_id: 1, created_at: -1 }, name: "legacy_channel_editions_recent" },
      ]),
      db.collection(COLLECTIONS.publicationAccessAudit).createIndexes([
        { key: { publication_id: 1, at: -1, _id: -1 }, name: "publication_access_audit" },
        { key: { principal_id: 1, at: -1, _id: -1 }, name: "principal_access_audit" },
      ]),
      db.collection(COLLECTIONS.publicationDrafts).createIndexes([
        { key: { publication_id: 1, created_at: -1, _id: -1 }, name: "publication_drafts_history" },
        { key: { publication_id: 1, editorial_status: 1, updated_at: -1 }, name: "publication_drafts_editorial_queue" },
        { key: { publication_id: 1, "release.published_at": -1, _id: -1 }, name: "publication_releases_recent" },
        { key: { publication_id: 1, "release.payload.items.location_ids": 1 }, name: "publication_release_locations" },
        { key: { publication_id: 1, "release.payload.items.source_references.location_id": 1, "release.payload.items.source_references.story_id": 1 }, name: "publication_release_sources" },
      ]),
      ensureReleaseIdentityIndex(db),
      db.collection(COLLECTIONS.publicationReleaseActions).createIndexes([
        { key: { publication_id: 1, release_id: 1, at: -1, _id: -1 }, name: "publication_release_actions_recent" },
      ]),
      db.collection(COLLECTIONS.publicationInterviewNotes).createIndexes([
        { key: { publication_id: 1, draft_id: 1, story_id: 1, updated_at: -1 }, name: "publication_interview_notes_story" },
      ]),
      db.collection(COLLECTIONS.publicationImages).createIndexes([
        { key: { publication_id: 1, draft_id: 1, removed_at: 1, story_id: 1, updated_at: -1 }, name: "publication_images_story" },
      ]),
    ]).then(() => undefined).catch((error: unknown) => {
      indexPromises.delete(db);
      throw error;
    });
    indexPromises.set(db, pending);
  }
  await pending;
}

export function publicationAccessFilter<T extends PublicationRecord>(principalId: string): Filter<T> {
  return {
    $or: [
      { owner_id: principalId },
      { "members.principal_id": principalId },
    ],
  } as Filter<T>;
}

export function accessiblePublicationFilter<T extends PublicationRecord>(principalId: string, publicationId: string): Filter<T> {
  return {
    _id: publicationId,
    ...publicationAccessFilter<T>(principalId),
  } as Filter<T>;
}

export function authorizedPublicationFilter<T extends PublicationRecord>(
  context: PublicationContext,
): Filter<T> {
  if (context.role !== "privileged") return accessiblePublicationFilter<T>(context.principalId, context.id);
  const issued = issuedContext(context);
  if (!issued || (issued.access === "write" && (!context.support || context.support.expiresAt <= Date.now()))) {
    throw new PublicationAccessDenied();
  }
  // Bind the owner snapshot too; ownership transfer invalidates an issued context.
  return { _id: context.id, owner_id: context.ownerId } as Filter<T>;
}

export async function assertPublicationWrite(
  db: Db,
  context: PublicationContext,
  action: string,
  options: { audit?: boolean; session?: ClientSession } = {},
) {
  if (context.role !== "privileged") {
    if (!await db.collection<PublicationRecord>(COLLECTIONS.outputChannels).findOne(
      accessiblePublicationFilter(context.principalId, context.id),
    )) throw new PublicationAccessDenied();
    return;
  }
  const issued = issuedContext(context);
  if (!issued || issued.db !== db || issued.access !== "write") throw new PublicationAccessDenied();
  const principal = await principalById(db, context.principalId);
  if (!principal) throw new PublicationAccessDenied();
  if (!await db.collection<PublicationRecord>(COLLECTIONS.outputChannels).findOne({
    _id: context.id, owner_id: context.ownerId,
  })) throw new PublicationAccessDenied();
  const support = await activePublicationSupport(db, principal, context.id);
  if (!support || support._id !== issued.supportId || support._id !== context.support?.id
    || support.expires_at <= Date.now()) throw new PublicationAccessDenied();
  const evidence = {
    publication_id: context.id, principal_id: principal.id, principal_email: principal.email,
    capability: "publication:write" as const, action: "privileged_write_access" as const,
    reason: `${action}; support ${support._id}; expires ${support.expires_at}: ${support.reason}`,
  };
  if (options.audit !== false) await appendPublicationAccessAudit(db, evidence, options.session);
  return { evidence, expiresAt: support.expires_at, supportId: support._id };
}

export async function resolvePublicationContext<T extends PublicationRecord>(
  db: Db,
  principalId: string,
  publicationId: string,
): Promise<PublicationContext<T> | null> {
  await ensurePublicationIndexes(db);
  const publication = await db.collection<T>(COLLECTIONS.outputChannels)
    .findOne(accessiblePublicationFilter<T>(principalId, publicationId));
  if (!publication) return null;

  if (publication.publication_scope_version !== 1) {
    await db.collection(COLLECTIONS.outputChannelEditions).updateMany(
      {
        publication_id: { $exists: false },
        channel_id: publication._id,
        owner_id: publication.owner_id,
      },
      { $set: { publication_id: publication._id } },
    );
    await db.collection(COLLECTIONS.outputChannels).updateOne(
      { _id: publication._id, owner_id: publication.owner_id },
      { $set: { publication_scope_version: 1 } },
    );
    publication.publication_scope_version = 1;
  }

  return {
    id: publication._id,
    ownerId: publication.owner_id,
    principalId,
    role: publication.owner_id === principalId ? "owner" : "editor",
    publication: publication as T,
  };
}

export async function resolvePrivilegedPublicationContext<T extends PublicationRecord>(
  db: Db,
  principal: {
    id: string;
    email: string;
    role: "owner" | "admin" | "editor";
    capabilities?: PublicationCapability[];
  },
  publicationId: string,
  reason: string,
  access: "read" | "write" = "read",
): Promise<PublicationContext<T> | null> {
  requirePublicationCapability(principal, "publication:inspect");
  if (access === "write") requirePublicationCapability(principal, "publication:write");
  const support = access === "write" ? await activePublicationSupport(db, principal, publicationId) : null;
  if (access === "write" && !support) throw new PublicationAccessDenied();
  await ensurePublicationIndexes(db);
  const publication = await db.collection<T>(COLLECTIONS.outputChannels).findOne({ _id: publicationId } as Filter<T>);
  if (!publication) return null;
  if (access === "read") await appendPublicationAccessAudit(db, {
    publication_id: publication._id,
    principal_id: principal.id,
    principal_email: principal.email,
    capability: "publication:inspect",
    action: "privileged_inspection",
    reason,
  });
  const context: PublicationContext<T> = {
    id: publication._id,
    ownerId: publication.owner_id,
    principalId: principal.id,
    role: "privileged",
    publication: publication as T,
    ...(support ? { support: { id: support._id, expiresAt: support.expires_at, reason: support.reason } } : {}),
  };
  privilegedContexts.set(context, { db, id: context.id, principalId: context.principalId, ownerId: context.ownerId, access, supportId: support?._id });
  return context;
}

export function publicationScopedFilter<T extends Document>(
  context: PublicationContext,
  filter: Filter<T> = {},
): Filter<T> {
  return { ...filter, publication_id: context.id } as Filter<T>;
}

export function compatiblePublicationScopedFilter<T extends Document>(
  context: PublicationContext,
  filter: Filter<T> = {},
): Filter<T> {
  const scope = {
    $or: [
      { publication_id: context.id },
      {
        publication_id: { $exists: false },
        channel_id: context.id,
        owner_id: context.ownerId,
      },
    ],
  };
  return Object.keys(filter).length
    ? { $and: [filter, scope] } as Filter<T>
    : scope as Filter<T>;
}

export function publicationOwnedDocument<T extends Document>(
  context: PublicationContext,
  document: T,
): T & { publication_id: string } {
  return { ...document, publication_id: context.id };
}

export function assertPublicationContext(context: PublicationContext, publicationId: string) {
  if (context.id !== publicationId) throw new PublicationAccessDenied();
}
