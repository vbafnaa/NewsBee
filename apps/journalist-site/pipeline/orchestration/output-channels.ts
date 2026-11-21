import type { ClientSession, Db } from "mongodb";
import { createHash, randomUUID } from "node:crypto";
import { principalById, type Principal } from "../accounts/identity";
import type { LocationProfile } from "../connectors/types";
import type { ArtifactStore } from "../storage/artifacts";
import { COLLECTIONS } from "../storage/mongo";
import { channelArtifactStore } from "../storage/mongo-channel-artifacts";
import {
  appendPublicationAccessAudit,
  appendPublicationChangeAudit,
  publicationChangeTransaction,
} from "../publications/audit";
import {
  accessiblePublicationFilter,
  assertPublicationContext,
  assertPublicationWrite,
  authorizedPublicationFilter,
  compatiblePublicationScopedFilter,
  ensurePublicationIndexes,
  publicationAccessFilter,
  publicationOwnedDocument,
  resolvePublicationContext,
  resolvePrivilegedPublicationContext,
  type PublicationContext,
  type PublicationMember,
  type PublicationRecord,
} from "../publications/access";
import { hasPublicationCapability, PublicationAccessDenied, type PublicationCapability } from "../publications/permissions";
import { ensurePublicationGovernance, publicationLifecycleFilter, PublicationLifecycleConflict } from "../publications/lifecycle";
import {
  decoratePublicationEdition,
  type PublicationSettingsDocument,
} from "../publications/settings";
import type {
  PublicationReleaseLocation,
  PublicationReleasePayloadV1,
} from "../../../../shared/publication-release";

export type OutputChannelDocument = PublicationSettingsDocument & {
  members?: PublicationMember[];
  name: string;
  url?: string;
  destinations?: OutputDestination[];
  destination?: "reader" | "video";
  drive_folder_id: string;
  enabled: boolean;
  archived_at?: number;
  archived_by?: string;
  archived_was_enabled?: boolean;
  selected_location_ids: string[];
  allowed_location_ids?: string[];
  lifecycle_revision?: number;
  published_location_ids: string[];
  reader_publication?: {
    manifest_file_id: string;
    manifest_revision: number;
    latest_release_id: string | null;
    latest_published_at: number | null;
    latest_title?: string | null;
    latest_window_start?: string | null;
    latest_window_end?: string | null;
    location_ids: string[];
    locations: PublicationReleaseLocation[];
    publication: PublicationReleasePayloadV1["publication"] | null;
  };
  reader_manifest_claim?: {
    token: string;
    claimed_at: number;
  };
  video_prompt_template?: string;
};

export type OutputDestination = { type: "reader" | "video"; url: string };

export type OutputChannelInput = {
  name: string;
  destinations: OutputDestination[];
  enabled: boolean;
  selectedLocationIds: string[];
};

export type OutputChannel = OutputChannelInput & {
  id: string;
  archivedAt: number | null;
  allowedLocationIds: string[];
  lifecycleRevision: number;
  driveFolderId: string;
  videoPromptTemplate?: string;
};

export type NewsroomDirectoryEntry = Pick<OutputChannel, "id" | "name" | "enabled" | "archivedAt" | "selectedLocationIds" | "lifecycleRevision"> & {
  destinations: Pick<OutputDestination, "type">[];
  accessMode: "direct" | "inspection";
};

export async function listOutputChannelDirectory(db: Db, principal: PublicationPrincipal): Promise<NewsroomDirectoryEntry[]> {
  const rows = await outputChannels(db).find(
    hasPublicationCapability(principal, "publication:inspect") ? {} : publicationAccessFilter(principal.id),
    { projection: { _id: 1, name: 1, owner_id: 1, members: 1, enabled: 1, selected_location_ids: 1,
      destinations: 1, destination: 1, archived_at: 1, lifecycle_revision: 1 } },
  ).sort({ name: 1, _id: 1 }).toArray();
  return rows.map((row) => ({
    id: row._id, name: row.name, enabled: row.enabled,
    archivedAt: typeof row.archived_at === "number" ? row.archived_at : null, lifecycleRevision: row.lifecycle_revision ?? 0,
    selectedLocationIds: row.selected_location_ids ?? [], destinations: channelDestinations(row).map(({ type }) => ({ type })),
    accessMode: row.owner_id === principal.id || row.members?.some((member) => member.principal_id === principal.id)
      ? "direct" : "inspection",
  }));
}

