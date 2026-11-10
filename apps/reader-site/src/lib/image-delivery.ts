import { safeImageUrl } from "../../../../shared/story-image";
import { MAX_IMAGE_BYTES, downloadStoryImage, type DeliveredImage } from "../../../../shared/image-validation";
export { downloadStoryImage, validImageBytes, type DeliveredImage } from "../../../../shared/image-validation";
export { isPublicImageAddress } from "../../../../shared/image-http";

const CACHE_BYTES = 24 * 1024 * 1024;
const CACHE_ENTRIES = 96;
const FRESH_MS = 60 * 60 * 1000;
const STALE_MS = 24 * FRESH_MS;

/** Bounded FIFO admission avoids dropping ordinary photo grids while limiting origin work. */
export function createImageDelivery(load = downloadStoryImage, now = Date.now) {
  const cache = new Map<string, { image: DeliveredImage; at: number }>();
  const pending = new Map<string, Promise<DeliveredImage>>();
  const waiting: Array<{ start(): void; abort(): void }> = [];
  let active = 0;
  let bytes = 0;
  const acquire = (signal: AbortSignal): Promise<() => void> => new Promise((resolve, reject) => {
    const entry = {
      start() {
        signal.removeEventListener("abort", entry.abort);
        active++;
        resolve(() => { active--; waiting.shift()?.start(); });
      },
      abort() {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error("Image queue timed out"));
      },
    };
    if (signal.aborted) { entry.abort(); return; }
    if (active < 8) entry.start();
    else { waiting.push(entry); signal.addEventListener("abort", entry.abort, { once: true }); }
  });
  const queuedLoad = async (key: string) => {
    const signal = AbortSignal.timeout(16_000);
    const release = await acquire(signal);
    try { return await load(key, signal); }
    finally { release(); }
  };
  return async (source: string): Promise<DeliveredImage> => {
    const key = safeImageUrl(source);
    if (!key) throw new Error("Image URL is invalid");
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      if (now() - cached.at < FRESH_MS) return cached.image;
    }
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= 40) {
      if (cached && now() - cached.at < STALE_MS) return cached.image;
      throw new Error("Image delivery is busy");
    }
    const promise = queuedLoad(key).then((image) => {
      const previous = cache.get(key);
      if (previous) { cache.delete(key); bytes -= previous.image.bytes.byteLength; }
      if (image.bytes.byteLength <= MAX_IMAGE_BYTES) {
        while ((bytes + image.bytes.byteLength > CACHE_BYTES || cache.size >= CACHE_ENTRIES) && cache.size) {
          const oldest = cache.keys().next().value!;
          bytes -= cache.get(oldest)!.image.bytes.byteLength;
          cache.delete(oldest);
        }
        cache.set(key, { image, at: now() });
        bytes += image.bytes.byteLength;
      }
      return image;
    }).catch((error: unknown) => {
      if (cached && now() - cached.at < STALE_MS) return cached.image;
      throw error;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };
}

export const deliverStoryImage = createImageDelivery();
