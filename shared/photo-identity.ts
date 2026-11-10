import { safeImageUrl } from "./story-image";

type PhotoIdentity = { image?: unknown; image_source_url?: unknown; image_asset_id?: unknown };
const TRANSFORMS = new Set(["w", "width", "h", "height", "q", "quality", "fit", "crop", "dpr", "auto", "format", "fm", "resize"]);
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function commonsFile(url: URL): string | null {
  let file: string | undefined;
  if (url.hostname === "commons.wikimedia.org" && url.pathname.startsWith("/wiki/File:")) file = url.pathname.slice(11);
  if (["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname)) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "wikipedia" && parts[1] === "commons") {
      const thumbnail = parts.indexOf("thumb");
      file = thumbnail >= 0 ? parts[thumbnail + 3] : parts.at(-1);
    }
  }
  if (!file) return null;
  try { return decodeURIComponent(file).replace(/_/g, " ").normalize("NFC"); }
  catch { return null; }
}

/** Identify the original photograph independently of its crop, thumbnail or layout asset. */
export function photoIdentityKeys(photo: PhotoIdentity, originalHash?: string): string[] {
  if (typeof photo.image !== "string" || !safeImageUrl(photo.image)) return [];
  const keys = new Set<string>();
  if (sha256(originalHash)) keys.add(`hash:${originalHash}`);
  if (sha256(photo.image_asset_id)) keys.add(`asset:${photo.image_asset_id}`);
  const source = safeImageUrl(photo.image_source_url);
  const urls = [new URL(photo.image), ...(source ? [new URL(source)] : [])];
  for (const url of urls) {
    const file = commonsFile(url);
    if (file) keys.add(`commons:${file}`);
  }
  const media = new URL(photo.image);
  media.hash = "";
  for (const key of [...media.searchParams.keys()]) if (TRANSFORMS.has(key.toLowerCase()) || /^utm_/i.test(key)) media.searchParams.delete(key);
  media.searchParams.sort();
  keys.add(`url:${media.href}`);
  return [...keys];
}

/** Keep the first placement in editorial order; retain every story when withholding repeats. */
export function uniquePhotoItems<T extends object>(items: readonly T[], originalHashes: ReadonlyMap<string, string> = new Map()): T[] {
  const seen = new Set<string>();
  return items.map(item => {
    const photo = item as PhotoIdentity;
    const keys = photoIdentityKeys(photo, typeof photo.image_asset_id === "string" ? originalHashes.get(photo.image_asset_id) : undefined);
    if (keys.some(key => seen.has(key))) {
      return Object.fromEntries(Object.entries(item).filter(([key]) => key !== "image" && !key.startsWith("image_"))) as T;
    }
    keys.forEach(key => seen.add(key));
    return item;
  });
}
