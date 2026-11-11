/**
 * An editor's Accept or Reject on a story a run pulled, with a reason code (`story-reasons.ts`), a
 * newsletter category and a note, tied to the run, the story and the editor. Separate from the source
 * map's labels. These are the human annotations a ranking model or skill is trained and tested on.
 *
 *   story_decisions   the current decision per run and link: `<run id>:<link key>`. Copies of one link
 *                     in a run share one decision. Each row is a full snapshot of the story as the
 *                     pipeline had it when the editor decided: its text, where and how it was found,
 *                     every copy, the checks it passed or failed, the model's and pre-ranker's ratings,
 *                     extracted details and the written draft. Items expire after 90 days and page
 *                     text after 30, so the snapshot is what keeps an annotation usable later.
 *   story_reviews     every save, appended, so a changed mind is kept.
 *
 * The exports read `story_decisions`: CSV (flat, one column per fact) and JSONL (the whole snapshot).
 * Source acceptance rates feed the local pre-ranker.
 */
import type { Db } from "mongodb";
import { getRun, type PipelineRun } from "../orchestration/runs";
import { normaliseUrl } from "../sourcemap/store";
import { SECTIONS, sectionLabel } from "../sourcemap/sections";
import { COLLECTIONS } from "../storage/mongo";
import { collectedItems, type CollectedItem, type Replication } from "./assemble";
import { EXTRACTION_POLICY, textFor, type Details } from "./details";
import { CATEGORY_REQUIRED_FOR, STORY_OTHER_CODES, storyDecisionOf, storyReasonLabel, type StoryDecision, type StoryReasonCode } from "./story-reasons";

export const STORY_DECISIONS = "story_decisions";
export const STORY_REVIEWS = "story_reviews";
/** Where extracted story details are kept (`editions/authoring.ts` STORY_DETAILS). */
const STORY_DETAILS = "story_details";
const TEXT_EXCERPT = 2000;
/** Outcomes the pipeline keeps a story at, as opposed to leaving it out. */
const KEPT = new Set(["published", "candidate", "held", "pooled", "collected"]);

/** What the pipeline knew about the story, as it stood when the editor decided. */
export type StorySnapshot = {
  description: string | null; kind: string | null; venue: string | null; schedule: string | null;
  area: string | null; locality_method: string | null; locality_evidence: string[];
  site_name: string | null; source_tier: string | null; section_hint: string | null;
  found_on_page: string | null; crawl_depth: number | null; extracted_by: string | null; extracted_quote: string | null; link_only: boolean;
  update_of: string | null; would_have_blocked: string[]; access_overrides: string[];
  copies: Array<{ item_id: string; url: string | null; source_id: string; source_name: string; status: string; step: string; reason: string | null }>;
  sources: Array<{ source_id: string; name: string; url: string | null; reader: string | null; tier: string | null; found_by: string | null; status: string | null }>;
  model_rating: CollectedItem["model_rating"] | null; pre_rank: CollectedItem["pre_rank"] | null;
  evidence: { text_quality: string; extraction: string; missing: string[]; sources: number } | null;
  details: Pick<Details, "people" | "organisations" | "places" | "when" | "numbers" | "what" | "why" | "quote" | "next_step"> | null;
  writing: { disposition: string; headline: string | null; summary: string | null; errors: string[] } | null;
  text_excerpt: string | null;
};
/** How the run was set up, so annotations from different settings can be told apart. */
export type RunSettingsSnapshot = { window: [string, string] | null; flow: string | null; map_flow: string | null; guardrails: string | null; access: string | null; scrape_depth: number | null; story_limit: number | null; playbook_version: string | null };

export type StoryDecisionDoc = {
  _id: string;
  run_id: string;
  location_id: string;
  location_name: string;
  run_day: string;
  key: string;
  url: string | null;
  title: string;
  story_date: string | null;
  story_id: string | null;
  item_ids: string[];
  /** The newsletter section the pipeline placed it in, if it got that far. */
  section: string | null;
  source_ids: string[];
  source_names: string[];
  source_urls: string[];
  pipeline_status: string;
  pipeline_step: string;
  pipeline_reason: string | null;
  rank: number | null;
  score: number | null;
  rating: string | null;
  pre_rank_score: number | null;
  replication: Replication | null;
  decision: StoryDecision | null;
  reason_code: StoryReasonCode | null;
  reason_label: string | null;
  reason: string | null;
  /** The editor's newsletter category (a section id): required on Accept, so a dropped story says where it belongs. */
  category?: string | null;
  /** The pipeline kept the story (its outcome) and whether the editor's decision goes against that. */
  pipeline_kept?: boolean;
  disagrees?: boolean;
  story?: StorySnapshot;
  run_settings?: RunSettingsSnapshot;
  by: string;
  at: string;
};

