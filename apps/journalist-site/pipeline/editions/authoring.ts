import { VERIFICATION_POLICY } from "../model/claim-verifier";
import { storySources } from "../../../../shared/source-attribution";
/**
 * Authoring: from a run's collected items to a published edition, in bounded steps.
 *
 *   startAuthoring  assemble the pool (editions/assemble.ts): locality, merging, ledger,
 *                   sections and rule order; the draft waits for each section's ranking
 *   rankSection     one job per section: the model rates the section's top items, the v5
 *                   pass (reader interest, editor order, variety) refines them; when every
 *                   section is ranked, the top CANDIDATES_PER_SECTION per section become
 *                   candidates (at most 3 per source, at most 3 city-wide items)
 *   authorNextStory one story per job: details extraction (light model, cached, capped),
 *                   the floor rules, writing with one validation retry; sections stop once
 *                   PUBLISHED_PER_SECTION stories have passed
 *   finishAuthoring front page and email, the edition, the ledger and the edition map
 */
import { refineRanking } from "../ranking/edition-ranker";
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { Settings } from "../core/config";
import { configuredModel } from "../core/config";
import type { Logger } from "../core/log";
import type { HttpTransport } from "../core/http";
import type { LocationProfile, SourceResult } from "../connectors/types";
import { Fetcher } from "../connectors/fetcher";
import { collapse, whenWhere, weekLabel, type SourceEvent, type Story } from "./stories";
import { COLLECTIONS } from "../storage/mongo";
import type { ModelRuntime } from "../model/runtime";
import { ModelRateLimitError } from "../model/runtime";
import * as ranking from "../model/newsworthiness";
import { pythonJson } from "../model/newsworthiness";
import { hasFactualityError } from "../model/grounding";
import * as writer from "../model/story-writer";
import * as policy from "../editorial/policy";
import * as withdrawals from "../editorial/withdrawals";
import { CRISIS_LINE, floorErrors, floorFlags, floorInstructions, stripFloorDetails } from "../editorial/floor";
import { currentOptions, limits, relaxedContentAllowed, rulesOff } from "../core/run-options";
import { previewContent } from "../email/preview";
import { sourceType } from "../ranking";
import { coverageTypes, storyKinds } from "../connectors/registry";
import { assemble, collectedItems, type PoolSection, type Replication, type RunOverrides } from "./assemble";
import { preRate, rankAgreement, PRE_RANK_POLICY, type PreRank } from "../ranking/pre-ranker";
import { sourceAcceptRates } from "./story-reviews";
import { detailsText, EXTRACTION_POLICY, extractDetails, mergeDetails, saveText, type Details } from "./details";
import { contentHash, EVIDENCE_POLICY, EvidenceReader, evidenceFor, evidenceText, missingDetails, rankingDescription, selectPassages, supportedFacts } from "./evidence";
import { SECTIONS, sectionLabel, type SectionId } from "../sourcemap/sections";
import { canSpend } from "../model/budget";
import { writeEditionMap } from "./edition-map";
import { hostOf, sourceMap, reviewedLocationSources } from "../sourcemap/store";
import { ruleTier } from "../search/classifier";
import { articleImageCandidates, imagesAllowed, mainText, pageRights, rightsAction } from "../connectors/web/page";
import { normalizeStoryImage, safeImageUrl, type StoryImage } from "../../../../shared/story-image";
import { publicHttpsGet } from "../../../../shared/image-http";
import { reviewAllowsCollection } from "../sourcemap/source-review";
import { publishableStoryImage } from "../images/pipeline";
import { uniqueEditionPhotos } from "../images/uniqueness";
import { planIllustrations, ILLUSTRATION_POLICY } from "../../../../shared/editorial-illustrations";

export const DEFAULT_MODEL = "qwen3:4b";
export const VALIDATION_POLICY = `${ranking.RANKING_POLICY}+${writer.WRITING_POLICY}+${policy.POLICY}+${EVIDENCE_POLICY}+${VERIFICATION_POLICY}`;
export const WIDER_TIERS = new Set(["region", "nearby"]);
const PRIORITY_SECTIONS = new Set<string>(["safety", "obituaries", "events", "real_estate", "sports"]);
const PRIMARY_TIERS = new Set(["official", "organisation", "business"]);
export const STORY_DETAILS = "story_details";
export const STORY_IMAGES = "story_images";
export type AuthoringDeps = { db: Db; model: ModelRuntime; rankingModel?: ModelRuntime; lightModel?: ModelRuntime; settings: Settings; log: Logger; transport?: HttpTransport };
export type AuthoringInput = { location: LocationProfile; runId: string; today: string; window: [string, string]; sourceResults: SourceResult[]; overrides?: RunOverrides };
export type RankedCandidate = ranking.Candidate & { rating: ranking.Rating; score: number; rated_by: "model" | "rule" | "pre_ranker"; rank: number; section_rank: number; source_id: string; source_type: string; tier: string; section: SectionId; explain?: unknown };
type EditionPayload = { id: string; location_id: string; location_name: string; window_start: string; window_end: string; published_at: number; headline: string; intro: string; items: Array<Record<string, any>>; coverage: string[]; corrections: Array<{ story_id: string; reason: string; created_at: number }> };
type EntryDoc = { id: string; edition_id: string; position: number; disposition: string; story_id: string; source_id: string; source_type: string; tier: string; section: SectionId; event_date: string; result: Record<string, any> };
export type DraftDoc = {
  id: string; run_id: string; location_id: string; location_name: string; today: string; window_start: string; window_end: string; status: string; created_at: number;
  model: string; provider: string; validation_policy: string; published?: EditionPayload; email_preview?: { subject: string; text: string; html: string }; summary?: Record<string, unknown>;
  events: SourceEvent[]; source_results: SourceResult[]; candidates: RankedCandidate[]; pool_sections: PoolSection[]; section_rankings: Record<string, RankedCandidate[]>;
  tokens: Record<string, string[]>; funnel: Record<string, number>; ranking: Record<string, unknown>; event_count: number; story_count: number; started_at_ms: number; [key: string]: unknown;
};