export type ChannelEditionStory = {
  location_id: string;
  location_name: string;
  edition_id: string;
  story_id: string;
  headline: string;
  blurb: string;
  event_date: string;
  source_url: string | null;
};

export type OutputChannelEditionDocument = {
  _id: string;
  publication_id?: string;
  owner_id: string;
  channel_id: string;
  title: string;
  output_modes: Array<"reader" | "video">;
  created_at: number;
  stories: ChannelEditionStory[];
  video_stories: Array<{ location_id: string; story_id: string }>;
  edition_ids: string[];
  per_story?: boolean;
};

export type ChannelReaderEdition = {
  id: string;
  location_id: string;
  location_name: string;
  window_start: string;
  window_end: string;
  published_at: number;
  headline: string;
  intro: string;
  items: Array<Record<string, unknown>>;
  coverage: string[];
  corrections: Array<{ story_id?: string; reason: string; created_at: number }>;
};

export type PublishableEdition = { id: string; location_id: string } & Record<string, unknown>;

export function outputChannels(db: Db) {
  return db.collection<OutputChannelDocument>(COLLECTIONS.outputChannels);
}

export type OutputChannelAccess = {
  context: PublicationContext<OutputChannelDocument>;
  channel: OutputChannel;
};

export function outputChannelConfigurationHash(channel: OutputChannel) {
  return createHash("sha256").update(JSON.stringify({
    name: channel.name, destinations: channel.destinations, enabled: channel.enabled,
    ...(channel.archivedAt != null ? { archivedAt: channel.archivedAt } : {}),
    selectedLocationIds: [...channel.selectedLocationIds].sort(),
    allowedLocationIds: [...channel.allowedLocationIds].sort(),
    lifecycleRevision: channel.lifecycleRevision,
  })).digest("hex");
}

function fromDocument(channel: OutputChannelDocument): OutputChannel {
  return {
    id: channel._id,
    name: channel.name,
    destinations: channelDestinations(channel),
    enabled: channel.enabled,
    archivedAt: typeof channel.archived_at === "number" ? channel.archived_at : null,
    selectedLocationIds: channel.selected_location_ids ?? [],
    allowedLocationIds: channel.allowed_location_ids ?? channel.selected_location_ids ?? [],
    lifecycleRevision: channel.lifecycle_revision ?? 0,
    driveFolderId: channel.drive_folder_id,
    ...(channel.video_prompt_template ? { videoPromptTemplate: channel.video_prompt_template } : {}),
  };
}

function channelDestinations(channel: OutputChannelDocument): OutputDestination[] {
  if (channel.destinations?.length) return channel.destinations;
  return [{ type: channel.destination ?? "reader", url: channel.url ?? "" }];
}

function hasReaderDestination(channel: OutputChannelDocument) {
  return channelDestinations(channel).some((destination) => destination.type === "reader");
}

export async function listOutputChannels(db: Db, principalId: string) {
  await ensurePublicationIndexes(db);
  const rows = await outputChannels(db).find(publicationAccessFilter<OutputChannelDocument>(principalId))
    .sort({ name: 1, _id: 1 }).toArray();
  await Promise.all(rows.map((row) => ensurePublicationGovernance(db, row._id)));
  return rows.map(fromDocument);
}

type PublicationPrincipal = {
  id: string;
  email: string;
  role: "owner" | "admin" | "editor";
  capabilities?: PublicationCapability[];
};

export async function listOutputChannelsForPrincipal(
  db: Db,
  principal: PublicationPrincipal,
  reason: string,
) {
  await ensurePublicationIndexes(db);
  const directRows = await outputChannels(db).find(publicationAccessFilter<OutputChannelDocument>(principal.id))
    .sort({ name: 1, _id: 1 }).toArray();
  await Promise.all(directRows.map((row) => ensurePublicationGovernance(db, row._id)));
  if (!hasPublicationCapability(principal, "publication:inspect")) return directRows.map(fromDocument);
  const directIds = new Set(directRows.map((row) => row._id));
  const rows = await outputChannels(db).find({}).sort({ name: 1, _id: 1 }).toArray();
  await Promise.all(rows.map((row) => ensurePublicationGovernance(db, row._id)));
  for (const row of rows) {
    if (directIds.has(row._id)) continue;
    await appendPublicationAccessAudit(db, {
      publication_id: row._id,
      principal_id: principal.id,
      principal_email: principal.email,
      capability: "publication:inspect",
      action: "privileged_inspection",
      reason,
    });
  }
  return rows.map(fromDocument);
}

