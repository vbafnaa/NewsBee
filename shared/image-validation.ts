import { createHash } from "node:crypto";
import { publicHttpsGet } from "./image-http";
import { safeImageUrl } from "./story-image";

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
export type DeliveredImage = { bytes: Uint8Array; contentType: string; etag: string };

/** Read actual raster dimensions rather than trusting a feed's claimed thumbnail size. */
export function rasterDimensions(bytes: Uint8Array, contentType: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (contentType === "image/png" && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (contentType === "image/gif" && bytes.length >= 10) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (contentType === "image/jpeg") {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) return null;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8)
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      offset += length;
    }
  }
  if (contentType === "image/webp" && bytes.length >= 30) {
    const tag = String.fromCharCode(...bytes.slice(12, 16));
    if (tag === "VP8X") return { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) };
    if (tag === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (tag === "VP8L" && bytes[20] === 0x2f) return { width: 1 + ((bytes[22] & 0x3f) << 8 | bytes[21]), height: 1 + ((bytes[24] & 0x0f) << 10 | bytes[23] << 2 | bytes[22] >> 6) };
  }
  return null;
}

export async function validateEditorialPhoto(source: string): Promise<{ hash: string }> {
  const photo = await downloadStoryImage(source);
  const size = rasterDimensions(photo.bytes, photo.contentType);
  if (!size || size.width < 240 || size.height < 120 || size.width > 30000 || size.height > 30000) throw new Error("Photo has unknown or unsuitable dimensions");
  return { hash: createHash("sha256").update(photo.bytes).digest("hex") };
}

/** Raster signatures shared by pipeline validation and reader delivery. */
export function validImageBytes(bytes: Uint8Array, contentType: string): boolean {
  if (!bytes.length || bytes.byteLength > MAX_IMAGE_BYTES) return false;
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (contentType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
  if (contentType === "image/gif") return ["GIF87a", "GIF89a"].includes(ascii(0, 6));
  if (contentType === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (contentType === "image/avif") return ascii(4, 8) === "ftyp" && /avif|avis/.test(ascii(8, Math.min(bytes.length, 40)));
  return false;
}

export async function downloadStoryImage(source: string, requestSignal?: AbortSignal): Promise<DeliveredImage> {
  const deadline = AbortSignal.timeout(8_000);
  const signal = requestSignal ? AbortSignal.any([requestSignal, deadline]) : deadline;
  let next: string | null = safeImageUrl(source);
  for (let redirects = 0; redirects <= 3 && next; redirects++) {
    const response = await publicHttpsGet({ url: next, signal, maxBytes: MAX_IMAGE_BYTES,
      allowedContentTypes: MIME_TYPES, headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      next = response.headers.location ? safeImageUrl(response.headers.location, response.url) : null;
      continue;
    }
    if (response.status !== 200) throw new Error(`Image origin returned HTTP ${response.status}`);
    const contentType = (response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!validImageBytes(response.body, contentType)) throw new Error("Image signature is invalid");
    return { bytes: response.body, contentType, etag: `"${createHash("sha256").update(response.body).digest("hex")}"` };
  }
  throw new Error("Image link is unavailable");
}
