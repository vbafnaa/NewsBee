import type { Db } from "mongodb";
import { randomUUID } from "node:crypto";
import type { LocationProfile } from "../connectors/types";
import type { ArtifactStore } from "../storage/artifacts";
import { COLLECTIONS } from "../storage/mongo";

export type OutputChannelDocument = {
  _id: string;
  owner_id: string;
  name: string;
  url?: string;
  destinations?: OutputDestination[];
  destination?: "reader" | "video";
  drive_folder_id: string;
  enabled: boolean;
  selected_location_ids: string[];
  published_location_ids: string[];
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
  driveFolderId: string;
};

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
  owner_id: string;
  channel_id: string;
  title: string;
  output_modes: Array<"reader" | "video">;
  created_at: number;
  stories: ChannelEditionStory[];
  video_stories: Array<{ location_id: string; story_id: string }>;
  edition_ids: string[];
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

function fromDocument(channel: OutputChannelDocument): OutputChannel {
  return {
    id: channel._id,
    name: channel.name,
    destinations: channelDestinations(channel),
    enabled: channel.enabled,
    selectedLocationIds: channel.selected_location_ids ?? [],
    driveFolderId: channel.drive_folder_id,
  };
}

function channelDestinations(channel: OutputChannelDocument): OutputDestination[] {
  if (channel.destinations?.length) return channel.destinations;
  return [{ type: channel.destination ?? "reader", url: channel.url ?? "" }];
}

function hasReaderDestination(channel: OutputChannelDocument) {
  return channelDestinations(channel).some((destination) => destination.type === "reader");
}

export async function listOutputChannels(db: Db, ownerId: string) {
  const rows = await outputChannels(db).find({ owner_id: ownerId }).sort({ name: 1, _id: 1 }).toArray();
  return rows.map(fromDocument);
}

export async function getOutputChannel(db: Db, ownerId: string, id: string) {
  const channel = await outputChannels(db).findOne({ _id: id, owner_id: ownerId });
  return channel ? fromDocument(channel) : null;
}

export async function listOutputChannelEditions(db: Db, ownerId: string, channelId: string) {
  return db.collection<OutputChannelEditionDocument>(COLLECTIONS.outputChannelEditions)
    .find({ owner_id: ownerId, channel_id: channelId })
    .sort({ created_at: -1 })
    .limit(30)
    .toArray();
}

export async function clearOutputChannelEditions(db: Db, store: ArtifactStore, channel: OutputChannelDocument) {
  const editions = await db.collection<OutputChannelEditionDocument>(COLLECTIONS.outputChannelEditions)
    .find({ owner_id: channel.owner_id, channel_id: channel._id })
    .toArray();
  for (const edition of editions) {
    for (let index = 0; index < edition.edition_ids.length; index += 1) {
      await store.removeFile(channel.drive_folder_id, `channel-edition-${edition._id}-${index + 1}.json`);
    }
  }
  await db.collection<OutputChannelEditionDocument>(COLLECTIONS.outputChannelEditions)
    .deleteMany({ owner_id: channel.owner_id, channel_id: channel._id });
}

export async function createOutputChannelEdition(
  db: Db,
  store: ArtifactStore,
  channel: OutputChannelDocument,
  ownerId: string,
  title: string,
  stories: ChannelEditionStory[],
  outputModes: Array<"reader" | "video">,
  videoStories: Array<{ location_id: string; story_id: string }>,
  editions: ChannelReaderEdition[],
) {
  const id = randomUUID().replaceAll("-", "");
  const editionIds = editions.map((_, index) => `${id}-${index + 1}`);
  const document: OutputChannelEditionDocument = {
    _id: id,
    owner_id: ownerId,
    channel_id: channel._id,
    title,
    output_modes: outputModes,
    created_at: Date.now(),
    stories,
    video_stories: videoStories,
    edition_ids: editionIds,
  };
  for (const [index, edition] of editions.entries()) {
    await store.saveJson(channel.drive_folder_id, `channel-edition-${document._id}-${index + 1}.json`, {
      ...edition,
      id: editionIds[index],
    });
  }
  await db.collection<OutputChannelEditionDocument>(COLLECTIONS.outputChannelEditions).insertOne(document);
  return document;
}

