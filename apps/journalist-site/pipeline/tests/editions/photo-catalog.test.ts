import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { categoryCommonsPhotos, namedCommonsPhotos, type CommonsPage } from "../../images/commons";
import { catalogPhotoApproved, discoverCatalogPhotos, importPhotoCatalog, parsePhotoCatalog, photoCatalogVersion, photoScopeMatches } from "../../images/catalog";
import { processStoryImage, publishableStoryImage, type ImagePipelineDeps } from "../../images/pipeline";
import { collapse } from "../../editions/stories";
import type { CollectedEvent, LocationProfile } from "../../connectors/types";
import type { HttpTransport } from "../../core/http";
import { COLLECTIONS } from "../../storage/mongo";
import { PHOTO_CATALOG_SOURCES, catalogSourceActive, type PhotoCatalogRecord } from "../../../../../shared/photo-catalog";
import { normalizeStoryImage } from "../../../../../shared/story-image";

const now = new Date("2026-11-03T12:00:00Z");
const location: LocationProfile = { id: "wedgwood", name: "Wedgwood, WA", state: "WA", systems: [],
  community: { parent_name: "Seattle" } as LocationProfile["community"] };
function manifest() {
  return { version: 1, location_id: location.id, sources: [{ id: "car-show", name: "Wedgwood Car Show", status: "active",
    reviewed_on: "2026-11-03", expires_on: "2026-12-03", evidence_url: "https://commons.wikimedia.org/wiki/Category:Wedgwood_Car_Show",
    kind: "commons_category", category: "Category:Wedgwood Car Show", scope: { kind: "event", name: "Wedgwood Car Show", city: "Seattle",
      aliases: ["19th Annual Wedgwood Car Show"], event_date: "2026-08-23", source_urls: [] } }] };
}
function page(index = 0): CommonsPage {
  return { title: `File:Wedgwood Car Show Seattle 2026 ${index}.jpg`, imageinfo: [{ mime: "image/jpeg", width: 6000, height: 4000,
    thumburl: `https://upload.wikimedia.org/commons/show-${index}.jpg`, thumbwidth: 2560, thumbheight: 1707,
    descriptionurl: `https://commons.wikimedia.org/wiki/File:Wedgwood_Car_Show_Seattle_2026_${index}.jpg`, extmetadata: {
      ImageDescription: { value: "19th Annual Wedgwood Car Show in Seattle" }, DateTimeOriginal: { value: "2026-08-23" },
      Artist: { value: "Joe Mabel" }, LicenseShortName: { value: "CC BY-SA 4.0" },
      LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" },
    } }] };
}
const response = (request: { url: string }, value: unknown, status = 200) => ({ url: request.url, status, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) });
const event = (overrides = {}) => collapse([{ source_id: "organizer", facts: { source_event_id: "show", title: "Wedgwood Car Show", kind: "event",
  venue: "Wedgwood Broiler", event_date: "2026-08-23", source_url: "https://organizer.example/event", ...overrides } as CollectedEvent }])[0];

