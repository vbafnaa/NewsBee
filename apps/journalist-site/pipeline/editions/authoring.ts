import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { Settings } from "../core/config";
import { configuredModel, rankingCandidateLimit } from "../core/config";
import type { Logger } from "../core/log";
import type { SourceResult, CollectedEvent } from "../connectors/types";
import { collapse, whenWhere, weekLabel, type SourceEvent, type Story } from "./stories";
import { COLLECTIONS } from "../storage/mongo";
import type { ModelRuntime } from "../model/runtime";
import * as ranking from "../model/newsworthiness";
import { pythonJson } from "../model/newsworthiness";
import * as writer from "../model/story-writer";
import * as policy from "../editorial/policy";
import * as withdrawals from "../editorial/withdrawals";
import { previewContent } from "../email/preview";
import { sourceType, rank as rankSource } from "../ranking";
import { isUpcoming, newsletterOrder } from "../../../../shared/newsletter-layout";

export const DEFAULT_MODEL = "qwen3:4b";
export const VALIDATION_POLICY = `${ranking.RANKING_POLICY}+${writer.WRITING_POLICY}+${policy.POLICY}`;
export const MAX_ENTRIES = 9;
export const MAX_ATTEMPTS = 12;
export const MAX_WIDER = 4;
export const MAX_WIDER_ATTEMPTS = 6;
export const WIDER_TIERS = new Set(["region", "nearby"]);
export const WIDER_SOURCES = ["hazards:", "statenews:", "trending:"] as const;
export const TOP_PER_SOURCE = 5;
export type AuthoringDeps = { db: Db; model: ModelRuntime; rankingModel?: ModelRuntime; settings: Settings; log: Logger };
export type AuthoringInput = { location: { id: string; name: string }; runId: string; today: string; window: [string, string]; events: SourceEvent[]; sourceResults: SourceResult[] };
type RankedCandidate = ranking.Candidate & { rating: ranking.Rating; score: number; rated_by: "model" | "rule"; rank: number; source_id: string; source_type: string; tier: string; section: string | null };
type EditionPayload = { id: string; location_id: string; location_name: string; window_start: string; window_end: string; published_at: number; headline: string; intro: string; items: Array<Record<string, any>>; coverage: string[]; corrections: Array<{ story_id: string; reason: string; created_at: number }> };
type EntryDoc = { id: string; edition_id: string; position: number; disposition: string; story_id: string; source_id: string; source_type: string; tier: string; event_date: string; result: Record<string, any> };
type DraftDoc = { id: string; run_id: string; location_id: string; location_name: string; today: string; window_start: string; window_end: string; status: string; created_at: number; model: string; provider: string; validation_policy: string; published?: EditionPayload; email_preview?: { subject: string; text: string; html: string }; summary?: Record<string, unknown>; events: SourceEvent[]; source_results: SourceResult[]; candidates: RankedCandidate[]; source_summary: Record<string, unknown>; ranking: Record<string, unknown>; event_count: number; story_count: number; started_at_ms: number; [key: string]: unknown };
function community(name: string) { return name.split(",")[0]; }
function storyCandidates(stories: Story[]) { return stories.map((story) => ({ id: story.id, title: story.title, description: story.description, occurrences: story.occurrences.length, venues: story.venues, first_date: story.first.event_date, kind: story.kind, tier: String(story.facts.tier ?? "local") })); }
function recordStory(story: Story) { return { id: story.id, title: story.title, description: story.description, kind: story.kind, occurrences: story.occurrences.map((item) => ({ ...item })) }; }
export function shortlistSource(events: SourceEvent[], kind: string, limit = TOP_PER_SOURCE): { stories: Story[]; summary: Record<string, number> } {
  const stories = collapse(events).filter((story) => sourceType(story.first.source_id) === kind);
  const ranked = rankSource(kind, stories).slice(0, limit);
  return { stories: ranked, summary: { stories: stories.length, considered: stories.length, shortlisted: ranked.length, preselection_limit: limit } };
}
function shortlist(stories: Story[], limit: number) {
  const grouped = new Map<string, Story[]>();
  for (const story of stories) { const kind = sourceType(story.first.source_id); const list = grouped.get(kind) ?? []; list.push(story); grouped.set(kind, list); }
  const selected: Story[] = []; const summary: Record<string, { stories: number; considered: number; shortlisted: number }> = {};
  for (const kind of [...grouped.keys()].sort()) { const all = grouped.get(kind)!; const top = rankSource(kind, all).slice(0, limit); selected.push(...top); summary[kind] = { stories: all.length, considered: all.length, shortlisted: top.length }; }
  return { selected, summary };
}
function nextCandidate(pending: RankedCandidate[], covered: Set<string>) { return pending.find((item) => !covered.has(item.source_type)) ?? pending[0]; }
function heldReasons(entries: Array<{ disposition: string; result: Record<string, any> }>) {
  const counts: Record<string, number> = {};
  for (const entry of entries) if (entry.disposition === "held") for (const error of (entry.result.validation_errors?.length ? entry.result.validation_errors : entry.result.error ? [entry.result.error] : [])) counts[error] = (counts[error] ?? 0) + 1;
  return counts;
}
function cacheKey(settings: Settings, locationId: string, candidate: RankedCandidate) {
  const values = { title: candidate.title, description: candidate.description ?? null, venues: candidate.venues, kind: candidate.kind ?? "event" };
  const sortedContent = Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  const key = createHash("sha256").update(pythonJson([configuredModel(settings) || DEFAULT_MODEL, VALIDATION_POLICY, sortedContent])).digest("hex");
  return `${locationId}:${key}`;
}
async function checkedItem(deps: AuthoringDeps, candidate: RankedCandidate) {
  const key = cacheKey(deps.settings, candidate.community_id as string, candidate);
  const cached = await deps.db.collection(COLLECTIONS.storyCache).findOne({ cache_key: key });
  if (cached?.result?.draft && writer.validateItem(candidate, cached.result.draft).length === 0) return { ...cached.result, cache_hit: true, wall_seconds: 0 };
  const result = await writer.writeItem(deps.model, candidate);
  if (result.disposition === "checks_passed") await deps.db.collection(COLLECTIONS.storyCache).updateOne({ cache_key: key }, { $set: { cache_key: key, location_id: candidate.community_id, result } }, { upsert: true });
  return { ...result, cache_hit: false };
}
async function getEntries(db: Db, draftId: string) { return db.collection<EntryDoc>(COLLECTIONS.editionEntries).find({ edition_id: draftId }).sort({ position: 1 }).toArray(); }

