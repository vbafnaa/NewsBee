import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { approvePhotoSupply, createPhotoInvite, photoSupplyInbox, publicPhotoInvite, rejectPhotoSupply, revokePhotoInvite, revokePhotoSource, submitPhotoSupply } from "../../images/supply";
import { discoverCatalogPhotos, importPhotoCatalog, listPhotoCatalog, photoGrantActive } from "../../images/catalog";
import { photoSupplyOpportunities } from "../../images/opportunities";
import { PHOTO_SUPPLY_INVITES, PHOTO_SUPPLY_SUBMISSIONS } from "../../../../../shared/photo-catalog";
import { PHOTO_SUPPLY_GRANT_TEXT, publicPhotoUrl, validatePhotoSupply } from "../../../../../shared/photo-supply";
import { COLLECTIONS } from "../../storage/mongo";
import { processStoryImage, publishableStoryImage } from "../../images/pipeline";
import { collapse } from "../../editions/stories";
import type { CollectedEvent } from "../../connectors/types";

const now = new Date("2026-11-04T12:00:00Z"), location = "wedgwood", by = "editor@example.test";
const scope = { kind: "person" as const, name: "Donna Moodie", city: "Seattle", aliases: [], source_urls: ["https://reporter.example/donna"], identity_url: "https://restaurant.example/team" };
function invitation() { return { source: { id: "portrait", name: "Donna Moodie portrait", evidence_url: "https://restaurant.example/team", scope } }; }
function input() { return { request_id: randomUUID(), name: "Photo editor", email: "editor@restaurant.example", authority: true, no_charge: true,
  people_permissions: true, editorial: true, archive: true, crop: true,
  photos: [{ image: "https://photos.example/donna-original.jpg", image_source_url: "https://restaurant.example/team", image_credit: "Pat Photographer",
    image_date: "2026-10-01", image_caption: "Donna Moodie at her Seattle restaurant." }] }; }
let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("photo-supply-tests"); });
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  await db.dropDatabase();
  await db.collection<{ _id: string }>(COLLECTIONS.locations).insertOne({ _id: location });
});
const invite = (value = invitation()) => createPhotoInvite(db, location, "Wedgwood", value, by, now);

