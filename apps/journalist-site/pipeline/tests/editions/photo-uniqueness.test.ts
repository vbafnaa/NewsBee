import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { photoIdentityKeys, uniquePhotoItems } from "../../../../../shared/photo-identity";
import { PHOTO_ASSETS } from "../../../../../shared/image-assets";
import { parseEdition } from "../../../../reader-site/src/lib/reader-data";
import { claimEditionPhoto, releaseEditionPhoto, photoUsedByOtherStory, uniqueEditionPhotos } from "../../images/uniqueness";
import { IMAGE_POLICY, IMAGE_RESULTS, processStoryImage, type ImagePipelineDeps } from "../../images/pipeline";
import { collapse } from "../../editions/stories";
import type { CollectedEvent, LocationProfile } from "../../connectors/types";
import { publishToReader } from "../../orchestration/publish";
import type { ArtifactStore } from "../../storage/artifacts";

const photo = (image = "https://photos.example/garden.jpg") => ({ image, image_credit: "Pat", image_source_url: "https://publisher.example/gallery" });
const file = "https://commons.wikimedia.org/wiki/File:Town_Garden_2026.jpg";
let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("photo-uniqueness"); });
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => { await db.dropDatabase(); });

it("identifies a Commons file across encoded titles, original URLs and thumbnail sizes", () => {
  const first = { ...photo("https://upload.wikimedia.org/wikipedia/commons/a/ab/Town_Garden_2026.jpg"), image_source_url: file };
  const second = { ...photo("https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Town_Garden_2026.jpg/960px-Town_Garden_2026.jpg?utm_campaign=example"),
    image_source_url: "https://commons.wikimedia.org/wiki/File:Town%20Garden%202026.jpg" };
  expect(photoIdentityKeys(first)).toContain("commons:Town Garden 2026.jpg");
  expect(uniquePhotoItems([{ story_id: "first", ...first }, { story_id: "second", ...second }])[1]).toEqual({ story_id: "second" });
});

it("ignores delivery transforms while preserving parameters that identify different photos", () => {
  const items = [photo("https://photos.example/image?id=1&width=1200&crop=wide"), photo("https://photos.example/image?crop=square&width=480&id=1"),
    photo("https://photos.example/image?id=2&width=1200")];
  expect(uniquePhotoItems(items).map(item => Boolean(item.image))).toEqual([true, false, true]);
});

it("does not treat different photographs on one article or gallery page as duplicates", () => {
  const items = [photo("https://photos.example/first.jpg"), photo("https://photos.example/second.jpg")];
  expect(uniquePhotoItems(items)).toEqual(items);
});

it("reserves one photo atomically when several story jobs compete", async () => {
  const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => claimEditionPhoto(db, "edition", `story-${i}`, "town", 0, photo(), "a".repeat(64))));
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await db.collection("edition_photo_claims").countDocuments()).toBe(1);
});

it("allows retries, other editions, new revisions and separate shadow comparisons", async () => {
  expect(await claimEditionPhoto(db, "edition", "first", "town", 0, photo())).toBe(true);
  expect(await claimEditionPhoto(db, "edition", "first", "town", 0, photo())).toBe(true);
  expect(await claimEditionPhoto(db, "edition", "second", "town", 0, photo())).toBe(false);
  expect(await claimEditionPhoto(db, "another-edition", "second", "town", 0, photo())).toBe(true);
  expect(await claimEditionPhoto(db, "edition", "second", "town", 1, photo())).toBe(true);
  expect(await claimEditionPhoto(db, "edition", "second", "town", 0, photo(), undefined, "shadow")).toBe(true);
  await releaseEditionPhoto(db, "edition", "first", 0);
  expect(await claimEditionPhoto(db, "edition", "second", "town", 0, photo())).toBe(true);
});

it("allows concurrent retries of the same story to keep their own reservation", async () => {
  const claims = await Promise.all(Array.from({ length: 8 }, () => claimEditionPhoto(db, "edition", "first", "town", 0, photo())));
  expect(claims.every(Boolean)).toBe(true);
  expect(await db.collection("edition_photo_claims").countDocuments()).toBe(1);
});

it("keeps the earliest existing placement when old image decisions contain repeats", async () => {
  await db.collection(IMAGE_RESULTS).insertMany(["first", "second"].map(story_id => ({ edition_id: "edition", story_id, policy: IMAGE_POLICY,
    status: "selected", image: photo(), revision: 0 })));
  await db.collection("edition_entries").insertMany(["first", "second"].map((story_id, position) => ({ edition_id: "edition", story_id,
    disposition: "checks_passed", position })));
  expect(await photoUsedByOtherStory(db, "edition", "first", 0, photo())).toBe(false);
  expect(await photoUsedByOtherStory(db, "edition", "second", 0, photo())).toBe(true);
});

it("recognizes differently cropped assets from the same original at publication", async () => {
  const first = "a".repeat(64), second = "b".repeat(64), distinct = "c".repeat(64);
  await db.collection<{ _id: string; original_hash: string }>(PHOTO_ASSETS).insertMany([
    { _id: first, original_hash: "d".repeat(64) }, { _id: second, original_hash: "d".repeat(64) }, { _id: distinct, original_hash: "e".repeat(64) },
  ]);
  const items = [{ story_id: "first", ...photo("https://one.example/a.jpg"), image_asset_id: first },
    { story_id: "second", headline: "Keep this story", ...photo("https://two.example/b.jpg"), image_asset_id: second },
    { story_id: "third", ...photo("https://three.example/c.jpg"), image_asset_id: distinct }];
  const output = await uniqueEditionPhotos(db, items);
  expect(output).toHaveLength(3);
  expect(output[1]).toEqual({ story_id: "second", headline: "Keep this story" });
  expect(output[2].image).toBe(items[2].image);
});

