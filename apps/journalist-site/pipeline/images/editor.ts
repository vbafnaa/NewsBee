import type { Db } from "mongodb";
import type { ModelRuntime, VisionInput, StructuredGeneration, JsonSchema } from "../model/runtime";
import { ModelRateLimitError } from "../model/runtime";
import { currentOptions } from "../core/run-options";
import { logApiCall, externalTransport } from "../trace/gateway";
import { recordDecision } from "../trace/decisions";
import { COLLECTIONS } from "../storage/mongo";
import { collapse } from "../editions/stories";
import type { LocationProfile } from "../connectors/types";
import { IMAGE_POLICY, saveResult, reserveUniquePhoto, sourceImagesApproved, publishableStoryImage, storyImageMismatch, type ImagePipelineDeps, type ImageResult } from "./pipeline";
import { photoUsedByOtherStory } from "./uniqueness";
import { contextPlace } from "./places";
import { reviewAreaPhoto, reviewCommonsPhoto, searchCommonsPhotos, type PhotoCandidate } from "./commons";
import { reviewStockPhoto, stockTopic } from "./stock";
import { PHOTO_EDITOR_SYSTEM, VISUAL_REVIEW_POLICY, PLAN_SCHEMA, REVIEW_SCHEMA, CRITIC_SCHEMA,
  parsePhotoPlan, parseVisualReviews, parseCritic, qualifiedReview, approvedCritic, photoStoryHash, photoMetadataHash, visualRefinement, localPhotoSchema, type PhotoPlan, type VisualReview } from "./review";
import { preparePhoto, cropPreviews, storePhoto, hash, PHOTO_QUALITY_POLICY, type PreparedPhoto } from "./quality";
import { normalizeStoryImage, safeImageUrl, type StoryImage } from "../../../../shared/story-image";
import { downloadStoryImage } from "../../../../shared/image-validation";
import { publicHttpsGet } from "../../../../shared/image-http";
import { eventVenuePhoto } from "../../../../shared/event-venue-photos";
import { READER_STORIES_COLLECTION, type ReaderStory } from "../../../../shared/reader-stories";
import { storyImageUrl, storyUrl } from "../connectors/neighbours";
import { catalogPhotoApproved, discoverCatalogPhotos, matchingCatalogSources, photoCatalogVersion } from "./catalog";

export const IMAGE_AGENT_STATES = "image_agent_states";
export const IMAGE_SHADOW_RESULTS = "story_image_shadow_results";
const BUDGETS = "image_agent_budgets";
type Candidate = PhotoCandidate & { provider: ImageResult["provider"]; reader_story_id?: string };
type State = {
  _id: string; run_id: string; calls: number; downloads: number; started_at: number;
  steps: Record<string, StructuredGeneration>; searches: Record<string, Candidate[]>;
  rejected: Array<{ candidate: string; reason: string }>; reviews: VisualReview[];
  downloaded?: Record<string, string>;
  primary?: ImageResult; stock?: ImageResult;
  plan?: PhotoPlan;
  approval?: { image_hash: string; story_hash: string; image_metadata_hash: string; critic: ReturnType<typeof parseCritic>; review: VisualReview };
  queries?: Array<{ phase: string; round: number; query: string }>;
  refinement_query?: string;
};
export type PhotoEditorDeps = ImagePipelineDeps & { model?: ModelRuntime | null; loadPhoto?: (source: string) => Promise<Uint8Array> };
class PhotoBudgetError extends Error {}
// Local CPU inference needs more time; hosted requests retain their shorter deadline.
const photoTiming = (model?: ModelRuntime | null) => model?.provider === "ollama"
  ? { story: 600_000, request: 240_000, keepAlive: "5m", preview: 640 }
  : { story: 180_000, request: 25_000, keepAlive: undefined, preview: 1280 };