it("stores only the token hash and exposes only the public invitation", async () => {
  const created = await invite();
  const stored = await db.collection(PHOTO_SUPPLY_INVITES).findOne({ id: created.id });
  expect(stored?._id).not.toBe(created.token); expect(JSON.stringify(stored)).not.toContain(created.token);
  const dto = await publicPhotoInvite(db, created.token, now);
  expect(dto).toMatchObject({ name: "Donna Moodie portrait", location_name: "Wedgwood", scope, grant_text: PHOTO_SUPPLY_GRANT_TEXT });
  expect(dto).not.toHaveProperty("created_by"); expect(dto).not.toHaveProperty("contact_email"); expect(dto).not.toHaveProperty("evidence_url");
  expect(await publicPhotoInvite(db, "bad-token", now)).toBeNull();
  expect(await publicPhotoInvite(db, created.token, new Date(now.getTime() + 15 * 86400000))).toBeNull();
});
it("holds supplier files until review, binds the approved grant to exact files, and withdraws it", async () => {
  const created = await invite(), raw = input();
  const submitted = await submitPhotoSupply(db, created.token, raw, now);
  expect(submitted.status).toBe("pending"); expect(await listPhotoCatalog(db, location)).toEqual([]);
  const approved = await approvePhotoSupply(db, location, submitted.id, by, now);
  expect(approved.status).toBe("active");
  const [source] = await listPhotoCatalog(db, location);
  expect(source.permission_record_id).toBe(submitted.id); expect(await photoGrantActive(db, source)).toBe(true);
  expect(source.kind === "supplied" && source.photos[0]).toMatchObject({ image_subject: "Donna Moodie", image_license: "Used with permission" });
  expect(source.kind === "supplied" && source.photos[0]).not.toHaveProperty("image_width");
  const story = collapse([{ source_id: "reporter", facts: { source_event_id: "donna", kind: "local_news", title: "Donna Moodie opens a restaurant",
    source_url: scope.source_urls[0] } as CollectedEvent }])[0];
  const transport = vi.fn();
  const candidates = await discoverCatalogPhotos(db, location, story, "Seattle", now, transport, false);
  expect(candidates).toHaveLength(1); expect(candidates[0]).toMatchObject({ accepted: true, image: { image_subject: "Donna Moodie" } });
  expect(transport).not.toHaveBeenCalled();
  if (source.kind !== "supplied") throw Error("Expected a supplied source");
  for (const changed of [{ ...source, expires_on: "2027-01-01" }, { ...source, scope: { ...source.scope, source_urls: ["https://other.example/donna"] } },
    { ...source, photos: [{ ...source.photos[0], image: "https://photos.example/replacement.jpg" }] }]) {
    await expect(importPhotoCatalog(db, { version: 1, location_id: location, sources: [changed] }, location, true, now)).rejects.toThrow("grant");
  }
  await revokePhotoSource(db, location, source.id, by, now);
  expect(await photoGrantActive(db, source)).toBe(false);
  expect(await discoverCatalogPhotos(db, location, story, "Seattle", now, transport, false)).toEqual([]);
  await expect(approvePhotoSupply(db, location, submitted.id, by, now)).rejects.toThrow("awaiting approval");
});
it("does not let an approved grant bypass the pipeline's native photo validation", async () => {
  const created = await invite(), submitted = await submitPhotoSupply(db, created.token, input(), now);
  await approvePhotoSupply(db, location, submitted.id, by, now);
  const story = collapse([{ source_id: "reporter", facts: { source_event_id: "donna", kind: "local_news", title: "Donna Moodie opens a restaurant",
    source_url: scope.source_urls[0] } as CollectedEvent }])[0];
  await db.collection(COLLECTIONS.editions).insertOne({ id: "edition", run_id: "run", location_id: location, status: "ready", events: [{ source_id: "reporter", facts: story.facts }] });
  await db.collection(COLLECTIONS.editionEntries).insertOne({ edition_id: "edition", story_id: story.id, source_id: "reporter", disposition: "checks_passed",
    result: { story: { id: story.id, kind: story.kind, title: story.title }, draft: { headline: story.title, summary: "Verified report." }, details: {} } });
  const validatePhoto = vi.fn(async () => { throw Error("Native photograph is only 900 pixels wide"); });
  const result = await processStoryImage({ db, now: () => now, sourcePhoto: async () => null, validatePhoto }, "edition", story.id,
    { id: location, name: "Wedgwood", state: "WA", systems: [], community: { parent_name: "Seattle" } as any });
  expect(validatePhoto).toHaveBeenCalledWith(input().photos[0].image);
  expect(result.image).toBeNull();
  expect(await publishableStoryImage(db, "edition", story.id, location, "reporter", now)).toBeNull();
});
it("makes concurrent submission retries idempotent without replacing previously consented files", async () => {
  const created = await invite(), raw = input();
  const results = await Promise.all(Array.from({ length: 6 }, () => submitPhotoSupply(db, created.token, raw, now)));
  expect(new Set(results.map(result => result.id)).size).toBe(1);
  await submitPhotoSupply(db, created.token, { ...raw, photos: [{ ...raw.photos[0], image: "https://photos.example/other.jpg" }] }, now);
  const inbox = await photoSupplyInbox(db, location);
  expect(inbox.submissions).toHaveLength(1); expect(inbox.submissions[0].photos[0].image).toBe(raw.photos[0].image);
  expect(inbox.invites[0]).not.toHaveProperty("_id");
});
it("accepts at most five distinct batches per invitation, including simultaneous calls", async () => {
  const created = await invite();
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => submitPhotoSupply(db, created.token, input(), now)));
  expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(5);
  expect(await db.collection(PHOTO_SUPPLY_SUBMISSIONS).countDocuments()).toBe(5);
});
it("requires authority and all requested rights, dated files and actual photographer credits", () => {
  for (const field of ["authority", "no_charge", "people_permissions", "editorial", "archive", "crop"])
    expect(() => validatePhotoSupply({ ...input(), [field]: false }, scope, now)).toThrow("permissions");
  for (const patch of [{ image_credit: "" }, { image_caption: "" }, { image_date: "2007-01-01" }, { image_date: "2026-11-05" }, { image_date: "2026-02-30" }, { image: "http://127.0.0.1/private" }]) {
    const raw = input();
    expect(() => validatePhotoSupply({ ...raw, photos: [{ ...raw.photos[0], ...patch }] }, scope, now)).toThrow("Invalid");
  }
  const raw = input();
  expect(() => validatePhotoSupply({ ...raw, photos: [raw.photos[0], raw.photos[0]] }, scope, now)).toThrow("once");
  expect(() => publicPhotoUrl("https://photos.example/image.jpg?access_token=private")).toThrow("credentials");
});
it("ignores supplier-supplied roles, asset references, catalog IDs and grant text", () => {
  const raw = input();
  const result = validatePhotoSupply({ ...raw, grant_text: "I refuse cropping", photos: [{ ...raw.photos[0], image_role: "stock", image_place: "Gum Wall",
    image_asset_id: "a".repeat(64), image_catalog_id: "b".repeat(64), image_subject: "Another Person" }] }, scope, now);
  expect(result.grant_text).toBe(PHOTO_SUPPLY_GRANT_TEXT);
  expect(result.photos[0]).toMatchObject({ image_subject: "Donna Moodie" });
  expect(result.photos[0]).not.toHaveProperty("image_role"); expect(result.photos[0]).not.toHaveProperty("image_asset_id");
  expect(result.photos[0]).not.toHaveProperty("image_catalog_id");
});
it("prevents cross-location decisions and rejects submissions without activating a source", async () => {
  const created = await invite(), submitted = await submitPhotoSupply(db, created.token, input(), now);
  await expect(approvePhotoSupply(db, "another-town", submitted.id, by, now)).rejects.toThrow("awaiting approval");
  await expect(rejectPhotoSupply(db, "another-town", submitted.id, "Not valid", by, now)).rejects.toThrow("awaiting review");
  await rejectPhotoSupply(db, location, submitted.id, "Need a dated original", by, now);
  await expect(approvePhotoSupply(db, location, submitted.id, by, now)).rejects.toThrow("awaiting approval");
  expect(await listPhotoCatalog(db, location)).toEqual([]);
});
it("disables expired, revoked and removing-location invitations without revoking a prior grant", async () => {
  const created = await invite(), submitted = await submitPhotoSupply(db, created.token, input(), now);
  await approvePhotoSupply(db, location, submitted.id, by, now);
  await revokePhotoInvite(db, location, created.id);
  expect(await publicPhotoInvite(db, created.token, now)).toBeNull();
  await expect(submitPhotoSupply(db, created.token, input(), now)).rejects.toThrow("expired");
  expect(await photoGrantActive(db, (await listPhotoCatalog(db, location))[0])).toBe(true);
  const second = await invite();
  await db.collection<{ _id: string; removal?: boolean }>(COLLECTIONS.locations).updateOne({ _id: location }, { $set: { removal: true } });
  expect(await publicPhotoInvite(db, second.token, now)).toBeNull();
});
it("does not expose signed coverage URLs or accept a blanket subject scope", async () => {
  await expect(invite({ source: { ...invitation().source, scope: { ...scope, source_urls: ["https://reporter.example/donna?key=private"] } } })).rejects.toThrow("credentials");
  await expect(invite({ source: { ...invitation().source, scope: { ...scope, source_urls: [] } } })).rejects.toThrow("approved story URLs");
});
it("queues thirteen publisher leads separately from the rejected low-resolution portrait", () => {
  const wedgwood = photoSupplyOpportunities("osm-r13915552-wa");
  expect(wedgwood.candidates.flatMap(candidate => candidate.photos)).toHaveLength(13);
  expect(wedgwood.candidates.map(candidate => candidate.kind)).toContain("person");
  expect(photoSupplyOpportunities("moses-lake-wa").candidates).toEqual([]);
  expect(photoSupplyOpportunities("moses-lake-wa").suppliers.length).toBeGreaterThan(0);
  expect(photoSupplyOpportunities("unrelated").suppliers).toEqual([]);
});
