import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { LocationProfile } from "../connectors/types";
import type { HttpTransport } from "../core/http";
import { Story, collapse } from "../editions/stories";
import { COLLECTIONS } from "../storage/mongo";
import { reviewAllowsCollection } from "../sourcemap/source-review";
import type { SourceRecord } from "../sourcemap/store";
import { discoverAreaPhotos, discoverVenuePhotos, type PhotoCandidate } from "./commons";
import { contextPlace, type PhotoPlace } from "./places";
import { allowsContextPhoto } from "../../../../shared/photo-presentation";
import { eventVenuePhoto } from "../../../../shared/event-venue-photos";
import { normalizeStoryImage, type StoryImage } from "../../../../shared/story-image";
import { downloadStoryImage, rasterDimensions, validImageBytes, validateEditorialPhoto } from "../../../../shared/image-validation";
import { cropPreviews, preparePhoto } from "./quality";
import { READER_STORIES_COLLECTION, type ReaderStory } from "../../../../shared/reader-stories";
import { storyImageUrl, storyUrl } from "../connectors/neighbours";
import { discoverStockPhotos, stockTopic, type StockTopic } from "./stock";
import { currentOptions } from "../core/run-options";
import { externalTransport, logApiCall } from "../trace/gateway";
import { recordDecision } from "../trace/decisions";
import { publicHttpsGet } from "../../../../shared/image-http";
import { PHOTO_ASSETS, type PhotoAsset } from "../../../../shared/image-assets";
import { photoStoryData, photoStoryHash, photoMetadataHash, VISUAL_REVIEW_POLICY, approvedCritic, qualifiedReview } from "./review";
import { photoStoryMismatch } from "../../../../shared/photo-story-match";
import { catalogPhotoApproved, discoverCatalogPhotos, photoCatalogVersion } from "./catalog";
import { PHOTO_CATALOG_SOURCES, isCalendarDate, type PhotoCatalogRecord, type PhotoCatalogReference } from "../../../../shared/photo-catalog";
import { IMAGE_POLICY, IMAGE_RESULTS, claimEditionPhoto, releaseEditionPhoto, photoUsedByOtherStory } from "./uniqueness";

export { IMAGE_POLICY, IMAGE_RESULTS } from "./uniqueness";
const SEARCH_CACHE = "venue_image_searches";
export type ImageStage = "classify" | "source_rights" | "discover" | "validate" | "stock_discover" | "stock_validate" | "attach" | "plan" | "visual_review" | "refine" | "critic" | "prepare" | "catalog_discover";
export type ImageResult = {
  _id: string; edition_id: string; story_id: string; run_id: string; location_id: string; policy: string;
  status: "selected" | "no_image" | "not_applicable" | "permission_required" | "failed";
  provider: "publisher" | "reader" | "reviewed_venue" | "commons" | "commons_stock" | "catalog" | null; reason: string; image: StoryImage | null;
  catalog?: PhotoCatalogReference;
  photo_hash?: string;
  selection?: { story_hash: string; image_metadata_hash: string };
  stages: ImageStage[]; candidates: PhotoCandidate[]; checked_at: number; error?: string;
  revision?: number; content_hash?: string;
  stock_checked?: boolean; primary_outcome?: { status: string; reason: string; error?: string };
  stock_topic?: string;
  reader_story_id?: string;
  agent?: { mode: "shadow" | "agentic"; state_id: string; story_hash: string; review_policy: string; image_hash?: string; asset_id?: string; reason?: string; calls?: number };
};
type Entry = { edition_id: string; story_id: string; source_id: string; disposition: string; result: Record<string, any> };
type Draft = { id: string; run_id: string; location_id: string; status: string; image_revision?: number; events: Parameters<typeof collapse>[0] };
function matchesSavedSelection(result: ImageResult, entry: Entry, story: Story) {
  return !result.image || result.selection?.story_hash === photoStoryHash(entry.result, story)
    && result.selection.image_metadata_hash === photoMetadataHash(result.image);
}
export type ImagePipelineDeps = { db: Db; transport?: HttpTransport; sourcePhoto: (story: Story) => Promise<StoryImage | null>;
  sourcePhotos?: (story: Story) => Promise<StoryImage[]>;
  validatePhoto?: (source: string) => Promise<unknown>; now?: () => Date };

