import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import sharp from "sharp";
import { processEditedImage, IMAGE_AGENT_STATES, IMAGE_SHADOW_RESULTS, type PhotoEditorDeps } from "../../images/editor";
import { processStoryImage, publishableStoryImage, IMAGE_RESULTS } from "../../images/pipeline";
import { collapse } from "../../editions/stories";
import { preparePhoto, photoCrop, cropPreviews } from "../../images/quality";
import { REVIEW_SCHEMA, CRITIC_SCHEMA, PLAN_SCHEMA, parseVisualReviews, parseCritic, qualifiedReview, approvedCritic } from "../../images/review";
import { COLLECTIONS } from "../../storage/mongo";
import { resolveRunOptions, withRunContext } from "../../core/run-options";
import { readPhotoAsset, PHOTO_ASSETS, type PhotoAsset, type PhotoBlob } from "../../../../../shared/image-assets";
import { UsageRecordingRuntime, type ModelRuntime } from "../../model/runtime";
import type { CollectedEvent, LocationProfile } from "../../connectors/types";
import * as imageValidation from "../../../../../shared/image-validation";
import { newRun, runs } from "../../orchestration/runs";
import { resumeRun, runOne, type OrchestratorDeps } from "../../orchestration/orchestrator";
import { ensureJobIndexes, runJobs, enqueue } from "../../orchestration/jobs";
import { loadSettings } from "../../core/config";
import type { ArtifactStore } from "../../storage/artifacts";
import { READER_STORIES_COLLECTION } from "../../../../../shared/reader-stories";
import { importPhotoCatalog } from "../../images/catalog";
import { PHOTO_CATALOG_SOURCES } from "../../../../../shared/photo-catalog";

const today = new Date("2026-11-02T12:00:00Z");
const location: LocationProfile = { id: "photo-town", name: "Seattle, WA", state: "WA", systems: [] };
let server: MongoMemoryServer, client: MongoClient, db: Db, high: Buffer, small: Buffer;
let model: ModelRuntime, deps: PhotoEditorDeps;
const generation = (value: any) => ({ response: JSON.stringify(value?.reviews ? { next_query: "", ...value } : value), done: true });
const relationship = { subject_matches: true, place_matches: true, time_matches: true, evidence_consistent: true,
  explanation: "A recent view of the named gathering place, explicitly used as venue context." };
const review = (id: string) => ({ id, relevance: 5, usefulness: 5, quality: 5, misleading: false, observations: "A clear garden path and benches are visible.", adds: "Shows the layout of the actual gathering place.", reason: "Clear relevant venue view", focus_x: 0.5, focus_y: 0.5, relationship });
const critic = { approved: true, preserves_context: true, matches_story: true, quality: 5, alt: "A garden path lined by trees and benches.", reason: "Both crops retain the relevant setting.", relationship };
function page() { return { title: "File:Town Garden Seattle 2026.jpg", imageinfo: [{ mime: "image/jpeg", thumburl: "https://upload.wikimedia.org/commons/garden.jpg", url: "https://upload.wikimedia.org/commons/garden-original.jpg", width: 2400, height: 1600, thumbwidth: 2400, thumbheight: 1600,
  descriptionurl: "https://commons.wikimedia.org/wiki/File:Town_Garden_Seattle_2026.jpg", extmetadata: { ImageDescription: { value: "Town Garden in Seattle" }, DateTimeOriginal: { value: "2026-10-01" }, Artist: { value: "Pat Photographer" }, LicenseShortName: { value: "CC BY-SA 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" } } }] }; }
