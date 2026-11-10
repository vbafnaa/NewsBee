import type { StoryImage } from "./story-image";

export const PHOTO_CATALOG_SOURCES = "photo_catalog_sources";

export type PhotoScope = {
  kind: "event" | "venue" | "street" | "person" | "organization" | "story";
  name: string;
  city: string;
  aliases: string[];
  event_date?: string;
  source_urls: string[];
  source_domains?: string[];
  identity_url?: string;
};

export type PhotoCatalogSource = {
  id: string;
  location_id: string;
  name: string;
  status: "active" | "pending" | "revoked";
  reviewed_on: string;
  expires_on: string;
  evidence_url: string;
  permission_record_id?: string;
  scope: PhotoScope;
} & (
  | { kind: "commons_category"; category: string }
  | { kind: "commons_files"; files: string[] }
  | { kind: "commons_search" }
  | { kind: "supplied"; photos: StoryImage[]; permission: { editorial: boolean; archive: boolean; crop: boolean } }
);

export type PhotoCatalogRecord = PhotoCatalogSource & { _id: string; revision: string; updated_at: string };
export type PhotoCatalogReference = { id: string; revision: string };
export const PHOTO_SUPPLY_INVITES = "photo_supply_invites";
export const PHOTO_SUPPLY_SUBMISSIONS = "photo_supply_submissions";

/** Rights attach to the exact files, subject scope and expiry approved by their supplier. */
export function photoGrantData(source: PhotoCatalogSource) {
  return [source.location_id, source.expires_on, source.scope,
    source.kind === "supplied" ? source.permission : null,
    source.kind === "supplied" ? source.photos.map(photo => Object.entries(photo).sort(([a], [b]) => a.localeCompare(b))) : null];
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function catalogSourceActive(source: PhotoCatalogSource, today = new Date()): boolean {
  const day = today.toISOString().slice(0, 10);
  return source.status === "active" && isCalendarDate(source.reviewed_on) && isCalendarDate(source.expires_on)
    && source.reviewed_on <= day && source.expires_on >= day
    && (source.kind !== "supplied" || source.permission?.editorial === true
      && source.permission.archive === true && source.permission.crop === true);
}