/** Create the ranked, persisted state for a resumable edition. */
export async function startAuthoring(deps: AuthoringDeps, input: AuthoringInput) {
  const old = await deps.db.collection<DraftDoc>(COLLECTIONS.editions).findOne({ run_id: input.runId });
  if (old) return old.id;
  const start = Date.now();
  const allStories = collapse(input.events);
  const limit = rankingCandidateLimit(deps.settings);
  const picked = shortlist(allStories, limit);
  const withdrawn = await withdrawals.forLocation(deps.db, input.location.id);
  const activeStories = picked.selected.filter((story) => !withdrawals.matching(story, withdrawn).length);
  const rankingModel = deps.rankingModel ?? deps.model;
  const [ranked, rankSummary] = await ranking.rank(rankingModel, storyCandidates(activeStories));
  Object.assign(rankSummary, { provider: rankingModel.provider, model: rankingModel.model, preselection_limit: limit });
  if (Number(rankSummary.fallback_ratings)) deps.log.warn("ranking_fallback_used", { run_id: input.runId, ...rankSummary });
  rankSummary.sources = picked.summary;
  const ids = new Map<string, Story>(activeStories.map((story) => [story.id, story]));
  const sourceResults = input.sourceResults ?? [];
  const rankedCandidates = ranked.map((candidate, index) => {
    const story = ids.get(candidate.id)!;
    return { ...candidate, rank: index + 1, source_id: story.first.source_id, source_type: sourceType(story.first.source_id), tier: String(story.facts.tier ?? "local"), section: typeof story.facts.section === "string" ? story.facts.section : null } as RankedCandidate;
  });
  const id = input.runId;
  const doc: DraftDoc = { id, run_id: input.runId, location_id: input.location.id, location_name: input.location.name, today: input.today, window_start: input.window[0], window_end: input.window[1], status: "drafting", created_at: Date.now() / 1000, model: deps.model.model ?? configuredModel(deps.settings) ?? DEFAULT_MODEL, provider: deps.model.provider, validation_policy: VALIDATION_POLICY, events: input.events, source_results: sourceResults, candidates: rankedCandidates, source_summary: picked.summary, ranking: rankSummary, event_count: input.events.length, story_count: allStories.length, started_at_ms: start, local_passed: 0, wider_passed: 0, wider_attempted: 0, held: 0, attempted: 0, held_reasons: {}, model_errors: [] };
  await deps.db.collection<DraftDoc>(COLLECTIONS.editions).insertOne(doc);
  deps.log.info("Edition authoring started", { edition_id: id, location_id: input.location.id, events: input.events.length, stories: allStories.length, ranked: rankedCandidates.length, model: doc.model, provider: doc.provider, policy: VALIDATION_POLICY });
  return id;
}

