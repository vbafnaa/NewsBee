import photos from "./event-venue-photos.json";
import { normalizeStoryImage, safeImageUrl, type StoryImage } from "./story-image";

/** Only reviewed, recent photos of an event's actual venue; never a category/keyword fallback. */
export function eventVenuePhoto(locationId: string, story: { kind?: string; source_url?: string | null }, today = new Date()): StoryImage | null {
  if (story.kind !== "event" && story.kind !== "meeting_preview") return null;
  const source = safeImageUrl(story.source_url);
  if (!source) return null;
  const photo = photos.find((entry) => entry.location_id === locationId && safeImageUrl(entry.source_url) === source);
  if (!photo) return null;
  const taken = Date.parse(photo.image_date + "T00:00:00Z");
  const age = today.getTime() - taken;
  if (!Number.isFinite(age) || age < 0 || age > 365 * 86400000 || photo.checked_on > today.toISOString().slice(0, 10)) return null;
  return normalizeStoryImage(photo);
}
