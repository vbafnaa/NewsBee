/**
 * Output channels: each channel (a Drive folder read by a site such as the reader site)
 * chooses which locations it publishes. Publishing writes the edition JSON and refreshes
 * the channel's locations.json in that folder.
 */
import type { Db } from "mongodb";
import type { LocationProfile } from "../connectors/types";
import type { ArtifactStore } from "../storage/artifacts";
import { COLLECTIONS } from "../storage/mongo";
import { logger } from "../core/log";

export type ChannelDocument = {
  _id: string;
  name: string;
  url: string;
  drive_folder_id: string;
  enabled: boolean;
  /** Locations this channel publishes. */
  selected_location_ids?: string[];
  /** Locations that have at least one edition in the channel folder. */
  published_location_ids?: string[];
  /** Legacy teammate field (source picking); no longer used by the pipeline. */
  selected_source_ids?: string[];
};

export type PublishableEdition = { id: string; location_id: string } & Record<string, unknown>;

export function channels(db: Db) {
  return db.collection<ChannelDocument>(COLLECTIONS.outputChannels);
}

/** The original team deployment's reader folder, kept only as a fallback for that deployment. */
const LEGACY_READER_DRIVE_FOLDER_ID = "1S2uePphOd_25yandeFtQJ6iZvSz2ydYw";

/** Drive folder for a newly created default reader channel; existing channels keep their folder. */
export function readerDriveFolderId(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.NEWSBEE_READER_DRIVE_FOLDER_ID?.trim();
  if (configured) {
    if (!/^[A-Za-z0-9_-]+$/.test(configured)) throw new Error("NEWSBEE_READER_DRIVE_FOLDER_ID is not a Drive folder ID");
    return configured;
  }
  logger("publish").warn("reader_drive_folder_default", { detail: "NEWSBEE_READER_DRIVE_FOLDER_ID is unset; using the legacy reader folder" });
  return LEGACY_READER_DRIVE_FOLDER_ID;
}

export async function ensureReaderChannel(db: Db) {
  const collection = channels(db);
  const existing = await collection.findOne({ _id: "reader-site" }, { projection: { drive_folder_id: 1 } });
  if (existing?.drive_folder_id) return;
  const driveFolderId = readerDriveFolderId();
  await collection.updateOne(
    { _id: "reader-site" },
    {
      $setOnInsert: {
        name: "Newsbee reader site",
        url: process.env.NEWSBEE_READER_SITE_URL ?? "https://newsbee-reader-site.vercel.app",
        drive_folder_id: driveFolderId,
        enabled: true,
      },
    },
    { upsert: true },
  );
  await collection.updateOne(
    { _id: "reader-site", drive_folder_id: { $exists: false } },
    { $set: { drive_folder_id: driveFolderId } },
  );
}

/** Enabled channels that publish this location. */
export async function channelsFor(db: Db, locationId: string) {
  return channels(db).find({ enabled: true, selected_location_ids: locationId }).sort({ _id: 1 }).toArray();
}

export function editionFileName(edition: { id: string }) {
  return `${edition.id}.json`;
}

/** The reader's directory entry for a location (reader-site Location type). */
export function directoryEntry(location: LocationProfile) {
  return {
    id: location.id,
    name: location.name,
    system_count: location.systems.length,
    branch_count: location.systems.reduce((total, system) => total + system.branches.length, 0),
  };
}

async function writeDirectory(db: Db, store: ArtifactStore, channel: ChannelDocument) {
  const selected = new Set(channel.selected_location_ids ?? []);
  const ids = [...new Set(channel.published_location_ids ?? [])].filter((id) => selected.has(id)).sort();
  const profiles = await db
    .collection<LocationProfile & { _id: string }>(COLLECTIONS.locations)
    .find({ _id: { $in: ids } })
    .toArray();
  const byId = new Map(profiles.map((profile) => [profile.id ?? profile._id, profile]));
  const locations = ids.flatMap((id) => {
    const profile = byId.get(id);
    return profile ? [directoryEntry({ ...profile, id })] : [];
  });
  await store.saveJson(channel.drive_folder_id, "locations.json", { locations });
}

/** Publish (or re-publish after a correction) an edition to every channel that carries its location. */
export async function publishToChannels(db: Db, store: ArtifactStore, edition: PublishableEdition) {
  const published: string[] = [];
  for (const channel of await channelsFor(db, edition.location_id)) {
    await channels(db).updateOne({ _id: channel._id }, { $addToSet: { published_location_ids: edition.location_id } });
    const fresh = (await channels(db).findOne({ _id: channel._id })) ?? channel;
    await store.saveJson(channel.drive_folder_id, editionFileName(edition), edition);
    await writeDirectory(db, store, fresh);
    published.push(channel._id);
  }
  return published;
}

/** Refresh a channel's locations.json (e.g. after its location selection changes). */
export async function refreshChannelDirectory(db: Db, store: ArtifactStore, channelId: string) {
  const channel = await channels(db).findOne({ _id: channelId });
  if (channel) await writeDirectory(db, store, channel);
}

/**
 * Copy each newly selected location's latest published edition into an enabled channel so
 * the site shows it right away, then refresh the channel's locations.json.
 */
export async function addLocationsToChannel(
  db: Db,
  store: ArtifactStore,
  channelId: string,
  locationIds: string[],
  latest: (locationId: string) => Promise<PublishableEdition | null>,
) {
  const channel = await channels(db).findOne({ _id: channelId });
  if (!channel) return [];
  const copied: string[] = [];
  if (channel.enabled) {
    for (const locationId of locationIds) {
      const edition = await latest(locationId);
      if (!edition) continue;
      await store.saveJson(channel.drive_folder_id, editionFileName(edition), edition);
      await channels(db).updateOne({ _id: channelId }, { $addToSet: { published_location_ids: locationId } });
      copied.push(locationId);
    }
  }
  await refreshChannelDirectory(db, store, channelId);
  return copied;
}

/**
 * A new channel's folder, starting with an empty locations.json. Drive: under
 * output-channels/ beneath the configured pipeline root. Local: a top-level folder in
 * the Drive stand-in.
 */
export async function createChannelFolder(store: ArtifactStore, pipelineFolderId: string | null, channelId: string) {
  let folder: string;
  if (store.kind === "local") {
    folder = `channel-${channelId}`;
  } else {
    if (!pipelineFolderId) throw new Error("NEWSBEE_PIPELINE_DRIVE_FOLDER_ID is not configured");
    folder = await store.ensureFolder(await store.ensureFolder(pipelineFolderId, "output-channels"), channelId);
  }
  await store.saveJson(folder, "locations.json", { locations: [] });
  return folder;
}