export function storyDecisions(db: Db) { return db.collection<StoryDecisionDoc>(STORY_DECISIONS); }
export async function ensureStoryReviewIndexes(db: Db) {
  await storyDecisions(db).createIndexes([{ key: { run_id: 1 } }, { key: { location_id: 1, at: -1 } }, { key: { location_id: 1, source_ids: 1 } }]);
  await db.collection(STORY_REVIEWS).createIndexes([{ key: { run_id: 1, key: 1, at: 1 } }]);
}

/** The key copies of one story share in a run: its normalised link, or the item itself when it has none. */
export function linkKey(item: Pick<CollectedItem, "_id" | "url">) {
  return item.url ? `url:${normaliseUrl(item.url)}` : `item:${item._id}`;
}

/** Outcomes, best first: a group shows its furthest-along copy. */
export const STATUS_ORDER = ["published", "candidate", "held", "pooled", "not_selected", "collected", "dropped"];
export function bestItem<T extends Pick<CollectedItem, "status">>(items: T[]) {
  return [...items].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))[0];
}

export type StoryReviewChange = { decision: StoryDecision | null; reason_code: StoryReasonCode | null; reason: string | null; category: string | null };
const CATEGORY_IDS = new Set<string>(SECTIONS.map((section) => section.id));

/** Check a review sent by an editor. Throws an `Invalid ...` error otherwise. */
export function storyReviewChange(body: { decision?: unknown; reason_code?: unknown; reason?: unknown; category?: unknown }): StoryReviewChange {
  const decision = body.decision ?? null;
  if (decision !== null && decision !== "accept" && decision !== "reject") throw new Error("Invalid decision: send accept, reject or null");
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") throw new Error("Invalid reason: send text or null");
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) || null : null;
  const code = typeof body.reason_code === "string" && body.reason_code ? body.reason_code : null;
  const category = typeof body.category === "string" && body.category ? body.category : null;
  if (decision === null) return { decision: null, reason_code: null, reason: null, category: null };
  if (!code) throw new Error("Invalid reason code: choose a reason for this decision");
  if (storyDecisionOf(code) !== decision) throw new Error("Invalid reason code: it doesn't belong to this decision");
  if (STORY_OTHER_CODES.includes(code) && !reason) throw new Error("Invalid reason: explain the Other reason");
  if (category && !CATEGORY_IDS.has(category)) throw new Error(`Invalid category: send one of ${[...CATEGORY_IDS].join(", ")}`);
  if (!category && CATEGORY_REQUIRED_FOR.has(decision)) throw new Error("Invalid category: choose the newsletter category for an accepted story");
  return { decision, reason_code: code as StoryReasonCode, reason, category };
}

/** The run's items that share `itemId`'s link, so one decision covers every copy. */
async function copiesOf(db: Db, runId: string, itemId: string) {
  const item = await collectedItems(db).findOne({ _id: itemId, run_id: runId });
  if (!item) throw new Error(`Invalid request: unknown item ${itemId}`);
  const key = linkKey(item);
  const copies = item.url ? (await collectedItems(db).find({ run_id: runId, url: { $ne: null } }).toArray()).filter((other) => linkKey(other) === key) : [item];
  return { key, copies };
}

const text = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
const strings = (value: unknown) => Array.isArray(value) ? value.map(String) : [];