beforeAll(async () => {
  server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("photo-editor-tests");
  high = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#486e50" } }).jpeg().toBuffer();
  small = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#486e50" } }).jpeg().toBuffer();
});
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  await db.dropDatabase();
  model = { provider: "fixture", model: "fixture-vision", supportsVision: true, health: async () => ({ status: "ok", detail: "fixture" }),
    generate: vi.fn(async () => ""), generateStructured: vi.fn(async () => generation({ useful: true, goal: "Show the actual garden setting", queries: ['"Town Garden"', '"Town Garden" Seattle exterior'], reason: "The setting helps the reader plan a visit." })),
    generateVisionStructured: vi.fn(async (_prompt, images, schema) => schema === CRITIC_SCHEMA ? generation(critic) : generation({ reviews: images.map(image => review(image.id)) })) };
  deps = { db, model, now: () => today, sourcePhoto: vi.fn(async () => null), loadPhoto: vi.fn(async () => high), validatePhoto: vi.fn(async () => undefined),
    transport: vi.fn(async request => ({ url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ query: { pages: { "1": page() } } })) })) };
});
async function seed(kind = "event", name = "Garden gathering", venue = "Town Garden") {
  const events = [{ source_id: "web:garden", facts: { source_event_id: "event", title: name, kind, venue, event_date: "2026-11-04", source_url: "https://organizer.example/event", description: "Neighbors gather at Town Garden in Seattle." } as CollectedEvent }];
  const story = collapse(events)[0];
  await db.collection(COLLECTIONS.editions).insertOne({ id: "edition", run_id: "run", location_id: location.id, status: "ready", events });
  await db.collection(COLLECTIONS.editionEntries).insertOne({ edition_id: "edition", story_id: story.id, source_id: "web:garden", disposition: "checks_passed", position: 0,
    result: { story: { id: story.id, title: name, kind }, draft: { headline: name, summary: "Validated story text." }, details: {}, ranking: { score: 10 } } });
  return story.id;
}
async function edit(id: string, phase: "primary" | "stock" = "primary", mode: "agentic" | "shadow" = "agentic", budget = 40) {
  return withRunContext({ db, runId: "run", locationId: location.id, options: resolveRunOptions({ image_mode: mode, image_call_budget: budget, paid: {} }) },
    () => processEditedImage(deps, "edition", id, location, phase, mode));
}

it("rejects a conflicting branch before downloading even when the organizer's catalog matches", async () => {
  await importPhotoCatalog(db, { version: 1, location_id: location.id, sources: [{ id: "school", name: "Arts School photographs",
    status: "active", reviewed_on: "2026-11-01", expires_on: "2026-12-01", kind: "commons_files", files: ["File:Town Garden Seattle 2026.jpg"],
    evidence_url: "https://organizer.example/venue", scope: { kind: "venue", name: "Arts School", aliases: ["Town Garden"], city: "Seattle" } }] }, location.id, true, today);
  const id = await seed("event", "Mime class", "Arts School");
  await db.collection(COLLECTIONS.editions).updateOne({ id: "edition" }, { $set: {
    "events.0.facts.description": "The class meets at Arts School’s Georgetown Studios.",
  } });
  const result = await edit(id);
  expect(result.image).toBeNull();
  expect(deps.loadPhoto).not.toHaveBeenCalled(); expect(model.generateVisionStructured).not.toHaveBeenCalled();
  expect(await db.collection(IMAGE_AGENT_STATES).findOne({})).toMatchObject({ rejected: expect.arrayContaining([
    expect.objectContaining({ reason: "photo_venue_conflict" }),
  ]) });
});

it("requires consistent subject, place and timing evidence despite perfect visual scores", () => {
  for (const key of ["subject_matches", "place_matches", "time_matches", "evidence_consistent"] as const) {
    const failed = { ...relationship, [key]: false };
    const visual = parseVisualReviews(generation({ reviews: [{ ...review("photo"), relationship: failed }] }), ["photo"])[0];
    expect(qualifiedReview(visual)).toBe(false);
    expect(approvedCritic(parseCritic(generation({ ...critic, relationship: failed })))).toBe(false);
  }
  expect(() => parseCritic(generation({ ...critic, relationship: undefined }))).toThrow();
  expect(() => parseVisualReviews(generation({ reviews: [{ ...review("photo"), relationship: { ...relationship, place_matches: "yes" } }] }), ["photo"])).toThrow();
});

it("invalidates older approvals and changed photo tags without making new model calls", async () => {
  const id = await seed(); await edit(id);
  const query = { edition_id: "edition", story_id: id };
  await db.collection(IMAGE_RESULTS).updateOne(query, { $set: { "agent.review_policy": "photo_editor_v3" } });
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:garden", today)).toBeNull();
  await db.collection(IMAGE_RESULTS).updateOne(query, { $set: { "agent.review_policy": "photo_editor_v4", "image.image_caption": "Photograph from the actual event." } });
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:garden", today)).toBeNull();
  expect(model.generateVisionStructured).toHaveBeenCalledTimes(2);
});

