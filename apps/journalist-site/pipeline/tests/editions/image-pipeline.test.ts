import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureDate, reviewCommonsPhoto, type CommonsPage } from "../../images/commons";
import { IMAGE_POLICY, IMAGE_RESULTS, processStoryImage, processStockImage, publishableStoryImage, type ImagePipelineDeps } from "../../images/pipeline";
import { stockTopic, reviewStockPhoto } from "../../images/stock";
import { normalizeStoryImage } from "../../../../../shared/story-image";
import { collapse } from "../../editions/stories";
import { COLLECTIONS } from "../../storage/mongo";
import type { CollectedEvent, LocationProfile } from "../../connectors/types";
import { ensureJobIndexes, enqueue, runJobs } from "../../orchestration/jobs";
import { newRun, runs } from "../../orchestration/runs";
import { resumeRun, rerunImageStage, runOne, type OrchestratorDeps } from "../../orchestration/orchestrator";
import { LocalArtifacts } from "../../storage/artifacts";
import { loadSettings } from "../../core/config";
import { FakeModel } from "../support/fake-model";
import { rasterDimensions } from "../../../../../shared/image-validation";
import { retryFailedStep } from "../../orchestration/retry-step";
import { READER_STORIES_COLLECTION } from "../../../../../shared/reader-stories";
import { reassemble } from "../../orchestration/inspect";
import { resolveRunOptions, withRunContext } from "../../core/run-options";
import { API_CALLS } from "../../trace/gateway";
import { RUN_DECISIONS } from "../../trace/decisions";

const today = new Date("2026-11-02T12:00:00Z");
const location: LocationProfile = { id: "fixture-wa", name: "Seattle, WA", state: "WA", systems: [] };
function page(): CommonsPage { return { title: "File:Town Garden Seattle 2026.jpg", imageinfo: [{
  mime: "image/jpeg", thumburl: "https://upload.wikimedia.org/commons/garden.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Town_Garden_Seattle_2026.jpg",
  thumbwidth: 1280, thumbheight: 853, extmetadata: { ImageDescription: { value: "Town Garden in Seattle" },
    DateTimeOriginal: { value: "2026-09-01 12:00:00" }, Artist: { value: "<a>Jane &amp; Alex</a>" },
    LicenseShortName: { value: "CC BY-SA 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" } },
}] }; }
let server: MongoMemoryServer, client: MongoClient, db: Db, root: string;
let deps: ImagePipelineDeps;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("image-pipeline-tests"); root = await mkdtemp(path.join(os.tmpdir(), "newsbee-images-")); });
afterAll(async () => {
  await client?.close(); await server?.stop();
  if (root && path.resolve(root).startsWith(path.join(os.tmpdir(), "newsbee-images-"))) await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.dropDatabase();
  deps = { db, now: () => today, sourcePhoto: vi.fn(async () => null), validatePhoto: vi.fn(async () => ({})),
    transport: vi.fn(async (request) => ({ url: request.url, status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify({ query: { pages: { "1": page() } } })) })) };
});
async function seed(kind = "event", name = "Garden gathering", draftId = "edition") {
  const facts = { source_event_id: name, title: name, kind, event_date: "2026-11-04", schedule_text: "November 4", venue: "Town Garden", source_url: "https://organizer.example/event", description: "Neighbors gather in Town Garden." } as CollectedEvent;
  const events = [{ source_id: "web:organizer", facts }], story = collapse(events)[0];
  await db.collection(COLLECTIONS.editions).updateOne({ id: draftId }, { $setOnInsert: { id: draftId, run_id: draftId, location_id: location.id, status: "ready", events: [] } }, { upsert: true });
  await db.collection(COLLECTIONS.editions).updateOne({ id: draftId }, { $push: { events: events[0] } } as never);
  await db.collection(COLLECTIONS.editionEntries).insertOne({ edition_id: draftId, story_id: story.id, source_id: "web:organizer", disposition: "checks_passed", result: { story: { id: story.id, title: name, kind }, draft: { headline: name, summary: "Validated copy." }, details: { image: "https://wrong.example/old.jpg", image_role: "venue", what: ["Original facts"] } } });
  return story.id;
}
async function approvePublisher() {
  await db.collection("source_map").insertOne({ location_id: location.id, source_id: "web:organizer", access_review: { collection_allowed: true, images_allowed: true, checked_on: "2026-10-01", expires_on: "2026-12-01" } });
}

