/**
 * Reader publishing: every published edition is written to the reader folder, and the
 * folder's locations.json lists every onboarded location that has a published edition.
 * The reader site resolves this same folder through its configured output channel,
 * and shows each location's edition with the latest `published_at`.
 *
 * An edition run ends `built`: written, but not on the reader. A person reviews it and publishes it
 * (`publishEdition`). Publishing an older edition again makes it the live one.
 */
import type { Db } from "mongodb";
import type { LocationProfile } from "../connectors/types";
import type { ArtifactStore } from "../storage/artifacts";
import { COLLECTIONS } from "../storage/mongo";
import { channelArtifactStore } from "../storage/mongo-channel-artifacts";
import { resolveReaderDriveFolderId, type ReaderChannel } from "../../../../shared/reader-folder";
import { correctedEdition, type DraftDoc } from "../editions/authoring";
import { writeEditionMap } from "../editions/edition-map";
import { recordPublished } from "../editions/ledger";
import { recordPublishedCounts } from "../sourcemap/store";
import { runs } from "./runs";
import { uniqueEditionPhotos } from "../images/uniqueness";
import { photoStoryMismatch } from "../../../../shared/photo-story-match";

export type PublishableEdition = { id: string; location_id: string } & Record<string, unknown>;

export function readerFolder(db: Db) {
  return resolveReaderDriveFolderId((id) => db.collection<ReaderChannel>(COLLECTIONS.outputChannels)
    .findOne({ _id: id }, { projection: { _id: 1, enabled: 1, drive_folder_id: 1 } }));
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

/** Onboarded locations with at least one published edition, in id order. */
export async function publishedLocationIds(db: Db) {
  const published = await db.collection(COLLECTIONS.editions).distinct("location_id", { status: "published" });
  return [...new Set(published.filter((id): id is string => typeof id === "string"))].sort();
}

/** Rewrite the reader folder's locations.json from the published locations that still exist. */
export async function writeReaderDirectory(db: Db, store: ArtifactStore, folderId?: string) {
  const selectedFolderId = folderId ?? await readerFolder(db);
  const ids = await publishedLocationIds(db);
  const profiles = await db
    .collection<LocationProfile & { _id: string }>(COLLECTIONS.locations)
    .find({ _id: { $in: ids }, removal: { $exists: false } })
    .toArray();
  const byId = new Map(profiles.map((profile) => [profile.id ?? profile._id, profile]));
  const locations = ids.flatMap((id) => {
    const profile = byId.get(id);
    return profile ? [directoryEntry({ ...profile, id })] : [];
  });
  await channelArtifactStore(db, store, selectedFolderId).saveJson(selectedFolderId, "locations.json", { locations });
  return locations.map((location) => location.id);
}

/** Publish (or re-publish after a correction) an edition to the reader folder. */
export async function publishToReader(db: Db, store: ArtifactStore, edition: PublishableEdition, folderId?: string) {
  const selectedFolderId = folderId ?? await readerFolder(db);
  const items = Array.isArray(edition.items) ? edition.items.map(item => photoStoryMismatch(item, item)
    ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== "image" && !key.startsWith("image_"))) : item) : null;
  const payload = items ? { ...edition, items: await uniqueEditionPhotos(db, items) } : edition;
  await channelArtifactStore(db, store, selectedFolderId).saveJson(selectedFolderId, editionFileName(edition), payload);
  await writeReaderDirectory(db, store, selectedFolderId);
  return selectedFolderId;
}

/** Editions that finished: built (waiting to be published) or published. */
export const FINISHED_EDITION_STATUSES = ["built", "published"];

export class PublishConflict extends Error {}

/**
 * Publish a finished edition to the reader: it becomes the location's live edition. The first time an
 * edition is published it also enters the no-repeat ledger (unless its run left history alone) and its
 * sources' published counts. Publishing it again, or an older one, only makes it live again.
 */
export async function publishEdition(db: Db, store: ArtifactStore, locationId: string, editionId: string, by: string, folderId?: string) {
  const editions = db.collection<DraftDoc>(COLLECTIONS.editions);
  const draft = await editions.findOne({ id: editionId, location_id: locationId });
  if (!draft) throw new PublishConflict(`No edition ${editionId} for this location`);
  if (!FINISHED_EDITION_STATUSES.includes(draft.status) || !draft.published) throw new PublishConflict("This edition isn't finished yet. Wait for its run to build it.");
  const selectedFolderId = folderId ?? await readerFolder(db);
  const first = draft.status === "built";
  const at = Date.now() / 1000;
  // The reader shows the edition with the latest published_at, so this one becomes the live one.
  const corrected = await correctedEdition(db, draft);
  const payload = { ...(corrected ?? draft.published), published_at: at };
  const claimed = await editions.updateOne({ id: editionId, status: draft.status }, { $set: {
    status: "published", published_at: at, "published.published_at": at, published_by: by, last_published_at: at,
    ...(first ? { first_published_at: at } : {}),
  } });
  if (!claimed.modifiedCount) throw new PublishConflict("This edition changed while publishing. Reload and try again.");
  const run = await runs(db).findOne({ _id: draft.run_id });
  if (first) {
    if (run?.options?.count_history !== false) await recordPublished(db, run?.today ?? draft.today, payload, new Map(Object.entries(draft.tokens ?? {})));
    await recordPublishedCounts(db, locationId, new Map(Object.entries((draft.source_counts as Record<string, number> | undefined) ?? {})));
  }
  const folder = await publishToReader(db, store, payload, selectedFolderId);
  if (run) {
    await runs(db).updateOne({ _id: run._id }, { $set: {
      status: "published", updated_at: at, "published.reader_folder": folder, "published.by": by, "published.at": at,
      ...(first ? { "published.first_at": at } : {}),
    } });
    await writeEditionMap(db, run._id).catch(() => undefined);
  }
  return { edition_id: editionId, run_id: draft.run_id, published_at: at, first, reader_folder: folder, output_channels: [] };
}

/** A location's finished editions, newest first, with which one the reader shows. */
export async function finishedEditions(db: Db, locationId: string, limit = 30) {
  const rows = await db.collection<DraftDoc>(COLLECTIONS.editions).find(
    { location_id: locationId, status: { $in: FINISHED_EDITION_STATUSES } },
    { projection: { id: 1, run_id: 1, status: 1, built_at: 1, published_at: 1, first_published_at: 1, published_by: 1, created_at: 1, window_start: 1, window_end: 1, "published.headline": 1, "published.items": 1, summary: 1 } },
  ).sort({ created_at: -1 }).limit(limit).toArray();
  const live = rows.filter((row) => row.status === "published").sort((a, b) => Number(b.published_at ?? 0) - Number(a.published_at ?? 0))[0]?.id ?? null;
  return rows.map((row) => ({
    id: row.id, run_id: row.run_id, status: row.status as "built" | "published", live: row.id === live,
    built_at: Number(row.built_at ?? row.created_at ?? 0) || null, published_at: row.status === "published" ? Number(row.published_at ?? 0) || null : null,
    first_published_at: Number(row.first_published_at ?? 0) || null, published_by: typeof row.published_by === "string" ? row.published_by : null,
    window: [row.window_start, row.window_end], headline: row.published?.headline ?? null, items: row.published?.items.length ?? 0,
    held: Number((row.summary as { held?: number } | undefined)?.held ?? 0),
  }));
}