/** Persist exactly one candidate result, including its one validation retry, per invocation. */
export async function authorNextStory(deps: AuthoringDeps, draftId: string) {
  const collection = deps.db.collection<DraftDoc>(COLLECTIONS.editions);
  const draft = await collection.findOne({ id: draftId });
  if (!draft) throw new Error(`No authoring draft: ${draftId}`);
  if (draft.status !== "drafting") return { more: false, done: true };
  const entries = await getEntries(deps.db, draftId);
  const doneIds = new Set(entries.map((entry) => entry.story_id));
  const covered = new Set(entries.filter((entry) => entry.disposition !== "held").map((entry) => entry.source_type));
  const pending = draft.candidates.filter((candidate) => !doneIds.has(candidate.id));
  const local = pending.filter((candidate) => candidate.tier === "local");
  const wider = pending.filter((candidate) => WIDER_TIERS.has(candidate.tier)).sort((a, b) => (a.tier === "region" ? 0 : 1) - (b.tier === "region" ? 0 : 1) || a.rank - b.rank);
  const localAttempted = entries.filter((entry) => entry.tier === "local").length;
  const widerEntries = entries.filter((entry) => WIDER_TIERS.has(entry.tier));
  const passedCount = entries.filter((entry) => entry.disposition !== "held").length;
  const widerPassed = widerEntries.filter((entry) => entry.disposition !== "held").length;
  const canLocal = local.length > 0 && passedCount < MAX_ENTRIES && localAttempted < MAX_ATTEMPTS;
  const canWider = wider.length > 0 && passedCount < MAX_ENTRIES && widerPassed < MAX_WIDER && widerEntries.length < MAX_WIDER_ATTEMPTS;
  if (!canLocal && !canWider) {
    await collection.updateOne({ id: draftId }, { $set: { status: "ready", attempted: entries.length, held: entries.filter((entry) => entry.disposition === "held").length, held_reasons: heldReasons(entries) } });
    return { more: false, done: true };
  }
  const localNews = canLocal ? local.filter((item) => !isUpcoming(item.kind)) : [];
  const widerNews = canWider ? wider.filter((item) => !isUpcoming(item.kind)) : [];
  const candidate = localNews.length ? nextCandidate(localNews, covered)
    : widerNews.length ? nextCandidate(widerNews, covered)
    : canLocal ? nextCandidate(local, covered) : nextCandidate(wider, covered);
  const story = collapse(draft.events).find((item) => item.id === candidate.id);
  if (!story) throw new Error(`Story no longer exists in draft: ${candidate.id}`);
  const candidateForWrite = { ...candidate, community_id: draft.location_id } as RankedCandidate & { community_id: string };
  const eligibility = policy.errors(candidate) .concat(policy.sourceErrors(story.occurrences.map((item) => item.source_url)));
  const existingWithdrawals = await withdrawals.forLocation(deps.db, draft.location_id);
  if (withdrawals.matching(story, existingWithdrawals).length) eligibility.push("previously_withdrawn");
  let result: Record<string, any>;
  if (eligibility.length) result = { disposition: "held", checks_passed: false, validation_errors: eligibility, attempts: 0, wall_seconds: 0 };
  else result = await checkedItem(deps, candidateForWrite);
  Object.assign(result, { story: recordStory(story), ranking: { rank: candidate.rank, score: candidate.score, rated_by: candidate.rated_by, ...candidate.rating }, when_where: whenWhere(story), source_url: story.first.source_url, tier: candidate.tier, section: candidate.section });
  const position = entries.length;
  await deps.db.collection(COLLECTIONS.editionEntries).updateOne({ id: `${draftId}:${candidate.id}` }, { $set: { id: `${draftId}:${candidate.id}`, edition_id: draftId, position, story_id: story.id, source_id: story.first.source_id, source_type: candidate.source_type, tier: candidate.tier, event_date: story.first.event_date, disposition: result.disposition, result } }, { upsert: true });
  const refreshed = await getEntries(deps.db, draftId);
  const refreshedDone = new Set(refreshed.map((entry) => entry.story_id));
  const remaining = draft.candidates.filter((item) => !refreshedDone.has(item.id));
  const totalPassed = refreshed.filter((entry) => entry.disposition !== "held").length;
  const localAttemptsAfter = refreshed.filter((entry) => entry.tier === "local").length;
  const wideEntriesAfter = refreshed.filter((entry) => WIDER_TIERS.has(entry.tier));
  const widePassedAfter = wideEntriesAfter.filter((entry) => entry.disposition !== "held").length;
  const more = (remaining.some((item) => item.tier === "local") && totalPassed < MAX_ENTRIES && localAttemptsAfter < MAX_ATTEMPTS)
    || (remaining.some((item) => WIDER_TIERS.has(item.tier)) && totalPassed < MAX_ENTRIES && widePassedAfter < MAX_WIDER && wideEntriesAfter.length < MAX_WIDER_ATTEMPTS);
  const errors = result.error ? [...((draft.model_errors as string[]) ?? []), String(result.error)] : (draft.model_errors as string[] ?? []);
  await collection.updateOne({ id: draftId }, { $set: { status: more ? "drafting" : "ready", attempted: refreshed.length, held: refreshed.filter((entry) => entry.disposition === "held").length, held_reasons: heldReasons(refreshed), model_errors: errors, local_passed: refreshed.filter((entry) => entry.tier === "local" && entry.disposition !== "held").length, wider_passed: widePassedAfter, wider_attempted: wideEntriesAfter.length } });
  deps.log.info("Edition item", { edition_id: draftId, story_id: story.id, rank: candidate.rank, score: candidate.score, category: candidate.rating.category, tier: candidate.tier, occurrences: story.occurrences.length, attempts: result.attempts, disposition: result.disposition, errors: result.validation_errors ?? result.error, wall_seconds: result.wall_seconds });
  return { more, done: !more, candidate: candidate.id, result };
}

