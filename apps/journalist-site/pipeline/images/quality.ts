import sharp from "sharp";
import { createHash } from "node:crypto";
import { Binary, type Db } from "mongodb";
import { PHOTO_ASSETS, type PhotoAsset, type PhotoBlob } from "../../../../shared/image-assets";
import type { VisionInput } from "../model/runtime";

export const PHOTO_QUALITY_POLICY = "editorial_pixels_v2";
export type Crop = { left: number; top: number; width: number; height: number };
export type PreparedPhoto = { bytes: Buffer; original: Buffer; hash: string; width: number; height: number; preview: VisionInput };
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const decoder = (bytes: Uint8Array) => sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning", animated: false }).timeout({ seconds: 5 });

/** Full decoding catches truncated files; EXIF orientation is applied before any crop math. */
export async function preparePhoto(bytes: Uint8Array, previewEdge = 1280): Promise<PreparedPhoto> {
  if (!bytes.byteLength || bytes.byteLength > 6 * 1024 * 1024) throw new Error("Photo exceeds download bounds");
  const metadata = await decoder(bytes).metadata();
  if ((metadata.pages ?? 1) !== 1 || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw new Error("Unsupported editorial photo");
  const { data, info } = await decoder(bytes).rotate().jpeg({ quality: 95 }).toBuffer({ resolveWithObject: true });
  if (info.width < 1200 || info.height < 600) throw new Error("Photo is below editorial resolution");
  const preview = await decoder(data).resize({ width: previewEdge, height: previewEdge, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  return { bytes: data, original: Buffer.from(bytes), hash: hash(bytes), width: info.width, height: info.height,
    preview: { id: hash(bytes), mimeType: "image/jpeg", data: preview.toString("base64") } };
}

export function photoCrop(photo: Pick<PreparedPhoto, "width" | "height">, x: number, y: number, aspect: number): Crop {
  if (![x, y, aspect].every(Number.isFinite) || x < 0 || x > 1 || y < 0 || y > 1 || aspect <= 0) throw new Error("Invalid photo crop");
  const width = Math.min(photo.width, Math.floor(photo.height * aspect));
  const height = Math.min(photo.height, Math.floor(width / aspect));
  return { width, height, left: Math.max(0, Math.min(photo.width - width, Math.round(x * photo.width - width / 2))),
    top: Math.max(0, Math.min(photo.height - height, Math.round(y * photo.height - height / 2))) };
}

export async function cropPreviews(photo: PreparedPhoto, x: number, y: number, lead: boolean, previewEdge = 1280, contactSheet = false) {
  const desktop = photoCrop(photo, x, y, 3 / 2), mobile = photoCrop(photo, x, y, 4 / 3);
  if (desktop.width < (lead ? 1800 : 1200) || desktop.height < (lead ? 900 : 600) || mobile.width < 1200 || mobile.height < 600)
    throw new Error("Reviewed crop is below editorial resolution");
  const images: VisionInput[] = [];
  for (const [id, crop] of [["desktop", desktop], ["mobile", mobile]] as const) images.push({ id, mimeType: "image/jpeg",
    data: (await decoder(photo.bytes).extract(crop).resize({ width: previewEdge, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer()).toString("base64") });
  const side = Math.min(512, photo.width, photo.height);
  const detail = { width: side, height: side, left: Math.max(0, Math.min(photo.width - side, Math.round(x * photo.width - side / 2))),
    top: Math.max(0, Math.min(photo.height - side, Math.round(y * photo.height - side / 2))) };
  images.push({ id: "detail", mimeType: "image/jpeg", data: (await decoder(photo.bytes).extract(detail).jpeg({ quality: 95 }).toBuffer()).toString("base64") });
  if (contactSheet) {
    const panels = await Promise.all(images.map(async (image, index) => ({
      input: index === 2 ? Buffer.from(image.data, "base64") : await decoder(Buffer.from(image.data, "base64")).resize({ width: 288 }).png().toBuffer(),
      left: index === 0 ? 16 : index === 1 ? 336 : 64, top: index === 2 ? 304 : 40,
    })));
    const labels = Buffer.from('<svg width="640" height="832"><g font-family="Arial,sans-serif" font-size="17" fill="#111"><text x="16" y="25">Desktop crop</text><text x="336" y="25">Mobile crop</text><text x="64" y="290">Native detail: 512 px at 1:1</text></g></svg>');
    const sheet = await sharp({ create: { width: 640, height: 832, channels: 3, background: "#ffffff" } })
      .composite([...panels, { input: labels, left: 0, top: 0 }]).png().toBuffer();
    return { desktop, mobile, images: [{ id: "desktop_mobile_detail", mimeType: "image/png" as const, data: sheet.toString("base64") }] };
  }
  return { desktop, mobile, images };
}

/** Immutable, durable originals and reviewed derivatives use the existing Mongo store. */
export async function storePhoto(db: Db, photo: PreparedPhoto, crops: { desktop: Crop; mobile: Crop }, context: { location_id: string; source_id: string; source_url: string }) {
  const id = hash(JSON.stringify([photo.hash, crops, PHOTO_QUALITY_POLICY]));
  const variants: PhotoAsset["variants"] = [];
  for (const layout of ["desktop", "mobile"] as const) {
    const crop = crops[layout];
    for (const width of [480, 960, 1200, 1800, 2400].filter(width => width <= crop.width)) {
      const { data, info } = await decoder(photo.bytes).extract(crop).resize({ width, withoutEnlargement: true }).webp({ quality: 88 }).toBuffer({ resolveWithObject: true });
      const variantId = hash(data);
      await db.collection<PhotoBlob>(PHOTO_ASSETS + "_blobs").updateOne({ _id: variantId }, { $setOnInsert: {
        bytes: new Binary(data), content_type: "image/webp", width: info.width, height: info.height,
      } }, { upsert: true });
      variants.push({ id: variantId, width: info.width, height: info.height, layout });
    }
  }
  await db.collection(PHOTO_ASSETS + "_originals").updateOne({ _id: photo.hash as never }, { $setOnInsert: { bytes: new Binary(photo.original), created_at: Date.now() } }, { upsert: true });
  await db.collection<PhotoAsset>(PHOTO_ASSETS).updateOne({ _id: id }, { $setOnInsert: {
    original_hash: photo.hash, variants, policy: PHOTO_QUALITY_POLICY, created_at: Date.now(), ...context,
  } }, { upsert: true });
  return id;
}