it("skips used URLs and identical downloaded originals before spending vision calls on a distinct candidate", async () => {
  const first = await seed(); await edit(first);
  const event = { source_id: "web:garden", facts: { source_event_id: "second", title: "Another garden gathering", kind: "event", venue: "Town Garden",
    event_date: "2026-11-05", source_url: "https://organizer.example/second", description: "An event in Town Garden, Seattle." } as CollectedEvent };
  const second = collapse([event])[0];
  await db.collection(COLLECTIONS.editions).updateOne({ id: "edition" }, { $push: { events: event } } as never);
  await db.collection(COLLECTIONS.editionEntries).insertOne({ edition_id: "edition", story_id: second.id, source_id: "web:garden", disposition: "checks_passed", position: 1,
    result: { story: { id: second.id, title: second.title, kind: "event" }, draft: { headline: second.title, summary: second.description }, details: {}, ranking: { score: 9 } } });
  const alias = page(), alternative = page();
  alias.title = "File:Town Garden Seattle copy.jpg"; alias.imageinfo[0].thumburl = "https://upload.wikimedia.org/commons/copy.jpg";
  alias.imageinfo[0].descriptionurl = "https://commons.wikimedia.org/wiki/File:Town_Garden_Seattle_copy.jpg";
  alternative.title = "File:Town Garden Seattle another view.jpg"; alternative.imageinfo[0].thumburl = "https://upload.wikimedia.org/commons/other.jpg";
  alternative.imageinfo[0].descriptionurl = "https://commons.wikimedia.org/wiki/File:Town_Garden_Seattle_another_view.jpg";
  const distinct = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#405f80" } }).jpeg().toBuffer();
  deps.transport = vi.fn(async request => ({ url: request.url, status: 200, headers: {},
    body: new TextEncoder().encode(JSON.stringify({ query: { pages: { 1: page(), 2: alias, 3: alternative } } })) }));
  deps.loadPhoto = vi.fn(async source => source.endsWith("other.jpg") ? distinct : high);
  expect(await edit(second.id)).toMatchObject({ status: "selected", image: { image: alternative.imageinfo[0].thumburl } });
  expect(vi.mocked(deps.loadPhoto!).mock.calls.map(call => call[0])).toEqual([alias.imageinfo[0].thumburl, alternative.imageinfo[0].thumburl]);
  expect(model.generateVisionStructured).toHaveBeenCalledTimes(4);
  await edit(second.id);
  expect(model.generateVisionStructured).toHaveBeenCalledTimes(4);
});

it("visually reviews catalog photos and withdraws archived selections when the catalog is revoked", async () => {
  await importPhotoCatalog(db, { version: 1, location_id: location.id, sources: [{ id: "garden", name: "Town Garden photos",
    status: "active", reviewed_on: "2026-11-01", expires_on: "2026-12-01", kind: "commons_category", category: "Category:Town Garden",
    evidence_url: "https://commons.wikimedia.org/wiki/Category:Town_Garden", scope: { kind: "venue", name: "Town Garden", city: "Seattle" } }] }, location.id, true, today);
  const id = await seed(); const result = await edit(id);
  expect(result).toMatchObject({ status: "selected", provider: "catalog", agent: { calls: 3 }, image: { image_role: "venue" } });
  expect(result.image?.image_catalog_id).toBe(result.catalog?.id);
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:garden", today)).not.toBeNull();
  await db.collection(PHOTO_CATALOG_SOURCES).updateMany({ location_id: location.id }, { $set: { status: "revoked" } });
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:garden", today)).toBeNull();
  expect(model.generateVisionStructured).toHaveBeenCalledTimes(2);
});

it("tries later approved publisher candidates after failed downloads", async () => {
  const id = await seed();
  await db.collection("source_map").insertOne({ location_id: location.id, source_id: "web:garden",
    access_review: { collection_allowed: true, images_allowed: true, checked_on: "2026-11-01", expires_on: "2026-12-01" } });
  deps.sourcePhotos = vi.fn(async () => Array.from({ length: 4 }, (_, i) => ({ image: `https://publisher.example/photo-${i}.jpg`, image_credit: "Pat",
    image_source_url: "https://publisher.example/event" })));
  deps.loadPhoto = vi.fn(async source => { if (!source.endsWith("photo-3.jpg")) throw Error("Unavailable"); return high; });
  expect(await edit(id)).toMatchObject({ status: "selected", provider: "publisher", image: { image: "https://publisher.example/photo-3.jpg" } });
  expect(deps.loadPhoto).toHaveBeenCalledTimes(4);
  expect(deps.sourcePhoto).not.toHaveBeenCalled();
});