export function imageResultId(draftId: string, storyId: string) { return `${draftId}:${storyId}:${IMAGE_POLICY}`; }
const day = (date: Date) => date.toISOString().slice(0, 10);
const commonsDisabled = () => currentOptions().external_off.includes("wikimedia");

/** Photo downloads keep their public-DNS guard and join the run's free-service controls. */
async function validatePhoto(deps: ImagePipelineDeps, source: string, catalog = false) {
  const host = new URL(source).hostname;
  const commons = host === "wikimedia.org" || host.endsWith(".wikimedia.org");
  if (commons && commonsDisabled()) {
    await logApiCall("wikimedia", false, "skipped", "Photo download switched off for this run");
    throw new Error("Wikimedia Commons is switched off for this run");
  }
  try {
    let image: unknown;
    if (deps.validatePhoto) image = await deps.validatePhoto(source);
    else if (catalog) {
      const photo = await preparePhoto((await downloadStoryImage(source)).bytes);
      await cropPreviews(photo, 0.5, 0.5, false);
      image = { hash: photo.hash };
    } else image = await validateEditorialPhoto(source);
    if (commons) await logApiCall("wikimedia", false, "ok", "Photo download and raster validation");
    return image;
  } catch (error) {
    if (commons) await logApiCall("wikimedia", false, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}
export async function sourceImagesApproved(db: Db, locationId: string, sourceId: string, today: Date): Promise<boolean> {
  const source = await db.collection<SourceRecord>("source_map").findOne({ location_id: locationId, source_id: sourceId });
  const review = source?.access_review;
  return Boolean(review?.images_allowed && reviewAllowsCollection(review, day(today)));
}

async function cachedVenueSearch(deps: ImagePipelineDeps, place: PhotoPlace, city: string, today: Date) {
  const key = createHash("sha256").update(JSON.stringify([IMAGE_POLICY, place, city.toLowerCase(), day(today)])).digest("hex");
  const collection = deps.db.collection<{ _id: string; candidates: PhotoCandidate[]; expires_at: Date }>(SEARCH_CACHE);
  await collection.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: "expire_venue_image_searches" });
  const cached = await collection.findOne({ _id: key, expires_at: { $gt: today } });
  if (cached) return cached.candidates;
  const candidates: PhotoCandidate[] = [];
  for (const query of place.queries.slice(0, 2)) {
    candidates.push(...await (place.role === "area" ? discoverAreaPhotos : discoverVenuePhotos)(query, city, today, externalTransport(deps.transport ?? publicHttpsGet)));
    if (candidates.some(candidate => candidate.accepted)) break;
  }
  await collection.updateOne({ _id: key }, { $set: { candidates, expires_at: new Date(today.getTime() + 86400000) } }, { upsert: true });
  return candidates;
}

async function cachedStockSearch(deps: ImagePipelineDeps, topic: StockTopic, today: Date) {
  const key = `stock:${IMAGE_POLICY}:${topic.id}:${day(today)}`;
  const collection = deps.db.collection<{ _id: string; candidates: PhotoCandidate[]; expires_at: Date }>(SEARCH_CACHE);
  await collection.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: "expire_venue_image_searches" });
  const cached = await collection.findOne({ _id: key, expires_at: { $gt: today } });
  if (cached) return cached.candidates;
  const candidates = await discoverStockPhotos(topic, today, externalTransport(deps.transport ?? publicHttpsGet));
  await collection.updateOne({ _id: key }, { $set: { candidates, expires_at: new Date(today.getTime() + 86400000) } }, { upsert: true });
  return candidates;
}

export async function reserveUniquePhoto(db: Db, result: ImageResult, mode: "published" | "shadow" = "published") {
  if (result.image && !await claimEditionPhoto(db, result.edition_id, result.story_id, result.location_id,
    result.revision ?? 0, result.image, result.photo_hash ?? result.agent?.image_hash, mode)) {
    result.image = null; result.provider = null; result.status = "no_image"; result.reason = "duplicate_photo_in_edition";
    delete result.catalog; delete result.photo_hash;
  }
  if (!result.image) {
    delete result.selection;
    await releaseEditionPhoto(db, result.edition_id, result.story_id, result.revision ?? 0, mode);
  }
}