it("tries multiple approved publisher images before searching for context", async () => {
  const id = await seed(); await approvePublisher();
  deps.sourcePhotos = vi.fn(async () => ["broken", "usable"].map(name => ({ image: `https://publisher.example/${name}.jpg`, image_credit: "Pat" })));
  deps.validatePhoto = vi.fn(async source => { if (source.includes("broken")) throw Error("Broken photo"); });
  expect(await processStoryImage(deps, "edition", id, location)).toMatchObject({ status: "selected", provider: "publisher", image: { image: "https://publisher.example/usable.jpg" } });
  expect(deps.validatePhoto).toHaveBeenCalledTimes(2); expect(deps.transport).not.toHaveBeenCalled();
  expect(deps.sourcePhoto).not.toHaveBeenCalled();
});

it("keeps publisher download failures retryable after all supplied candidates fail", async () => {
  const id = await seed("local_news"); await approvePublisher();
  deps.sourcePhotos = vi.fn(async () => ["first", "second"].map(name => ({ image: `https://publisher.example/${name}.jpg`, image_credit: "Pat" })));
  deps.validatePhoto = vi.fn(async () => { throw Error("Origin unavailable"); });
  await expect(processStoryImage(deps, "edition", id, location)).rejects.toThrow("retry is safe");
  expect(deps.validatePhoto).toHaveBeenCalledTimes(2);
});

it("skips a publisher's wrong venue before downloading and rechecks saved choices against rewritten copy", async () => {
  const id = await seed(); await approvePublisher();
  await db.collection(COLLECTIONS.editions).updateOne({ id: "edition" }, { $set: {
    "events.0.facts.venue": "Arts School", "events.0.facts.description": "The class meets at Georgetown Studios.",
  } });
  const image = { image_credit: "Pat", image_source_url: "https://publisher.example/event", image_role: "venue" as const,
    image_date: "2026-10-01", image_license: "CC0", image_license_url: "https://creativecommons.org/publicdomain/zero/1.0/", image_caption: "Venue context" };
  deps.sourcePhotos = vi.fn(async () => [{ ...image, image: "https://photos.example/wrong.jpg", image_place: "Town Garden" },
    { ...image, image: "https://photos.example/studio.jpg", image_place: "Georgetown Studios" }]);
  const result = await processStoryImage(deps, "edition", id, location);
  expect(result).toMatchObject({ status: "selected", provider: "publisher", image: { image_place: "Georgetown Studios" } });
  expect(deps.validatePhoto).toHaveBeenCalledTimes(1);
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:organizer", today)).not.toBeNull();
  await db.collection(IMAGE_RESULTS).updateOne({ story_id: id }, { $set: { "image.image_caption": "Actual event participants" } });
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:organizer", today)).toBeNull();
  expect(await processStoryImage(deps, "edition", id, location)).toMatchObject({ image: { image_caption: image.image_caption } });
  expect(deps.validatePhoto).toHaveBeenCalledTimes(2);
  await db.collection(COLLECTIONS.editionEntries).updateOne({ story_id: id }, { $set: {
    "result.draft.summary": "Location: Riverside Studios.",
  } });
  // All current narrative evidence must agree; an old cached selection is not approval for a rewritten location.
  await db.collection(COLLECTIONS.editions).updateOne({ id: "edition" }, { $set: {
    "events.0.facts.description": "Location: Riverside Studios.",
  } });
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:organizer", today)).toBeNull();
});

it.each(["public_record", "safety_incident", "housing_market", "development", "court_case"])("keeps %s text-only without network or model work", async (kind) => {
  const id = await seed(kind);
  const result = await processStoryImage(deps, "edition", id, location);
  expect(result).toMatchObject({ status: "not_applicable", reason: "record_story_no_context_photo", image: null });
  expect(deps.transport).not.toHaveBeenCalled(); expect(deps.sourcePhoto).not.toHaveBeenCalled(); expect(deps.validatePhoto).not.toHaveBeenCalled();
  const entry = await db.collection(COLLECTIONS.editionEntries).findOne({ story_id: id });
  expect(entry?.result.details).toEqual({ image: null, what: ["Original facts"] }); expect(entry?.result.draft.summary).toBe("Validated copy.");
});