/** A reservation is consumed even if a worker dies during the remote call. */
async function reserveCall(db: Db, stateId: string, runId: string) {
  const local = await db.collection<State>(IMAGE_AGENT_STATES).findOneAndUpdate({ _id: stateId, calls: { $lt: 4 } }, { $inc: { calls: 1 } }, { returnDocument: "after" });
  if (!local) throw new PhotoBudgetError("photo_story_call_budget_exhausted");
  const budget = Math.min(200, Math.max(0, currentOptions().image_call_budget ?? 40));
  const budgets = db.collection<{ _id: string; used: number }>(BUDGETS);
  await budgets.updateOne({ _id: runId }, { $setOnInsert: { used: 0 } }, { upsert: true });
  const allowed = await budgets.findOneAndUpdate({ _id: runId, used: { $lt: budget } }, { $inc: { used: 1 } });
  if (!allowed) throw new PhotoBudgetError("photo_run_call_budget_exhausted");
}

/** A persisted step reuses only the exact prompt/images and completed structured response. */
async function modelStep(deps: PhotoEditorDeps, state: State, label: string, prompt: string, schema: JsonSchema, images?: VisionInput[]) {
  const timing = photoTiming(deps.model);
  const remaining = timing.story - (Date.now() - state.started_at);
  if (remaining <= 0) throw new PhotoBudgetError("photo_time_budget_exhausted");
  const local = deps.model?.provider === "ollama";
  const modelSchema = local ? localPhotoSchema(schema, images?.map(image => image.id)) : schema;
  const modelPrompt = local ? `${prompt}\nReturn only a compact JSON object matching this schema. Each explanation must be one short sentence. Copy the candidate id exactly.\nJSON SCHEMA:${JSON.stringify(modelSchema)}` : prompt;
  const key = hash(JSON.stringify([label, modelPrompt, modelSchema, images?.map(image => [image.id, hash(image.data)])]));
  const saved = await deps.db.collection<State>(IMAGE_AGENT_STATES).findOne({ _id: state._id });
  if (saved?.steps[key]) return saved.steps[key];
  if (!deps.model?.supportsVision || !deps.model.generateVisionStructured) throw Error("visual_review_unavailable");
  const cacheKey = hash(JSON.stringify([key, VISUAL_REVIEW_POLICY, deps.model.provider, deps.model.model]));
  const cache = deps.db.collection<{ _id: string; result: StructuredGeneration; expires_at: Date }>("photo_model_reviews");
  await cache.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: "expire_photo_model_reviews" });
  const cached = await cache.findOne({ _id: cacheKey, expires_at: { $gt: new Date() } });
  if (cached) {
    await deps.db.collection<State>(IMAGE_AGENT_STATES).updateOne({ _id: state._id }, { $set: { [`steps.${key}`]: cached.result } });
    await recordDecision({ stage: "plan", actor: "agent", subject: `photo-model:${label}`, decision: "cached_visual_step", reason: "Exact prompt, pixels, model and review policy match" });
    return cached.result;
  }
  await reserveCall(deps.db, state._id, state.run_id);
  const options = { timeoutMs: Math.min(timing.request, remaining), keepAlive: timing.keepAlive };
  const result = images
    ? await deps.model.generateVisionStructured(modelPrompt, images, modelSchema, { ...options, numPredict: local ? 700 : 2400 })
    : await deps.model.generateStructured(modelPrompt, modelSchema, { ...options, numPredict: 700 });
  if (schema === PLAN_SCHEMA) parsePhotoPlan(result);
  else if (schema === REVIEW_SCHEMA) parseVisualReviews(result, images!.map(image => image.id));
  else if (schema === CRITIC_SCHEMA) parseCritic(result);
  await cache.updateOne({ _id: cacheKey }, { $set: { result, expires_at: new Date(Date.now() + 7 * 86400000) } }, { upsert: true });
  await deps.db.collection<State>(IMAGE_AGENT_STATES).updateOne({ _id: state._id }, { $set: { [`steps.${key}`]: result } });
  return result;
}

async function reject(deps: PhotoEditorDeps, state: State, candidate: string, reason: string) {
  await deps.db.collection<State>(IMAGE_AGENT_STATES).updateOne({ _id: state._id }, { $push: { rejected: { candidate: candidate.slice(0, 300), reason: reason.slice(0, 600) } } });
  await recordDecision({ stage: "plan", actor: "agent", subject: `image:${candidate}`, decision: "rejected", reason, rule: VISUAL_REVIEW_POLICY });
}