export async function storyImageMismatch(db: Db, result: Record<string, any>, story: Story, image: StoryImage,
  catalog?: PhotoCatalogReference): Promise<string | null> {
  const source = catalog && await db.collection<PhotoCatalogRecord>(PHOTO_CATALOG_SOURCES).findOne({ _id: catalog.id, revision: catalog.revision });
  const aliases = source?.scope.kind === "venue" || source?.scope.kind === "street" ? [source.scope.name, ...source.scope.aliases] : [];
  return photoStoryMismatch(photoStoryData(result, story), image, aliases);
}

/** Audit and attachment share an idempotent identity; retries repair an interrupted attachment. */
export async function saveResult(db: Db, entry: Entry, result: ImageResult) {
  const current = await db.collection<Draft>(COLLECTIONS.editions).findOne({ id: result.edition_id });
  if (!current || current.status !== "ready" || (current.image_revision ?? 0) !== (result.revision ?? 0)) throw new Error("Image draft changed before attachment");
  if (result.image) {
    const story = collapse(current.events).find(item => item.id === result.story_id);
    const mismatch = story ? await storyImageMismatch(db, entry.result, story, result.image, result.catalog) : "photo_story_missing";
    if (mismatch) {
      result.image = null; result.provider = null; result.status = "no_image"; result.reason = mismatch;
      delete result.catalog; delete result.photo_hash;
    } else {
      result.selection = { story_hash: photoStoryHash(entry.result, story!), image_metadata_hash: photoMetadataHash(result.image!) };
    }
  }
  if (!result.image) delete result.selection;
  await reserveUniquePhoto(db, result);
  await db.collection<ImageResult>(IMAGE_RESULTS).replaceOne({ _id: result._id }, result, { upsert: true });
  const details = Object.fromEntries(Object.entries(entry.result.details ?? {}).filter(([key]) => key !== "image" && !key.startsWith("image_")));
  await db.collection(COLLECTIONS.editionEntries).updateOne({ edition_id: result.edition_id, story_id: result.story_id, disposition: "checks_passed" }, {
    $set: { "result.details": { ...details, image: null, ...result.image },
      "result.image_pipeline": { status: result.status, reason: result.reason, provider: result.provider, policy: result.policy, checked_at: result.checked_at } },
  });
  await recordDecision({ stage: "plan", actor: "rule", subject: `image:${result.edition_id}:${result.story_id}`,
    decision: result.status, reason: result.reason, rule: result.policy,
    evidence: { story_id: result.story_id, provider: result.provider, stages: result.stages,
      image_credit: result.image?.image_credit ?? null, stock_checked: Boolean(result.stock_checked) } });
  return result;
}