/** Repeating items print as compact lists: separate stories would crowd the edition and cost far more model calls. */
export const DIGEST_KINDS = new Set(["home_sale", "building_permit", "game_result", "obituary"]);
function digestDraft(story: Story): writer.ItemDraft {
  const description = story.description ?? "";
  // Strict death notices print the name, dates and service details, with a link to the original.
  const summary = story.kind === "obituary" && !rulesOff("topic_content")
    ? description.split(/(?<=[.!?])\s+/).filter((sentence) => /\b(born|died|passed|service|memorial|funeral|celebration|visitation|\d{4})\b/i.test(sentence)).slice(0, 3).join(" ") || story.title
    : description || story.title;
  return { headline: story.title.slice(0, writer.HEADLINE_MAX), summary };
}
function community(name: string) { return name.split(",")[0]; }
function storyCandidates(stories: Story[]) { return stories.map((story) => ({ id: story.id, title: story.title, description: rankingDescription(story), occurrences: story.scheduledOccurrences.length, venues: story.venues, first_date: story.first.event_date, kind: story.kind, tier: String(story.facts.tier ?? "local") })); }
function recordStory(story: Story) { return { id: story.id, title: story.title, description: story.description, kind: story.kind, legacy_story_id: story.facts.legacy_story_id ?? null, occurrences: story.occurrences.map((item) => ({ ...item })) }; }
const SECTION_ORDER = new Map(SECTIONS.map((section, index) => [section.id as string, index]));
function heldReasons(entries: Array<{ disposition: string; result: Record<string, any> }>) {
  const counts: Record<string, number> = {};
  for (const entry of entries) if (entry.disposition === "held") for (const error of (entry.result.validation_errors?.length ? entry.result.validation_errors : entry.result.error ? [entry.result.error] : [])) counts[error] = (counts[error] ?? 0) + 1;
  return counts;
}
function cacheKey(settings: Settings, locationId: string, candidate: writer.StoryInput & { venues: string[] }) {
  // The profile is part of the key, so an exploration draft is never reused by a strict run.
  const values = { title: candidate.title, description: candidate.description ?? null, venues: candidate.venues, kind: candidate.kind ?? "event", as_of: candidate.as_of ?? null, source_date: candidate.source_date ?? null, floor_flags: candidate.floor_flags ?? null, people: candidate.people ?? [], verification_sources: candidate.verification_sources ?? [], ...(rulesOff("quality") || rulesOff("sensitive") || rulesOff("topic_content") || relaxedContentAllowed() ? { loosened: true } : {}) };
  const sortedContent = Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  const key = createHash("sha256").update(pythonJson([configuredModel(settings) || DEFAULT_MODEL, VALIDATION_POLICY, sortedContent])).digest("hex");
  return `${locationId}:${key}`;
}
async function checkedItem(deps: AuthoringDeps, candidate: writer.StoryInput & { community_id: string; venues: string[] }) {
  const key = cacheKey(deps.settings, candidate.community_id, candidate);
  const cached = await deps.db.collection(COLLECTIONS.storyCache).findOne({ cache_key: key });
  if (cached?.result?.draft && cached.result.verification?.policy === VERIFICATION_POLICY && cached.result.verification.checks_passed === true && writer.validateItem(candidate, cached.result.draft).length === 0) return { ...cached.result, cache_hit: true, wall_seconds: 0 };
  const result = await writer.writeItem(deps.model, candidate, { verify: true });
  if (result.disposition === "checks_passed") await deps.db.collection(COLLECTIONS.storyCache).updateOne({ cache_key: key }, { $set: { cache_key: key, location_id: candidate.community_id, result } }, { upsert: true });
  return { ...result, cache_hit: false };
}
async function getEntries(db: Db, draftId: string) { return db.collection<EntryDoc>(COLLECTIONS.editionEntries).find({ edition_id: draftId }).sort({ position: 1 }).toArray(); }
function drafts(db: Db) { return db.collection<DraftDoc>(COLLECTIONS.editions); }

/** Create the assembled, persisted state for a resumable edition. Returns the draft id and the sections to rank. */
export async function startAuthoring(deps: AuthoringDeps, input: AuthoringInput) {
  const old = await drafts(deps.db).findOne({ run_id: input.runId });
  if (old) return { id: old.id, sections: old.pool_sections.filter((section) => !old.section_rankings?.[section.id]).map((section) => section.id) };
  const start = Date.now();
  const transport = deps.transport ?? (await import("../core/http")).fetchTransport;
  const pool = await assemble({ db: deps.db, settings: deps.settings, transport, fetcher: new Fetcher(transport), location: input.location, today: input.today, log: deps.log, runId: input.runId, overrides: input.overrides });
  const id = input.runId;
  const doc: DraftDoc = {
    id, run_id: input.runId, location_id: input.location.id, location_name: input.location.name, today: input.today, window_start: input.window[0], window_end: input.window[1],
    status: pool.sections.length ? "ranking" : "ready", created_at: Date.now() / 1000, model: deps.model.model ?? configuredModel(deps.settings) ?? DEFAULT_MODEL, provider: deps.model.provider,
    validation_policy: VALIDATION_POLICY, events: pool.events, source_results: input.sourceResults, candidates: [], pool_sections: pool.sections, section_rankings: {},
    tokens: pool.tokens, funnel: pool.funnel, ranking: {}, event_count: pool.funnel.items_collected, story_count: pool.funnel.after_merge, started_at_ms: start,
    attempted: 0, held: 0, held_reasons: {}, model_errors: [],
  };
  await drafts(deps.db).insertOne(doc);
  await writeEditionMap(deps.db, input.runId).catch((error) => deps.log.warn("edition_map_failed", { run_id: input.runId, error: String(error) }));
  deps.log.info("Edition assembled", { edition_id: id, location_id: input.location.id, ...pool.funnel, sections: pool.sections.map((section) => `${section.id}:${section.stories.length}`) });
  return { id, sections: pool.sections.map((section) => section.id) };
}