it("discovers, validates, attaches and audits a recent licensed venue photo", async () => {
  const id = await seed(); const result = await processStoryImage(deps, "edition", id, location);
  expect(result).toMatchObject({ status: "selected", provider: "commons", image: { image_role: "venue", image_date: "2026-09-01", image_credit: "Jane & Alex", image_license: "CC BY-SA 4.0" } });
  expect(result.stages).toEqual(["classify", "source_rights", "discover", "validate", "attach"]);
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:organizer", today)).toEqual(result.image);
  const entry = await db.collection(COLLECTIONS.editionEntries).findOne({ story_id: id }); expect(entry?.result.details.image).toBe(result.image?.image);
  expect(deps.sourcePhoto).not.toHaveBeenCalled();
});

it("allows a permit street photo and rechecks its eligibility before publishing", async () => {
  const id = await seed("development", "Pergola permit");
  await db.collection(COLLECTIONS.editions).updateOne({ id: "edition" }, { $set: { "events.0.facts.venue": "800 block of NW 90TH ST" } });
  const photo = page(); photo.title = "File:NW 90th Street Seattle 2026.jpg";
  photo.imageinfo![0].extmetadata!.ImageDescription.value = "Streetscape on NW 90th Street, Seattle";
  deps.transport = vi.fn(async request => ({ url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ query: { pages: { "1": photo } } })) }));
  const result = await processStoryImage(deps, "edition", id, location);
  expect(result).toMatchObject({ status: "selected", reason: "recent_licensed_actual_street", image: { image_role: "area", image_place: "NW 90th Street" } });
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:organizer", today)).toMatchObject({ image_role: "area" });
  await db.collection(COLLECTIONS.editionEntries).updateOne({ story_id: id }, { $set: { "result.story.kind": "safety_incident" } });
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:organizer", today)).toBeNull();
});

it("allows an actual approved photo supplied by a record, while never searching for context", async () => {
  const id = await seed("safety_incident"); await approvePublisher();
  await db.collection(COLLECTIONS.editions).updateOne({ id: "edition" }, { $set: { "events.0.facts.details": {
    image: "https://publisher.example/actual-incident.jpg", image_source_url: "https://publisher.example/report", image_credit: "Department photographer" } } });
  const result = await processStoryImage(deps, "edition", id, location);
  expect(result).toMatchObject({ status: "selected", provider: "publisher", reason: "approved_record_source_photo" });
  expect(deps.transport).not.toHaveBeenCalled(); expect(deps.sourcePhoto).not.toHaveBeenCalled(); expect(deps.validatePhoto).toHaveBeenCalledTimes(1);
});

it("preserves upstream reader-photo approvals and rechecks withdrawal before publication", async () => {
  const id = await seed("reader_story", "Neighbours plant a garden");
  await db.collection(COLLECTIONS.editions).updateOne({ id: "edition" }, { $set: { "events.0.facts.source_event_id": "reader-submission" } });
  await db.collection(READER_STORIES_COLLECTION).insertOne({ _id: "reader-submission" as never, location_id: location.id, status: "approved",
    image: { data: Buffer.from([255, 216, 255, 192, 0, 8, 8, 3, 32, 5, 0, 3]).toString("base64"), mime_type: "image/jpeg", caption: "Garden volunteers", credit: "A neighbour", permission_confirmed_at: "2026-10-01" } });
  expect(await processStoryImage(deps, "edition", id, location)).toMatchObject({ status: "selected", provider: "reader", image: { image_credit: "A neighbour", image_caption: "Garden volunteers" } });
  expect(deps.transport).not.toHaveBeenCalled(); expect(deps.sourcePhoto).not.toHaveBeenCalled();
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:organizer", today)).not.toBeNull();
  await db.collection(READER_STORIES_COLLECTION).updateOne({ _id: "reader-submission" as never }, { $set: { status: "rejected" } });
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:organizer", today)).toBeNull();
});

it("repairs interrupted attachments from the saved audit without repeating network work", async () => {
  const id = await seed(); await processStoryImage(deps, "edition", id, location);
  await db.collection(COLLECTIONS.editionEntries).updateOne({ story_id: id }, { $set: { "result.details.image": null } });
  await processStoryImage(deps, "edition", id, location);
  expect(deps.transport).toHaveBeenCalledTimes(1); expect(deps.validatePhoto).toHaveBeenCalledTimes(1);
  expect((await db.collection(COLLECTIONS.editionEntries).findOne({ story_id: id }))?.result.details.image).toContain("garden.jpg");
});