/** One story, independent of authoring models. Missing photographs never hold the news text. */
export async function processStoryImage(deps: ImagePipelineDeps, draftId: string, storyId: string, location: LocationProfile): Promise<ImageResult> {
  const draft = await deps.db.collection<Draft>(COLLECTIONS.editions).findOne({ id: draftId, location_id: location.id });
  const entry = await deps.db.collection<Entry>(COLLECTIONS.editionEntries).findOne({ edition_id: draftId, story_id: storyId });
  if (!draft || !entry || entry.disposition !== "checks_passed" || draft.status !== "ready") throw new Error("Image stage requires a validated story in a ready draft");
  const today = deps.now?.() ?? new Date();
  const result: ImageResult = { _id: imageResultId(draftId, storyId), edition_id: draftId, run_id: draft.run_id,
    story_id: storyId, location_id: location.id, policy: IMAGE_POLICY, status: "no_image", reason: "no_suitable_photo",
    provider: null, image: null, stages: ["classify"], candidates: [], checked_at: today.getTime() };
  const story = collapse(draft.events).find((item) => item.id === storyId);
  if (!story) throw new Error("Image stage story is absent from the collected draft");
  result.revision = draft.image_revision ?? 0;
  let duplicate = false;
  let mismatch: string | null = null;
  const verify = async (image: StoryImage, catalog = false, reference?: PhotoCatalogReference): Promise<boolean> => {
    const issue = await storyImageMismatch(deps.db, entry.result, story, image, reference);
    if (issue) { mismatch = issue; result.candidates.push({ title: image.image_alt ?? image.image_place ?? "Story photo", accepted: false, reason: issue }); return false; }
    const used = async (hash?: string) => photoUsedByOtherStory(deps.db, draftId, storyId, result.revision ?? 0, image, hash);
    if (await used()) { duplicate = true; return false; }
    const checked = await validatePhoto(deps, image.image, catalog);
    const fingerprint = checked && typeof checked === "object" && "hash" in checked && typeof checked.hash === "string" ? checked.hash : undefined;
    if (await used(fingerprint)) { duplicate = true; return false; }
    result.photo_hash = fingerprint;
    return true;
  };
  result.content_hash = createHash("sha256").update(JSON.stringify([photoStoryHash(entry.result, story), VISUAL_REVIEW_POLICY, entry.source_id, result.revision,
    Boolean(story.facts.link_only), Boolean(story.facts.image_blocked), Boolean(story.facts.no_page_fetch), normalizeStoryImage(story.facts.details),
    await photoCatalogVersion(deps.db, location.id)])).digest("hex");
  if (story.kind === "reader_story") {
    const submission = await deps.db.collection<ReaderStory>(READER_STORIES_COLLECTION).findOne({ _id: story.first.source_event_id, location_id: location.id, status: "approved" });
    const photo = submission?.image;
    result.stages.push("source_rights");
    if (submission && photo?.credit?.trim() && photo.permission_confirmed_at) {
      const bytes = Buffer.from(photo.data, "base64");
      result.photo_hash = createHash("sha256").update(bytes).digest("hex");
      const size = rasterDimensions(bytes, photo.mime_type);
      if (validImageBytes(bytes, photo.mime_type) && size && size.width >= 240 && size.height >= 120) {
        result.image = normalizeStoryImage({ image: storyImageUrl(submission), image_source_url: storyUrl(submission),
          image_credit: photo.credit, image_caption: photo.caption, image_alt: photo.caption, image_width: size.width, image_height: size.height });
        if (result.image) { result.status = "selected"; result.provider = "reader"; result.reason = "approved_reader_photo"; result.reader_story_id = submission._id; }
      }
    }
    if (!result.image) result.reason = "no_approved_reader_photo";
    result.stages.push("validate", "attach"); return saveResult(deps.db, entry, result);
  }
  const place = contextPlace(story);
  // Census, safety and court records stay photo-free; a permit may use its actual street.
  if (!place && ["public_record", "safety_incident", "housing_market", "development", "court_case", "home_sale", "building_permit"].includes(story.kind)) {
    // An actual photo explicitly supplied with an approved record is different from context.
    const supplied = !story.facts.link_only && !story.facts.image_blocked && normalizeStoryImage(story.facts.details, { source_url: story.first.source_url });
    if (supplied && !supplied.image_role && await sourceImagesApproved(deps.db, location.id, entry.source_id, today)) {
      result.stages.push("source_rights", "validate");
      if (!await verify(supplied)) {
        result.reason = mismatch ?? "duplicate_photo_in_edition"; result.stages.push("attach");
        return saveResult(deps.db, entry, result);
      }
      result.status = "selected"; result.reason = "approved_record_source_photo"; result.provider = "publisher"; result.image = supplied;
      result.stages.push("attach"); return saveResult(deps.db, entry, result);
    }
    result.status = "not_applicable"; result.reason = "record_story_no_context_photo";
    result.stages.push("attach");
    return saveResult(deps.db, entry, result);
  }
  result.stages.push("source_rights");
  const publisherApproved = await sourceImagesApproved(deps.db, location.id, entry.source_id, today);
  result.content_hash = createHash("sha256").update(JSON.stringify([result.content_hash, publisherApproved])).digest("hex");
  // Completed retries reuse an audit only while its rights and capture date still apply.
  const existing = await deps.db.collection<ImageResult>(IMAGE_RESULTS).findOne({ _id: result._id });
  if (existing && existing.content_hash === result.content_hash && today.getTime() - existing.checked_at < 86400000 && existing.status !== "failed"
    && matchesSavedSelection(existing, entry, story)
    && (existing.provider !== "publisher" || publisherApproved && !story.facts.link_only && !story.facts.image_blocked)
    && existing.provider !== "commons_stock"
    && (!existing.image || !await photoUsedByOtherStory(deps.db, draftId, storyId, result.revision ?? 0, existing.image, existing.photo_hash ?? existing.agent?.image_hash))
    && (existing.provider !== "catalog" || existing.catalog && await catalogPhotoApproved(deps.db, existing.catalog, story, location.id,
      location.community?.parent_name || location.name.split(",")[0].trim(), today))
    && (!existing.image?.image_date || today.getTime() - Date.parse(existing.image.image_date + "T00:00:00Z") <= 365 * 86400000)) {
    return saveResult(deps.db, entry, existing);
  }
  let publisherBroken = false;
  if (publisherApproved && !story.facts.link_only && !story.facts.image_blocked) {
    try {
      const supplied = deps.sourcePhotos ? await deps.sourcePhotos(story) : [await deps.sourcePhoto(story)];
      for (const candidate of supplied.slice(0, 4)) {
        const image = normalizeStoryImage(candidate);
        if (!image) continue;
        try {
          result.stages.push("validate"); if (!await verify(image)) continue;
          result.status = "selected"; result.reason = "approved_publisher_photo"; result.provider = "publisher"; result.image = image;
          break;
        } catch {
          publisherBroken = true;
          result.candidates.push({ title: image.image_alt ?? "Publisher photo", accepted: false, reason: "publisher_photo_download_or_validation_failed" });
        }
      }
    } catch (error) {
      if (!place && story.kind !== "event" && story.kind !== "meeting_preview") throw error;
      publisherBroken = true;
      result.candidates.push({ title: "Publisher photo", accepted: false, reason: "publisher_photo_download_or_validation_failed" });
    }
  }
  let catalogBroken = false;
  if (!result.image) {
    const city = location.community?.parent_name || location.name.split(",")[0].trim();
    const candidates = await discoverCatalogPhotos(deps.db, location.id, story, city, today,
      externalTransport(deps.transport ?? publicHttpsGet), !commonsDisabled());
    if (candidates.length) result.stages.push("catalog_discover");
    result.candidates.push(...candidates);
    for (const candidate of candidates.filter(candidate => candidate.accepted && candidate.image).slice(0, 3)) {
      try {
        result.stages.push("validate");
        if (!await verify(candidate.image!, true, candidate.catalog)) continue;
        if (!await catalogPhotoApproved(deps.db, candidate.catalog!, story, location.id, city, today)) continue;
        result.image = candidate.image!; result.catalog = candidate.catalog; result.provider = "catalog";
        result.status = "selected"; result.reason = "approved_catalog_photo"; break;
      } catch {
        catalogBroken = true;
        result.candidates.push({ title: candidate.title, accepted: false, reason: "catalog_photo_validation_failed" });
      }
    }
  }
  if (!result.image && publisherBroken && !place && story.kind !== "event" && story.kind !== "meeting_preview")
    throw new Error("Publisher photo download/validation failed; retry is safe");
  if (!result.image && (place || story.kind === "event" || story.kind === "meeting_preview")) {
    result.stages.push("discover");
    if (commonsDisabled()) {
      await logApiCall("wikimedia", false, "skipped", "Venue/street photo discovery switched off for this run");
      result.reason = "wikimedia_disabled_for_run"; result.stages.push("attach");
      return saveResult(deps.db, entry, result);
    }
    const reviewed = eventVenuePhoto(location.id, { kind: story.kind, source_url: story.first.source_url }, today);
    const city = location.community?.parent_name || location.name.split(",")[0].trim();
    const candidates: Array<{ image: StoryImage; provider: ImageResult["provider"] }> = [];
    if (reviewed) candidates.push({ image: reviewed, provider: "reviewed_venue" });
    if (!reviewed && place) {
      result.candidates.push(...await cachedVenueSearch(deps, place, city, today));
      for (const candidate of result.candidates.filter((item) => !item.catalog && item.accepted && item.image).slice(0, 2)) candidates.push({ image: candidate.image!, provider: "commons" });
    }
    let broken = publisherBroken || catalogBroken;
    for (const candidate of candidates) {
      result.stages.push("validate");
      try {
        if (!await verify(candidate.image)) continue;
        result.image = candidate.image; result.provider = candidate.provider; result.status = "selected";
        result.reason = place?.role === "area" ? "recent_licensed_actual_street" : "recent_licensed_actual_venue"; break;
      } catch { broken = true; }
    }
    // A broken curated asset does not count as exhausting the independent venue search.
    if (!result.image && reviewed && place) {
      const discovered = await cachedVenueSearch(deps, place, city, today);
      result.candidates.push(...discovered);
      const next = discovered.find(candidate => candidate.accepted && candidate.image && candidate.image.image !== reviewed.image);
      if (next?.image) {
        result.stages.push("validate");
        try {
          if (await verify(next.image)) {
            result.image = next.image; result.provider = "commons";
            result.status = "selected"; result.reason = "recent_licensed_actual_venue";
          }
        } catch { broken = true; }
      }
    }
    if (!result.image && broken) throw new Error("Venue photo download/validation failed; retry is safe");
    if (!result.image) result.reason = place?.role === "area" ? "no_recent_licensed_street_match" : story.first.venue ? "no_recent_licensed_venue_match" : "event_venue_missing";
  } else if (!result.image && !publisherApproved) {
    result.status = "permission_required"; result.reason = "publisher_photo_reuse_not_approved";
  }
  // Retrying a formerly failed primary job may find no improvement. Retain a current,
  // already-validated secondary image only after attempting the primary sources again.
  if (!result.image && existing?.provider === "commons_stock" && existing.image && existing.revision === result.revision
    && matchesSavedSelection(existing, entry, story)
    && stockTopic(story)?.id === existing.stock_topic && today.getTime() - existing.checked_at < 86400000
    && existing.image.image_date && today.getTime() - Date.parse(existing.image.image_date + "T00:00:00Z") <= 365 * 86400000) {
    return saveResult(deps.db, entry, { ...existing, content_hash: result.content_hash,
      primary_outcome: { status: result.status, reason: result.reason } });
  }
  if (!result.image && duplicate) { result.status = "no_image"; result.reason = "duplicate_photo_in_edition"; }
  if (!result.image && mismatch) { result.status = "no_image"; result.reason = mismatch; }
  result.stages.push("attach");
  return saveResult(deps.db, entry, result);
}

