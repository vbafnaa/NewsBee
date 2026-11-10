import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { StoryImage } from "../../../../shared/story-image";
import { PHOTO_ASSETS, type PhotoAsset } from "../../../../shared/image-assets";
import { photoIdentityKeys, uniquePhotoItems } from "../../../../shared/photo-identity";

export const IMAGE_RESULTS = "story_image_results";
export const IMAGE_POLICY = "story_images_v7";
export const EDITION_PHOTO_CLAIMS = "edition_photo_claims";
type Mode = "published" | "shadow";
type Selection = { story_id: string; image: StoryImage | null; photo_hash?: string; agent?: { image_hash?: string }; revision?: number };
type Claim = { _id: string; edition_id: string; revision: number; mode: Mode; location_id: string; story_id: string; identities: string[] };
const claimId = (editionId: string, revision: number, mode: Mode, storyId: string) => createHash("sha256")
  .update(JSON.stringify([editionId, revision, mode, storyId])).digest("hex");

async function assetHashes(db: Db, images: Array<{ image_asset_id?: unknown }>): Promise<Map<string, string>> {
  const ids = [...new Set(images.map(image => image.image_asset_id).filter((id): id is string => typeof id === "string"))];
  if (!ids.length) return new Map();
  const assets = await db.collection<PhotoAsset>(PHOTO_ASSETS).find({ _id: { $in: ids } }, { projection: { _id: 1, original_hash: 1 } }).toArray();
  return new Map(assets.map(asset => [asset._id, asset.original_hash]));
}

/** The earliest existing placement owns a photo when migrating decisions made before this rule. */
export async function editionPhotoOwner(db: Db, editionId: string, revision: number, image: StoryImage, originalHash?: string, mode: Mode = "published"): Promise<string | null> {
  const collection = mode === "shadow" ? "story_image_shadow_results" : IMAGE_RESULTS;
  const selected = await db.collection<Selection>(collection).find({ edition_id: editionId, status: "selected", policy: IMAGE_POLICY,
    $or: [{ revision }, ...(revision === 0 ? [{ revision: { $exists: false } }] : [])] }).limit(1000).toArray();
  const hashes = await assetHashes(db, [image, ...selected.flatMap(item => item.image ? [item.image] : [])]);
  const wanted = new Set(photoIdentityKeys(image, originalHash ?? hashes.get(image.image_asset_id ?? "")));
  const matches = selected.filter(item => item.image && photoIdentityKeys(item.image,
    item.photo_hash ?? item.agent?.image_hash ?? hashes.get(item.image.image_asset_id ?? "")).some(key => wanted.has(key)));
  if (!matches.length) return null;
  const entries = await db.collection<{ story_id: string; position?: number; result?: { ranking?: { score?: number } } }>("edition_entries")
    .find({ edition_id: editionId, story_id: { $in: matches.map(item => item.story_id) }, disposition: "checks_passed" },
      { projection: { story_id: 1, position: 1, "result.ranking.score": 1 } }).toArray();
  const byId = new Map(entries.map(entry => [entry.story_id, entry]));
  return matches.filter(item => byId.has(item.story_id)).sort((a, b) => {
    const first = byId.get(a.story_id)!, second = byId.get(b.story_id)!;
    return (first.position ?? Number.MAX_SAFE_INTEGER) - (second.position ?? Number.MAX_SAFE_INTEGER)
      || (second.result?.ranking?.score ?? 0) - (first.result?.ranking?.score ?? 0) || a.story_id.localeCompare(b.story_id);
  })[0]?.story_id ?? null;
}

export async function photoUsedByOtherStory(db: Db, editionId: string, storyId: string, revision: number, image: StoryImage,
  originalHash?: string, mode: Mode = "published"): Promise<boolean> {
  const owner = await editionPhotoOwner(db, editionId, revision, image, originalHash, mode);
  if (owner && owner !== storyId) return true;
  const hashes = await assetHashes(db, [image]);
  const identities = photoIdentityKeys(image, originalHash ?? hashes.get(image.image_asset_id ?? ""));
  return Boolean(await db.collection<Claim>(EDITION_PHOTO_CLAIMS).findOne({ edition_id: editionId, revision, mode,
    story_id: { $ne: storyId }, identities: { $in: identities } }));
}

/** A unique multikey index reserves every known identity in one atomic write. */
export async function claimEditionPhoto(db: Db, editionId: string, storyId: string, locationId: string, revision: number,
  image: StoryImage, originalHash?: string, mode: Mode = "published"): Promise<boolean> {
  if (await photoUsedByOtherStory(db, editionId, storyId, revision, image, originalHash, mode)) return false;
  const hashes = await assetHashes(db, [image]);
  const identities = photoIdentityKeys(image, originalHash ?? hashes.get(image.image_asset_id ?? ""));
  if (!identities.length) return false;
  const claims = db.collection<Claim>(EDITION_PHOTO_CLAIMS);
  await claims.createIndex({ edition_id: 1, revision: 1, mode: 1, identities: 1 }, { unique: true, name: "unique_edition_photo" });
  const _id = claimId(editionId, revision, mode, storyId);
  try {
    const record: Claim = { _id, edition_id: editionId, revision, mode, story_id: storyId, location_id: locationId, identities };
    await claims.replaceOne({ _id }, record, { upsert: true });
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      return Boolean(await claims.findOne({ _id, identities: { $all: identities } }));
    }
    throw error;
  }
}

export async function releaseEditionPhoto(db: Db, editionId: string, storyId: string, revision: number, mode: Mode = "published") {
  await db.collection<Claim>(EDITION_PHOTO_CLAIMS).deleteOne({ _id: claimId(editionId, revision, mode, storyId) });
}

export async function uniqueEditionPhotos<T extends object>(db: Db, items: readonly T[]): Promise<T[]> {
  return uniquePhotoItems(items, await assetHashes(db, items.map(item => item as { image_asset_id?: unknown })));
}