it("caches empty venue searches across different stories, without inventing photos", async () => {
  deps.transport = vi.fn(async (request) => ({ url: request.url, status: 200, headers: {}, body: new TextEncoder().encode('{"query":{"pages":{}}}') }));
  const a = await seed(), b = await seed("event", "Second garden event");
  expect((await processStoryImage(deps, "edition", a, location)).status).toBe("no_image");
  expect((await processStoryImage(deps, "edition", b, location)).status).toBe("no_image");
  expect(deps.transport).toHaveBeenCalledTimes(1);
});

it("requires explicit publisher reuse approval and checks it again before publication", async () => {
  const id = await seed("local_news");
  expect((await processStoryImage(deps, "edition", id, location)).status).toBe("permission_required");
  expect(deps.sourcePhoto).not.toHaveBeenCalled();
  await approvePublisher();
  deps.sourcePhoto = vi.fn(async () => ({ image: "https://publisher.example/photo.jpg", image_source_url: "https://publisher.example/story", image_credit: "Reporter" }));
  expect((await processStoryImage(deps, "edition", id, location)).provider).toBe("publisher");
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:organizer", today)).not.toBeNull();
  await db.collection("source_map").updateOne({ source_id: "web:organizer" }, { $set: { "access_review.images_allowed": false } });
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:organizer", today)).toBeNull();
});

it("invalidates a cached selection when rewriting changes the venue/revision", async () => {
  const id = await seed(); await processStoryImage(deps, "edition", id, location);
  await db.collection(COLLECTIONS.editions).updateOne({ id: "edition" }, { $set: { "events.0.facts.venue": "Another Garden", image_revision: 1 } });
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:organizer", today)).toBeNull();
  expect((await processStoryImage(deps, "edition", id, location)).status).toBe("no_image");
});

it.each([
  ["old capture", (p: CommonsPage) => { p.imageinfo![0].extmetadata!.DateTimeOriginal.value = "2007-07-29"; }, "capture_date_not_recent"],
  ["upload date only", (p: CommonsPage) => { delete p.imageinfo![0].extmetadata!.DateTimeOriginal; }, "capture_date_unknown"],
  ["wrong city", (p: CommonsPage) => { p.title = "File:Town Garden Portland.jpg"; p.imageinfo![0].extmetadata!.ImageDescription.value = "Town Garden in Portland"; }, "venue_or_city_mismatch"],
  ["restricted license", (p: CommonsPage) => { p.imageinfo![0].extmetadata!.LicenseShortName.value = "CC BY-NC 4.0"; }, "license_not_approved"],
  ["fake license domain", (p: CommonsPage) => { p.imageinfo![0].extmetadata!.LicenseUrl.value = "https://creativecommons.org.evil.example/licenses/by-sa/4.0/"; }, "license_not_approved"],
  ["portrait", (p: CommonsPage) => { p.title = "File:Town Garden Seattle portrait.jpg"; }, "unsuitable_venue_subject"],
  ["SVG", (p: CommonsPage) => { p.imageinfo![0].mime = "image/svg+xml"; }, "not_a_supported_photograph"],
  ["unexpected multilingual metadata", (p: CommonsPage) => { p.imageinfo![0].extmetadata!.ImageDescription.value = { en: "Town Garden Seattle" }; p.title = "File:Garden.jpg"; }, "venue_or_city_mismatch"],
] as const)("rejects %s rather than filling a card with unsuitable media", (_name, change, reason) => {
  const candidate = page(); change(candidate); expect(reviewCommonsPhoto(candidate, "Town Garden", "Seattle", today)).toMatchObject({ accepted: false, reason });
});

it("uses capture dates, rejecting unknown/partial dates and invalid ISO calendar dates", () => {
  expect(captureDate("Taken on 30 November 2025")).toBe("2025-11-30");
  expect(captureDate("2026")).toBeNull(); expect(captureDate("2026-02-30")).toBeNull();
});

it("checks raster header dimensions, including tiny and truncated images", () => {
  const png = new Uint8Array(24); const view = new DataView(png.buffer); view.setUint32(16, 1); view.setUint32(20, 1);
  expect(rasterDimensions(png, "image/png")).toEqual({ width: 1, height: 1 });
  view.setUint32(16, 1280); view.setUint32(20, 853);
  expect(rasterDimensions(png, "image/png")).toEqual({ width: 1280, height: 853 });
  expect(rasterDimensions(png.slice(0, 18), "image/png")).toBeNull();
  const jpeg = new Uint8Array([255, 216, 255, 192, 0, 8, 8, 3, 32, 5, 0, 3]);
  expect(rasterDimensions(jpeg, "image/jpeg")).toEqual({ width: 1280, height: 800 });
});