export async function resolveOutputChannel(db: Db, principalId: string, id: string): Promise<OutputChannelAccess | null> {
  const context = await resolvePublicationContext<OutputChannelDocument>(db, principalId, id);
  if (context) {
    await ensurePublicationGovernance(db, id);
    context.publication.allowed_location_ids ??= [...context.publication.selected_location_ids ?? []];
    context.publication.lifecycle_revision ??= 0;
  }
  return context ? { context, channel: fromDocument(context.publication) } : null;
}

export async function resolveOutputChannelForPrincipal(
  db: Db,
  principal: PublicationPrincipal,
  id: string,
  reason: string,
  access: "read" | "write" = "read",
): Promise<OutputChannelAccess | null> {
  const direct = await resolveOutputChannel(db, principal.id, id);
  if (direct) return direct;
  if (!hasPublicationCapability(principal, "publication:inspect")) return null;
  const context = await resolvePrivilegedPublicationContext<OutputChannelDocument>(db, principal, id, reason, access);
  return context ? { context, channel: fromDocument(context.publication) } : null;
}

export async function getOutputChannel(db: Db, principalId: string, id: string) {
  return (await resolveOutputChannel(db, principalId, id))?.channel ?? null;
}

export async function listOutputChannelEditions(db: Db, context: PublicationContext) {
  return db.collection<OutputChannelEditionDocument>(COLLECTIONS.outputChannelEditions)
    .find(compatiblePublicationScopedFilter<OutputChannelEditionDocument>(context))
    .sort({ created_at: -1, _id: -1 })
    .limit(30)
    .toArray();
}

export async function clearOutputChannelEditions(db: Db, store: ArtifactStore, channel: OutputChannelDocument) {
  const scope = {
    id: channel._id,
    ownerId: channel.owner_id,
    principalId: channel.owner_id,
    role: "owner" as const,
    publication: channel,
  };
  await resolvePublicationContext<OutputChannelDocument>(db, channel.owner_id, channel._id);
  const editions = await db.collection<OutputChannelEditionDocument>(COLLECTIONS.outputChannelEditions)
    .find(compatiblePublicationScopedFilter<OutputChannelEditionDocument>(scope))
    .toArray();
  for (const edition of editions) {
    for (let index = 0; index < edition.edition_ids.length; index += 1) {
      await channelArtifactStore(db, store, channel.drive_folder_id).removeFile(channel.drive_folder_id, `channel-edition-${edition._id}-${index + 1}.json`);
    }
  }
  await db.collection<OutputChannelEditionDocument>(COLLECTIONS.outputChannelEditions)
    .deleteMany(compatiblePublicationScopedFilter<OutputChannelEditionDocument>(scope));
}

export async function publishedChannelStories(db: Db, context: PublicationContext, editionIds: string[]) {
  if (!editionIds.length) return new Set<string>();
  const editions = await db.collection<OutputChannelEditionDocument>(COLLECTIONS.outputChannelEditions)
    .find(compatiblePublicationScopedFilter<OutputChannelEditionDocument>(context, {
      output_modes: "reader",
      "stories.edition_id": { $in: editionIds },
    }))
    .project<Pick<OutputChannelEditionDocument, "stories">>({ stories: 1 }).toArray();
  const current = new Set(editionIds);
  return new Set(editions.flatMap(({ stories }) => stories
    .filter((story) => current.has(story.edition_id))
    .map((story) => `${story.location_id}:${story.edition_id}:${story.story_id}`)));
}

