import { isCalendarDate, type PhotoScope } from "./photo-catalog";
import { normalizeStoryImage, safeImageUrl, type StoryImage } from "./story-image";

export const PHOTO_SUPPLY_MAX_PHOTOS = 6;
export const PHOTO_SUPPLY_MAX_BATCHES = 5;
export const PHOTO_SUPPLY_GRANT_VERSION = "photo_supply_v1";
export const PHOTO_SUPPLY_GRANT_TEXT = "I own these photographs or am authorized to grant their use. I authorize Newsbee, at no charge, to publish the submitted files in its community newsletter and website, retain them in archived editions, and resize or crop them, within the coverage scope and expiry shown above. The credits, captions, capture dates and subjects I provide are accurate. Any required permissions from depicted people have been obtained.";
export type PhotoSupplyInput = { request_id: string; name: string; email: string; photos: StoryImage[];
  permission: { editorial: true; archive: true; crop: true }; grant_version: string; grant_text: string };
export type PublicPhotoInvite = { name: string; location_name: string; scope: PhotoScope; expires_on: string; grant_text: string; requested_photos: Partial<StoryImage>[] };
function invalid(message: string): never { throw Error(`Invalid photo supply: ${message}`); }
const clean = (value: unknown, max: number) => typeof value === "string" && value.length <= max
  && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : "";

export function publicPhotoUrl(value: unknown) {
  const result = safeImageUrl(value);
  if (!result || [...new URL(result).searchParams.keys()].some(key => /^(token|access_token|auth|authorization|password|signature|x-amz-signature|api_key|key)$/i.test(key)))
    invalid("use a public HTTPS photo or source URL without access credentials");
  return result;
}

/** Supplier consent proposes a bounded set of files; only an administrator can approve it. */
export function validatePhotoSupply(value: unknown, scope: PhotoScope, today = new Date()): PhotoSupplyInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("a submission must be an object");
  const raw = value as Record<string, unknown>;
  const request_id = clean(raw.request_id, 36), name = clean(raw.name, 120), email = clean(raw.email, 254).toLowerCase();
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(request_id)) invalid("invalid submission identity");
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid("provide your name and email");
  if (raw.authority !== true || raw.no_charge !== true || raw.people_permissions !== true
    || raw.editorial !== true || raw.archive !== true || raw.crop !== true) invalid("confirm all photo-use permissions");
  if (!Array.isArray(raw.photos) || !raw.photos.length || raw.photos.length > PHOTO_SUPPLY_MAX_PHOTOS) invalid(`submit between one and ${PHOTO_SUPPLY_MAX_PHOTOS} photographs`);
  const photos = raw.photos.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid("invalid photo details");
    const fields = value as Record<string, unknown>;
    const date = clean(fields.image_date, 10);
    if (!isCalendarDate(date) || Date.parse(date) > today.getTime() || today.getTime() - Date.parse(date) > 365 * 86400000) invalid("each photo needs a capture date within the last 365 days");
    const credit = clean(fields.image_credit, 240), caption = clean(fields.image_caption, 500), alt = clean(fields.image_alt, 500) || caption;
    if (!credit || !caption || !alt) invalid("each photo needs its photographer credit and a factual caption");
    const image = normalizeStoryImage({ image: publicPhotoUrl(fields.image), image_source_url: publicPhotoUrl(fields.image_source_url),
      image_credit: credit, image_caption: caption, image_alt: alt, image_date: date, image_license: "Used with permission" });
    if (!image) invalid("unsupported photo metadata");
    // A catalog reference is attached after approval. Suppliers cannot choose their own role or scope.
    return { ...image, ...(scope.kind === "venue" ? { image_role: "venue" as const, image_place: scope.name }
      : scope.kind === "street" ? { image_role: "area" as const, image_place: scope.name }
      : scope.kind === "person" || scope.kind === "organization" ? { image_subject: scope.name } : {}) };
  });
  if (new Set(photos.map(photo => photo.image)).size !== photos.length) invalid("submit each original photograph only once");
  return { request_id, name, email, photos, permission: { editorial: true, archive: true, crop: true },
    grant_version: PHOTO_SUPPLY_GRANT_VERSION, grant_text: PHOTO_SUPPLY_GRANT_TEXT };
}