async function queuedRun(kind: string, title = "Queued story") {
  const run = newRun(location, { by: "editor", kind: "manual" }, "2026-11-02", ["2026-11-01", "2026-11-08"], []);
  run.status = "authoring"; run.draft_id = run._id; await runs(db).insertOne(run);
  await db.collection(COLLECTIONS.locations).insertOne({ ...location, _id: location.id } as never); await ensureJobIndexes(db);
  const id = await seed(kind, title, run._id);
  for (const jobKind of ["author_start", "author_story"] as const) {
    const jobId = await enqueue(db, { kind: jobKind, run_id: run._id, location_id: location.id });
    await db.collection(COLLECTIONS.jobs).updateOne({ _id: jobId as never }, { $set: { status: "completed", result: { more: false } } });
  }
  const orchestration: OrchestratorDeps = { db, model: new FakeModel(() => { throw Error("Image stage must never call a model"); }),
    store: new LocalArtifacts(root), settings: loadSettings({ NEWSBEE_ROOT: root }), transport: deps.transport };
  return { run, id, orchestration };
}

it.each(["current", "agentic"] as const)("runs illustrated %s flow without photo searches, vision calls or stock jobs", async flow => {
  const { run, id, orchestration } = await queuedRun("event", "Mime workshop");
  await runs(db).updateOne({ _id: run._id }, { $set: { options: resolveRunOptions({ mode: "autopilot", flow, image_mode: "illustrated", paid: {} }) } });
  orchestration.transport = vi.fn(async () => { throw Error("Illustration selection must not make network calls"); });
  await resumeRun(orchestration, run._id, "editor");
  await runOne(orchestration);
  const jobs = await runJobs(db, run._id);
  expect(jobs.some(job => job.kind === "stock_story")).toBe(false);
  expect(jobs.filter(job => job.kind === "author_finish")).toHaveLength(1);
  expect((await runs(db).findOne({ _id: run._id }))?.status).toBe("finishing");
  const entry = await db.collection(COLLECTIONS.editionEntries).findOne({ edition_id: run._id, story_id: id });
  expect(entry?.result.image_pipeline).toMatchObject({ status: "illustration_planned", provider: "newsbee_ai" });
  expect(orchestration.transport).not.toHaveBeenCalled();
  expect((orchestration.model as FakeModel).calls).toEqual([]);
  expect(await db.collection(API_CALLS).countDocuments({ run_id: run._id })).toBe(0);
});

it("resumes image jobs exactly once and waits for all images before the existing finish gate", async () => {
  const { run, orchestration } = await queuedRun("public_record");
  await seed("safety_incident", "Second record", run._id);
  await resumeRun(orchestration, run._id, "editor"); await resumeRun(orchestration, run._id, "editor");
  expect((await runJobs(db, run._id)).filter(j => j.kind === "image_story")).toHaveLength(2);
  expect(await runOne(orchestration)).toBe(true); expect((await runs(db).findOne({ _id: run._id }))?.status).toBe("authoring");
  expect(await runOne(orchestration)).toBe(true); expect((await runs(db).findOne({ _id: run._id }))?.status).toBe("awaiting_finish");
  expect(await db.collection(IMAGE_RESULTS).countDocuments({ run_id: run._id, status: "not_applicable" })).toBe(2);
});

it.each(["current", "agentic"] as const)("keeps %s autopilot moving after primary and stock images finish", async flow => {
  const { run, orchestration } = await queuedRun("event", "Board games for neighbors");
  await runs(db).updateOne({ _id: run._id }, { $set: { options: resolveRunOptions({ mode: "autopilot", flow, image_mode: "current", paid: {} }) } });
  orchestration.transport = vi.fn(async request => ({ url: request.url, status: 200, headers: {}, body: new TextEncoder().encode('{"query":{"pages":{}}}') }));
  await resumeRun(orchestration, run._id, "editor");
  await runOne(orchestration);
  expect((await runs(db).findOne({ _id: run._id }))?.status).toBe("authoring");
  expect((await runJobs(db, run._id)).some(job => job.kind === "stock_story")).toBe(true);
  expect((await runJobs(db, run._id)).some(job => job.kind === "author_finish")).toBe(false);
  await runOne(orchestration);
  const finished = await runs(db).findOne({ _id: run._id });
  expect(finished?.status).toBe("finishing");
  expect(finished?.stage_transitions).toEqual(expect.arrayContaining([expect.objectContaining({ status: "finishing", by: "autopilot" })]));
  expect((await runJobs(db, run._id)).filter(job => job.kind === "author_finish")).toHaveLength(1);
});