export async function createOutputChannelEdition(
  db: Db,
  store: ArtifactStore,
  channel: OutputChannelDocument,
  context: PublicationContext,
  title: string,
  stories: ChannelEditionStory[],
  outputModes: Array<"reader" | "video">,
  videoStories: Array<{ location_id: string; story_id: string }>,
  editions: ChannelReaderEdition[],
  perStory = false,
) {
  assertPublicationContext(context, channel._id);
  await assertPublicationWrite(db, context, "create_publication_edition");
  const id = randomUUID().replaceAll("-", "");
  const editionIds = editions.map((_, index) => `${id}-${index + 1}`);
  const document: OutputChannelEditionDocument = publicationOwnedDocument(context, {
    _id: id,
    owner_id: channel.owner_id,
    channel_id: channel._id,
    title,
    output_modes: outputModes,
    created_at: Date.now(),
    stories,
    video_stories: videoStories,
    edition_ids: editionIds,
    ...(perStory ? { per_story: true } : {}),
  });
  for (const [index, edition] of editions.entries()) {
    const payload = decoratePublicationEdition(channel, {
      ...edition,
      id: editionIds[index],
    });
    await channelArtifactStore(db, store, channel.drive_folder_id).saveJson(channel.drive_folder_id, `channel-edition-${document._id}-${index + 1}.json`, {
      ...payload,
    });
  }
  await db.collection<OutputChannelEditionDocument>(COLLECTIONS.outputChannelEditions).insertOne(document);
  if (editions.length) {
    for (const locationId of new Set(editions.map((edition) => edition.location_id))) {
      await outputChannels(db).updateOne(authorizedPublicationFilter(context), {
        $addToSet: { published_location_ids: locationId },
      });
    }
    const fresh = await outputChannels(db).findOne(authorizedPublicationFilter(context));
    if (fresh) await writeOutputChannelDirectory(db, store, fresh);
  }
  return document;
}

export async function latestChannelStoryEdition(
  db: Db,
  store: ArtifactStore,
  channel: OutputChannelDocument,
  context: PublicationContext,
  locationId: string,
) {
  assertPublicationContext(context, channel._id);
  const previous = await db.collection<OutputChannelEditionDocument>(COLLECTIONS.outputChannelEditions)
    .find(compatiblePublicationScopedFilter<OutputChannelEditionDocument>(context, {
      per_story: true,
      output_modes: "reader",
      "stories.location_id": locationId,
    }))
    .sort({ created_at: -1, _id: -1 }).limit(1).next();
  if (!previous) return null;
  const name = `channel-edition-${previous._id}-1.json`;
  const files = channelArtifactStore(db, store, channel.drive_folder_id);
  const file = (await files.list(channel.drive_folder_id)).find((item) => item.name === name);
  if (!file) throw new Error(`Published channel story file ${name} is missing.`);
  return { stories: previous.stories, edition: await files.readJson<ChannelReaderEdition>(file.id) };
}

export async function createOutputChannel(db: Db, ownerId: string, id: string, driveFolderId: string, input: OutputChannelInput, session?: ClientSession) {
  await ensurePublicationIndexes(db);
  const document: OutputChannelDocument = {
    _id: id,
    owner_id: ownerId,
    members: [],
    publication_scope_version: 1,
    name: input.name,
    destinations: input.destinations,
    drive_folder_id: driveFolderId,
    enabled: input.enabled,
    selected_location_ids: input.selectedLocationIds,
    allowed_location_ids: [...input.selectedLocationIds],
    lifecycle_revision: 0,
    published_location_ids: [],
  };
  await outputChannels(db).insertOne(document, session ? { session } : undefined);
  return fromDocument(document);
}

export async function updateOutputChannel(
  db: Db, access: OutputChannelAccess, input: OutputChannelInput, expectedRevision: number,
  allowedLocationIds?: string[],
) {
  const { context } = access;
  await assertPublicationWrite(db, context, "publication_updated", { audit: false });
  if (allowedLocationIds !== undefined) {
    const principal = await principalById(db, context.principalId);
    if (!principal || (principal.role !== "owner" && principal.role !== "admin")) throw new PublicationAccessDenied();
  }
  const allowed = allowedLocationIds ?? context.publication.allowed_location_ids ?? context.publication.selected_location_ids ?? [];
  if (input.selectedLocationIds.some((id) => !allowed.includes(id))) throw new PublicationAccessDenied();
  const channel = await outputChannels(db).findOneAndUpdate(
    { $and: [publicationLifecycleFilter<OutputChannelDocument>(context, expectedRevision),
      { $nor: [{ archived_at: { $type: "double" } }, { archived_at: { $type: "int" } },
        { archived_at: { $type: "long" } }, { archived_at: { $type: "decimal" } }] }] },
    { $set: { name: input.name, destinations: input.destinations, enabled: input.enabled, selected_location_ids: input.selectedLocationIds,
        allowed_location_ids: allowed },
      $inc: { lifecycle_revision: 1 },
      $unset: { url: "", destination: "" } },
    { returnDocument: "after" },
  );
  if (!channel) throw new PublicationLifecycleConflict();
  await assertPublicationWrite(db, context, "publication_updated");
  return fromDocument(channel);
}