/** Rank one section; when the last section is ranked, choose the candidates. Returns whether candidates are ready. */
export async function rankSection(deps: AuthoringDeps, draftId: string, sectionId: string) {
  const draft = await drafts(deps.db).findOne({ id: draftId });
  if (!draft) throw new Error(`No authoring draft: ${draftId}`);
  if (draft.status !== "ranking") return { ready: draft.status !== "ranking" };
  if (!draft.section_rankings?.[sectionId]) {
    const section = draft.pool_sections.find((item) => item.id === sectionId);
    const ids = new Set(section?.stories ?? []);
    const stories = collapse(draft.events).filter((story) => ids.has(story.id));
    const withdrawn = await withdrawals.forLocation(deps.db, draft.location_id);
    const active = stories.filter((story) => !withdrawals.matching(story, withdrawn).length);
    const positions = new Map((section?.stories ?? []).map((id, index) => [id, index]));
    active.sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0));
    const transport = deps.transport ?? (await import("../core/http")).fetchTransport;
    await new EvidenceReader(deps.db, transport, deps.log).enrich(active);
    const evidenceFields: Record<string, unknown> = {};
    for (const story of active) {
      const index = draft.events.findIndex((event) => event.facts === story.facts);
      if (index >= 0) evidenceFields[`events.${index}.facts.evidence`] = evidenceFor(story);
      await collectedItems(deps.db).updateMany({ run_id: draft.run_id, story_id: story.id }, { $set: { evidence: evidenceFor(story) } });
    }
    if (Object.keys(evidenceFields).length) await drafts(deps.db).updateOne({ id: draftId }, { $set: evidenceFields });
    const rankingModel = deps.rankingModel ?? deps.model;
    // The local pre-ranker rates every story in shadow, and stands in where the model gives no rating.
    const rates = await sourceAcceptRates(deps.db, draft.location_id).catch(() => undefined);
    const preRanks = new Map<string, PreRank>(active.map((story) => [story.id, preRate({
      id: story.id, title: story.title, description: story.description, kind: story.kind, tier: String(story.facts.tier ?? "local"),
      source_tier: story.facts.source_tier as string | undefined, section: sectionId, first_date: story.first.event_date, occurrences: story.scheduledOccurrences.length,
      independent: (story.facts.replication as Replication | undefined)?.independent ?? 1, update_of: story.facts.update_of, source_id: story.first.source_id,
    }, { today: draft.today, sourceRates: rates })]));
    const [rated, report] = await ranking.rank(rankingModel, storyCandidates(active), (candidate) => preRanks.get(candidate.id)!.rating);
    const modelRated = rated.filter((item) => item.rated_by === "model");
    const preTop = new Set([...modelRated].sort((a, b) => preRanks.get(b.id)!.score - preRanks.get(a.id)!.score).slice(0, 5).map((item) => item.id));
    report.pre_ranker = {
      policy: PRE_RANK_POLICY, filled_in: rated.length - modelRated.length, compared: modelRated.length,
      agreement: rankAgreement(modelRated.map((item) => item.score), modelRated.map((item) => preRanks.get(item.id)!.score)),
      mean_abs_diff: modelRated.length ? Math.round(modelRated.reduce((sum, item) => sum + Math.abs(item.score - preRanks.get(item.id)!.score), 0) / modelRated.length * 100) / 100 : null,
      top5_overlap: modelRated.length ? [...modelRated].sort((a, b) => b.score - a.score).slice(0, 5).filter((item) => preTop.has(item.id)).length : null,
    };
    // The rule order (locality strength, freshness, detail, source record, pins) breaks ties and lifts pinned sources.
    const ruleScores = new Map((await collectedItems(deps.db).find({ run_id: draft.run_id, section: sectionId as SectionId, status: "pooled" }, { projection: { story_id: 1, score: 1 } }).toArray()).map((item) => [item.story_id, Number(item.score ?? 0)]));
    for (const item of rated) item.score = Math.round((item.score + 0.5 * (ruleScores.get(item.id) ?? 0)) * 1000) / 1000;
    rated.sort((a, b) => b.score - a.score);
    const byId = new Map(active.map((story) => [story.id, story]));
    const [refined, refinement] = await refineRanking(deps.db, rankingModel, rated, {
      runId: `${draft.run_id}:${sectionId}`, locationId: draft.location_id, community: draft.location_name,
      sourceTypes: new Map(active.map((story) => [story.id, sourceType(story.first.source_id)])),
      sourceIds: new Map(active.map((story) => [story.id, story.first.source_id])),
    });
    const ranked = refined.map((candidate, index) => {
      const story = byId.get(candidate.id)!;
      return { ...candidate, rank: 0, section_rank: index + 1, source_id: story.first.source_id, source_type: sourceType(story.first.source_id), tier: String(story.facts.tier ?? "local"), section: sectionId as SectionId } as RankedCandidate;
    });
    await drafts(deps.db).updateOne({ id: draftId }, { $set: { [`section_rankings.${sectionId}`]: ranked, [`ranking.${sectionId}`]: { ...report, refinement, provider: rankingModel.provider, model: rankingModel.model } } });
    for (const candidate of ranked) {
      const pre = preRanks.get(candidate.id);
      await collectedItems(deps.db).updateMany({ run_id: draft.run_id, story_id: candidate.id }, { $set: {
        rank: candidate.section_rank, score: (candidate.explain as { final?: number } | undefined)?.final ?? candidate.score,
        why: `${candidate.rated_by === "pre_ranker" ? "pre-ranker (no model rating): " : ""}${candidate.rating.category.replace(/_/g, " ")}; civic ${candidate.rating.civic}, appeal ${candidate.rating.appeal}, special ${candidate.rating.special}`,
        model_rating: { rated_by: candidate.rated_by, category: candidate.rating.category, civic: candidate.rating.civic, appeal: candidate.rating.appeal, special: candidate.rating.special },
        ...(pre ? { pre_rank: { score: pre.score, civic: pre.rating.civic, appeal: pre.rating.appeal, special: pre.rating.special, rules: pre.rules, policy: pre.policy } } : {}),
      } });
    }
  }
  const refreshed = (await drafts(deps.db).findOne({ id: draftId }))!;
  if (refreshed.pool_sections.some((section) => !refreshed.section_rankings?.[section.id])) return { ready: false };
  // Every section is ranked: choose candidates.
  const candidates: RankedCandidate[] = [];
  const caps = limits();
  let wider = 0;
  for (const section of SECTIONS) {
    const ranked = refreshed.section_rankings[section.id] ?? [];
    const perSource = new Map<string, number>();
    let taken = 0;
    // A priority topic has its own allowance, so general city news can't use it up first.
    let sectionWider = 0;
    const priority = PRIORITY_SECTIONS.has(section.id);
    for (const candidate of ranked) {
      if (taken >= caps.candidatesPerSection) break;
      if ((perSource.get(candidate.source_id) ?? 0) >= caps.perSourceInSection) { await notSelected(deps.db, refreshed.run_id, candidate.id, `more than ${caps.perSourceInSection} from one source in this section`); continue; }
      if (WIDER_TIERS.has(candidate.tier)) {
        if ((priority ? sectionWider : wider) >= caps.widerItems) { await notSelected(deps.db, refreshed.run_id, candidate.id, `more than ${caps.widerItems} city-wide items`); continue; }
        if (priority) sectionWider += 1; else wider += 1;
      }
      perSource.set(candidate.source_id, (perSource.get(candidate.source_id) ?? 0) + 1);
      taken += 1;
      candidates.push(candidate);
      await collectedItems(deps.db).updateMany({ run_id: refreshed.run_id, story_id: candidate.id }, { $set: { status: "candidate", step: "ranking" } });
    }
    for (const candidate of ranked.slice(taken)) {
      if (!candidates.includes(candidate)) await notSelected(deps.db, refreshed.run_id, candidate.id, `ranked below the section's top ${caps.candidatesPerSection}`, true);
    }
  }
  // A run's story limit keeps the best of every section, section by section.
  const storyLimit = currentOptions().story_limit;
  if (storyLimit && candidates.length > storyLimit) {
    const kept = [...candidates].sort((a, b) => a.section_rank - b.section_rank).slice(0, storyLimit);
    for (const candidate of candidates.filter((item) => !kept.includes(item))) await notSelected(deps.db, refreshed.run_id, candidate.id, `over this run's limit of ${storyLimit} stories`);
    candidates.splice(0, candidates.length, ...candidates.filter((item) => kept.includes(item)));
  }
  // The edition leads with local stories from primary sources, then priority topics, each in its
  // section's order. Original local reporting follows; wider news comes last.
  const tiers = new Map((await sourceMap(deps.db).find({ location_id: refreshed.location_id }, { projection: { source_id: 1, source_tier: 1, url: 1, name: 1, "found_by.method": 1 } }).toArray()).map((record) => [record.source_id, record.source_tier ?? (["newsrooms", "publishers"].includes(record.found_by?.method) ? "local_reporting" : record.url ? ruleTier(record.url, record.name) : "official")]));
  const lead = (candidate: RankedCandidate) => (candidate.tier === "local" ? 4 : 0) + (PRIMARY_TIERS.has(String(tiers.get(candidate.source_id))) ? 2 : 0) + (PRIORITY_SECTIONS.has(candidate.section) ? 1 : 0);
  candidates.sort((a, b) => lead(b) - lead(a) || a.section_rank - b.section_rank);
  candidates.forEach((candidate, index) => { candidate.rank = index + 1; });
  await drafts(deps.db).updateOne({ id: draftId }, { $set: { candidates, status: candidates.length ? "drafting" : "ready" } });
  await writeEditionMap(deps.db, refreshed.run_id).catch(() => undefined);
  deps.log.info("Edition candidates chosen", { edition_id: draftId, candidates: candidates.length, sections: refreshed.pool_sections.length });
  return { ready: true };
}
async function notSelected(db: Db, runId: string, storyId: string, reason: string, onlyIfPooled = false) {
  await collectedItems(db).updateMany({ run_id: runId, story_id: storyId, ...(onlyIfPooled ? { status: "pooled" as const } : {}) }, { $set: { status: "not_selected", reason, step: "ranking" } });
}

