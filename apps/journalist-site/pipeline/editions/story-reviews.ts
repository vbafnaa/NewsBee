/**
 * An editor's Accept or Reject on a story a run pulled, with a reason code (`story-reasons.ts`) and a
 * note, tied to the run, the story and the editor. Separate from the source map's labels.
 *
 *   story_decisions   the current decision per run and link: `<run id>:<link key>`. Copies of one link
 *                     in a run share one decision. Each row is a snapshot of what the editor saw:
 *                     the story's date, sources, outcome, ranking and replication at that moment.
 *   story_reviews     every save, appended, so a changed mind is kept.
 *
 * The CSV export reads `story_decisions`. Source acceptance rates feed the local pre-ranker.
 */
import type { Db } from "mongodb";
import { getRun } from "../orchestration/runs";
import { normaliseUrl } from "../sourcemap/store";
import { collectedItems, type CollectedItem, type Replication } from "./assemble";
import { STORY_OTHER_CODES, storyDecisionOf, storyReasonLabel, type StoryDecision, type StoryReasonCode } from "./story-reasons";

export const STORY_DECISIONS = "story_decisions";
export const STORY_REVIEWS = "story_reviews";

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

export type StoryReviewChange = { decision: StoryDecision | null; reason_code: StoryReasonCode | null; reason: string | null };

/** Check a review sent by an editor. Throws an `Invalid ...` error otherwise. */
export function storyReviewChange(body: { decision?: unknown; reason_code?: unknown; reason?: unknown }): StoryReviewChange {
  const decision = body.decision ?? null;
  if (decision !== null && decision !== "accept" && decision !== "reject") throw new Error("Invalid decision: send accept, reject or null");
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") throw new Error("Invalid reason: send text or null");
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) || null : null;
  const code = typeof body.reason_code === "string" && body.reason_code ? body.reason_code : null;
  if (decision === null) return { decision: null, reason_code: null, reason: null };
  if (!code) throw new Error("Invalid reason code: choose a reason for this decision");
  if (storyDecisionOf(code) !== decision) throw new Error("Invalid reason code: it doesn't belong to this decision");
  if (STORY_OTHER_CODES.includes(code) && !reason) throw new Error("Invalid reason: explain the Other reason");
  return { decision, reason_code: code as StoryReasonCode, reason };
}

/** The run's items that share `itemId`'s link, so one decision covers every copy. */
async function copiesOf(db: Db, runId: string, itemId: string) {
  const item = await collectedItems(db).findOne({ _id: itemId, run_id: runId }, { projection: { facts: 0, evidence: 0 } });
  if (!item) throw new Error(`Invalid request: unknown item ${itemId}`);
  const key = linkKey(item);
  const copies = item.url
    ? (await collectedItems(db).find({ run_id: runId, url: { $ne: null } }, { projection: { facts: 0, evidence: 0 } }).toArray()).filter((other) => linkKey(other) === key)
    : [item];
  return { key, copies };
}

/**
 * Save an editor's decision on the story behind `itemId` in a run, for every copy of its link.
 * A null decision clears it. The history row is appended either way.
 */
export async function saveStoryReview(db: Db, runId: string, itemId: string, change: StoryReviewChange, by: string) {
  const run = await getRun(db, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  const { key, copies } = await copiesOf(db, runId, itemId);
  const lead = bestItem(copies);
  const snapshot = new Map((run.source_snapshot ?? []).map((source) => [source.source_id, source.url]));
  const preRank = lead.pre_rank?.score;
  const doc: StoryDecisionDoc = {
    _id: `${runId}:${key}`, run_id: runId, location_id: run.location_id, location_name: run.location_name, run_day: run.today,
    key, url: lead.url, title: lead.title, story_date: lead.event_date, story_id: lead.story_id ?? null, item_ids: copies.map((item) => item._id),
    section: lead.section ?? null, source_ids: [...new Set(copies.map((item) => item.source_id))], source_names: [...new Set(copies.map((item) => item.source_name))],
    source_urls: [...new Set(copies.map((item) => snapshot.get(item.source_id)).filter((url): url is string => Boolean(url)))],
    pipeline_status: lead.status, pipeline_step: lead.step, pipeline_reason: lead.reason, rank: lead.rank ?? null, score: lead.score ?? null, rating: lead.why ?? null,
    pre_rank_score: typeof preRank === "number" ? preRank : null, replication: lead.replication ?? null,
    decision: change.decision, reason_code: change.reason_code, reason_label: storyReasonLabel(change.reason_code), reason: change.reason, by, at: new Date().toISOString(),
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

export const CSV_COLUMNS = [
  "location", "location_id", "run_id", "run_date", "exported_at", "story_title", "story_url", "story_date", "section",
  "sources", "source_urls", "copies", "independent_publishers", "pipeline_status", "pipeline_step", "pipeline_reason",
  "rank", "score", "model_rating", "pre_rank_score", "decision", "reason_code", "reason_label", "reason_note", "reviewed_by", "reviewed_at",
] as const;

/** One CSV cell. Text that a spreadsheet would run as a formula is prefixed with a quote mark. */
export function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  let text = Array.isArray(value) ? value.join("; ") : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function storyReviewCsv(docs: StoryDecisionDoc[], exportedAt = new Date().toISOString()) {
  const rows = docs.map((doc) => [
    doc.location_name, doc.location_id, doc.run_id, doc.run_day, exportedAt, doc.title, doc.url, doc.story_date, doc.section,
    doc.source_names, doc.source_urls, doc.replication?.copies ?? doc.item_ids.length, doc.replication?.independent ?? null, doc.pipeline_status, doc.pipeline_step, doc.pipeline_reason,
    doc.rank, doc.score, doc.rating, doc.pre_rank_score, doc.decision, doc.reason_code, doc.reason_label, doc.reason, doc.by, doc.at,
  ].map(csvCell).join(","));
  return `${[CSV_COLUMNS.join(","), ...rows].join("\r\n")}\r\n`;
}

/** Reviewed stories for a run, or for every run at a location, oldest review first. */
export async function reviewedStories(db: Db, filter: { runId?: string; locationId?: string }) {
  const query = filter.runId ? { run_id: filter.runId } : { location_id: filter.locationId };
  return storyDecisions(db).find(query).sort({ run_day: 1, at: 1 }).toArray();
}