describe("bounded Commons discovery", () => {
  it("paginates directly through files, deduplicates and stops at two pages", async () => {
    const transport = vi.fn<HttpTransport>(async request => {
      const second = new URL(request.url).searchParams.has("gcmcontinue");
      const pages = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, page(i + (second ? 12 : 0))]));
      return response(request, { query: { pages }, continue: { gcmcontinue: second ? "third-page" : "second-page" } });
    });
    expect(await categoryCommonsPhotos("Category:Wedgwood Car Show", transport)).toHaveLength(24);
    expect(transport).toHaveBeenCalledTimes(2);
    const query = new URL(transport.mock.calls[1][0].url).searchParams;
    expect(query.get("gcmcontinue")).toBe("second-page");
    expect(query.get("gcmtype")).toBe("file"); expect(query.get("gcmnamespace")).toBe("6");
    expect(transport.mock.calls[0][0]).toMatchObject({ timeoutMs: 8000, maxBytes: 1048576 });
  });
  it("ignores non-files and repeated continuation values", async () => {
    const transport = vi.fn<HttpTransport>(async request => response(request, { query: { pages: {
      1: page(), 2: page(), 3: { title: "Category:Unrelated" },
    } }, continue: { gcmcontinue: "same-page" } }));
    expect(await categoryCommonsPhotos("Category:Wedgwood Car Show", transport)).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("accepts an empty category and rejects API failures", async () => {
    expect(await categoryCommonsPhotos("Category:Empty", async request => response(request, { batchcomplete: "" }))).toEqual([]);
    await expect(categoryCommonsPhotos("Category:Empty", async request => response(request, { error: { code: "maxlag" } }))).rejects.toThrow("invalid response");
    await expect(categoryCommonsPhotos("Category:Empty", async request => response(request, {}, 503))).rejects.toThrow("503");
  });
  it("rejects query injection before any request and bounds named file requests", async () => {
    const transport = vi.fn<HttpTransport>(async request => response(request, { query: { pages: { 1: page() } } }));
    await expect(categoryCommonsPhotos("Category:Show|Category:Other", transport)).rejects.toThrow("Invalid");
    await expect(namedCommonsPhotos(Array(13).fill("File:Car.jpg"), transport)).rejects.toThrow("Invalid");
    expect(transport).not.toHaveBeenCalled();
    expect(await namedCommonsPhotos(["File:Car.jpg", "File:Car.jpg"], transport)).toHaveLength(1);
    expect(new URL(transport.mock.calls[0][0].url).searchParams.get("titles")).toBe("File:Car.jpg");
  });
});

let server: MongoMemoryServer, client: MongoClient, db: Db, deps: ImagePipelineDeps;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("photo-catalog-tests"); });
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  await db.dropDatabase();
  deps = { db, now: () => now, sourcePhoto: vi.fn(async () => null), validatePhoto: vi.fn(async () => undefined),
    transport: vi.fn(async request => response(request, { query: { pages: { 1: page() } } })) };
});
async function seed(overrides = {}) {
  const story = event(overrides);
  await db.collection(COLLECTIONS.editions).insertOne({ id: "edition", run_id: "run", location_id: location.id, status: "ready",
    events: [{ source_id: "organizer", facts: story.facts }] });
  await db.collection(COLLECTIONS.editionEntries).insertOne({ edition_id: "edition", story_id: story.id, source_id: "organizer", disposition: "checks_passed",
    result: { story: { id: story.id, kind: story.kind, title: story.title }, draft: { headline: story.title, summary: "Validated report." }, details: {} } });
  return story;
}