export async function channelFolder(store: ArtifactStore, pipelineRoot: string | null, id: string) {
  if (store.kind === "local") return `channel-${id}`;
  if (!pipelineRoot) throw new Error("NEWSBEE_PIPELINE_DRIVE_FOLDER_ID is not configured");
  return store.ensureFolder(await store.ensureFolder(pipelineRoot, "output-channels"), id);
}

export async function writeOutputChannelDirectory(db: Db, store: ArtifactStore, channel: OutputChannelDocument) {
  const allowed = new Set(channel.allowed_location_ids ?? channel.selected_location_ids ?? []);
  const selected = new Set((channel.selected_location_ids ?? []).filter((id) => allowed.has(id)));
  const ids = [...new Set(channel.published_location_ids ?? [])].filter((id) => selected.has(id)).sort();
  const profiles = await db.collection<LocationProfile & { _id: string }>(COLLECTIONS.locations)
    .find({ _id: { $in: ids }, removal: { $exists: false } }).toArray();
  const byId = new Map(profiles.map((profile) => [profile.id ?? profile._id, profile]));
  const locations = ids.flatMap((id) => {
    const profile = byId.get(id);
    return profile ? [{
      id,
      name: profile.name,
      system_count: profile.systems.length,
      branch_count: profile.systems.reduce((total, system) => total + system.branches.length, 0),
    }] : [];
  });
  await channelArtifactStore(db, store, channel.drive_folder_id).saveJson(channel.drive_folder_id, "locations.json", { locations });
}

export async function publishToOutputChannels(db: Db, store: ArtifactStore, edition: PublishableEdition) {
  await ensurePublicationIndexes(db);
  const channels = await outputChannels(db).find({
    enabled: true,
    selected_location_ids: edition.location_id,
    owner_id: { $type: "string" },
  }).sort({ _id: 1 }).toArray();
  const published: string[] = [];
  for (const channel of channels) {
    if (!(channel.allowed_location_ids ?? channel.selected_location_ids ?? []).includes(edition.location_id)) continue;
    if (!hasReaderDestination(channel)) continue;
    const payload = decoratePublicationEdition(channel, edition);
    await channelArtifactStore(db, store, channel.drive_folder_id).saveJson(channel.drive_folder_id, `${edition.id}.json`, payload);
    await outputChannels(db).updateOne({ _id: channel._id }, { $addToSet: { published_location_ids: edition.location_id } });
    const fresh = await outputChannels(db).findOne({ _id: channel._id });
    if (fresh) await writeOutputChannelDirectory(db, store, fresh);
    published.push(channel._id);
  }
  return published;
}

export async function syncOutputChannelLocations(
  db: Db,
  store: ArtifactStore,
  ownerId: string,
  id: string,
  locationIds: string[],
  latest: (locationId: string) => Promise<PublishableEdition | null>,
) {
  await ensurePublicationIndexes(db);
  const channel = await outputChannels(db).findOne(accessiblePublicationFilter(ownerId, id));
  if (!channel) return [];
  const copied: string[] = [];
  if (channel.enabled && hasReaderDestination(channel)) {
    for (const locationId of locationIds) {
      if (!channel.selected_location_ids.includes(locationId) ||
        !(channel.allowed_location_ids ?? channel.selected_location_ids).includes(locationId)) continue;
      const edition = await latest(locationId);
      if (!edition) continue;
      const payload = decoratePublicationEdition(channel, edition);
      await channelArtifactStore(db, store, channel.drive_folder_id).saveJson(channel.drive_folder_id, `${edition.id}.json`, payload);
      await outputChannels(db).updateOne(accessiblePublicationFilter(ownerId, id), {
        $addToSet: { published_location_ids: locationId },
      });
      copied.push(locationId);
    }
  }
  const fresh = await outputChannels(db).findOne(accessiblePublicationFilter(ownerId, id));
  if (fresh && hasReaderDestination(fresh)) await writeOutputChannelDirectory(db, store, fresh);
  return copied;
}