/** Secondary queue stage: only after primary acquisition has a saved no-photo outcome. */
export async function processStockImage(deps: ImagePipelineDeps, draftId: string, storyId: string, location: LocationProfile): Promise<ImageResult> {
  const draft = await deps.db.collection<Draft>(COLLECTIONS.editions).findOne({ id: draftId, location_id: location.id, status: "ready" });
  const entry = await deps.db.collection<Entry>(COLLECTIONS.editionEntries).findOne({ edition_id: draftId, story_id: storyId, disposition: "checks_passed" });
  const primary = await deps.db.collection<ImageResult>(IMAGE_RESULTS).findOne({ _id: imageResultId(draftId, storyId) });
  if (!draft || !entry || !primary || primary.revision !== (draft.image_revision ?? 0)) throw new Error("Stock stage requires a completed primary image decision for the current draft");
  const story = collapse(draft.events).find(item => item.id === storyId);
  if (!story) throw new Error("Stock stage story is absent from the collected draft");
  const topic = stockTopic(entry.result.story ?? {});
  if (!topic || primary.image && primary.provider !== "commons_stock") return primary;
  if (primary.stock_checked && primary.status !== "failed" && matchesSavedSelection(primary, entry, story) && (!primary.image || !await photoUsedByOtherStory(deps.db,
    draftId, storyId, primary.revision ?? 0, primary.image, primary.photo_hash ?? primary.agent?.image_hash))) return saveResult(deps.db, entry, primary);
  const today = deps.now?.() ?? new Date();
  const result: ImageResult = { ...primary, status: "no_image", reason: "no_suitable_licensed_stock_photo", provider: null, image: null,
    stock_checked: true, stock_topic: topic.id, checked_at: today.getTime(), error: undefined,
    primary_outcome: primary.primary_outcome ?? { status: primary.status, reason: primary.reason, ...(primary.error ? { error: primary.error } : {}) },
    stages: [...primary.stages, "stock_discover"], candidates: [...primary.candidates] };
  if (commonsDisabled()) {
    await logApiCall("wikimedia", false, "skipped", "Stock photo discovery switched off for this run");
    result.reason = "wikimedia_disabled_for_run"; result.stages.push("attach");
    return saveResult(deps.db, entry, result);
  }
  const candidates = await cachedStockSearch(deps, topic, today);
  result.candidates.push(...candidates);
  let broken = false;
  for (const candidate of candidates.filter(candidate => candidate.accepted && candidate.image).slice(0, 2)) {
    if (await storyImageMismatch(deps.db, entry.result, story, candidate.image!)) continue;
    if (await photoUsedByOtherStory(deps.db, draftId, storyId, result.revision ?? 0, candidate.image!)) continue;
    result.stages.push("stock_validate");
    try {
      const checked = await validatePhoto(deps, candidate.image!.image);
      const fingerprint = checked && typeof checked === "object" && "hash" in checked && typeof checked.hash === "string" ? checked.hash : undefined;
      if (await photoUsedByOtherStory(deps.db, draftId, storyId, result.revision ?? 0, candidate.image!, fingerprint)) continue;
      result.photo_hash = fingerprint;
      result.image = candidate.image!; result.status = "selected"; result.provider = "commons_stock"; result.reason = "stock_after_primary_sources_exhausted"; break;
    } catch { broken = true; }
  }
  if (!result.image && broken) throw new Error("Stock photo validation failed; retry is safe");
  result.stages.push("attach");
  return saveResult(deps.db, entry, result);
}