it("validates without mutation and applies idempotent, community-scoped imports", async () => {
  const before = await photoCatalogVersion(db, location.id);
  expect(await importPhotoCatalog(db, manifest(), location.id, false, now)).toMatchObject({ applied: false });
  expect(await db.collection(PHOTO_CATALOG_SOURCES).countDocuments()).toBe(0);
  await importPhotoCatalog(db, manifest(), location.id, true, now);
  await importPhotoCatalog(db, manifest(), location.id, true, now);
  expect(await db.collection(PHOTO_CATALOG_SOURCES).countDocuments()).toBe(1);
  expect(await photoCatalogVersion(db, location.id)).not.toBe(before);
  const other = { ...manifest(), location_id: "moses-lake" };
  await importPhotoCatalog(db, other, other.location_id, true, now);
  expect(await db.collection(PHOTO_CATALOG_SOURCES).countDocuments()).toBe(2);
  expect(() => parsePhotoCatalog(other, location.id, now)).toThrow("community");
});
it.each(["2026-02-30", "tomorrow"])("rejects invalid calendar dates: %s", expires => {
  const data = manifest(); data.sources[0].expires_on = expires;
  expect(() => parsePhotoCatalog(data, location.id, now)).toThrow("date");
});
it("rejects future reviews, vague scopes, duplicate IDs and missing permissions", () => {
  const future = manifest(); future.sources[0].reviewed_on = "2026-11-04";
  expect(() => parsePhotoCatalog(future, location.id, now)).toThrow("review window");
  const broad = manifest(); broad.sources[0].scope.name = "Seattle";
  expect(() => parsePhotoCatalog(broad, location.id, now)).toThrow("specific");
  const duplicate = manifest(); duplicate.sources.push(duplicate.sources[0]);
  expect(() => parsePhotoCatalog(duplicate, location.id, now)).toThrow("duplicate");
  const supplied = { ...manifest(), sources: [{ ...manifest().sources[0], kind: "supplied", photos: [], permission: { editorial: true, archive: false, crop: true } }] };
  expect(() => parsePhotoCatalog(supplied, location.id, now)).toThrow("permission");
  supplied.sources[0].status = "pending";
  expect(parsePhotoCatalog(supplied, location.id, now)[0].status).toBe("pending");
});
it("matches the exact event, city, date and optional original source", () => {
  const scope = parsePhotoCatalog(manifest(), location.id, now)[0].scope;
  expect(photoScopeMatches(scope, event(), "Seattle")).toBe(true);
  expect(photoScopeMatches(scope, event(), "Moses Lake")).toBe(false);
  expect(photoScopeMatches(scope, event({ event_date: "2027-08-23" }), "Seattle")).toBe(false);
  expect(photoScopeMatches(scope, event({ title: "Unrelated neighborhood car show" }), "Seattle")).toBe(false);
  expect(photoScopeMatches(scope, event({ kind: "safety_incident" }), "Seattle")).toBe(false);
  scope.source_urls = ["https://another.example/event"];
  expect(photoScopeMatches(scope, event(), "Seattle")).toBe(false);
});
it("does not fetch pending, expired or wrong-community sources", async () => {
  const data = manifest(); data.sources[0].status = "pending";
  await importPhotoCatalog(db, data, location.id, true, now);
  expect(await discoverCatalogPhotos(db, location.id, event(), "Seattle", now, deps.transport!)).toEqual([]);
  data.sources[0].status = "active"; data.sources[0].expires_on = "2026-11-02"; data.sources[0].reviewed_on = "2026-11-01";
  await importPhotoCatalog(db, data, location.id, true, now);
  expect(await discoverCatalogPhotos(db, location.id, event(), "Seattle", now, deps.transport!)).toEqual([]);
  expect(await discoverCatalogPhotos(db, "another-community", event(), "Seattle", now, deps.transport!)).toEqual([]);
  expect(deps.transport).not.toHaveBeenCalled();
});
it("honors the run's Commons switch without changing catalog permissions", async () => {
  await importPhotoCatalog(db, manifest(), location.id, true, now);
  expect(await discoverCatalogPhotos(db, location.id, event(), "Seattle", now, deps.transport!, false)).toEqual([]);
  expect(deps.transport).not.toHaveBeenCalled();
});
it("keeps a supplied-photo grant private while attaching only its public credit and scope", async () => {
  const privateEvidence = "https://admin.example/permissions/grant-123";
  const data = { version: 1, location_id: location.id, sources: [{ ...manifest().sources[0], kind: "supplied", evidence_url: privateEvidence,
    permission: { editorial: true, archive: true, crop: true }, photos: [{ image: "https://photos.example/show.jpg", image_credit: "Pat Photographer", image_source_url: "https://organizer.example/event",
      image_alt: "Neighbors viewing cars", image_caption: "Wedgwood Car Show, Seattle", image_date: "2026-08-23", image_width: 2400,
      image_height: 1600, image_license: "Used with permission" }] }] };
  await importPhotoCatalog(db, data, location.id, true, now);
  const candidates = await discoverCatalogPhotos(db, location.id, event(), "Seattle", now, deps.transport!, false);
  expect(candidates).toHaveLength(1);
  expect(normalizeStoryImage(candidates[0].image)).toMatchObject({ image_credit: "Pat Photographer", image_license: "Used with permission" });
  expect(JSON.stringify(candidates)).not.toContain(privateEvidence);
  expect(deps.transport).not.toHaveBeenCalled();
  data.sources[0].permission.crop = false;
  expect(() => parsePhotoCatalog(data, location.id, now)).toThrow("permission");
});
it("preserves privately licensed venue metadata only when linked to a complete catalog reference", () => {
  const image = { image: "https://photos.example/venue.jpg", image_role: "venue", image_credit: "Pat", image_caption: "View of Town Garden",
    image_date: "2026-10-01", image_license: "Used with permission", image_catalog_id: "a".repeat(64), image_catalog_revision: "b".repeat(64) };
  expect(normalizeStoryImage(image)).toMatchObject(image);
  expect(normalizeStoryImage({ ...image, image_catalog_revision: undefined })).toBeNull();
});
it("checks each file's identity, capture date and license instead of trusting category membership", async () => {
  await importPhotoCatalog(db, manifest(), location.id, true, now);
  const wrongDate = page(1); wrongDate.imageinfo![0].extmetadata!.DateTimeOriginal.value = "2007-08-23";
  const wrongCity = page(2); wrongCity.title = "File:Car Show.jpg"; wrongCity.imageinfo![0].extmetadata!.ImageDescription.value = "Wedgwood Car Show, another city";
  const restricted = page(3); restricted.imageinfo![0].extmetadata!.UsageTerms = { value: "Permission required" };
  deps.transport = vi.fn(async request => response(request, { query: { pages: { 1: page(), 2: wrongDate, 3: wrongCity, 4: restricted } } }));
  const candidates = await discoverCatalogPhotos(db, location.id, event(), "Seattle", now, deps.transport);
  expect(candidates.filter(candidate => candidate.accepted)).toHaveLength(1);
  expect(candidates[0].image).toMatchObject({ image_credit: "Joe Mabel", image_date: "2026-08-23", image_license: "CC BY-SA 4.0" });
  expect(candidates[0].image).not.toHaveProperty("image_role");
  expect(candidates[0].image?.image_catalog_id).toMatch(/^[a-f0-9]{64}$/);
  await discoverCatalogPhotos(db, location.id, event(), "Seattle", now, deps.transport);
  expect(deps.transport).toHaveBeenCalledTimes(1);
});
it("selects a catalog event photo, then blocks changed permissions before publication and retry", async () => {
  await importPhotoCatalog(db, manifest(), location.id, true, now);
  const story = await seed();
  const result = await processStoryImage(deps, "edition", story.id, location);
  expect(result).toMatchObject({ status: "selected", provider: "catalog", image: { image_credit: "Joe Mabel" } });
  expect(await publishableStoryImage(db, "edition", story.id, location.id, "organizer", now)).toEqual(result.image);
  const source = (await db.collection<PhotoCatalogRecord>(PHOTO_CATALOG_SOURCES).findOne())!;
  expect(catalogSourceActive(source, now)).toBe(true);
  expect(await catalogPhotoApproved(db, result.catalog!, story, "another-community", "Seattle", now)).toBe(false);
  await db.collection<PhotoCatalogRecord>(PHOTO_CATALOG_SOURCES).updateOne({ _id: source._id }, { $set: { status: "revoked" } });
  expect(await publishableStoryImage(db, "edition", story.id, location.id, "organizer", now)).toBeNull();
  deps.transport = vi.fn(async request => response(request, { batchcomplete: "" }));
  expect((await processStoryImage(deps, "edition", story.id, location)).image).toBeNull();
});
it("invalidates a saved no-photo outcome when a new catalog source is imported", async () => {
  const story = await seed();
  deps.transport = vi.fn(async request => response(request, { batchcomplete: "" }));
  expect((await processStoryImage(deps, "edition", story.id, location)).image).toBeNull();
  await importPhotoCatalog(db, manifest(), location.id, true, now);
  deps.transport = vi.fn(async request => response(request, { query: { pages: { 1: page() } } }));
  expect(await processStoryImage(deps, "edition", story.id, location)).toMatchObject({ status: "selected", provider: "catalog" });
});
it.each(["public_record", "safety_incident", "housing_market", "court_case"])("never queries the catalog for %s context", async kind => {
  await importPhotoCatalog(db, manifest(), location.id, true, now);
  const story = await seed({ kind });
  expect(await processStoryImage(deps, "edition", story.id, location)).toMatchObject({ status: "not_applicable", image: null });
  expect(deps.transport).not.toHaveBeenCalled(); expect(deps.validatePhoto).not.toHaveBeenCalled();
});
it("retains source-photo rights metadata and accepts catalog references only as a complete valid pair", () => {
  const candidate = { image: "https://photos.example/show.jpg", image_date: "2026-08-23", image_license: "CC BY 4.0",
    image_license_url: "https://creativecommons.org/licenses/by/4.0/", image_catalog_id: "a".repeat(64), image_catalog_revision: "b".repeat(64) };
  expect(normalizeStoryImage(candidate)).toMatchObject(candidate);
  expect(normalizeStoryImage({ ...candidate, image_catalog_revision: "invalid" })).not.toHaveProperty("image_catalog_id");
});