it("honors the Commons service switch for venue and stock and logs the run's image decisions", async () => {
  const id = await seed("event", "Board games for neighbors");
  const options = resolveRunOptions({ external_off: ["wikimedia"], paid: {} });
  const result = await withRunContext({ db, runId: "run-controls", locationId: location.id, options }, async () => {
    const primary = await processStoryImage(deps, "edition", id, location);
    expect(primary.reason).toBe("wikimedia_disabled_for_run");
    return processStockImage(deps, "edition", id, location);
  });
  expect(result).toMatchObject({ image: null, reason: "wikimedia_disabled_for_run", stock_checked: true });
  expect(deps.transport).not.toHaveBeenCalled(); expect(deps.validatePhoto).not.toHaveBeenCalled();
  expect(await db.collection(API_CALLS).countDocuments({ run_id: "run-controls", service: "wikimedia", paid: false, outcome: "skipped" })).toBe(2);
  expect(await db.collection(RUN_DECISIONS).findOne({ run_id: "run-controls", subject: `image:edition:${id}` })).toMatchObject({ decision: "no_image", reason: "wikimedia_disabled_for_run" });
});

it("logs Commons API and validated-photo work without paid-service calls", async () => {
  const id = await seed(); const options = resolveRunOptions({ paid: {} });
  await withRunContext({ db, runId: "run-controls", locationId: location.id, options }, () => processStoryImage(deps, "edition", id, location));
  expect(await db.collection(API_CALLS).countDocuments({ run_id: "run-controls", service: "wikimedia", paid: false, outcome: "ok" })).toBe(2);
  expect(await db.collection(API_CALLS).countDocuments({ paid: true })).toBe(0);
  expect(await db.collection(RUN_DECISIONS).findOne({ run_id: "run-controls" })).toMatchObject({ decision: "selected", evidence: { provider: "commons", story_id: id } });
});

it("retries a failed provider three times, then preserves text and exposes the image failure", async () => {
  const { run, orchestration } = await queuedRun("event"); orchestration.transport = vi.fn(async () => { throw Error("Provider unavailable"); });
  await resumeRun(orchestration, run._id, "editor");
  for (let attempt = 0; attempt < 3; attempt++) {
    await db.collection(COLLECTIONS.jobs).updateMany({ kind: "image_story" }, { $set: { available_at: 0 } });
    expect(await runOne(orchestration)).toBe(true);
  }
  expect((await runs(db).findOne({ _id: run._id }))?.status).toBe("awaiting_finish");
  expect(await db.collection(IMAGE_RESULTS).findOne({ run_id: run._id })).toMatchObject({ status: "failed", reason: "image_retries_exhausted" });
  expect(await db.collection(COLLECTIONS.editionEntries).findOne({ edition_id: run._id })).toMatchObject({ disposition: "checks_passed", result: { draft: { summary: "Validated copy." }, details: { image: null } } });
  const job = (await runJobs(db, run._id)).find(job => job.kind === "image_story")!;
  await retryFailedStep(db, run._id, job._id, "editor");
  expect((await runs(db).findOne({ _id: run._id }))?.status).toBe("authoring");
  expect((await runJobs(db, run._id)).find(item => item._id === job._id)).toMatchObject({ status: "pending", attempts: 0 });
});

it("does not publish early when image-task enqueueing was interrupted halfway through", async () => {
  const { run, id, orchestration } = await queuedRun("public_record"); await seed("safety_incident", "Other record", run._id);
  await enqueue(db, { kind: "image_story", run_id: run._id, location_id: location.id,
    payload: { draft_id: run._id, story_id: id, revision: 0, policy: IMAGE_POLICY }, dedupe_key: `image_story:${run._id}:${id}:${IMAGE_POLICY}:0` });
  await runOne(orchestration); expect((await runs(db).findOne({ _id: run._id }))?.status).toBe("authoring");
  await resumeRun(orchestration, run._id, "editor"); await runOne(orchestration);
  expect((await runs(db).findOne({ _id: run._id }))?.status).toBe("awaiting_finish");
});