it("inspects real pixels, critiques both crops, archives originals and serves variants without the origin", async () => {
  const id = await seed(); const result = await edit(id);
  expect(result).toMatchObject({ status: "selected", reason: "visually_reviewed_editorial_photo", agent: { calls: 3 }, image: { image_credit: "Pat Photographer", image_alt: critic.alt, image_width: 2400 } });
  const call = vi.mocked(model.generateVisionStructured!).mock.calls[0];
  expect(call[3]).toMatchObject({ timeoutMs: 25000 });
  expect(call[1][0].data).toBeTruthy(); expect(call[1][0].mimeType).toBe("image/jpeg");
  expect(await sharp(Buffer.from(call[1][0].data, "base64")).metadata()).toMatchObject({ width: 1280 });
  expect(vi.mocked(model.generateVisionStructured!).mock.calls[1][1].map(image => image.id)).toEqual(["desktop", "mobile", "detail"]);
  const detail = vi.mocked(model.generateVisionStructured!).mock.calls[1][1][2];
  expect(await sharp(Buffer.from(detail.data, "base64")).metadata()).toMatchObject({ width: 512, height: 512 });
  const asset = await readPhotoAsset({ asset: id => db.collection<PhotoAsset>(PHOTO_ASSETS).findOne({ _id: id }), blob: id => db.collection<PhotoBlob>(PHOTO_ASSETS + "_blobs").findOne({ _id: id }) }, result.image!.image_asset_id!, 960, "mobile");
  expect(await sharp(asset.bytes).metadata()).toMatchObject({ width: 960, height: 720, format: "webp" });
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:garden", today)).toMatchObject({ image_asset_id: result.image!.image_asset_id });
  expect(await db.collection(PHOTO_ASSETS + "_originals").countDocuments()).toBe(1);
  const again = await edit(id); expect(again.image?.image_asset_id).toBe(result.image!.image_asset_id);
  expect(model.generateVisionStructured).toHaveBeenCalledTimes(2);
});

it("reserves local CPU calls for pixel review and crop criticism while preserving delivered resolution", async () => {
  const id = await seed();
  model = { ...model, provider: "ollama" }; deps.model = model;
  model.generateVisionStructured = vi.fn(async (_prompt, images, schema) => "approved" in (schema.properties as object)
    ? generation(critic) : generation({ reviews: images.map(image => review(image.id)) }));
  expect(await edit(id)).toMatchObject({ status: "selected", agent: { calls: 2 }, image: { image_width: 2400 } });
  expect(model.generateStructured).not.toHaveBeenCalled();
  const call = vi.mocked(model.generateVisionStructured!).mock.calls[0];
  expect(call[3]).toMatchObject({ timeoutMs: 240000, keepAlive: "5m" });
  const bounded = call[2] as any;
  expect(bounded.properties.reviews).toMatchObject({ minItems: 1, maxItems: 1 });
  expect(bounded.properties.reviews.items.properties.id.enum).toEqual([call[1][0].id]);
  expect(bounded.properties.reviews.items.properties.quality.enum).toEqual([0, 1, 2, 3, 4, 5]);
  expect(await sharp(Buffer.from(call[1][0].data, "base64")).metadata()).toMatchObject({ width: 640 });
  const sheet = vi.mocked(model.generateVisionStructured!).mock.calls[1][1][0];
  expect(sheet.id).toBe("desktop_mobile_detail");
  const bytes = Buffer.from(sheet.data, "base64");
  expect(await sharp(bytes).metadata()).toMatchObject({ width: 640, height: 832, format: "png" });
  const original = await cropPreviews(await preparePhoto(high), 0.5, 0.5, true);
  const native = await sharp(Buffer.from(original.images[2].data, "base64")).removeAlpha().raw().toBuffer();
  expect(await sharp(bytes).extract({ left: 64, top: 304, width: 512, height: 512 }).removeAlpha().raw().toBuffer()).toEqual(native);
});

it.each(["public_record", "safety_incident", "court_case", "home_sale"])("does no searches or model work for %s context", async kind => {
  const id = await seed(kind); const result = await edit(id);
  expect(result).toMatchObject({ status: "not_applicable", image: null });
  expect(model.generateStructured).not.toHaveBeenCalled(); expect(deps.transport).not.toHaveBeenCalled();
});