/** Exhausted image retries degrade to text-only and preserve the failure for the editor. */
export async function failStoryImage(db: Db, draftId: string, storyId: string, locationId: string, runId: string, error: string, stock = false) {
  const entry = await db.collection<Entry>(COLLECTIONS.editionEntries).findOne({ edition_id: draftId, story_id: storyId });
  if (!entry) return;
  const primary = stock ? await db.collection<ImageResult>(IMAGE_RESULTS).findOne({ _id: imageResultId(draftId, storyId) }) : null;
  await saveResult(db, entry, { _id: imageResultId(draftId, storyId), edition_id: draftId, story_id: storyId,
    run_id: runId, location_id: locationId, policy: IMAGE_POLICY, status: "failed", reason: stock ? "stock_retries_exhausted" : "image_retries_exhausted", image: null,
    provider: null, stages: stock ? [...(primary?.stages ?? []), "stock_discover", "attach"] : ["attach"], candidates: primary?.candidates ?? [], checked_at: Date.now(), error,
    ...(stock ? { stock_checked: true, primary_outcome: primary?.primary_outcome ?? { status: primary?.status ?? "failed", reason: primary?.reason ?? "image_retries_exhausted" } } : {}),
    revision: Number((await db.collection<Draft>(COLLECTIONS.editions).findOne({ id: draftId }))?.image_revision ?? 0) });
}

