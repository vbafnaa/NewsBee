/**
 * Reader publishing: every published edition is written to the reader folder, and the
 * folder's locations.json lists every onboarded location that has a published edition.
 * There are no output channels; the reader site reads this one folder.
 */
import type { Db } from "mongodb";
import type { LocationProfile } from "../connectors/types";
import type { ArtifactStore } from "../storage/artifacts";
import { COLLECTIONS } from "../storage/mongo";
import { readerDriveFolderId } from "../../../../shared/reader-folder";

export type PublishableEdition = { id: string; location_id: string } & Record<string, unknown>;

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
export async function writeReaderDirectory(db: Db, store: ArtifactStore, folderId = readerDriveFolderId()) {
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
  await store.saveJson(folderId, "locations.json", { locations });
  return locations.map((location) => location.id);
}

/** Publish (or re-publish after a correction) an edition to the reader folder. */
export async function publishToReader(db: Db, store: ArtifactStore, edition: PublishableEdition, folderId = readerDriveFolderId()) {
  await store.saveJson(folderId, editionFileName(edition), edition);
  await writeReaderDirectory(db, store, folderId);
  return folderId;
}