function editionCoverage(sourceResults: SourceResult[]) {
  const lines = sourceResults.filter((item) => item.status !== "ingested").map((item) => `${item.name}: coverage unavailable (${item.status}).`);
  if (!sourceResults.length) lines.push("Source coverage was not recorded for this edition.");
  if (!sourceResults.some((item) => item.source_id.startsWith("meetings:"))) lines.push("No public meeting source was checked for this edition.");
  const hasWider = sourceResults.some((item) => WIDER_SOURCES.some((prefix) => item.source_id.startsWith(prefix)));
  lines.unshift("Private prototype: library listings, public meetings" + (hasWider ? ", official state news and trends about the town and nearby places" : "") + " only, not all local news.");
  return lines;
}
function validEditionShape(value: any) {
  const kinds = new Set(["event", "meeting_preview", "meeting_outcome", "state_news", "earthquake", "trending_topic", "social_trend"]);
  const itemValid = (item: any) => typeof item.story_id === "string" && typeof item.headline === "string" && typeof item.blurb === "string" && typeof item.when_where === "string" && typeof item.event_date === "string" && (typeof item.source_url === "string" || item.source_url === null) && (Number.isInteger(item.rank) || item.rank === null) && kinds.has(item.kind) && typeof item.source_name === "string" && (typeof item.section === "string" || item.section === null) && typeof item.local === "boolean";
  const correctionValid = (item: any) => typeof item.story_id === "string" && typeof item.reason === "string" && typeof item.created_at === "number";
  const coverageValid = !("coverage" in value) || (Array.isArray(value.coverage) && value.coverage.every((line: unknown) => typeof line === "string"));
  const correctionsValid = !("corrections" in value) || (Array.isArray(value.corrections) && value.corrections.every(correctionValid));
  return typeof value.id === "string" && typeof value.location_id === "string" && typeof value.location_name === "string" && typeof value.window_start === "string" && typeof value.window_end === "string" && typeof value.published_at === "number" && typeof value.headline === "string" && typeof value.intro === "string" && Array.isArray(value.items) && value.items.every(itemValid) && coverageValid && correctionsValid;
}
export async function finishAuthoring(deps: AuthoringDeps, draftId: string) {
  const collection = deps.db.collection<DraftDoc>(COLLECTIONS.editions);
  const draft = await collection.findOne({ id: draftId });
  if (!draft) throw new Error(`No authoring draft: ${draftId}`);
  if (draft.status === "published") return { edition: draft.published, emailPreview: draft.email_preview, summary: draft.summary };
  const entries = await getEntries(deps.db, draftId);
  if (entries.length < draft.candidates.length && draft.status !== "ready") return { done: false, more: true };
  const passed = entries.filter((entry) => entry.disposition !== "held").sort((a, b) => newsletterOrder(
    { kind: a.result.story.kind ?? "event", local: a.tier === "local", rank: Number(a.result.ranking.rank) },
    { kind: b.result.story.kind ?? "event", local: b.tier === "local", rank: Number(b.result.ranking.rank) },
  ));
  const itemStories = passed.map((entry) => entry.result.story as writer.StoryInput);
  const itemDrafts = passed.map((entry) => entry.result.draft as writer.ItemDraft);
  const week = weekLabel(draft.window_start, draft.window_end);
  const front = await writer.writeFront(deps.model, community(draft.location_name), week, itemStories, itemDrafts);
  const email = await writer.writeEmail(deps.model, community(draft.location_name), week, itemStories, itemDrafts, { headline: String(front.headline), intro: String(front.intro) });
  const now = Date.now() / 1000;
  const items = passed.map((entry) => ({ story_id: entry.result.story.id, headline: entry.result.draft.headline, blurb: entry.result.draft.summary, when_where: entry.result.when_where, event_date: entry.event_date, source_url: entry.result.source_url ?? null, rank: entry.result.ranking.rank, kind: entry.result.story.kind ?? "event", source_name: draft.source_results.find((result) => result.source_id === entry.source_id)?.name ?? "Local source", section: isUpcoming(entry.result.story.kind ?? "event") ? "Upcoming events" : entry.result.section ?? null, local: entry.tier === "local" }));
  const payload: EditionPayload = { id: draftId, location_id: draft.location_id, location_name: draft.location_name, window_start: draft.window_start, window_end: draft.window_end, published_at: now, headline: String(front.headline), intro: String(front.intro), items, coverage: editionCoverage(draft.source_results), corrections: [] as Array<{ story_id: string; reason: string; created_at: number }> };
  if (!validEditionShape(payload)) throw new Error("Generated edition does not match the published edition contract");
  const emailPreview = previewContent(draft.location_name, draft.location_id, { headline: payload.headline, intro: payload.intro, email: email as { blurb?: string } });
  const allEntries = await getEntries(deps.db, draftId);
  const summary = { included: passed.length, local_included: passed.filter((entry) => entry.tier === "local").length, wider_included: passed.filter((entry) => WIDER_TIERS.has(entry.tier)).length, wider_attempted: allEntries.filter((entry) => WIDER_TIERS.has(entry.tier)).length, held: allEntries.filter((entry) => entry.disposition === "held").length, attempted: allEntries.length, not_attempted: draft.candidates.length - allEntries.length, events: draft.event_count, stories: draft.story_count, ranked: draft.candidates.length, ranking: draft.ranking, duration_seconds: Math.round((Date.now() - Number(draft.started_at_ms)) / 1000) / 1000, model: draft.model, provider: draft.provider, policy: draft.validation_policy, held_reasons: heldReasons(allEntries), model_errors: draft.model_errors ?? [], front, email };
  await collection.updateOne({ id: draftId }, { $set: { status: "published", published_at: now, published: payload, email_preview: emailPreview, summary, front, email, held_reasons: summary.held_reasons, model_errors: summary.model_errors } });
  deps.log.info("Edition published", { edition_id: draftId, location_id: draft.location_id, included: summary.included, held: summary.held, attempted: summary.attempted, front_fallback: front.fallback, duration_seconds: summary.duration_seconds });
  return { edition: payload, emailPreview, summary };
}

export async function latestPublished(deps: AuthoringDeps, locationId: string) {
  const doc = await deps.db.collection<DraftDoc>(COLLECTIONS.editions).find({ location_id: locationId, status: "published" }).sort({ published_at: -1, id: -1 }).limit(1).next();
  if (!doc?.published) return null;
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
export async function emailContent(deps: AuthoringDeps, editionId: string) {
  const draft = await deps.db.collection<DraftDoc>(COLLECTIONS.editions).findOne({ id: editionId, status: "published" });
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