/** Recheck rights/freshness at the publication boundary, including resumed old drafts. */
export async function publishableStoryImage(db: Db, draftId: string, storyId: string, locationId: string, sourceId: string, today = new Date(), lead = false) {
  const audit = await db.collection<ImageResult>(IMAGE_RESULTS).findOne({ _id: imageResultId(draftId, storyId), status: "selected" });
  if (!audit?.image) return null;
  const draft = await db.collection<Draft>(COLLECTIONS.editions).findOne({ id: draftId, location_id: locationId });
  if (!draft || audit.location_id !== locationId || (draft.image_revision ?? 0) !== (audit.revision ?? 0)) return null;
  const currentEntry = await db.collection<Entry>(COLLECTIONS.editionEntries).findOne({ edition_id: draftId, story_id: storyId, disposition: "checks_passed" });
  const currentStory = collapse(draft.events).find(story => story.id === storyId);
  if (!currentEntry || !currentStory || await storyImageMismatch(db, currentEntry.result, currentStory, audit.image, audit.catalog)) return null;
  if (audit.selection?.story_hash !== photoStoryHash(currentEntry.result, currentStory)
    || audit.selection.image_metadata_hash !== photoMetadataHash(audit.image)) return null;
  if (await photoUsedByOtherStory(db, draftId, storyId, audit.revision ?? 0, audit.image, audit.photo_hash ?? audit.agent?.image_hash)) return null;
  if (audit.provider === "catalog") {
    const story = collapse(draft.events).find(story => story.id === storyId);
    const source = audit.catalog && await db.collection<PhotoCatalogRecord>(PHOTO_CATALOG_SOURCES).findOne({ _id: audit.catalog.id });
    if (!story || !source || !audit.catalog || audit.image.image_catalog_id !== audit.catalog.id
      || audit.image.image_catalog_revision !== audit.catalog.revision
      || !await catalogPhotoApproved(db, audit.catalog, story, locationId, source.scope.city, today)
      || !isCalendarDate(audit.image.image_date) || Date.parse(audit.image.image_date) > today.getTime()
      || today.getTime() - Date.parse(audit.image.image_date) > 365 * 86400000) return null;
  }
  if (audit.agent?.mode === "agentic") {
    if (lead && (audit.image.image_width ?? 0) < 1800) return null;
    const entry = await db.collection<Entry>(COLLECTIONS.editionEntries).findOne({ edition_id: draftId, story_id: storyId, disposition: "checks_passed" });
    const story = collapse(draft.events).find(story => story.id === storyId);
    const asset = audit.agent.asset_id && await db.collection<PhotoAsset>(PHOTO_ASSETS).findOne({ _id: audit.agent.asset_id });
    const state = await db.collection("image_agent_states").findOne({ _id: audit.agent.state_id as never });
    if (!entry || !story || photoStoryHash(entry.result, story) !== audit.agent.story_hash || audit.agent.review_policy !== VISUAL_REVIEW_POLICY
      || !asset || asset.original_hash !== audit.agent.image_hash || audit.image.image_asset_id !== asset._id
      || state?.approval?.image_hash !== audit.agent.image_hash || state?.approval?.story_hash !== audit.agent.story_hash
      || state.approval.image_metadata_hash !== photoMetadataHash(audit.image)
      || !approvedCritic(state.approval.critic) || !qualifiedReview(state.approval.review)) return null;
  }
  if (audit.provider === "reader") {
    const submission = await db.collection<ReaderStory>(READER_STORIES_COLLECTION).findOne({ _id: audit.reader_story_id, location_id: locationId, status: "approved", "image.permission_confirmed_at": { $exists: true }, "image.credit": { $exists: true } });
    if (!submission?.image || audit.agent?.image_hash && createHash("sha256").update(Buffer.from(submission.image.data, "base64")).digest("hex") !== audit.agent.image_hash) return null;
  }
  if (audit.provider === "publisher" && !await sourceImagesApproved(db, locationId, sourceId, today)) return null;
  if (audit.image.image_role && (!audit.image.image_date || today.getTime() - Date.parse(audit.image.image_date + "T00:00:00Z") > 365 * 86400000)) return null;
  if (audit.image.image_role === "stock") {
    const entry = await db.collection<Entry>(COLLECTIONS.editionEntries).findOne({ edition_id: draftId, story_id: storyId });
    if (!stockTopic(entry?.result.story ?? {})) return null;
  }
  if (audit.image.image_role === "area" || audit.image.image_role === "venue") {
    const entry = await db.collection<Entry>(COLLECTIONS.editionEntries).findOne({ edition_id: draftId, story_id: storyId });
    if (!allowsContextPhoto(entry?.result.story?.kind, audit.image.image_role)) return null;
  }
  return normalizeStoryImage(audit.image);
}