/** Everything the pipeline knew about a story, from its best copy and the run. */
async function storySnapshot(db: Db, run: PipelineRun, copies: CollectedItem[], lead: CollectedItem): Promise<StorySnapshot> {
  const facts = (lead.facts ?? {}) as Record<string, unknown>;
  const locality = (lead.locality ?? facts.locality ?? null) as { method?: string; matches?: unknown } | null;
  const snapshot = new Map((run.source_snapshot ?? []).map((source) => [source.source_id, source]));
  const [detailsDoc, entry, stored] = await Promise.all([
    lead.story_id ? db.collection<{ _id: string; details: Details }>(STORY_DETAILS).findOne({ _id: `${lead.location_id}:${lead.story_id}:${EXTRACTION_POLICY}` }) : null,
    lead.story_id && run.draft_id ? db.collection<{ disposition: string; result?: { draft?: { headline?: string; summary?: string }; validation_errors?: string[]; error?: string } }>(COLLECTIONS.editionEntries).findOne({ edition_id: run.draft_id, story_id: lead.story_id }) : null,
    textFor(db, lead.url).catch(() => null),
  ]);
  const details = detailsDoc?.details ?? null;
  return {
    description: text(facts.description), kind: text(facts.kind), venue: text(facts.venue), schedule: text(facts.schedule_text),
    area: text(facts.tier), locality_method: locality?.method ?? null, locality_evidence: strings(locality?.matches).slice(0, 8),
    site_name: text(facts.site_name), source_tier: text(facts.source_tier), section_hint: text(facts.section_hint),
    found_on_page: text(facts.found_via) ?? text(facts.found_by), crawl_depth: typeof facts.crawl_depth === "number" ? facts.crawl_depth : null,
    extracted_by: text(facts.extracted_by), extracted_quote: text(facts.extracted_quote), link_only: facts.link_only === true,
    update_of: text(facts.update_of), would_have_blocked: lead.would_have_blocked ?? [], access_overrides: lead.access_overrides ?? [],
    copies: copies.map((item) => ({ item_id: item._id, url: item.url, source_id: item.source_id, source_name: item.source_name, status: item.status, step: item.step, reason: item.reason })),
    sources: [...new Set(copies.map((item) => item.source_id))].map((id) => {
      const source = snapshot.get(id);
      return { source_id: id, name: source?.name ?? copies.find((item) => item.source_id === id)?.source_name ?? id, url: source?.url ?? null, reader: source?.reader ?? null, tier: source?.tier ?? null, found_by: source?.found_by ?? null, status: source?.status ?? null };
    }),
    model_rating: lead.model_rating ?? null, pre_rank: lead.pre_rank ?? null,
    evidence: lead.evidence ? { text_quality: lead.evidence.text_quality, extraction: lead.evidence.extraction, missing: lead.evidence.missing, sources: lead.evidence.sources.length } : null,
    details: details ? { people: details.people, organisations: details.organisations, places: details.places, when: details.when, numbers: details.numbers, what: details.what, why: details.why, quote: details.quote, next_step: details.next_step } : null,
    writing: entry ? { disposition: entry.disposition, headline: entry.result?.draft?.headline ?? null, summary: entry.result?.draft?.summary ?? null, errors: [...(entry.result?.validation_errors ?? []), ...(entry.result?.error ? [entry.result.error] : [])] } : null,
    text_excerpt: stored ? stored.slice(0, TEXT_EXCERPT) : text(facts.description),
  };
}

function runSettings(run: PipelineRun): RunSettingsSnapshot {
  const options = run.options;
  return {
    window: run.window ?? null, flow: options?.flow ?? null, map_flow: options?.map_flow ?? null, guardrails: options?.guardrails ?? null, access: options?.access ?? null,
    scrape_depth: options ? options.scrape_depth ?? 1 : null, story_limit: options?.story_limit ?? null, playbook_version: run.playbook_version ?? null,
  };
}

/**
 * Save an editor's decision on the story behind `itemId` in a run, for every copy of its link, with a
 * snapshot of the story. A null decision clears it. The history row is appended either way.
 */