it("protects older reader payloads without dropping any story text or IDs", () => {
  const item = { headline: "An event", blurb: "Keep the published copy", when_where: "Town Garden", event_date: "2026-11-04", source_url: "https://publisher.example/event",
    ...photo(), image_source_url: file };
  const parsed = parseEdition({ id: "edition", location_id: "town", location_name: "Town", window_start: "2026-11-03", window_end: "2026-11-09",
    published_at: 1, headline: "Town news", intro: "", items: [{ story_id: "first", ...item }, { story_id: "second", ...item, image: "https://photos.example/crop.jpg" }] });
  expect(parsed?.items).toHaveLength(2);
  expect(parsed?.items[0].image).toBe(item.image);
  expect(parsed?.items[1]).toMatchObject({ story_id: "second", blurb: item.blurb });
  expect(parsed?.items[1]).not.toHaveProperty("image");
});

it("does not let an ineligible record photo take the slot from a valid event", () => {
  const image = { ...photo(), image_role: "venue", image_place: "Town Garden", image_caption: "Location context", image_date: "2026-10-01",
    image_license: "CC BY 4.0", image_license_url: "https://creativecommons.org/licenses/by/4.0/" };
  const item = { headline: "Update", blurb: "Keep the copy", when_where: "Town Garden", event_date: "2026-11-04", source_url: "https://publisher.example/event", ...image };
  const parsed = parseEdition({ id: "edition", location_id: "town", location_name: "Town", window_start: "2026-11-03", window_end: "2026-11-09",
    published_at: 1, headline: "News", intro: "", items: [{ ...item, story_id: "record", kind: "public_record" }, { ...item, story_id: "event", kind: "event" }] });
  expect(parsed?.items[0]).not.toHaveProperty("image");
  expect(parsed?.items[1].image).toBe(image.image);
});

it("withholds a conflicting photo when a saved edition is republished directly", async () => {
  const story = { story_id: "mime", headline: "Mime class", blurb: "The class meets at Georgetown Studios.",
    when_where: "Where: Market Theater by the Gum Wall", kind: "event" };
  const saveJson = vi.fn(async (_folder: string, _name: string, _value: unknown) => "saved");
  const store = { saveJson } as ArtifactStore;
  await publishToReader(db, store, { id: "edition", location_id: "town", items: [
    { ...story, ...photo(), image_role: "venue", image_place: "Gum Wall" },
  ] }, "reader");
  expect(saveJson.mock.calls[0][2]).toMatchObject({ id: "edition", items: [story] });
  expect((saveJson.mock.calls[0][2] as { items: object[] }).items[0]).not.toHaveProperty("image");
});

const location: LocationProfile = { id: "town", name: "Seattle, WA", state: "WA", systems: [] };
async function seed(name: string) {
  const event = { source_id: "web:publisher", facts: { source_event_id: name, title: name, kind: "local_news", event_date: "2026-11-04",
    venue: "Town Garden", source_url: "https://publisher.example/story" } as CollectedEvent };
  const story = collapse([event])[0];
  await db.collection("editions").updateOne({ id: "edition" }, { $setOnInsert: { id: "edition", run_id: "run", location_id: location.id, status: "ready", events: [] } }, { upsert: true });
  await db.collection("editions").updateOne({ id: "edition" }, { $push: { events: event } } as never);
  await db.collection("edition_entries").insertOne({ edition_id: "edition", story_id: story.id, source_id: "web:publisher", disposition: "checks_passed",
    result: { story: { id: story.id, title: name, kind: "local_news" }, draft: { headline: name, summary: "Validated copy" }, details: {} } });
  return story.id;
}

it("tries the next publisher candidate when the first one belongs to another story", async () => {
  await db.collection("source_map").insertOne({ location_id: location.id, source_id: "web:publisher", access_review: {
    images_allowed: true, collection_allowed: true, checked_on: "2026-11-01", expires_on: "2026-12-01" } });
  const first = await seed("First story"), second = await seed("Second story");
  const deps: ImagePipelineDeps = { db, now: () => new Date("2026-11-03T12:00:00Z"), sourcePhoto: async () => null,
    sourcePhotos: vi.fn(async () => [photo("https://photos.example/a.jpg"), photo("https://photos.example/b.jpg")]), validatePhoto: vi.fn(async () => undefined) };
  expect(await processStoryImage(deps, "edition", first, location)).toMatchObject({ image: { image: "https://photos.example/a.jpg" } });
  expect(await processStoryImage(deps, "edition", second, location)).toMatchObject({ image: { image: "https://photos.example/b.jpg" } });
  expect(deps.validatePhoto).toHaveBeenCalledTimes(2);
});

it("detects identical downloaded bytes at different URLs before selecting a fallback", async () => {
  await db.collection("source_map").insertOne({ location_id: location.id, source_id: "web:publisher", access_review: {
    images_allowed: true, collection_allowed: true, checked_on: "2026-11-01", expires_on: "2026-12-01" } });
  const first = await seed("First story"), second = await seed("Second story");
  const deps: ImagePipelineDeps = { db, now: () => new Date("2026-11-03T12:00:00Z"), sourcePhoto: async () => null,
    sourcePhotos: vi.fn(async () => [photo("https://photos.example/a.jpg")]), validatePhoto: vi.fn(async url => ({ hash: (url.endsWith("b.jpg") ? "b" : "a").repeat(64) })) };
  await processStoryImage(deps, "edition", first, location);
  deps.sourcePhotos = vi.fn(async () => [photo("https://mirror.example/alias.jpg"), photo("https://photos.example/b.jpg")]);
  expect(await processStoryImage(deps, "edition", second, location)).toMatchObject({ image: { image: "https://photos.example/b.jpg" } });
});
