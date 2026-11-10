import type { Db } from "mongodb";
import { COLLECTIONS } from "./storage/mongo";

export type YouTubeLocationSettings = {
  _id: string;
  location_id: string;
  principal_id: string;
  account_email: string;
  channel_id: string;
  channel_title: string;
  playlist_id: string | null;
  playlist_title: string | null;
  updated_at: number;
};

function collection(db: Db) {
  return db.collection<YouTubeLocationSettings>(COLLECTIONS.youtubeLocationSettings);
}

function settingsId(locationId: string, principalId: string) {
  return `${locationId}:${principalId}`;
}

export async function getYouTubeLocationSettings(db: Db, locationId: string, principalId: string, accountEmail: string) {
  const settings = await collection(db).findOne({ _id: settingsId(locationId, principalId) });
  if (!settings || settings.account_email !== accountEmail.trim().toLowerCase()) return null;
  return settings;
}

export async function saveYouTubeLocationSettings(
  db: Db,
  locationId: string,
  principalId: string,
  accountEmail: string,
  channel: { id: string; title: string },
  playlist: { id: string; title: string } | null,
) {
  const settings: YouTubeLocationSettings = {
    _id: settingsId(locationId, principalId),
    location_id: locationId,
    principal_id: principalId,
    account_email: accountEmail.trim().toLowerCase(),
    channel_id: channel.id,
    channel_title: channel.title,
    playlist_id: playlist?.id ?? null,
    playlist_title: playlist?.title ?? null,
    updated_at: Date.now(),
  };
  await collection(db).replaceOne({ _id: settings._id }, settings, { upsert: true });
  return settings;
}
