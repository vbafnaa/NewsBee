/**
 * Everything a run pulled, for checking that collection gets every relevant story: one row per link
 * (copies of the same link from several sources merged, each copy listed), with its outcome and the
 * editor's decision, and one row per source with what it found, kept and left out and why.
 */
import type { Db } from "mongodb";
import { getRun } from "../orchestration/runs";
import { collectedItems, type CollectedItem, type Replication } from "./assemble";
import { bestItem, linkKey, STATUS_ORDER, storyDecisionsForRun, type StoryDecisionDoc } from "./story-reviews";

/** Runs are capped well below this; it keeps one huge run from loading without limit. */
const MAX_ITEMS = 8000;

export type PulledCopy = Pick<CollectedItem, "_id" | "source_id" | "source_name" | "status" | "reason" | "step" | "event_date"> & { section: string | null; rank: number | null };
export type PulledGroup = {
  key: string; url: string | null; title: string; event_date: string | null; item_id: string;
  status: string; step: string; reason: string | null; section: string | null; rank: number | null; score: number | null; why: string | null;
  story_id: string | null; copies: number; sources: number; source_names: string[]; items: PulledCopy[];
  replication: Replication | null; pre_rank: number | null; review: Pick<StoryDecisionDoc, "decision" | "reason_code" | "reason_label" | "reason" | "by" | "at"> | null;
};
export type PulledSource = { source_id: string; name: string; url: string | null; collection: string | null; detail: string | null; found: number; kept: number; dropped: number; published: number; reasons: Array<{ reason: string; count: number }> };
export type PulledFilters = { q?: string | null; status?: string | null; source?: string | null; decision?: string | null; reason?: string | null; offset?: number; limit?: number };

/** A reason without the headline quoted in it, so the same reason counts together. */
export function reasonKind(reason: string | null | undefined, step: string) {
  if (!reason) return step === "reader" ? "left out by the reader" : step;
  return reason.replace(/\s*\(printed in the edition of .*\)$/, "").replace(/"[^"]*"/g, "\"…\"").replace(/\s+/g, " ").trim().slice(0, 140);
}

function topReasons(items: CollectedItem[], limit = 6) {
  const counts = new Map<string, number>();
  for (const item of items) { const key = reasonKind(item.reason, item.step); counts.set(key, (counts.get(key) ?? 0) + 1); }
  return [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, limit);
}

export async function pulledStories(db: Db, runId: string, filters: PulledFilters = {}) {
  const run = await getRun(db, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  const items = await collectedItems(db).find({ run_id: runId }, { projection: { facts: 0, evidence: 0, locality: 0 } }).limit(MAX_ITEMS).toArray();
  const decisions = await storyDecisionsForRun(db, runId);

  // One row per link.
  const byKey = new Map<string, typeof items>();
  for (const item of items) { const key = linkKey(item); byKey.set(key, [...(byKey.get(key) ?? []), item]); }
  const groups: PulledGroup[] = [...byKey].map(([key, copies]) => {
    const lead = bestItem(copies);
    const review = decisions.get(key);
    return {
      key, url: lead.url, title: lead.title, event_date: lead.event_date ?? copies.find((item) => item.event_date)?.event_date ?? null, item_id: lead._id,
      status: lead.status, step: lead.step, reason: lead.reason, section: lead.section ?? null, rank: lead.rank ?? null, score: lead.score ?? null, why: lead.why ?? null,
      story_id: lead.story_id ?? null, copies: copies.length, sources: new Set(copies.map((item) => item.source_id)).size, source_names: [...new Set(copies.map((item) => item.source_name))],
      items: copies.map((item) => ({ _id: item._id, source_id: item.source_id, source_name: item.source_name, status: item.status, reason: item.reason, step: item.step, event_date: item.event_date, section: item.section ?? null, rank: item.rank ?? null })),
      replication: lead.replication ?? null, pre_rank: typeof lead.pre_rank?.score === "number" ? lead.pre_rank.score : null,
      review: review ? { decision: review.decision, reason_code: review.reason_code, reason_label: review.reason_label, reason: review.reason, by: review.by, at: review.at } : null,
    };
  });

  const q = filters.q?.trim().toLowerCase();
  const reason = filters.reason?.trim().toLowerCase();
  const shown = groups.filter((group) =>
    (!q || group.title.toLowerCase().includes(q) || (group.url ?? "").toLowerCase().includes(q))
    && (!filters.status || group.status === filters.status)
    && (!filters.source || group.items.some((item) => item.source_id === filters.source))
    && (!reason || group.items.some((item) => reasonKind(item.reason, item.step).toLowerCase().includes(reason)))
    && (!filters.decision || (filters.decision === "unreviewed" ? !group.review : group.review?.decision === filters.decision)))
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) ||(a.section ?? "").localeCompare(b.section ?? "") || (a.rank ?? 9999) - (b.rank ?? 9999) || b.copies - a.copies || a.title.localeCompare(b.title));

  // One row per source, in the run's collection order, with sources that returned nothing included.
  const bySource = new Map<string, CollectedItem[]>();
  for (const item of items) bySource.set(item.source_id, [...(bySource.get(item.source_id) ?? []), item]);
  const snapshot = new Map((run.source_snapshot ?? []).map((source) => [source.source_id, source]));
  const ids = [...new Set([...(run.sources ?? []).map((source) => source.source_id), ...bySource.keys()])];
  const sources: PulledSource[] = ids.map((id) => {
    const record = run.sources?.find((source) => source.source_id === id);
    const list = bySource.get(id) ?? [];
    const dropped = list.filter((item) => item.status === "dropped");
    return {
      source_id: id, name: record?.name ?? list[0]?.source_name ?? id, url: snapshot.get(id)?.url ?? null,
      collection: record?.result_status ?? record?.status ?? null, detail: record?.detail ?? record?.error ?? null,
      found: list.length, kept: list.length - dropped.length, dropped: dropped.length, published: list.filter((item) => item.status === "published").length, reasons: topReasons(dropped),
    };
  }).sort((a, b) => b.found - a.found || a.name.localeCompare(b.name));

  const stepCount = (step: string) => items.filter((item) => item.step === step).length;
  const offset = Math.max(0, filters.offset ?? 0), limit = Math.min(500, Math.max(1, filters.limit ?? 100));
  return {
    run: { id: run._id, location_id: run.location_id, location_name: run.location_name, today: run.today },
    summary: {
      items: items.length, links: groups.length,
      repeated_links: groups.filter((group) => group.copies > 1).length, repeated_copies: groups.reduce((sum, group) => sum + group.copies - 1, 0),
      merged_into_stories: stepCount("merge"), repeats_of_printed: new Set(items.filter((item) => item.step === "ledger").map((item) => item.story_id ?? item._id)).size,
      title_rejected: items.filter((item) => item.step === "title" || /^title is |^title under /.test(item.reason ?? "")).length,
      by_status: Object.fromEntries(STATUS_ORDER.map((status) => [status, items.filter((item) => item.status === status).length]).filter(([, count]) => count)),
      reviewed: { accept: [...decisions.values()].filter((doc) => doc.decision === "accept").length, reject: [...decisions.values()].filter((doc) => doc.decision === "reject").length },
      truncated: items.length >= MAX_ITEMS,
    },
    sources, total: shown.length, offset, groups: shown.slice(offset, offset + limit),
  };
}

function statusRank(status: string) { const index = STATUS_ORDER.indexOf(status); return index < 0 ? STATUS_ORDER.length : index; }
