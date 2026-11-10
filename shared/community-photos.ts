import photos from "./community-photos.json";
import { safeImageUrl } from "./story-image";

export type CommunityPhoto = {
  image: string; source_url: string; credit: string; license: string; license_url: string;
  date: string; caption: string; alt: string; width: number; height: number; checked_on: string;
};

/** Manually reviewed file photos for community covers, never inferred story evidence. */
export function communityPhoto(locationId: string | undefined): CommunityPhoto | null {
  const photo = locationId && Object.hasOwn(photos, locationId) ? photos[locationId as keyof typeof photos] : null;
  if (!photo || !safeImageUrl(photo.image) || !safeImageUrl(photo.source_url) || !safeImageUrl(photo.license_url)
    || !photo.credit || !photo.caption || !/^\d{4}-\d{2}-\d{2}$/.test(photo.date)) return null;
  return photo;
}
