import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ readerData: vi.fn(), readerDatabase: vi.fn(), approvedStoryImage: vi.fn(), deliverStoryImage: vi.fn() }));
vi.mock("../../../../reader-site/src/lib/reader-data", () => ({ readerData: mocks.readerData, readerDatabase: mocks.readerDatabase, approvedStoryImage: mocks.approvedStoryImage }));
vi.mock("../../../../reader-site/src/lib/image-delivery", () => ({ deliverStoryImage: mocks.deliverStoryImage }));
import { GET } from "../../../../reader-site/src/pages/api/images/[location_id]";
import { createHash } from "node:crypto";
import { photoGrantData } from "../../../../../shared/photo-catalog";

const assetId = "a".repeat(64);
let item: Record<string, unknown>;
let catalog: Record<string, unknown> | null;
let grant: Record<string, unknown> | null;
const blob = { _id: "variant", bytes: new Uint8Array([1, 2, 3]), content_type: "image/webp", width: 1200, height: 800 };
const find = vi.fn(async (collection: string, query: any) => collection === "photo_catalog_sources"
  ? catalog && Object.entries(query).every(([key, value]) => catalog?.[key] === value) ? catalog : null
  : collection === "photo_supply_submissions" ? grant && Object.entries(query).every(([key, value]) => grant?.[key] === value) ? grant : null
  : collection.endsWith("_blobs") ? blob : query._id === assetId ? {
  _id: assetId, original_hash: createHash("sha256").update("approved reader photo").digest("hex"), variants: [{ id: "variant", layout: "desktop", width: 1200, height: 800 }, { id: "variant", layout: "mobile", width: 1200, height: 900 }],
} : null);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
  vi.clearAllMocks();
  catalog = null;
  grant = null;
  item = { story_id: "story", kind: "event", image: "https://origin.example/old.jpg", image_credit: "Pat", image_asset_id: assetId };
  mocks.readerData.mockImplementation(async () => ({ locations: [{ id: "town" }], editions: [{ id: "edition", location_id: "town", items: [item] }] }));
  mocks.readerDatabase.mockResolvedValue({ collection: (name: string) => ({ findOne: (query: any) => find(name, query) }) });
  mocks.deliverStoryImage.mockRejectedValue(Error("Origin is offline"));
});
afterEach(() => vi.useRealTimers());
const get = (query = "", headers = {}) => {
  const url = new URL("https://reader.example/reader/api/images/town?edition=edition&item=0" + query);
  return GET({ params: { location_id: "town" }, url, request: new Request(url, { headers }) } as any);
};
it("delivers only the published edition's archived variant, even when the origin is offline", async () => {
  const response = await get("&width=1200&asset=" + "c".repeat(64));
  expect(response.status).toBe(200); expect(response.headers.get("Content-Type")).toBe("image/webp");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(blob.bytes);
  expect(find).toHaveBeenCalledWith("photo_assets", { _id: assetId }); expect(mocks.deliverStoryImage).not.toHaveBeenCalled();
  expect((await get("&width=999999")).status).toBe(400);
});
it("keeps reader-photo variants approval-scoped and uncached, including conditional requests", async () => {
  item.kind = "reader_story"; item.image_source_url = "https://reader.example/reader/share?location=town&story=reader-submission";
  mocks.approvedStoryImage.mockResolvedValue({ credit: "Pat", permission_confirmed_at: "2026-11-02", data: Buffer.from("approved reader photo").toString("base64") });
  const response = await get(); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  mocks.approvedStoryImage.mockResolvedValue({ credit: "Pat", permission_confirmed_at: "2026-11-02", data: Buffer.from("replacement photo").toString("base64") });
  expect((await get()).status).toBe(404);
  mocks.approvedStoryImage.mockResolvedValue(null);
  const removed = await get("", { "If-None-Match": '"variant"' });
  expect(removed.status).toBe(404); expect(removed.headers.get("Cache-Control")).toBe("no-store");
});
it("rechecks catalog permission before archived delivery and conditional responses", async () => {
  item.image_catalog_id = "b".repeat(64); item.image_catalog_revision = "c".repeat(64); item.image_date = "2026-11-01";
  catalog = { _id: item.image_catalog_id, revision: item.image_catalog_revision, location_id: "town", status: "active", kind: "commons_category",
    reviewed_on: "2026-01-01", expires_on: "2099-01-01" };
  const response = await get();
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  const conditional = { "If-None-Match": response.headers.get("ETag")! };
  expect((await get("", conditional)).status).toBe(304);
  catalog.status = "revoked";
  const removed = await get("", conditional);
  expect(removed.status).toBe(404); expect(removed.headers.get("Cache-Control")).toBe("no-store");
});
it.each(["location_id", "revision", "expires_on"])("blocks catalog photos with a changed %s", async field => {
  item.image_catalog_id = "b".repeat(64); item.image_catalog_revision = "c".repeat(64); item.image_date = "2026-11-01";
  catalog = { _id: item.image_catalog_id, revision: item.image_catalog_revision, location_id: "town", status: "active", kind: "commons_category",
    reviewed_on: "2026-01-01", expires_on: "2099-01-01", [field]: field === "expires_on" ? "2026-01-02" : "changed" };
  expect((await get()).status).toBe(404);
  expect(mocks.deliverStoryImage).not.toHaveBeenCalled();
});
it("rechecks the exact supplier grant before serving an archived photo or a 304", async () => {
  item.headline = "Donna Moodie opens a restaurant"; item.image_subject = "Donna Moodie";
  item.image_catalog_id = "b".repeat(64); item.image_catalog_revision = "c".repeat(64); item.image_date = "2026-11-01";
  catalog = { _id: item.image_catalog_id, revision: item.image_catalog_revision, location_id: "town", status: "active", kind: "supplied",
    reviewed_on: "2026-11-01", expires_on: "2026-12-01", permission_record_id: "1ed192d1-9028-4e9d-895b-4471d648fe46",
    permission: { editorial: true, archive: true, crop: true }, scope: { kind: "person", name: "Donna Moodie", city: "Seattle" }, photos: [item] };
  grant = { _id: catalog.permission_record_id, location_id: "town", status: "approved", grant_fingerprint: createHash("sha256").update(JSON.stringify(photoGrantData(catalog as any))).digest("hex") };
  const response = await get(); expect(response.status).toBe(200);
  const conditional = { "If-None-Match": response.headers.get("ETag")! };
  catalog.expires_on = "2026-12-02";
  expect((await get("", conditional)).status).toBe(404);
  catalog.expires_on = "2026-12-01"; grant.status = "revoked";
  expect((await get("", conditional)).status).toBe(404);
});
it("withholds a portrait after the story no longer supports its named subject", async () => {
  item.image_subject = "Donna Moodie"; item.headline = "A different restaurant opens";
  expect((await get()).status).toBe(404);
  expect(find).not.toHaveBeenCalled();
});