it("rejects low-resolution files before vision, even if provider dimensions claim high resolution", async () => {
  const id = await seed(); deps.loadPhoto = vi.fn(async () => small);
  expect((await edit(id)).image).toBeNull(); expect(model.generateVisionStructured).not.toHaveBeenCalled();
  expect(await db.collection(IMAGE_AGENT_STATES).findOne({})).toMatchObject({ rejected: expect.arrayContaining([expect.objectContaining({ reason: "Photo is below editorial resolution" })]) });
});

it("rejects wrong cities before downloading and rejects files that cannot be decoded", async () => {
  const id = await seed(); const wrong = page(); wrong.imageinfo[0].extmetadata.ImageDescription.value = "Town Garden in Portland"; wrong.title = "File:Town Garden Portland.jpg";
  deps.transport = vi.fn(async request => ({ url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ query: { pages: { "1": wrong } } })) }));
  expect((await edit(id)).image).toBeNull(); expect(deps.loadPhoto).not.toHaveBeenCalled(); expect(model.generateVisionStructured).not.toHaveBeenCalled();
  await expect(preparePhoto(new Uint8Array([255, 216, 255, 0]))).rejects.toThrow();
});

it.each(["date", "license"])("rejects unknown or unapproved %s evidence before visual review", async field => {
  const id = await seed(); const invalid = page();
  if (field === "date") invalid.imageinfo[0].extmetadata.DateTimeOriginal.value = "unknown";
  else invalid.imageinfo[0].extmetadata.LicenseShortName.value = "CC BY-NC 4.0";
  deps.transport = vi.fn(async request => ({ url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ query: { pages: { "1": invalid } } })) }));
  expect((await edit(id)).image).toBeNull(); expect(deps.loadPhoto).not.toHaveBeenCalled(); expect(model.generateVisionStructured).not.toHaveBeenCalled();
});

it("refines a rejected search, compares new pixels and selects a better candidate within four model calls", async () => {
  const id = await seed();
  const improved = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#617fa2" } }).jpeg().toBuffer();
  deps.transport = vi.fn(async request => {
    const image = page();
    if (new URL(request.url).searchParams.get("gsrsearch")?.includes("entrance")) {
      image.title = "File:Town Garden Seattle exterior.jpg"; image.imageinfo[0].thumburl = "https://upload.wikimedia.org/commons/garden2.jpg";
    }
    return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ query: { pages: { "1": image } } })) };
  });
  deps.loadPhoto = vi.fn(async url => url.includes("garden2") ? improved : high);
  let comparisons = 0;
  model.generateVisionStructured = vi.fn(async (_prompt, images, schema) => {
    if (schema === CRITIC_SCHEMA) return generation(critic);
    comparisons++;
    return generation({ next_query: '"Town Garden" entrance', reviews: images.map(image => comparisons === 1 ? { ...review(image.id), relevance: 1, reason: "The visible scene adds little context." } : review(image.id)) });
  });
  const result = await edit(id);
  expect(result).toMatchObject({ status: "selected", agent: { calls: 4 }, image: { image: "https://upload.wikimedia.org/commons/garden2.jpg" } });
  const state = await db.collection(IMAGE_AGENT_STATES).findOne({}); expect(state?.queries).toHaveLength(2);
  expect(state?.rejected).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "The visible scene adds little context." })]));
});

it("uses stock only in the separate stage after primary searches produce no qualified photo", async () => {
  const id = await seed("event", "Board games for neighbors");
  deps.transport = vi.fn(async request => {
    const stockSearch = new URL(request.url).searchParams.get("gsrsearch")?.includes('"board games"');
    const stock = page(); stock.title = "File:Board games 2026.jpg"; stock.imageinfo[0].extmetadata.ImageDescription.value = "Board games on a table";
    return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ query: { pages: stockSearch ? { "1": stock } : {} } })) };
  });
  expect((await edit(id)).image).toBeNull(); expect(model.generateVisionStructured).not.toHaveBeenCalled();
  const stock = await edit(id, "stock");
  expect(stock).toMatchObject({ status: "selected", provider: "commons_stock", stock_checked: true, image: { image_role: "stock" }, agent: { calls: 4 } });
});