export async function saveStoryReview(db: Db, runId: string, itemId: string, change: StoryReviewChange, by: string) {
  const run = await getRun(db, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  const { key, copies } = await copiesOf(db, runId, itemId);
  const lead = bestItem(copies);
  const story = await storySnapshot(db, run, copies, lead);
  const pipelineKept = KEPT.has(lead.status);
  const doc: StoryDecisionDoc = {
    _id: `${runId}:${key}`, run_id: runId, location_id: run.location_id, location_name: run.location_name, run_day: run.today,
    key, url: lead.url, title: lead.title, story_date: lead.event_date, story_id: lead.story_id ?? null, item_ids: copies.map((item) => item._id),
    section: lead.section ?? null, source_ids: [...new Set(copies.map((item) => item.source_id))], source_names: [...new Set(copies.map((item) => item.source_name))],
    source_urls: [...new Set(story.sources.map((source) => source.url).filter((url): url is string => Boolean(url)))],
    pipeline_status: lead.status, pipeline_step: lead.step, pipeline_reason: lead.reason, rank: lead.rank ?? null, score: lead.score ?? null, rating: lead.why ?? null,
    pre_rank_score: lead.pre_rank?.score ?? null, replication: lead.replication ?? null,
    decision: change.decision, reason_code: change.reason_code, reason_label: storyReasonLabel(change.reason_code), reason: change.reason,
    category: change.category, pipeline_kept: pipelineKept, disagrees: change.decision === null ? false : (change.decision === "accept") !== pipelineKept,
    story, run_settings: runSettings(run), by, at: new Date().toISOString(),
  };
  if (change.decision === null) await storyDecisions(db).deleteOne({ _id: doc._id });
  else await storyDecisions(db).replaceOne({ _id: doc._id }, doc, { upsert: true });
  const { _id: _ignored, ...history } = doc;
  await db.collection(STORY_REVIEWS).insertOne(history);
  return doc;
}

/** A run's decisions by link key. */
export async function storyDecisionsForRun(db: Db, runId: string) {
  return new Map((await storyDecisions(db).find({ run_id: runId }).toArray()).map((doc) => [doc.key, doc]));
}

/** Per source, how many of its stories editors accepted and rejected at this location. */
export async function sourceAcceptRates(db: Db, locationId: string) {
  const rows = await storyDecisions(db).aggregate<{ _id: string; accepted: number; rejected: number }>([
    { $match: { location_id: locationId, decision: { $in: ["accept", "reject"] } } },
    { $unwind: "$source_ids" },
    { $group: { _id: "$source_ids", accepted: { $sum: { $cond: [{ $eq: ["$decision", "accept"] }, 1, 0] } }, rejected: { $sum: { $cond: [{ $eq: ["$decision", "reject"] }, 1, 0] } } } },
  ]).toArray();
  return new Map(rows.map((row) => [row._id, { accepted: row.accepted, rejected: row.rejected }]));
}

/** The CSV, one column per fact. Decisions saved before a column existed leave it blank. */
const COLUMNS: Array<[string, (doc: StoryDecisionDoc, exportedAt: string) => unknown]> = [
  ["location", (doc) => doc.location_name], ["location_id", (doc) => doc.location_id], ["run_id", (doc) => doc.run_id], ["run_date", (doc) => doc.run_day],
  ["run_window", (doc) => doc.run_settings?.window?.join(" to ")], ["run_flow", (doc) => doc.run_settings?.flow], ["website_depth", (doc) => doc.run_settings?.scrape_depth],
  ["guardrails", (doc) => doc.run_settings?.guardrails], ["access", (doc) => doc.run_settings?.access], ["playbook_version", (doc) => doc.run_settings?.playbook_version],
  ["exported_at", (_doc, exportedAt) => exportedAt],
  ["story_title", (doc) => doc.title], ["story_description", (doc) => doc.story?.description], ["story_url", (doc) => doc.url],
  ["copy_urls", (doc) => [...new Set(doc.story?.copies.map((copy) => copy.url).filter(Boolean) ?? [])]], ["story_date", (doc) => doc.story_date],
  ["kind", (doc) => doc.story?.kind], ["pipeline_section", (doc) => doc.section], ["editor_category", (doc) => doc.category],
  ["editor_category_label", (doc) => doc.category ? sectionLabel(doc.category as never) : null],
  ["venue", (doc) => doc.story?.venue], ["schedule", (doc) => doc.story?.schedule], ["area", (doc) => doc.story?.area],
  ["locality_method", (doc) => doc.story?.locality_method], ["locality_evidence", (doc) => doc.story?.locality_evidence],
  ["site_name", (doc) => doc.story?.site_name], ["sources", (doc) => doc.source_names], ["source_urls", (doc) => doc.source_urls],
  ["source_readers", (doc) => doc.story?.sources.map((source) => source.reader).filter(Boolean)], ["source_tiers", (doc) => doc.story?.sources.map((source) => source.tier).filter(Boolean)],
  ["source_found_by", (doc) => doc.story?.sources.map((source) => source.found_by).filter(Boolean)], ["story_source_tier", (doc) => doc.story?.source_tier],
  ["found_on_page", (doc) => doc.story?.found_on_page], ["crawl_depth", (doc) => doc.story?.crawl_depth], ["section_hint", (doc) => doc.story?.section_hint],
  ["extracted_by", (doc) => doc.story?.extracted_by], ["extracted_quote", (doc) => doc.story?.extracted_quote], ["link_only", (doc) => doc.story?.link_only],
  ["copies", (doc) => doc.replication?.copies ?? doc.item_ids.length], ["copy_sources", (doc) => doc.replication?.sources ?? doc.source_ids.length],
  ["independent_publishers", (doc) => doc.replication?.independent], ["publishers", (doc) => doc.replication?.publishers],
  ["pipeline_status", (doc) => doc.pipeline_status], ["pipeline_step", (doc) => doc.pipeline_step], ["pipeline_reason", (doc) => doc.pipeline_reason],
  ["pipeline_kept", (doc) => doc.pipeline_kept], ["editor_disagrees", (doc) => doc.disagrees], ["update_of", (doc) => doc.story?.update_of],
  ["would_have_blocked", (doc) => doc.story?.would_have_blocked], ["access_overrides", (doc) => doc.story?.access_overrides],
  ["rank", (doc) => doc.rank], ["score", (doc) => doc.score], ["rated_by", (doc) => doc.story?.model_rating?.rated_by],
  ["model_category", (doc) => doc.story?.model_rating?.category], ["model_civic", (doc) => doc.story?.model_rating?.civic],
  ["model_appeal", (doc) => doc.story?.model_rating?.appeal], ["model_special", (doc) => doc.story?.model_rating?.special], ["model_rating_text", (doc) => doc.rating],
  ["pre_rank_score", (doc) => doc.pre_rank_score], ["pre_rank_civic", (doc) => doc.story?.pre_rank?.civic], ["pre_rank_appeal", (doc) => doc.story?.pre_rank?.appeal],
  ["pre_rank_special", (doc) => doc.story?.pre_rank?.special], ["pre_rank_rules", (doc) => doc.story?.pre_rank?.rules],
  ["evidence_text_quality", (doc) => doc.story?.evidence?.text_quality], ["evidence_extraction", (doc) => doc.story?.evidence?.extraction],
  ["evidence_missing", (doc) => doc.story?.evidence?.missing],
  ["details_people", (doc) => doc.story?.details?.people], ["details_organisations", (doc) => doc.story?.details?.organisations], ["details_places", (doc) => doc.story?.details?.places],
  ["details_when", (doc) => doc.story?.details?.when], ["details_numbers", (doc) => doc.story?.details?.numbers], ["details_what", (doc) => doc.story?.details?.what],
  ["details_quote", (doc) => doc.story?.details?.quote ? `${doc.story.details.quote.text} (${doc.story.details.quote.by})` : null], ["details_next_step", (doc) => doc.story?.details?.next_step],
  ["written_disposition", (doc) => doc.story?.writing?.disposition], ["written_headline", (doc) => doc.story?.writing?.headline],
  ["written_summary", (doc) => doc.story?.writing?.summary], ["writing_errors", (doc) => doc.story?.writing?.errors],
  ["text_excerpt", (doc) => doc.story?.text_excerpt],
  ["decision", (doc) => doc.decision], ["reason_code", (doc) => doc.reason_code], ["reason_label", (doc) => doc.reason_label], ["reason_note", (doc) => doc.reason],
  ["reviewed_by", (doc) => doc.by], ["reviewed_at", (doc) => doc.at],
];
export const CSV_COLUMNS = COLUMNS.map(([name]) => name);

/** One CSV cell. Text that a spreadsheet would run as a formula is prefixed with a quote mark. */
export function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  let text = Array.isArray(value) ? value.join("; ") : String(value);
  if ((typeof value === "string" || Array.isArray(value)) && /^[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function storyReviewCsv(docs: StoryDecisionDoc[], exportedAt = new Date().toISOString()) {
  const rows = docs.map((doc) => COLUMNS.map(([, value]) => csvCell(value(doc, exportedAt))).join(","));
  return `${[CSV_COLUMNS.join(","), ...rows].join("\r\n")}\r\n`;
}

/** One JSON object per line: the whole snapshot, for training and analysis without flattening. */
export function storyReviewJsonl(docs: StoryDecisionDoc[], exportedAt = new Date().toISOString()) {
  return docs.map(({ _id, ...doc }) => JSON.stringify({ id: _id, exported_at: exportedAt, ...doc, editor_category_label: doc.category ? sectionLabel(doc.category as never) : null })).join("\n") + (docs.length ? "\n" : "");
}

/** Reviewed stories for a run, or for every run at a location, oldest review first. */
export async function reviewedStories(db: Db, filter: { runId?: string; locationId?: string }) {
  const query = filter.runId ? { run_id: filter.runId } : { location_id: filter.locationId };
  return storyDecisions(db).find(query).sort({ run_day: 1, at: 1 }).toArray();
}