it("clears image tasks and decisions when an editor reassembles the draft", async () => {
  const { run, orchestration } = await queuedRun("public_record"); await resumeRun(orchestration, run._id, "editor"); await runOne(orchestration);
  expect(await db.collection(IMAGE_RESULTS).countDocuments({ run_id: run._id })).toBe(1);
  await reassemble(db, run._id, "editor");
  expect(await db.collection(IMAGE_RESULTS).countDocuments({ run_id: run._id })).toBe(0);
  expect((await runJobs(db, run._id)).some(job => job.kind === "image_story")).toBe(false);
});

it("reruns only images at the review gate without rewriting text or republishing", async () => {
  const { run, id, orchestration } = await queuedRun("public_record");
  await resumeRun(orchestration, run._id, "editor"); await runOne(orchestration);
  const original = (await db.collection(COLLECTIONS.editionEntries).findOne({ story_id: id }))?.result.draft;
  await rerunImageStage(orchestration, run._id, "editor");
  expect((await runJobs(db, run._id)).filter(job => job.kind === "author_story")).toHaveLength(1);
  expect((await runJobs(db, run._id)).filter(job => job.kind === "image_story")).toHaveLength(2);
  await runOne(orchestration);
  expect((await db.collection(COLLECTIONS.editionEntries).findOne({ story_id: id }))?.result.draft).toEqual(original);
  expect((await runs(db).findOne({ _id: run._id }))?.status).toBe("awaiting_finish");
  await runs(db).updateOne({ _id: run._id }, { $set: { status: "published" } });
  await expect(rerunImageStage(orchestration, run._id, "editor")).rejects.toThrow("waiting for publication review");
});

function stockPage(): CommonsPage {
  const candidate = page(); candidate.title = "File:Board games 2026.jpg";
  candidate.imageinfo![0].extmetadata!.ImageDescription.value = "Board games on a table";
  return candidate;
}

it("uses clearly labeled licensed stock only after primary acquisition has no suitable photo", async () => {
  const id = await seed("event", "Board games for everyone");
  deps.transport = vi.fn(async request => ({ url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ query: { pages:
    new URL(request.url).searchParams.get("gsrsearch")?.includes("town garden") ? {} : { "1": stockPage() } } })) }));
  await expect(processStockImage(deps, "edition", id, location)).rejects.toThrow("completed primary");
  expect(deps.transport).not.toHaveBeenCalled();
  expect((await processStoryImage(deps, "edition", id, location)).status).toBe("no_image");
  const result = await processStockImage(deps, "edition", id, location);
  expect(result).toMatchObject({ status: "selected", provider: "commons_stock", reason: "stock_after_primary_sources_exhausted",
    primary_outcome: { status: "no_image" }, image: { image_role: "stock", image_license: "CC BY-SA 4.0" } });
  expect(result.stages.indexOf("stock_discover")).toBeGreaterThan(result.stages.indexOf("discover"));
  expect(await publishableStoryImage(db, "edition", id, location.id, "web:organizer", today)).toMatchObject({ image_role: "stock" });
  const stock = result.image!; expect(normalizeStoryImage(stock)).toEqual(stock);
  expect(normalizeStoryImage({ ...stock, image_license_url: undefined })).toBeNull();
  // A primary retry must attempt primary sources again, then retain the existing fallback.
  expect((await processStoryImage(deps, "edition", id, location)).provider).toBe("commons_stock");
});

it("never replaces an available actual venue photo with stock", async () => {
  const id = await seed("event", "Board games in the garden");
  const primary = await processStoryImage(deps, "edition", id, location);
  expect(primary.provider).toBe("commons");
  expect((await processStockImage(deps, "edition", id, location)).image).toEqual(primary.image);
  expect(deps.transport).toHaveBeenCalledTimes(1);
});

it("tries the real venue before stock when the publisher photo is broken", async () => {
  const id = await seed("event", "Board games in the garden"); await approvePublisher();
  deps.sourcePhoto = vi.fn(async () => ({ image: "https://publisher.example/broken.jpg", image_source_url: "https://publisher.example/event" }));
  deps.validatePhoto = vi.fn(async source => { if (source.includes("publisher.example")) throw Error("Broken publisher image"); });
  const result = await processStoryImage(deps, "edition", id, location);
  expect(result).toMatchObject({ status: "selected", provider: "commons", image: { image_role: "venue" } });
  expect(deps.validatePhoto).toHaveBeenCalledTimes(2);
});