it("rechecks publisher approval after visual review and before publication", async () => {
  const id = await seed();
  await db.collection("source_map").insertOne({ location_id: location.id, source_id: "web:garden", access_review: { images_allowed: true, collection_allowed: true, checked_on: "2026-10-01", expires_on: "2026-12-01" } });
  deps.sourcePhoto = vi.fn(async () => ({ image: "https://organizer.example/photo.jpg", image_source_url: "https://organizer.example/event", image_credit: "Source Photographer" }));
  const selected = await edit(id); expect(selected.provider).toBe("publisher");
  await db.collection("source_map").updateOne({ source_id: "web:garden" }, { $set: { "access_review.images_allowed": false } });
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:garden", today)).toBeNull();
});

it("does not choose a high-resolution image that fails relevance or editorial usefulness", async () => {
  const id = await seed(); model.generateVisionStructured = vi.fn(async (_prompt, images) => generation({ reviews: images.map(image => ({ ...review(image.id), usefulness: 1, reason: "Decorative image adds no useful information." })) }));
  expect((await edit(id)).image).toBeNull(); expect(await db.collection(PHOTO_ASSETS).countDocuments()).toBe(0);
});

it("rejects a crop when the independent critic finds lost or misleading context", async () => {
  const id = await seed(); model.generateVisionStructured = vi.fn(async (_prompt, images, schema) => schema === CRITIC_SCHEMA ? generation({ ...critic, preserves_context: false }) : generation({ reviews: images.map(image => review(image.id)) }));
  expect((await edit(id)).image).toBeNull(); expect(await db.collection(PHOTO_ASSETS).countDocuments()).toBe(0);
});

it("respects an edition call budget of zero and fails to text without a vision-capable model", async () => {
  const id = await seed(); expect((await edit(id, "primary", "agentic", 0)).reason).toBe("photo_run_call_budget_exhausted");
  expect(model.generateStructured).not.toHaveBeenCalled(); expect(deps.transport).not.toHaveBeenCalled();
  await db.collection(IMAGE_AGENT_STATES).deleteMany({}); deps.model = { ...model, supportsVision: false };
  expect((await edit(id)).reason).toBe("visual_review_unavailable"); expect(model.generateVisionStructured).not.toHaveBeenCalled();
});

it("retries a transient model failure without caching it as an editorial rejection or resetting call reservations", async () => {
  const id = await seed();
  vi.mocked(model.generateStructured).mockRejectedValueOnce(new Error("Local model timed out"));
  expect((await edit(id)).reason).toBe("visual_review_unavailable");
  const resumed = await edit(id);
  expect(resumed).toMatchObject({ status: "selected", agent: { calls: 4 } });
  expect(model.generateStructured).toHaveBeenCalledTimes(2);
  expect(await db.collection("image_agent_budgets").findOne({ _id: "run" as never })).toMatchObject({ used: 4 });
});

it.each([0, 1])("respects the hosted Agent model allowance of %s without making unpermitted provider calls", async allowance => {
  const id = await seed(); const inner = { ...model, provider: "gemini" };
  deps.model = new UsageRecordingRuntime(inner, { role: "agent", sink: vi.fn() });
  const options = resolveRunOptions({ image_mode: "agentic", paid: allowance ? { agent_model: allowance } : {} });
  const result = await withRunContext({ db, runId: "run", locationId: location.id, options }, () => processEditedImage(deps, "edition", id, location, "primary", "agentic"));
  expect(result.image).toBeNull(); expect(inner.generateStructured).toHaveBeenCalledTimes(allowance);
  expect(inner.generateVisionStructured).not.toHaveBeenCalled();
  expect(await db.collection("api_calls").countDocuments({ service: "agent_model", outcome: "ok" })).toBe(allowance);
  expect(await db.collection("api_calls").countDocuments({ service: "agent_model", outcome: "skipped" })).toBeGreaterThan(0);
});

it("reviews only approved reader photo bytes and withdraws the resulting asset on rejection", async () => {
  const id = await seed("reader_story", "Neighbors share a garden story");
  await db.collection(READER_STORIES_COLLECTION).insertOne({ _id: "event", location_id: location.id, status: "approved",
    image: { data: high.toString("base64"), mime_type: "image/jpeg", credit: "A neighbor", caption: "Garden volunteers", permission_confirmed_at: "2026-11-02" } } as never);
  const result = await edit(id);
  expect(result).toMatchObject({ status: "selected", provider: "reader", reader_story_id: "event" });
  expect(deps.loadPhoto).not.toHaveBeenCalled(); expect(deps.transport).not.toHaveBeenCalled();
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:garden", today)).toMatchObject({ image_asset_id: result.image!.image_asset_id });
  await db.collection(READER_STORIES_COLLECTION).updateOne({ _id: "event" as never }, { $set: { status: "rejected" } });
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:garden", today)).toBeNull();
});