export async function createOutputChannel(db: Db, ownerId: string, id: string, driveFolderId: string, input: OutputChannelInput) {
  const document: OutputChannelDocument = {
    _id: id,
    owner_id: ownerId,
    name: input.name,
    destinations: input.destinations,
    drive_folder_id: driveFolderId,
    enabled: input.enabled,
    selected_location_ids: input.selectedLocationIds,
    published_location_ids: [],
  };
  await outputChannels(db).insertOne(document);
  return fromDocument(document);
}

export async function updateOutputChannel(db: Db, ownerId: string, id: string, input: OutputChannelInput) {
  const result = await outputChannels(db).updateOne(
    { _id: id, owner_id: ownerId },
    { $set: { name: input.name, destinations: input.destinations, enabled: input.enabled, selected_location_ids: input.selectedLocationIds },
      $unset: { url: "", destination: "" } },
  );
  if (!result.matchedCount) return null;
  const channel = await outputChannels(db).findOne({ _id: id, owner_id: ownerId });
  return channel ? fromDocument(channel) : null;
}

export async function channelFolder(store: ArtifactStore, pipelineRoot: string | null, id: string) {
  if (store.kind === "local") return `channel-${id}`;
  if (!pipelineRoot) throw new Error("NEWSBEE_PIPELINE_DRIVE_FOLDER_ID is not configured");
  return store.ensureFolder(await store.ensureFolder(pipelineRoot, "output-channels"), id);
}

export async function writeOutputChannelDirectory(db: Db, store: ArtifactStore, channel: OutputChannelDocument) {
  const selected = new Set(channel.selected_location_ids ?? []);
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
  await store.saveJson(channel.drive_folder_id, "locations.json", { locations });
}

export async function publishToOutputChannels(db: Db, store: ArtifactStore, edition: PublishableEdition) {
  const channels = await outputChannels(db).find({
    enabled: true,
    selected_location_ids: edition.location_id,
    owner_id: { $type: "string" },
  }).sort({ _id: 1 }).toArray();
  const published: string[] = [];
  for (const channel of channels) {
    if (!hasReaderDestination(channel)) continue;
    await store.saveJson(channel.drive_folder_id, `${edition.id}.json`, edition);
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
  const channel = await outputChannels(db).findOne({ _id: id, owner_id: ownerId });
  if (!channel) return [];
  const copied: string[] = [];
  if (channel.enabled && hasReaderDestination(channel)) {
    for (const locationId of locationIds) {
      const edition = await latest(locationId);
      if (!edition) continue;
      await store.saveJson(channel.drive_folder_id, `${edition.id}.json`, edition);
      await outputChannels(db).updateOne({ _id: id }, { $addToSet: { published_location_ids: locationId } });
      copied.push(locationId);
    }
  }
  const fresh = await outputChannels(db).findOne({ _id: id, owner_id: ownerId });
  if (fresh && hasReaderDestination(fresh)) await writeOutputChannelDirectory(db, store, fresh);
  return copied;
}

export async function clearOutputChannelFeed(db: Db, store: ArtifactStore, channel: OutputChannelDocument) {
  for (const locationId of new Set(channel.published_location_ids ?? [])) {
    const editions = await db.collection<{ id: string }>(COLLECTIONS.editions)
      .find({ location_id: locationId, id: { $exists: true } }).project<{ id: string }>({ id: 1 }).toArray();
    for (const edition of editions) await store.removeFile(channel.drive_folder_id, `${edition.id}.json`);
  }
  await store.removeFile(channel.drive_folder_id, "locations.json");
  await outputChannels(db).updateOne({ _id: channel._id }, { $set: { published_location_ids: [] } });
}

export async function removeLocationFromOutputChannels(db: Db, store: ArtifactStore, locationId: string) {
  const affected = await outputChannels(db).find({
    $or: [{ selected_location_ids: locationId }, { published_location_ids: locationId }],
  }).toArray();
  for (const channel of affected) {
    await outputChannels(db).updateOne(
      { _id: channel._id },
      { $pull: { selected_location_ids: locationId, published_location_ids: locationId } },
    );
    const updated = await outputChannels(db).findOne({ _id: channel._id });
    if (updated && hasReaderDestination(updated)) await writeOutputChannelDirectory(db, store, updated);
  }
}