/** The primary and secondary jobs share four model calls, six downloads and one bounded deadline. */
export async function processEditedImage(deps: PhotoEditorDeps, draftId: string, storyId: string, location: LocationProfile,
  phase: "primary" | "stock", mode: "agentic" | "shadow"): Promise<ImageResult> {
  const draft = await deps.db.collection(COLLECTIONS.editions).findOne({ id: draftId, location_id: location.id, status: "ready" });
  const entry = await deps.db.collection(COLLECTIONS.editionEntries).findOne({ edition_id: draftId, story_id: storyId, disposition: "checks_passed" });
  if (!draft || !entry) throw Error("Photo editor requires a ready validated story");
  const story = collapse(draft.events).find(story => story.id === storyId);
  if (!story) throw Error("Photo story is absent from this draft");
  const storyHash = photoStoryHash(entry.result, story);
  const lead = await deps.db.collection(COLLECTIONS.editionEntries).findOne({ edition_id: draftId, disposition: "checks_passed" }, { sort: { "result.ranking.score": -1, position: 1 } });
  const isLead = lead?.story_id === storyId;
  const revision = Number(draft.image_revision ?? 0), today = deps.now?.() ?? new Date();
  const catalogVersion = await photoCatalogVersion(deps.db, location.id);
  const city = location.community?.parent_name || location.name.split(",")[0].trim();
  const stateId = hash(JSON.stringify([draftId, storyId, revision, storyHash, VISUAL_REVIEW_POLICY, PHOTO_QUALITY_POLICY,
    deps.model?.provider, deps.model?.model, isLead, mode, catalogVersion, today.toISOString().slice(0, 10)]));
  const states = deps.db.collection<State>(IMAGE_AGENT_STATES);
  await states.updateOne({ _id: stateId }, { $setOnInsert: { run_id: String(draft.run_id), calls: 0, downloads: 0,
    started_at: Date.now(), steps: {}, searches: {}, rejected: [], reviews: [] } }, { upsert: true });
  const state = (await states.findOne({ _id: stateId }))!;
  const result: ImageResult = { _id: `${draftId}:${storyId}:${IMAGE_POLICY}`, edition_id: draftId, story_id: storyId, location_id: location.id,
    run_id: String(draft.run_id), policy: IMAGE_POLICY, status: "no_image", reason: "no_qualified_photo", image: null, provider: null,
    checked_at: today.getTime(), revision, content_hash: storyHash, stages: ["classify"], candidates: [],
    ...(phase === "stock" ? { stock_checked: true, primary_outcome: { status: state.primary?.status ?? "no_image", reason: state.primary?.reason ?? "no_qualified_photo" } } : {}),
    agent: { mode, state_id: stateId, story_hash: storyHash, review_policy: VISUAL_REVIEW_POLICY } };
  const finish = async () => {
    result.agent!.calls = (await states.findOne({ _id: stateId }))?.calls ?? 0;
    const latestDraft = await deps.db.collection(COLLECTIONS.editions).findOne({ id: draftId, status: "ready" });
    const latestEntry = await deps.db.collection(COLLECTIONS.editionEntries).findOne({ edition_id: draftId, story_id: storyId, disposition: "checks_passed" });
    const latestStory = latestDraft && collapse(latestDraft.events).find(item => item.id === storyId);
    if (!latestEntry || !latestStory || Number(latestDraft!.image_revision ?? 0) !== revision || photoStoryHash(latestEntry.result, latestStory) !== storyHash)
      throw Error("Story changed during photo editing");
    result.stages.push("attach");
    if (mode === "shadow") {
      const mismatch = result.image && await storyImageMismatch(deps.db, latestEntry.result, latestStory, result.image, result.catalog);
      if (mismatch) { result.image = null; result.provider = null; result.status = "no_image"; result.reason = mismatch; delete result.catalog; }
      await reserveUniquePhoto(deps.db, result, "shadow");
      await deps.db.collection<ImageResult>(IMAGE_SHADOW_RESULTS).replaceOne({ _id: result._id }, result, { upsert: true });
      await deps.db.collection(COLLECTIONS.editionEntries).updateOne({ edition_id: draftId, story_id: storyId }, { $set: {
        "result.image_pipeline.shadow_status": result.status, "result.image_pipeline.shadow_reason": result.reason,
      } });
      await recordDecision({ stage: "plan", actor: "agent", subject: `image-shadow:${storyId}`, decision: result.status, reason: result.reason,
        evidence: { state_id: stateId, calls: result.agent!.calls } });
    } else await saveResult(deps.db, entry as any, result);
    await states.updateOne({ _id: stateId }, { $set: { [phase]: result } });
    return result;
  };
  const place = contextPlace(story), stock = stockTopic(entry.result.story ?? {});
  if (phase === "stock") {
    if (!state.primary) throw Error("Stock requires a completed primary photo decision");
    if (state.primary.image && !await storyImageMismatch(deps.db, entry.result, story, state.primary.image, state.primary.catalog)
      && !await photoUsedByOtherStory(deps.db, draftId, storyId, revision, state.primary.image,
        state.primary.photo_hash ?? state.primary.agent?.image_hash, mode === "shadow" ? "shadow" : "published")
      && (mode === "shadow" || await publishableStoryImage(deps.db, draftId, storyId, location.id, entry.source_id, today))) return state.primary;
    if (!stock) { result.status = "not_applicable"; result.reason = "stock_not_applicable"; return finish(); }
  }
  const approved = await sourceImagesApproved(deps.db, location.id, entry.source_id, today);
  const cached = state[phase];
  if (cached && !cached.image && cached.reason !== "visual_review_unavailable") return mode === "shadow" ? cached : saveResult(deps.db, entry as any, cached);
  if (cached?.image && mode === "agentic" && await publishableStoryImage(deps.db, draftId, storyId, location.id, entry.source_id, today))
    return saveResult(deps.db, entry as any, cached);
  if (phase === "primary" && !place && story.kind !== "reader_story" && !approved) {
    const record = ["public_record", "safety_incident", "court_case", "home_sale", "housing_market", "development", "building_permit"].includes(story.kind);
    const catalog = !record && await matchingCatalogSources(deps.db, location.id, story, city, today, !currentOptions().external_off.includes("wikimedia"));
    if (record || !catalog || !catalog.length) {
      result.status = record ? "not_applicable" : "permission_required";
      result.reason = record ? "record_story_no_context_photo" : "publisher_photo_reuse_not_approved";
      return finish();
    }
  }
  if (!deps.model?.supportsVision || !deps.model.generateVisionStructured) { result.reason = "visual_review_unavailable"; return finish(); }
  const disabled = currentOptions().external_off.includes("wikimedia");
  const brief = { headline: entry.result.draft?.headline ?? story.title, summary: entry.result.draft?.summary ?? story.description,
    source_description: story.description, when_where: entry.result.when_where ?? null, reported_venues: story.venues,
    kind: story.kind, place: place?.name ?? null, city, date: story.first.event_date, editorial_protections: entry.result.floor ?? null,
    relationship: phase === "stock" ? "stock activity; never the actual event or participants" : place?.role === "area" ? "actual named street; never evidence of the permitted work" : "actual source or venue; do not imply the event was photographed" };
  let plan: PhotoPlan;
  try {
    result.stages.push("plan");
    const local = deps.model.provider === "ollama";
    // Local planning uses verified place names to reserve inference for pixel review.
    plan = (local && phase === "stock" ? undefined : state.plan) ?? (local ? {
      useful: true, goal: phase === "stock" ? `Show the neutral activity: ${stock!.id}` : place ? `Show the actual ${place.name} setting` : "Review the approved source photograph",
      queries: (place?.queries ?? []).slice(0, 2), reason: "Use verified source and place evidence; require visual review before attachment.",
    } : parsePhotoPlan(await modelStep(deps, state, "plan", `${PHOTO_EDITOR_SYSTEM}\nDecide whether a photograph adds specific useful information. Plan at most two Commons search phrases for the named place. Never invent a source or licensing.\nSTORY DATA:\n${JSON.stringify(brief)}`, PLAN_SCHEMA)));
    if (local && !state.plan) await recordDecision({ stage: "plan", actor: "rule", subject: `photo-plan:${storyId}`,
      decision: "local_evidence_plan", reason: plan.reason, evidence: { queries: plan.queries, model_calls: 0 } });
    if (!state.plan) await states.updateOne({ _id: stateId }, { $set: { plan } });
    if (!plan.useful) { result.reason = "photo_adds_no_editorial_value"; return finish(); }
    let catalogCandidates: Candidate[] = [];
    if (phase === "primary") {
      const cachedCatalog = state.searches.catalog;
      catalogCandidates = cachedCatalog ?? (await discoverCatalogPhotos(deps.db, location.id, story, city, today,
        externalTransport(deps.transport ?? publicHttpsGet), !disabled)).map(candidate => ({ ...candidate, provider: "catalog" as const }));
      if (!cachedCatalog) await states.updateOne({ _id: stateId }, { $set: { "searches.catalog": catalogCandidates } });
      if (catalogCandidates.length) result.stages.push("catalog_discover");
    }
    for (let round = 0; round < (phase === "primary" ? 2 : 1); round++) {
      if (Date.now() - state.started_at > photoTiming(deps.model).story) throw new PhotoBudgetError("photo_time_budget_exhausted");
      result.stages.push(round ? "refine" : phase === "stock" ? "stock_discover" : "source_rights");
      const key = `${phase}_${round}`;
      let refinement = (await states.findOne({ _id: stateId }))?.refinement_query;
      if (round > 0 && !refinement) {
        const progress = (await states.findOne({ _id: stateId }))!;
        // When no image reached vision, the planner can still learn from metadata/decoder failures.
        if (!progress.reviews.length && !local) {
          const revised = parsePhotoPlan(await modelStep(deps, state, "refine_search", `${PHOTO_EDITOR_SYSTEM}\nRevise the search from these actual outcomes. Prefer a different, evidence-grounded phrase; do not repeat failed queries. A newer upload cannot prove a newer capture.\nSTORY DATA:${JSON.stringify(brief)}\nQUERIES TRIED:${JSON.stringify(progress.queries ?? [])}\nMETADATA RESULTS:${JSON.stringify(result.candidates.map(candidate => ({ title: candidate.title, reason: candidate.reason })))}\nREJECTIONS:${JSON.stringify(progress.rejected.slice(-8))}`, PLAN_SCHEMA));
          if (!revised.useful) { result.reason = "photo_adds_no_editorial_value"; return finish(); }
          refinement = revised.queries.find(query => !progress.queries?.some(tried => tried.query.startsWith(query + " ")));
        }
      }
      let candidates = state.searches[key];
      const readerBytes = new Map<string, Uint8Array>();
      if (!candidates) {
        candidates = [...catalogCandidates];
        if (phase === "primary" && round === 0) {
          if (story.kind === "reader_story") {
            const submission = await deps.db.collection<ReaderStory>(READER_STORIES_COLLECTION).findOne({ _id: story.first.source_event_id, location_id: location.id, status: "approved" });
            if (submission?.image?.permission_confirmed_at && submission.image.credit?.trim()) {
              const image = normalizeStoryImage({ image: storyImageUrl(submission), image_source_url: storyUrl(submission), image_credit: submission.image.credit, image_caption: submission.image.caption, image_alt: submission.image.caption });
              if (image) { candidates.push({ title: "Approved reader photo", accepted: true, reason: "reader_permission_confirmed", provider: "reader", image, reader_story_id: submission._id }); readerBytes.set(image.image, Buffer.from(submission.image.data, "base64")); }
            }
          } else if (approved && !story.facts.link_only && !story.facts.image_blocked) {
            try {
              const supplied = deps.sourcePhotos ? await deps.sourcePhotos(story) : [await deps.sourcePhoto(story)];
              for (const value of supplied.slice(0, 4)) {
                const image = normalizeStoryImage(value);
                if (image?.image_credit && image.image_source_url) candidates.push({ title: image.image_alt ?? "Approved story photo", accepted: true,
                  reason: "publisher_permission_confirmed", provider: "publisher", image });
              }
            } catch (error) { await reject(deps, state, "Publisher photo", error instanceof Error ? error.message : String(error)); }
          }
          if (place && !disabled) {
            const reviewed = eventVenuePhoto(location.id, { kind: story.kind, source_url: story.first.source_url }, today);
            if (reviewed) candidates.push({ title: reviewed.image_place ?? "Reviewed venue photo", accepted: true, reason: "reviewed_venue", provider: "reviewed_venue", image: reviewed });
          }
        }
        if (!disabled && (phase === "stock" || place) && (round > 0 || !candidates.some(candidate => candidate.accepted
          && ["publisher", "reader", "catalog"].includes(candidate.provider ?? "")))) {
          const words = phase === "stock" ? stock!.query : refinement || plan.queries[round] || place!.queries[round] || place!.name;
          const query = `${words} ${phase === "primary" ? `"${city.replace(/["\\]/g, "")}"` : ""} filetype:bitmap -intitle:DPLA -intitle:MOHAI`.slice(0, 300);
          if ((await states.findOne({ _id: stateId }))?.queries?.some(item => item.query === query)) {
            await reject(deps, state, query, "Identical search already attempted"); continue;
          }
          await states.updateOne({ _id: stateId }, { $push: { queries: { phase, round, query } } });
          await recordDecision({ stage: "query", actor: "agent", subject: query, decision: "photo_search", reason: plan.goal,
            evidence: { story_id: storyId, phase, round, state_id: stateId, provider: "wikimedia" } });
          const pages = await searchCommonsPhotos(query, externalTransport(deps.transport ?? publicHttpsGet)).catch(async error => {
            await reject(deps, state, query, error instanceof Error ? error.message : String(error)); return [];
          });
          for (const page of pages) {
            const reviewed = phase === "stock" ? reviewStockPhoto(page, stock!, today) : place!.role === "area" ? reviewAreaPhoto(page, place!.name, city, today)
              : place!.queries.map(alias => reviewCommonsPhoto(page, alias, city, today)).find(candidate => candidate.accepted) ?? reviewCommonsPhoto(page, place!.name, city, today);
            candidates.push({ ...reviewed, provider: phase === "stock" ? "commons_stock" : "commons" });
          }
        } else if (disabled) await logApiCall("wikimedia", false, "skipped", "Photo editor: Commons switched off for this run");
        await states.updateOne({ _id: stateId }, { $set: { [`searches.${key}`]: candidates } }); state.searches[key] = candidates;
      }
      result.candidates.push(...candidates);
      const prepared: Array<{ id: string; candidate: Candidate; photo: PreparedPhoto }> = [];
      const priority = (candidate: Candidate) => (["publisher", "reader"].includes(candidate.provider ?? "") ? 4 : candidate.provider === "catalog" && !candidate.image?.image_role ? 2 : 0)
        - (/\b(engine|dashboard|detail|logo)\b/i.test(candidate.title) && !/\b(engine|dashboard)\b/i.test(story.title) ? 1 : 0);
      const ordered = candidates.filter(candidate => candidate.accepted && candidate.image).sort((a, b) => priority(b) - priority(a));
      const unique = ordered.filter((candidate, index) => ordered.findIndex(item => item.image!.image === candidate.image!.image) === index);
      for (const candidate of unique) {
        if (prepared.length >= (local ? 1 : 3)) break;
        const image = candidate.image!;
        const mismatch = await storyImageMismatch(deps.db, entry.result, story, image, candidate.catalog);
        if (mismatch) { await reject(deps, state, image.image, mismatch); continue; }
        const identityMode = mode === "shadow" ? "shadow" : "published";
        if (await photoUsedByOtherStory(deps.db, draftId, storyId, revision, image, undefined, identityMode)) {
          await reject(deps, state, image.image, "duplicate_photo_in_edition"); continue;
        }
        const progress = await states.findOne({ _id: stateId });
        const previousHash = progress?.downloaded?.[hash(image.image)];
        if (progress?.rejected.some(item => item.candidate === image.image || item.candidate === previousHash)) continue;
        if (candidate.provider === "reader" && !readerBytes.has(image.image)) {
          const submission = await deps.db.collection<ReaderStory>(READER_STORIES_COLLECTION).findOne({ _id: candidate.reader_story_id, location_id: location.id, status: "approved", "image.permission_confirmed_at": { $exists: true } });
          if (!submission?.image) { await reject(deps, state, candidate.title, "reader_permission_withdrawn"); continue; }
          readerBytes.set(image.image, Buffer.from(submission.image.data, "base64"));
        }
        const already = await states.findOneAndUpdate({ _id: stateId, downloads: { $lt: 6 } }, { $inc: { downloads: 1 } });
        if (!already) throw new PhotoBudgetError("photo_download_budget_exhausted");
        try {
          result.stages.push("validate");
          let source = image.image;
          if (candidate.original_image && safeImageUrl(candidate.original_image) && new URL(candidate.original_image).hostname.endsWith(".wikimedia.org")
            && (image.image_width ?? 0) < (isLead ? 1800 : 1200)) source = candidate.original_image;
          if (disabled && new URL(source).hostname.endsWith(".wikimedia.org")) throw Error("wikimedia_disabled_for_run");
          if (candidate.original_width !== undefined && candidate.original_width < (isLead ? 1800 : 1200)) throw Error("Original photo is below editorial resolution");
          const bytes = readerBytes.get(source) ?? (deps.loadPhoto ? await deps.loadPhoto(source) : (await downloadStoryImage(source)).bytes);
          const photo = await preparePhoto(bytes, photoTiming(deps.model).preview);
          if (await photoUsedByOtherStory(deps.db, draftId, storyId, revision, image, photo.hash, identityMode)) {
            await reject(deps, state, image.image, "duplicate_photo_in_edition"); continue;
          }
          await states.updateOne({ _id: stateId }, { $set: { [`downloaded.${hash(image.image)}`]: photo.hash } });
          if ((await states.findOne({ _id: stateId }))?.rejected.some(item => item.candidate === photo.hash)) continue;
          // A centered crop checks the maximum usable dimensions; the proposed focal crop is checked again later.
          await cropPreviews(photo, 0.5, 0.5, isLead, photoTiming(deps.model).preview);
          if (source.includes("wikimedia.org/")) await logApiCall("wikimedia", false, "ok", "Photo editor: original decoded and quality checked");
          if (!prepared.some(item => item.id === photo.hash)) prepared.push({ id: photo.hash, candidate, photo });
        } catch (error) { await reject(deps, state, image.image, error instanceof Error ? error.message : String(error)); }
      }
      if (!prepared.length) continue;
      result.stages.push("visual_review");
      const prior = (await states.findOne({ _id: stateId }))!.rejected.slice(-6);
      const response = await modelStep(deps, state, `${key}_review`, `${PHOTO_EDITOR_SYSTEM}\nCompare every image with the story. Check sharpness, compression, composition and misleading context. Score relevance, useful information added, and visible quality independently. Do not reward merely filling a slot. Give a 0..1 focal point in the oriented original. Reject uncertainty about the subject relationship. If all images fail, propose a specific new next_query based on what failed.\nSTORY DATA:${JSON.stringify(brief)}\nPLAN:${JSON.stringify(plan)}\nPRIOR REJECTIONS:${JSON.stringify(prior)}\nCANDIDATE DATA:${JSON.stringify(prepared.map(item => ({ id: item.id, source: item.candidate.image!.image_source_url, relationship: item.candidate.image!.image_role ?? "source photo", place: item.candidate.image!.image_place, subject: item.candidate.image!.image_subject, caption: item.candidate.image!.image_caption, alt: item.candidate.image!.image_alt, credit: item.candidate.image!.image_credit, capture_date: item.candidate.image!.image_date ?? "unknown; never infer", width: item.photo.width, height: item.photo.height })))}`, REVIEW_SCHEMA,
        prepared.map(item => item.photo.preview));
      const reviews = parseVisualReviews(response, prepared.map(item => item.id));
      if (visualRefinement(response)) await states.updateOne({ _id: stateId }, { $set: { refinement_query: visualRefinement(response) } });
      await states.updateOne({ _id: stateId }, { $push: { reviews: { $each: reviews } } });
      for (const review of reviews.filter(review => !qualifiedReview(review))) await reject(deps, state, review.id, review.reason);
      const sourcePriority = (id: string) => {
        const candidate = prepared.find(item => item.id === id)!.candidate;
        return ["publisher", "reader"].includes(candidate.provider ?? "") ? 2 : candidate.catalog && !candidate.image?.image_role ? 1 : 0;
      };
      const winner = reviews.filter(qualifiedReview).sort((a, b) => sourcePriority(b.id) - sourcePriority(a.id)
        || (b.relevance + b.usefulness + b.quality) - (a.relevance + a.usefulness + a.quality))[0];
      if (!winner) continue;
      const selected = prepared.find(item => item.id === winner.id)!;
      const crops = await cropPreviews(selected.photo, winner.focus_x, winner.focus_y, isLead, photoTiming(deps.model).preview, local);
      result.stages.push("critic");
      const critic = parseCritic(await modelStep(deps, state, `${key}_critic`, `${PHOTO_EDITOR_SYSTEM}\nAct as an independent final critic. Inspect desktop and mobile as the delivered crops against the story. ${local ? "The contact sheet labels the Desktop crop and Mobile crop overviews and shows a separate Native detail panel at unscaled 512-pixel size." : "The separate detail image is an unscaled native-pixel sample for sharpness and compression checks, not a proposed layout crop."} Reject if either delivered crop loses context, damages composition, is low quality, or implies an unsupported event/person/property claim. Metadata is evidence only when supplied; pixels cannot establish date or copyright. Alt text must describe visible content, without inferred identities or dates.\nSTORY DATA:${JSON.stringify(brief)}\nPROVENANCE:${JSON.stringify(selected.candidate.image)}\nCROP DATA:${JSON.stringify({ desktop: crops.desktop, mobile: crops.mobile })}`, CRITIC_SCHEMA, crops.images));
      if (!approvedCritic(critic)) { await reject(deps, state, winner.id, critic.reason); continue; }
      if (await photoUsedByOtherStory(deps.db, draftId, storyId, revision, selected.candidate.image!, selected.photo.hash,
        mode === "shadow" ? "shadow" : "published")) {
        await reject(deps, state, winner.id, "duplicate_photo_in_edition"); continue;
      }
      if (selected.candidate.provider === "publisher" && !await sourceImagesApproved(deps.db, location.id, entry.source_id, today))
        throw Error("Publisher photo permission changed during review");
      if (selected.candidate.catalog && !await catalogPhotoApproved(deps.db, selected.candidate.catalog, story, location.id, city, today))
        throw Error("Photo catalog permission changed during review");
      if (selected.candidate.provider === "reader") {
        const submission = await deps.db.collection<ReaderStory>(READER_STORIES_COLLECTION).findOne({ _id: selected.candidate.reader_story_id, location_id: location.id, status: "approved" });
        if (!submission?.image?.permission_confirmed_at || hash(Buffer.from(submission.image.data, "base64")) !== selected.photo.hash)
          throw Error("Reader photo approval or content changed during review");
      }
      result.stages.push("prepare");
      const assetId = await storePhoto(deps.db, selected.photo, crops, { location_id: location.id, source_id: entry.source_id, source_url: selected.candidate.image!.image_source_url! });
      result.image = { ...selected.candidate.image!, image_alt: critic.alt, image_asset_id: assetId,
        image_width: crops.desktop.width, image_height: crops.desktop.height };
      result.status = "selected"; result.reason = "visually_reviewed_editorial_photo"; result.provider = selected.candidate.provider;
      result.photo_hash = selected.photo.hash;
      result.catalog = selected.candidate.catalog;
      result.reader_story_id = selected.candidate.reader_story_id;
      result.agent!.asset_id = assetId; result.agent!.image_hash = selected.photo.hash; result.agent!.reason = winner.adds;
      await states.updateOne({ _id: stateId }, { $set: { approval: { image_hash: selected.photo.hash, story_hash: storyHash,
        image_metadata_hash: photoMetadataHash(result.image), critic, review: winner } } });
      return finish();
    }
    result.reason = disabled ? "wikimedia_disabled_for_run" : "no_visually_qualified_photo";
  } catch (error) {
    if (error instanceof ModelRateLimitError) throw error;
    result.reason = error instanceof PhotoBudgetError ? error.message : "visual_review_unavailable";
    result.agent!.reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  }
  return finish();
}