it("tries independent venue discovery before stock when a curated venue file is broken", async () => {
  const id = await seed("event", "Board games at Carkeek Park");
  const ballard = { ...location, id: "osm-w1551637823-wa" };
  await db.collection(COLLECTIONS.editions).updateOne({ id: "edition" }, { $set: { location_id: ballard.id,
    "events.0.facts.venue": "Carkeek Park", "events.0.facts.source_url": "https://interfaithcommunitysanctuary.org/mc-events/roots-of-joy-earth-circle-carkeek-park-lower-meadow/?mc_id=4119" } });
  const candidate = page(); candidate.title = "File:Carkeek Park Seattle 2026.jpg"; candidate.imageinfo![0].extmetadata!.ImageDescription.value = "Carkeek Park in Seattle";
  deps.transport = vi.fn(async request => ({ url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ query: { pages: { "1": candidate } } })) }));
  deps.validatePhoto = vi.fn(async source => { if (source.includes("Olympic_Mountains")) throw Error("Unavailable curated file"); });
  expect(await processStoryImage(deps, "edition", id, ballard)).toMatchObject({ status: "selected", provider: "commons" });
  expect(deps.transport).toHaveBeenCalledTimes(1); expect(deps.validatePhoto).toHaveBeenCalledTimes(2);
});

it.each([
  { kind: "public_record", title: "Census gardening statistics" },
  { kind: "safety_incident", title: "Board games stolen in police report" },
  { kind: "local_news", title: "Welcome to our new craft teacher" },
  { kind: "obituary", title: "Remembering a chess champion" },
  { kind: "event", title: "Memorial and board games" },
  { kind: "event", title: "Prayer and gardening" },
  { kind: "event", title: "A gathering with no specific activity" },
])("does not use generic stock for $title", story => expect(stockTopic(story)).toBeNull());

it("applies topical, license and capture-date checks to stock photos", () => {
  const topic = stockTopic({ kind: "event", title: "Board games" })!;
  expect(reviewStockPhoto(page(), topic, today)).toMatchObject({ accepted: false, reason: "stock_topic_mismatch" });
  const old = stockPage(); old.imageinfo![0].extmetadata!.DateTimeOriginal.value = "2007-01-01";
  expect(reviewStockPhoto(old, topic, today)).toMatchObject({ accepted: false, reason: "capture_date_not_recent" });
  const restricted = stockPage(); restricted.imageinfo![0].extmetadata!.LicenseShortName.value = "CC BY-NC 4.0";
  expect(reviewStockPhoto(restricted, topic, today)).toMatchObject({ accepted: false, reason: "license_not_approved" });
});

it("queues stock as a separate second pass only after every primary image job settles", async () => {
  const { run, orchestration } = await queuedRun("event", "Board games at the garden");
  await seed("public_record", "Record story", run._id);
  orchestration.transport = vi.fn(async request => ({ url: request.url, status: 200, headers: {}, body: new TextEncoder().encode('{"query":{"pages":{}}}') }));
  await resumeRun(orchestration, run._id, "editor"); await runOne(orchestration);
  expect((await runJobs(db, run._id)).some(job => job.kind === "stock_story")).toBe(false);
  await runOne(orchestration);
  expect((await runJobs(db, run._id)).filter(job => job.kind === "stock_story")).toHaveLength(1);
  expect((await runs(db).findOne({ _id: run._id }))?.status).toBe("authoring");
  await runOne(orchestration); expect((await runs(db).findOne({ _id: run._id }))?.status).toBe("awaiting_finish");
});

it("exhausts primary retries before stock retries and preserves validated text when both fail", async () => {
  const { run, orchestration } = await queuedRun("event", "Board games for everyone");
  orchestration.transport = vi.fn(async () => { throw Error("Provider unavailable"); });
  await resumeRun(orchestration, run._id, "editor");
  for (let attempt = 0; attempt < 6; attempt++) {
    await db.collection(COLLECTIONS.jobs).updateMany({ kind: { $in: ["image_story", "stock_story"] } }, { $set: { available_at: 0 } });
    expect(await runOne(orchestration)).toBe(true);
    if (attempt < 2) expect((await runJobs(db, run._id)).some(job => job.kind === "stock_story")).toBe(false);
  }
  expect((await runs(db).findOne({ _id: run._id }))?.status).toBe("awaiting_finish");
  expect(await db.collection(IMAGE_RESULTS).findOne({ run_id: run._id })).toMatchObject({ status: "failed", reason: "stock_retries_exhausted", primary_outcome: { status: "failed" } });
  expect(await db.collection(COLLECTIONS.editionEntries).findOne({ edition_id: run._id })).toMatchObject({ disposition: "checks_passed", result: { draft: { summary: "Validated copy." } } });
});
