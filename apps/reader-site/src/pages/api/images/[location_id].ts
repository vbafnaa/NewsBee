import type { APIRoute } from "astro";
import { readerData, readerDatabase, approvedStoryImage } from "../../../lib/reader-data";
import { deliverStoryImage } from "../../../lib/image-delivery";
import { readPhotoAsset, PHOTO_ASSETS, type PhotoAsset, type PhotoBlob } from "../../../../../../shared/image-assets";
import { createHash } from "node:crypto";
import { PHOTO_CATALOG_SOURCES, PHOTO_SUPPLY_SUBMISSIONS, photoGrantData, catalogSourceActive, isCalendarDate, type PhotoCatalogRecord } from "../../../../../../shared/photo-catalog";
import { photoStoryMismatch } from "../../../../../../shared/photo-story-match";

export const prerender = false;

/** Images are addressed by their published edition, never by an arbitrary incoming URL. */
export const GET: APIRoute = async ({ params, url, request }) => {
  const editionId = url.searchParams.get("edition");
  const itemIndex = url.searchParams.get("item") ?? "";
  const unavailable = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });
  if (!editionId || editionId.length > 240 || !/^(0|[1-9]\d{0,4})$/.test(itemIndex)) return unavailable(400);
  try {
    const { locations, editions } = await readerData();
    if (!locations.some((entry) => entry.id === params.location_id)) return unavailable(404);
    const edition = editions.find((entry) => entry.id === editionId && entry.location_id === params.location_id);
    const item = edition?.items[Number(itemIndex)];
    if (!item?.image) return unavailable(404);
    if (photoStoryMismatch(item, item)) return unavailable(404);
    const readerPhoto = item.kind === "reader_story";
    let approvedHash: string | null = null;
    if (readerPhoto) {
      const submissionId = item.image_source_url && new URL(item.image_source_url).searchParams.get("story");
      const approved = submissionId && await approvedStoryImage(params.location_id!, submissionId);
      if (!approved || !approved.permission_confirmed_at || !approved.credit?.trim()) return unavailable(404);
      if (item.image_asset_id) approvedHash = createHash("sha256").update(Buffer.from(approved.data, "base64")).digest("hex");
    }
    const width = Number(url.searchParams.get("width") ?? 1200);
    if (![480, 960, 1200, 1800, 2400].includes(width)) return unavailable(400);
    const catalogPhoto = Boolean(item.image_catalog_id);
    const db = item.image_asset_id || catalogPhoto ? await readerDatabase() : null;
    if (catalogPhoto) {
      if (!/^[a-f0-9]{64}$/.test(item.image_catalog_id ?? "") || !/^[a-f0-9]{64}$/.test(item.image_catalog_revision ?? "")) return unavailable(404);
      const source = db && await db.collection<PhotoCatalogRecord>(PHOTO_CATALOG_SOURCES).findOne({
        _id: item.image_catalog_id, location_id: params.location_id, revision: item.image_catalog_revision,
      });
      const captured = isCalendarDate(item.image_date) ? Date.parse(item.image_date) : NaN;
      const age = Date.now() - captured;
      if (!source || !catalogSourceActive(source) || !Number.isFinite(age) || age < 0 || age > 365 * 86400000) return unavailable(404);
      if (source.permission_record_id) {
        const grant = await db!.collection(PHOTO_SUPPLY_SUBMISSIONS).findOne({ _id: source.permission_record_id as never, location_id: params.location_id, status: "approved" });
        if (!grant || grant.grant_fingerprint !== createHash("sha256").update(JSON.stringify(photoGrantData(source))).digest("hex")) return unavailable(404);
      }
    }
    const readerAsset = db && approvedHash ? await db.collection<PhotoAsset>(PHOTO_ASSETS).findOne({ _id: item.image_asset_id }) : null;
    if (approvedHash && readerAsset?.original_hash !== approvedHash) return unavailable(404);
    const image = item.image_asset_id && db ? await readPhotoAsset({
      asset: id => readerAsset && readerAsset._id === id ? Promise.resolve(readerAsset) : db.collection<PhotoAsset>(PHOTO_ASSETS).findOne({ _id: id }),
      blob: id => db.collection<PhotoBlob>(PHOTO_ASSETS + "_blobs").findOne({ _id: id }),
    }, item.image_asset_id, width, url.searchParams.get("layout") === "mobile" ? "mobile" : "desktop") : await deliverStoryImage(item.image);
    const headers = {
      "Content-Type": image.contentType,
      "Content-Length": String(image.bytes.byteLength),
      "Cache-Control": readerPhoto || catalogPhoto ? "no-store" : "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      ETag: image.etag,
    };
    if (request.headers.get("if-none-match") === image.etag) {
      const { "Content-Length": _length, ...conditionalHeaders } = headers;
      return new Response(null, { status: 304, headers: conditionalHeaders });
    }
    return new Response(new Uint8Array(image.bytes), { headers });
  } catch {
    return unavailable(502);
  }
};
