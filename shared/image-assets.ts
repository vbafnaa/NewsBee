export const PHOTO_ASSETS = "photo_assets";
export type PhotoLayout = "desktop" | "mobile";
export type AssetVariant = { id: string; width: number; height: number; layout: PhotoLayout };
export type PhotoAsset = {
  _id: string; original_hash: string; source_url: string; variants: AssetVariant[];
  policy: string; created_at: number; location_id: string; source_id: string;
};
export type PhotoBlob = { _id: string; bytes: Uint8Array | { value(): Uint8Array }; content_type: string; width: number; height: number };
export type PhotoAssetReader = { asset(id: string): Promise<PhotoAsset | null>; blob(id: string): Promise<PhotoBlob | null> };

/** The caller must first resolve this asset id from an authorized published edition. */
export async function readPhotoAsset(store: PhotoAssetReader, id: string, width: number, layout: PhotoLayout = "desktop") {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid photo asset identity");
  const asset = await store.asset(id);
  if (!asset) throw new Error("Photo asset is unavailable");
  const variants = asset.variants.filter(item => item.layout === layout).sort((a, b) => a.width - b.width);
  const variant = variants.find(item => item.width >= width) ?? variants.at(-1);
  if (!variant) throw new Error("No reviewed photo variant");
  const blob = await store.blob(variant.id);
  if (!blob) throw new Error("Photo variant is unavailable");
  const bytes = Buffer.from(blob.bytes instanceof Uint8Array ? blob.bytes : blob.bytes.value());
  return { bytes, contentType: blob.content_type, width: blob.width, height: blob.height, etag: `"${variant.id}"` };
}