it("blocks publication when the reviewed story changes, without rewriting the story", async () => {
  const id = await seed(); expect((await edit(id)).status).toBe("selected");
  await db.collection(COLLECTIONS.editionEntries).updateOne({ story_id: id }, { $set: { "result.draft.summary": "A revised and different story." } });
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:garden", today)).toBeNull();
  expect((await db.collection(COLLECTIONS.editionEntries).findOne({ story_id: id }))?.result.draft.summary).toBe("A revised and different story.");
});

it("keeps shadow selection separate from the rule-selected published photo", async () => {
  const id = await seed(); const rule = await processStoryImage(deps, "edition", id, location);
  const result = await edit(id, "primary", "shadow"); expect(result.status).toBe("selected");
  expect((await db.collection(IMAGE_RESULTS).findOne({ story_id: id }))?.image).toEqual(rule.image);
  expect(await db.collection(IMAGE_SHADOW_RESULTS).findOne({ story_id: id })).toMatchObject({ status: "selected", agent: { mode: "shadow" } });
});

it("checks post-crop resolution and strictly validates model candidate IDs and score ranges", async () => {
  const photo = await preparePhoto(high); expect(photoCrop(photo, 0.9, 0.1, 3 / 2)).toMatchObject({ width: 2400, height: 1600, left: 0, top: 0 });
  expect(() => photoCrop(photo, 2, 0.5, 3 / 2)).toThrow();
  expect(() => parseVisualReviews(generation({ reviews: [review("wrong-id")] }), ["expected"])).toThrow();
  expect(() => parseVisualReviews(generation({ reviews: [{ ...review("expected"), quality: 6 }] }), ["expected"])).toThrow();
  expect(() => parseCritic(generation({ ...critic, approved: "yes" }))).toThrow();
});

it.each([ ["current", "autopilot"], ["agentic", "autopilot"], ["current", "manual"] ] as const)("runs visually reviewed images through %s/%s without skipping its publication behavior", async (flow, mode) => {
  const id = await seed();
  const run = newRun(location, { by: "editor", kind: "manual" }, "2026-11-02", ["2026-11-01", "2026-11-08"], []);
  run._id = "run"; run.status = "authoring"; run.draft_id = "edition"; run.options = resolveRunOptions({ mode, flow, image_mode: "agentic", paid: {} });
  await runs(db).insertOne(run); await ensureJobIndexes(db);
  for (const kind of ["author_start", "author_story"] as const) {
    const jobId = await enqueue(db, { kind, run_id: "run", location_id: location.id });
    await db.collection(COLLECTIONS.jobs).updateOne({ _id: jobId as never }, { $set: { status: "completed", result: { more: false } } });
  }
  await db.collection(COLLECTIONS.locations).insertOne({ ...location, _id: location.id } as never);
  const store: ArtifactStore = { kind: "local", ensureFolder: async (parent, name) => `${parent}/${name}`, saveJson: async () => "fixture", saveText: async () => "fixture",
    readJson: async () => { throw Error("No fixture artifact"); }, readText: async () => "", list: async () => [], findFolder: async () => null, removeFile: async () => 0 };
  const orchestration: OrchestratorDeps = { db, settings: loadSettings({ NEWSBEE_MODE: "local" }), model, agentModel: model, store, transport: deps.transport };
  const download = vi.spyOn(imageValidation, "downloadStoryImage").mockResolvedValue({ bytes: high, contentType: "image/jpeg", etag: '"fixture"' });
  try {
    await resumeRun(orchestration, "run", "editor"); expect(await runOne(orchestration)).toBe(true);
    expect(await db.collection(IMAGE_RESULTS).findOne({ story_id: id })).toMatchObject({ status: "selected", agent: { mode: "agentic" } });
    expect((await runs(db).findOne({ _id: "run" }))?.status).toBe(mode === "manual" ? "awaiting_finish" : "finishing");
    expect((await runJobs(db, "run")).filter(job => job.kind === "author_finish")).toHaveLength(mode === "manual" ? 0 : 1);
    expect(model.generate).not.toHaveBeenCalled();
  } finally { download.mockRestore(); }
});