export async function clearOutputChannelFeed(db: Db, store: ArtifactStore, channel: OutputChannelDocument) {
  for (const locationId of new Set(channel.published_location_ids ?? [])) {
    const editions = await db.collection<{ id: string }>(COLLECTIONS.editions)
      .find({ location_id: locationId, id: { $exists: true } }).project<{ id: string }>({ id: 1 }).toArray();
    for (const edition of editions) await channelArtifactStore(db, store, channel.drive_folder_id).removeFile(channel.drive_folder_id, `${edition.id}.json`);
  }
  await channelArtifactStore(db, store, channel.drive_folder_id).removeFile(channel.drive_folder_id, "locations.json");
  await outputChannels(db).updateOne({ _id: channel._id }, { $set: { published_location_ids: [] } });
}

function locationRemovalChannelFilter(locationId: string) {
  return {
    $or: [{ selected_location_ids: locationId }, { published_location_ids: locationId }, { allowed_location_ids: locationId }],
  };
}

export async function assertLocationRemovalPublicationActor(db: Db, locationId: string, actor?: Principal) {
  if (!await outputChannels(db).findOne(locationRemovalChannelFilter(locationId), { projection: { _id: 1 } })) return;
  const principal = actor && await principalById(db, actor.id);
  if (!principal || (principal.role !== "owner" && principal.role !== "admin")) throw new PublicationAccessDenied();
  return principal;
}

export async function removeLocationFromOutputChannels(
  db: Db, store: ArtifactStore, locationId: string, actor?: Principal,
) {
  const affected = await outputChannels(db).find(locationRemovalChannelFilter(locationId)).toArray();
  if (!affected.length) return;
  const principal = await assertLocationRemovalPublicationActor(db, locationId, actor);
  if (!principal) throw new PublicationLifecycleConflict();
  const updated = await publicationChangeTransaction(db, async (session) => {
    const changed: OutputChannelDocument[] = [];
    for (const channel of affected) {
      const expectedRevision = channel.lifecycle_revision ?? 0;
      const allowed = channel.allowed_location_ids ?? channel.selected_location_ids ?? [];
      const next = {
        ...channel,
        allowed_location_ids: allowed.filter((id) => id !== locationId),
        selected_location_ids: (channel.selected_location_ids ?? []).filter((id) => id !== locationId),
        published_location_ids: (channel.published_location_ids ?? []).filter((id) => id !== locationId),
        lifecycle_revision: expectedRevision + 1,
      };
      const result = await outputChannels(db).updateOne({
        _id: channel._id,
        ...(expectedRevision === 0
          ? { $or: [{ lifecycle_revision: 0 }, { lifecycle_revision: { $exists: false } }] }
          : { lifecycle_revision: expectedRevision }),
      }, { $set: {
        allowed_location_ids: next.allowed_location_ids,
        selected_location_ids: next.selected_location_ids,
        published_location_ids: next.published_location_ids,
        lifecycle_revision: next.lifecycle_revision,
      } }, { session });
      if (!result.matchedCount) throw new PublicationLifecycleConflict();
      await appendPublicationChangeAudit(db, {
        publication_id: channel._id, principal_id: principal.id, principal_email: principal.email,
        action: allowed.includes(locationId) ? "allowed_communities_updated"
          : (channel.selected_location_ids ?? []).includes(locationId) ? "coverage_updated" : "publication_updated",
        resource_id: channel._id,
        detail: `Removed community ${locationId} at lifecycle revision ${next.lifecycle_revision}.`,
        before_hash: outputChannelConfigurationHash(fromDocument(channel)),
        after_hash: outputChannelConfigurationHash(fromDocument(next)),
      }, session);
      changed.push(next);
    }
    return changed;
  });
  for (const channel of updated) {
    if (hasReaderDestination(channel)) await writeOutputChannelDirectory(db, store, channel);
  }
}