function subjectManifest(kind: "person" | "organization" = "person") {
  return { version: 1, location_id: location.id, sources: [{ id: "subject", name: "Reviewed subject photographs", kind: "commons_search",
    status: "active", reviewed_on: "2026-11-03", expires_on: "2026-12-03", evidence_url: "https://organization.example/media",
    scope: { kind, name: kind === "person" ? "Donna Moodie" : "Marjorie", city: "Seattle", aliases: [],
      source_domains: ["publisher.example"], identity_url: "https://organization.example/profile", source_urls: [] } }] };
}
it("matches subject-led stories only to verified identities and approved original source domains", () => {
  const scope = parsePhotoCatalog(subjectManifest(), location.id, now)[0].scope;
  const story = event({ kind: "news_report", title: "Donna Moodie shares her restaurant story", source_url: "https://publisher.example/news" });
  expect(photoScopeMatches(scope, story, "Seattle")).toBe(true);
  expect(photoScopeMatches(scope, story, "Moses Lake")).toBe(false);
  story.occurrences[0].source_url = "https://publisher.example.evil.example/news";
  expect(photoScopeMatches(scope, story, "Seattle")).toBe(false);
  story.occurrences[0].source_url = "https://publisher.example/news";
  for (const kind of ["court_case", "obituary", "safety_incident"]) { story.kind = kind; expect(photoScopeMatches(scope, story, "Seattle")).toBe(false); }
  const bad = subjectManifest(); bad.sources[0].scope.identity_url = "";
  expect(() => parsePhotoCatalog(bad, location.id, now)).toThrow();
});
it("discovers a recent licensed portrait by subject and preserves its attribution without treating a person as a venue", async () => {
  await importPhotoCatalog(db, subjectManifest(), location.id, true, now);
  const portrait = page(); portrait.title = "File:Donna Moodie portrait Seattle 2026.jpg";
  portrait.imageinfo![0].extmetadata!.ImageDescription.value = "Portrait of Donna Moodie, Seattle restaurateur";
  deps.transport = vi.fn(async request => response(request, { query: { pages: { 1: portrait } } }));
  const story = event({ kind: "news_report", title: "Donna Moodie shares her restaurant story", source_url: "https://publisher.example/news" });
  const candidates = await discoverCatalogPhotos(db, location.id, story, "Seattle", now, deps.transport);
  expect(candidates[0]).toMatchObject({ accepted: true, image: { image_subject: "Donna Moodie", image_credit: "Joe Mabel" } });
  expect(candidates[0].image).not.toHaveProperty("image_place"); expect(candidates[0].image).not.toHaveProperty("image_role");
  expect(deps.transport).toHaveBeenCalledTimes(1);
  const query = new URL(vi.mocked(deps.transport!).mock.calls[0][0].url).searchParams.get("gsrsearch");
  expect(query).toContain('"donna moodie"');
});
it("permits an exact-story photo grant without approving the publisher's entire image collection", async () => {
  const data = { version: 1, location_id: location.id, sources: [{ id: "route40", name: "Route 40 approved photographs", kind: "supplied", status: "active",
    reviewed_on: "2026-11-03", expires_on: "2026-12-03", evidence_url: "https://organization.example/grant",
    permission: { editorial: true, archive: true, crop: true }, scope: { kind: "story", name: "Route 40 completion", city: "Seattle", source_urls: ["https://publisher.example/route40"] },
    photos: [{ image: "https://photos.example/riders.jpg", image_source_url: "https://organization.example/media", image_credit: "Pat",
      image_caption: "Riders at the project gathering", image_alt: "Riders at a bus stop", image_date: "2026-10-29", image_license: "Used with permission" }] }] };
  await importPhotoCatalog(db, data, location.id, true, now);
  const story = event({ kind: "local_news", title: "Bus project completed", source_url: "https://publisher.example/route40" });
  expect((await discoverCatalogPhotos(db, location.id, story, "Seattle", now, deps.transport!, false))[0].accepted).toBe(true);
  story.occurrences[0].source_url = "https://publisher.example/another-story";
  expect(await discoverCatalogPhotos(db, location.id, story, "Seattle", now, deps.transport!, false)).toEqual([]);
});