type ImageDoc = { _id: string; images: StoryImage[]; checked_at: number };
/** Covers the article, robots.txt and every redirect request issued by Fetcher. */
function guardedPageTransport(injected?: HttpTransport): HttpTransport {
  const transport = injected ?? publicHttpsGet;
  return async (request) => {
    const url = safeImageUrl(request.url);
    if (!url) throw new Error("Article image metadata requires a public HTTPS URL");
    return transport({ ...request, url, timeoutMs: 8000 });
  };
}
/** Image discovery has its own cache and budget; it never depends on an available LLM. */
export async function storyImages(deps: Pick<AuthoringDeps, "db" | "transport">, locationId: string, story: Story): Promise<StoryImage[]> {
  if (story.facts.link_only || story.facts.image_blocked) return [];
  const fallback = { source_url: story.first.source_url, source_name: typeof story.facts.source_name === "string" ? story.facts.source_name : story.first.venue };
  const details = story.facts.details as Record<string, unknown> | undefined;
  const values = [story.facts.details, ...(Array.isArray(details?.image_candidates) ? details.image_candidates.slice(0, 4) : [])];
  const normalize = (values: unknown[]) => [...new Map(values.map(value => normalizeStoryImage(value, fallback))
    .filter((image): image is StoryImage => Boolean(image)).map(image => [image.image, image])).values()].slice(0, 4);
  const collected = normalize(values);
  if (collected.length) return collected;
  if (story.facts.no_page_fetch) return [];
  const url = safeImageUrl(story.first.source_url);
  if (!url) return [];
  const key = `${locationId}:${story.id}:images_v4:${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
  const collection = deps.db.collection<ImageDoc>(STORY_IMAGES);
  const cached = await collection.findOne({ _id: key }).catch(() => null);
  const ttl = cached?.images?.length ? 7 * 86400_000 : 3600_000;
  if (cached && Date.now() - cached.checked_at < ttl) {
    return normalize(cached.images);
  }
  let images: StoryImage[] = [];
  try {
    const response = await new Fetcher(guardedPageTransport(deps.transport)).getResponse(url, 1024 * 1024, "text/html, application/xhtml+xml");
    const html = new TextDecoder().decode(response.body);
    const flags = pageRights(response.headers, html);
    if (rightsAction(flags) === "ok") {
      if (imagesAllowed(flags)) images = normalize(articleImageCandidates(html, response.url, story.title));
      await saveText(deps.db, response.url, mainText(html)).catch(() => undefined);
    }
  } catch { /* Image metadata failures leave the validated story eligible for publication. */ }
  await collection.updateOne({ _id: key }, { $set: { images, checked_at: Date.now() } }, { upsert: true }).catch(() => undefined);
  return images;
}

export async function storyImage(deps: Pick<AuthoringDeps, "db" | "transport">, locationId: string, story: Story): Promise<StoryImage | null> {
  return (await storyImages(deps, locationId, story))[0] ?? null;
}

/** Details for a story: cached per story; extracted by the light model while the daily cap allows. */
async function storyDetails(deps: AuthoringDeps, draft: DraftDoc, story: Story): Promise<Details> {
  const ruleDetails = mergeDetails({ ...(story.facts.details as Partial<Details> | undefined), image: null });
  if (story.facts.link_only || story.facts.no_page_fetch) return ruleDetails;
  if (!evidenceFor(story)) {
    const transport = deps.transport ?? (await import("../core/http")).fetchTransport;
    await new EvidenceReader(deps.db, transport, deps.log).enrich([story]);
  }
  const packet = evidenceFor(story)!;
  const text = evidenceText(packet);
  const hash = contentHash(JSON.stringify([story.title, story.description, ruleDetails, text]));
  const key = `${draft.location_id}:${story.id}:${EXTRACTION_POLICY}`;
  const cached = await deps.db.collection<{ _id: string; details: Details; content_hash?: string }>(STORY_DETAILS).findOne({ _id: key });
  if (cached?.content_hash === hash) {
    packet.extraction = "complete";
    return mergeDetails(ruleDetails, { ...cached.details, image: null });
  }
  if (!deps.lightModel) { packet.extraction = "model_unavailable"; return ruleDetails; }
  if (!(await canSpend(deps.db, deps.settings))) { packet.extraction = "budget_exhausted"; return ruleDetails; }
  let details: Details;
  try {
    const extracted = await extractDetails(deps.lightModel, story, text, community(draft.location_name));
    const { section: _section, ...values } = extracted;
    details = values;
  } catch (error) {
    if (error instanceof ModelRateLimitError) throw error;
    packet.extraction = "failed";
    packet.extraction_error = error instanceof Error ? error.message : String(error);
    deps.log.warn("details_extraction_failed", { story_id: story.id, error: error instanceof Error ? error.message : String(error) });
    return ruleDetails;
  }
  await deps.db.collection<{ _id: string; details: Details; at: number; content_hash: string }>(STORY_DETAILS).updateOne({ _id: key }, { $set: { details, at: Date.now() / 1000, content_hash: hash } }, { upsert: true });
  packet.extraction = "complete";
  return mergeDetails(ruleDetails, details);
}

/** Persist exactly one candidate result, including its one validation retry, per invocation. */
export async function authorNextStory(deps: AuthoringDeps, draftId: string) {
  const collection = drafts(deps.db);
  const draft = await collection.findOne({ id: draftId });
  if (!draft) throw new Error(`No authoring draft: ${draftId}`);
  if (draft.status !== "drafting") return { more: false, done: true };
  const entries = await getEntries(deps.db, draftId);
  const caps = limits();
  const doneIds = new Set(entries.map((entry) => entry.story_id));
  const passedBySection = new Map<string, number>();
  for (const entry of entries) if (entry.disposition === "checks_passed") passedBySection.set(entry.section, (passedBySection.get(entry.section) ?? 0) + 1);
  const pendingOf = (done: Set<string>, passed: Map<string, number>) => draft.candidates
    .filter((candidate) => !done.has(candidate.id) && (passed.get(candidate.section) ?? 0) < caps.publishedPerSection)
    .sort((a, b) => (SECTION_ORDER.get(a.section) ?? 99) - (SECTION_ORDER.get(b.section) ?? 99) || a.section_rank - b.section_rank);
  const pending = pendingOf(doneIds, passedBySection);
  if (!pending.length) {
    await collection.updateOne({ id: draftId }, { $set: { status: "ready", attempted: entries.length, held: entries.filter((entry) => entry.disposition === "held").length, held_reasons: heldReasons(entries) } });
    return { more: false, done: true };
  }
  const candidate = pending[0];
  const story = collapse(draft.events).find((item) => item.id === candidate.id);
  if (!story) throw new Error(`Story no longer exists in draft: ${candidate.id}`);
  // Digest kinds print as compact list entries from their source facts, with no model call.
  const digest = DIGEST_KINDS.has(story.kind) ? digestDraft(story) : null;
  const details = digest ? mergeDetails(story.facts.details as Details | undefined) : await storyDetails(deps, draft, story);
  const packet = digest ? null : evidenceFor(story)!;
  if (packet) {
    packet.missing = missingDetails(details);
    packet.facts = supportedFacts(details, packet);
    await collectedItems(deps.db).updateMany({ run_id: draft.run_id, story_id: story.id }, { $set: { evidence: packet } });
  }
  const rawText = packet ? evidenceText(packet) : "";
  const flags = floorFlags({ title: story.title, description: `${story.description ?? ""} ${details.what.join(" ")} ${rawText}`, kind: story.kind });
  const strictFlags = floorFlags({ title: story.title, description: `${story.description ?? ""} ${details.what.join(" ")} ${rawText}`, kind: story.kind }, true);
  const usableText = flags.withholdNames || flags.blockAddresses || flags.suicide ? "" : rawText;
  const enriched = selectPassages([detailsText(details, { withholdPeople: flags.withholdNames }), story.description ?? "", usableText].filter(Boolean).join("\n")).join("\n");
  // Strict sports coverage stays positive about students; exploration prints what's available.
  const sportsRule = candidate.section === "sports" && !rulesOff("topic_content") ? " Name students only for a win, award or honour. Leave out injuries and discipline." : "";
  const candidateForWrite = {
    ...candidate, description: enriched, as_of: draft.today, source_date: story.first.event_date, community_id: draft.location_id, venues: story.venues,
    verification_sources: [
      { id: "source-record", url: story.first.source_url, text: [story.title, story.description ?? "", whenWhere(story)].join("\n") },
      ...(usableText ? (packet?.sources ?? []).filter(source => source.passages.length).map((source, index) => ({ id: `source-page-${index}`, url: source.final_url ?? source.url, text: source.passages.join("\n") })) : []),
    ],
    floor_flags: flags, floor_instructions: `${floorInstructions(flags)}${sportsRule}`, people: details.people, update_of: story.facts.update_of ?? null,
  };
  const eligibility = [...new Set([...policy.errors(candidateForWrite), ...policy.eventDateErrors({ ...story, first_date: story.first.event_date })])].concat(policy.sourceErrors(story.occurrences.map((item) => item.source_url)));
  const existingWithdrawals = await withdrawals.forLocation(deps.db, draft.location_id);
  const withdrawn = withdrawals.matching(story, existingWithdrawals).length > 0;
  const blockedByRules: string[] = [];
  let result: Record<string, any>;
  if (withdrawn) result = { disposition: "held", checks_passed: false, validation_errors: [...eligibility, "previously_withdrawn"], attempts: 0, wall_seconds: 0 };
  else if (Array.isArray(story.facts.merge_conflicts) && story.facts.merge_conflicts.length) result = { disposition: "held", checks_passed: false, validation_errors: story.facts.merge_conflicts, attempts: 0, wall_seconds: 0 };
  else if (eligibility.includes("conflicting_event_dates") || eligibility.length && !rulesOff("quality")) result = { disposition: "held", checks_passed: false, validation_errors: eligibility, attempts: 0, wall_seconds: 0 };
  else if (digest) result = { disposition: "checks_passed", checks_passed: true, draft: digest, digest: true, validation_errors: [], attempts: 0, wall_seconds: 0 };
  else {
    if (eligibility.length) blockedByRules.push(...eligibility.map((error) => `eligibility:${error}`));
    result = await checkedItem(deps, candidateForWrite);
  }
  // Exploration: run a story that failed a check, with minors' and victims' names and suicide method removed.
  if (rulesOff("quality") && result.disposition === "held" && result.draft && !hasFactualityError(result.validation_errors ?? [])) {
    blockedByRules.push(...((result.validation_errors as string[] | undefined) ?? []));
    result = { ...result, disposition: "checks_passed", checks_passed: true, draft: { ...result.draft, ...stripFloorDetails(result.draft, flags, details.people) }, flagged_errors: result.validation_errors, validation_errors: [] };
  }
  if (result.draft && rulesOff("sensitive") && strictFlags.blockAddresses && floorErrors(result.draft, strictFlags, details.people).includes("floor:house_number")) blockedByRules.push("floor:house_number");
  if (blockedByRules.length) await collectedItems(deps.db).updateMany({ run_id: draft.run_id, story_id: story.id }, { $addToSet: { would_have_blocked: { $each: blockedByRules } } });
  if (result.disposition === "checks_passed" && result.draft) {
    if (story.facts.update_of && !/^update:/i.test(result.draft.headline) && result.draft.headline.length <= writer.HEADLINE_MAX - 8) result.draft = { ...result.draft, headline: `Update: ${result.draft.headline}` };
    if (flags.suicide) result.draft = { ...result.draft, summary: `${result.draft.summary} ${CRISIS_LINE}` };
  }
  Object.assign(result, {
    story: recordStory(story), writing_source: { id: candidateForWrite.id, title: candidateForWrite.title, description: candidateForWrite.description, venues: candidateForWrite.venues, kind: candidateForWrite.kind }, details, floor: flags,
    ranking: { rank: candidate.rank, section_rank: candidate.section_rank, score: candidate.score, rated_by: candidate.rated_by, ...candidate.rating, ...(candidate.explain ? { explain: candidate.explain } : {}) },
    when_where: whenWhere(story), source_url: story.first.source_url, tier: candidate.tier, section: candidate.section, also_from: story.facts.also_from ?? [],
    sources: storySources([
      ...story.occurrences.map((item) => ({ url: item.source_url, name: item.source_name ?? draft.source_results.find((source) => source.source_id === item.source_id)?.name ?? hostOf(item.source_url) ?? "Local source" })),
      ...(packet?.sources ?? []).filter((source) => source.passages.length > 0).map((source) => ({ url: source.final_url ?? source.url, name: hostOf(source.final_url ?? source.url) ?? "Supporting source" })),
    ]),
    image_caption: story.facts.image_caption ?? null, image_credit: story.facts.image_credit ?? null,
  });
  const position = entries.length;
  await deps.db.collection(COLLECTIONS.editionEntries).updateOne({ id: `${draftId}:${candidate.id}` }, { $set: { id: `${draftId}:${candidate.id}`, edition_id: draftId, position, story_id: story.id, source_id: story.first.source_id, source_type: candidate.source_type, tier: candidate.tier, section: candidate.section, event_date: story.first.event_date, disposition: result.disposition, result } }, { upsert: true });
  await collectedItems(deps.db).updateMany({ run_id: draft.run_id, story_id: story.id }, { $set: { status: result.disposition === "held" ? "held" : "candidate", step: "authoring", ...(result.disposition === "held" ? { reason: `held: ${(result.validation_errors ?? [result.error]).filter(Boolean).join(", ")}` } : {}) } });
  const refreshed = await getEntries(deps.db, draftId);
  const passedAfter = new Map<string, number>();
  for (const entry of refreshed) if (entry.disposition === "checks_passed") passedAfter.set(entry.section, (passedAfter.get(entry.section) ?? 0) + 1);
  const more = pendingOf(new Set(refreshed.map((entry) => entry.story_id)), passedAfter).length > 0;
  const errors = result.error ? [...((draft.model_errors as string[]) ?? []), String(result.error)] : (draft.model_errors as string[] ?? []);
  await collection.updateOne({ id: draftId }, { $set: { status: more ? "drafting" : "ready", attempted: refreshed.length, held: refreshed.filter((entry) => entry.disposition === "held").length, held_reasons: heldReasons(refreshed), model_errors: errors } });
  deps.log.info("Edition item", { edition_id: draftId, story_id: story.id, section: candidate.section, rank: candidate.section_rank, score: candidate.score, details: details.extracted ? "extracted" : "rules", floor: flags.reason, attempts: result.attempts, disposition: result.disposition, errors: result.validation_errors ?? result.error, wall_seconds: result.wall_seconds });
  return { more, done: !more, candidate: candidate.id, result };
}

export function editionCoverage(sourceResults: SourceResult[]) {
  const lines = sourceResults.filter((item) => item.status !== "ingested").length
    ? [`${sourceResults.filter((item) => item.status !== "ingested").length} of ${sourceResults.length} sources had nothing usable this week; see where this news comes from for details.`] : [];
  if (!sourceResults.length) lines.push("Source coverage was not recorded for this edition.");
  const ran = (type: string) => sourceResults.some((item) => item.source_id.startsWith(`${type}:`));
  const labels = (group: "local" | "wider" | "parents") => [...new Set(coverageTypes(group).filter((connector) => ran(connector.type)).map((connector) => connector.meta.coverage.label))];
  const covered = [...labels("local"), ...labels("parents"), ...labels("wider")];
  lines.unshift(`Gathered from ${sourceResults.length} sources: ${covered.join(", ") || "none"}.`);
  return lines;
}
function validEditionShape(value: any) {
  const kinds = storyKinds();
  const itemValid = (item: any) => typeof item.story_id === "string" && typeof item.headline === "string" && typeof item.blurb === "string" && typeof item.when_where === "string" && typeof item.event_date === "string" && (typeof item.source_url === "string" || item.source_url === null) && (Number.isInteger(item.rank) || item.rank === null) && kinds.has(item.kind) && typeof item.source_name === "string" && (typeof item.section === "string" || item.section === null) && typeof item.local === "boolean";
  const correctionValid = (item: any) => typeof item.story_id === "string" && typeof item.reason === "string" && typeof item.created_at === "number";
  const coverageValid = !("coverage" in value) || (Array.isArray(value.coverage) && value.coverage.every((line: unknown) => typeof line === "string"));
  const correctionsValid = !("corrections" in value) || (Array.isArray(value.corrections) && value.corrections.every(correctionValid));
  return typeof value.id === "string" && typeof value.location_id === "string" && typeof value.location_name === "string" && typeof value.window_start === "string" && typeof value.window_end === "string" && typeof value.published_at === "number" && typeof value.headline === "string" && typeof value.intro === "string" && Array.isArray(value.items) && value.items.every(itemValid) && coverageValid && correctionsValid;
}
export async function finishAuthoring(deps: AuthoringDeps, draftId: string) {
  const collection = drafts(deps.db);
  const draft = await collection.findOne({ id: draftId });
  if (!draft) throw new Error(`No authoring draft: ${draftId}`);
  if (draft.status === "built" || draft.status === "published") return { edition: draft.published, emailPreview: draft.email_preview, summary: draft.summary, tokens: draft.tokens };
  if (draft.status !== "ready") return { done: false, more: true };
  let entries = await getEntries(deps.db, draftId);
  const reviewed = await reviewedLocationSources(deps.db, draft.location_id);
  const holds = new Map(reviewed.filter((source) => !reviewAllowsCollection(source.access_review, new Date().toISOString().slice(0, 10)))
    .map((source) => [source.source_id, source.access_review!.reason]));
  let newlyHeld = 0;
  for (const entry of entries) {
    if (entry.disposition !== "checks_passed" || !holds.has(entry.source_id)) continue;
    await deps.db.collection(COLLECTIONS.editionEntries).updateOne({ edition_id: draftId, story_id: entry.story_id, disposition: "checks_passed" }, {
      $set: { disposition: "held", "result.disposition": "held", "result.checks_passed": false,
        "result.validation_errors": [...(entry.result.validation_errors ?? []), `source_access_review:${holds.get(entry.source_id)}`] },
    });
    newlyHeld++;
  }
  if (newlyHeld) entries = await getEntries(deps.db, draftId);
  const perSection = new Map<string, number>();
  const caps = limits();
  const passed = entries.filter((entry) => entry.disposition === "checks_passed")
    .sort((a, b) => (SECTION_ORDER.get(a.section) ?? 99) - (SECTION_ORDER.get(b.section) ?? 99) || Number(a.result.ranking.section_rank) - Number(b.result.ranking.section_rank))
    .filter((entry) => { const count = perSection.get(entry.section) ?? 0; perSection.set(entry.section, count + 1); return count < caps.publishedPerSection; });
  if (newlyHeld && !passed.length) throw new Error("Source access review prevents publication: no permitted validated stories remain");
  // The front page leads with the strongest story overall.
  const lead = [...passed].sort((a, b) => Number(b.result.ranking.score) - Number(a.result.ranking.score))[0];
  const ordered = lead ? [lead, ...passed.filter((entry) => entry !== lead)] : passed;
  const itemStories = ordered.map((entry) => (entry.result.writing_source ?? entry.result.story) as writer.StoryInput);
  const itemDrafts = ordered.map((entry) => entry.result.draft as writer.ItemDraft);
  const week = weekLabel(draft.window_start, draft.window_end);
  const front = await writer.writeFront(deps.model, community(draft.location_name), week, itemStories, itemDrafts);
  const email = await writer.writeEmail(deps.model, community(draft.location_name), week, itemStories, itemDrafts, { headline: String(front.headline), intro: String(front.intro) });
  const now = Date.now() / 1000;
  const sourceName = (sourceId: string, url?: string | null) => (sourceId.startsWith("sweep:") ? hostOf(url) : null) || (draft.source_results.find((result) => result.source_id === sourceId)?.name ?? "Local source");
  const illustrated = currentOptions().image_mode === "illustrated";
  const approvedImages = illustrated ? new Map<string, StoryImage | null>() : new Map(await Promise.all(ordered.map(async (entry) => [entry.story_id,
    await publishableStoryImage(deps.db, draftId, entry.story_id, draft.location_id, entry.source_id, undefined, entry === lead)] as const)));
  const items = await uniqueEditionPhotos(deps.db, ordered.map((entry, index) => ({
    story_id: entry.result.story.id, ...(entry.result.story.legacy_story_id ? { legacy_story_id: entry.result.story.legacy_story_id } : {}), headline: entry.result.draft.headline, blurb: entry.result.draft.summary, when_where: entry.result.when_where, event_date: entry.event_date,
    source_url: entry.result.source_url ?? null, rank: index + 1, kind: entry.result.story.kind ?? "event", source_name: sourceName(entry.source_id, entry.result.source_url),
    sources: entry.result.sources ?? storySources([{ url: entry.result.source_url, name: sourceName(entry.source_id, entry.result.source_url) }]),
    section: sectionLabel(entry.section), section_id: entry.section, local: entry.tier === "local", also_from: entry.result.also_from ?? [],
    ...(entry.result.digest ? { digest: true } : {}),
    ...(entry === lead ? { lead: true } : {}),
    // Preserve saved attribution metadata; the image URL still requires a current audit.
    ...(!illustrated && entry.result.image_credit ? { image_caption: entry.result.image_caption, image_credit: entry.result.image_credit } : {}),
    ...approvedImages.get(entry.story_id),
  })));
  const illustrations = illustrated ? planIllustrations(items, draft.location_id) : new Map();
  const visualItems = illustrated ? items.map((item, index) => ({ ...item, ...(illustrations.has(index)
    ? { illustration_id: illustrations.get(index)!.id, illustration_asset_id: illustrations.get(index)!.asset_id ?? illustrations.get(index)!.id, illustration_policy: ILLUSTRATION_POLICY } : {}) })) : items;
  if (illustrated && ordered.length) await deps.db.collection(COLLECTIONS.editionEntries).bulkWrite(ordered.map((entry, index) => ({ updateOne: {
    filter: { edition_id: draftId, story_id: entry.story_id, disposition: "checks_passed" }, update: { $set: {
      "result.illustration": illustrations.get(index) ?? null,
      "result.image_pipeline": { status: illustrations.has(index) ? "illustrated" : "not_applicable", provider: "newsbee_ai", policy: ILLUSTRATION_POLICY,
        reason: illustrations.has(index) ? "distinct_reviewed_illustration" : "no_distinct_matching_illustration", checked_at: Date.now() },
    } },
  } })));
  const payload: EditionPayload & { media_mode?: "illustrated" | "photos" } = { id: draftId, location_id: draft.location_id, location_name: draft.location_name, window_start: draft.window_start, window_end: draft.window_end, published_at: now, headline: String(front.headline), intro: String(front.intro), items: visualItems, coverage: editionCoverage(draft.source_results), corrections: [] as Array<{ story_id: string; reason: string; created_at: number }>,
    ...(currentOptions().image_mode ? { media_mode: illustrated ? "illustrated" as const : "photos" as const } : {}) };
  if (!validEditionShape(payload)) throw new Error("Generated edition does not match the published edition contract");
  const emailPreview = previewContent(draft.location_name, draft.location_id, { headline: payload.headline, intro: payload.intro, email: email as { blurb?: string } });
  const allEntries = await getEntries(deps.db, draftId);
  const summary = { included: passed.length, by_section: Object.fromEntries([...perSection].map(([section, count]) => [section, Math.min(count, caps.publishedPerSection)])), local_included: passed.filter((entry) => entry.tier === "local").length, wider_included: passed.filter((entry) => WIDER_TIERS.has(entry.tier)).length, held: allEntries.filter((entry) => entry.disposition === "held").length, attempted: allEntries.length, not_attempted: draft.candidates.length - allEntries.length, events: draft.event_count, stories: draft.story_count, ranked: draft.candidates.length, funnel: draft.funnel, ranking: draft.ranking, duration_seconds: Math.round((Date.now() - Number(draft.started_at_ms)) / 1000) / 1000, model: draft.model, provider: draft.provider, policy: draft.validation_policy, held_reasons: heldReasons(allEntries), model_errors: draft.model_errors ?? [], front, email };
  // Built, not published: a person reviews it and publishes it to the reader (orchestration/publish.ts).
  const sourceCounts: Record<string, number> = {};
  for (const entry of passed) sourceCounts[entry.source_id] = (sourceCounts[entry.source_id] ?? 0) + 1;
  await collection.updateOne({ id: draftId }, { $set: { status: "built", built_at: now, published_at: now, published: payload, email_preview: emailPreview, summary, front, email, held_reasons: summary.held_reasons, model_errors: summary.model_errors, source_counts: sourceCounts } });
  const publishedIds = new Set(items.map((item) => item.story_id));
  await collectedItems(deps.db).updateMany({ run_id: draft.run_id, story_id: { $in: [...publishedIds] } }, { $set: { status: "published", step: "published", reason: null } });
  await collectedItems(deps.db).updateMany({ run_id: draft.run_id, status: "candidate" }, { $set: { status: "not_selected", reason: `candidate not published: the section already had ${caps.publishedPerSection} stories`, step: "authoring" } });
  deps.log.info("Edition built", { edition_id: draftId, location_id: draft.location_id, included: summary.included, held: summary.held, attempted: summary.attempted, front_fallback: front.fallback, duration_seconds: summary.duration_seconds });
  return { edition: payload, emailPreview, summary, tokens: draft.tokens };
}

export async function latestPublished(deps: Pick<AuthoringDeps, "db"> & Partial<AuthoringDeps>, locationId: string) {
  const doc = await drafts(deps.db).find({ location_id: locationId, status: "published" }).sort({ published_at: -1, id: -1 }).limit(1).next();
  return doc ? correctedEdition(deps.db, doc) : null;
}

/** An edition as the reader gets it: its stories, less any withdrawn since, with their corrections. */
export async function correctedEdition(db: Db, doc: Pick<DraftDoc, "id" | "location_id" | "location_name" | "window_start" | "window_end" | "published">) {
  if (!doc.published) return null;
  const locationId = doc.location_id;
  const deps = { db };
  const decisions = await withdrawals.forLocation(deps.db, locationId);
  const corrections: Array<{ story_id: string; reason: string; created_at: number }> = [];
  const entries = await getEntries(deps.db, doc.id);
  const storyById = new Map(entries.map((entry) => [entry.story_id, entry.result.story]));
  const items = doc.published.items.filter((item) => {
    const story = storyById.get(String(item.story_id));
    if (!story) return true;
    const affected = withdrawals.matching(story, decisions);
    for (const decision of affected) if (!corrections.some((value) => value.story_id === decision.story_id)) corrections.push({ story_id: decision.story_id, reason: decision.reason, created_at: decision.created_at });
    return affected.length === 0;
  });
  const result: EditionPayload = { ...doc.published, items, corrections };
  if (corrections.length) { const front = writer.fallbackFront(community(doc.location_name), weekLabel(doc.window_start, doc.window_end), !!items.length); result.headline = front.headline; result.intro = front.intro; }
  return result;
}

/** Reader-facing teaser content, adjusted dynamically when a published story is withdrawn. */
export async function emailContent(deps: Pick<AuthoringDeps, "db"> & Partial<AuthoringDeps>, editionId: string) {
  const draft = await drafts(deps.db).findOne({ id: editionId, status: "published" });
  if (!draft?.published) throw new Error(`No published edition: ${editionId}`);
  const entries = await getEntries(deps.db, editionId);
  const decisions = await withdrawals.forLocation(deps.db, draft.location_id);
  const affected = entries.filter((entry) => entry.disposition !== "held" && withdrawals.matching(entry.result.story, decisions).length > 0);
  if (affected.length) {
    const front = writer.fallbackFront(community(draft.location_name), "updated edition", false);
    return { location_id: draft.location_id, location_name: draft.location_name, headline: front.headline, intro: "This edition has been corrected. Read the website for the current stories.", blurb: "A story was withdrawn; the correction notice is available with the edition." };
  }
  const email = draft.email as { blurb?: string } | undefined;
  return { location_id: draft.location_id, location_name: draft.location_name, headline: draft.published.headline, intro: draft.published.intro, blurb: email?.blurb ?? writer.fallbackEmail(community(draft.location_name), true).blurb };
}

export { ModelRateLimitError };
