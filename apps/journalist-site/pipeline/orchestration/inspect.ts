/**
 * Run inspection: list a run's items, trace one item from source to story, and the editor
 * actions that rerun part of a run without starting over.
 */
import type { Db } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import { collectedItems, type CollectedItem } from "../editions/assemble";
import { STORY_DETAILS } from "../editions/authoring";
import { EXTRACTION_POLICY, textFor } from "../editions/details";
import { sourceMap } from "../sourcemap/store";
import { CONNECTORS, windowOf } from "../connectors/registry";
import { describeWindow } from "../sourcemap/windows";
import { floorFlags } from "../editorial/floor";
import { enqueue, runJobs } from "./jobs";
import { getRun, RunConflict, runs } from "./runs";
import { IMAGE_RESULTS, imageResultId, type ImageResult } from "../images/pipeline";
import { getLocation } from "../communities/locations";

const now = () => Date.now() / 1000;

export async function listItems(db: Db, runId: string, filters: { q?: string | null; status?: string | null; source?: string | null; section?: string | null; limit?: number; offset?: number }) {
  const query: Record<string, unknown> = { run_id: runId };
  if (filters.status) query.status = filters.status;
  if (filters.source) query.source_id = filters.source;
  if (filters.section) query.section = filters.section;
  if (filters.q) query.title = { $regex: filters.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  const [items, total, counts] = await Promise.all([
    collectedItems(db).find(query, { projection: { facts: 0, evidence: 0 } }).sort({ status: 1, section: 1, rank: 1, title: 1 }).skip(filters.offset ?? 0).limit(filters.limit ?? 200).toArray(),
    collectedItems(db).countDocuments(query),
    collectedItems(db).aggregate<{ _id: string; count: number }>([{ $match: { run_id: runId } }, { $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
  ]);
  return { items, total, counts: Object.fromEntries(counts.map((row) => [row._id, row.count])) };
}

export async function itemTrace(db: Db, runId: string, itemId: string) {
  const item = await collectedItems(db).findOne({ _id: itemId, run_id: runId });
  if (!item) throw new Error(`Unknown item: ${itemId}`);
  const run = await getRun(db, runId);
  const source = await sourceMap(db).findOne({ _id: `${item.location_id}:${item.source_id}` });
  const connector = CONNECTORS[(source?.reader ?? item.source_id.split(":")[0]) as keyof typeof CONNECTORS];
  const window = connector ? describeWindow(windowOf(connector, { type: connector.type, source_id: item.source_id, name: "", params: { ...(source?.params ?? {}), ...(source?.window ? { window: source.window } : {}) } })) : null;
  const siblings: CollectedItem[] = item.merge_group ? await collectedItems(db).find({ run_id: runId, merge_group: item.merge_group, _id: { $ne: itemId } }, { projection: { facts: 0 } }).toArray() : [];
  const entry = item.story_id && run?.draft_id ? await db.collection(COLLECTIONS.editionEntries).findOne({ edition_id: run.draft_id, story_id: item.story_id }) : null;
  const details = item.story_id ? await db.collection(STORY_DETAILS).findOne({ _id: `${item.location_id}:${item.story_id}:${EXTRACTION_POLICY}` as never }) : null;
  const text = await textFor(db, item.url);
  const image = item.story_id && run?.draft_id ? await db.collection<ImageResult>(IMAGE_RESULTS).findOne({ _id: imageResultId(run.draft_id, item.story_id) }) : null;
  const shadow = item.story_id && run?.draft_id ? await db.collection<ImageResult>("story_image_shadow_results").findOne({ _id: imageResultId(run.draft_id, item.story_id) }) : null;
  const agentId = shadow?.agent?.state_id ?? image?.agent?.state_id;
  const imageAgent = agentId ? await db.collection("image_agent_states").findOne({ _id: agentId as never }, { projection: { steps: 0 } }) : null;
  return {
    item, window, source: source ? { name: source.name, url: source.url, reader: source.reader, found_by: source.found_by, status: source.status, inside_area: source.inside_area, section: source.section } : null,
    siblings, details: details?.details ?? entry?.result?.details ?? item.facts?.details ?? null,
    floor: entry?.result?.floor ?? (item.facts ? floorFlags({ title: item.title, description: String(item.facts.description ?? ""), kind: String(item.facts.kind ?? "") }) : null),
    writing: entry ? { disposition: entry.disposition, draft: entry.result?.draft ?? null, errors: entry.result?.validation_errors ?? [], error: entry.result?.error ?? null, attempts: entry.result?.attempts ?? 0, rejected_first: entry.result?.rejected_first ?? null, ranking: entry.result?.ranking ?? null } : null,
    text_excerpt: text ? text.slice(0, 1200) : null,
    overrides: run?.overrides ?? {},
    image,
    image_agent: imageAgent,
    image_shadow: shadow,
  };
}

/** Collect one source again (during collection or while waiting for authoring). */
export async function recollectSource(db: Db, runId: string, sourceId: string, by: string) {
  const run = await getRun(db, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  await getLocation(db, run.location_id);
  if (!["collecting", "awaiting_authoring"].includes(run.status)) throw new RunConflict("Sources can be collected again only before authoring starts");
  const task = (run.collection_tasks ?? []).find((item) => item.source_id === sourceId);
  if (!task) throw new Error(`Source is not part of this run: ${sourceId}`);
  const at = now();
  await runs(db).updateOne({ _id: runId, status: { $in: ["collecting", "awaiting_authoring"] } }, {
    $set: { status: "collecting", updated_at: at, "sources.$[source].status": "pending" },
    $push: { stage_transitions: { status: "collecting", by, at } },
  }, { arrayFilters: [{ "source.source_id": sourceId }] });
  const jobId = await enqueue(db, { kind: "collect_source", run_id: runId, location_id: run.location_id, payload: { task }, dedupe_key: `collect:${runId}:${sourceId}:${Math.round(at)}` });
  await runs(db).updateOne({ _id: runId }, { $set: { "sources.$[source].job_id": jobId } }, { arrayFilters: [{ "source.source_id": sourceId }] });
  return { job_id: jobId };
}

/** Throw away the draft and assemble again (after editor overrides, or new sources). */
export async function reassemble(db: Db, runId: string, by: string) {
  const run = await getRun(db, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  await getLocation(db, run.location_id);
  if (!["awaiting_authoring", "awaiting_finish", "authoring", "failed"].includes(run.status)) throw new RunConflict("Reassemble before publishing: the run must be waiting for authoring or for the front page");
  const at = now();
  const admitted = await runs(db).updateOne({ _id: runId, status: run.status, updated_at: run.updated_at }, {
    $set: { status: "awaiting_authoring", admission: "newsroom", updated_at: at },
  });
  if (!admitted.matchedCount) throw new RunConflict("The run changed before reassembly. Reload and retry.");
  if (run.draft_id) {
    await db.collection(COLLECTIONS.editions).deleteOne({ id: run.draft_id, status: { $ne: "published" } });
    await db.collection(COLLECTIONS.editionEntries).deleteMany({ edition_id: run.draft_id });
    await db.collection(IMAGE_RESULTS).deleteMany({ edition_id: run.draft_id });
    await db.collection("edition_photo_claims").deleteMany({ edition_id: run.draft_id });
    await db.collection("story_image_shadow_results").deleteMany({ edition_id: run.draft_id });
    await db.collection("image_agent_states").deleteMany({ run_id: runId });
  }
  await db.collection(COLLECTIONS.jobs).updateMany({ run_id: runId, kind: { $in: ["author_start", "author_rank", "author_story", "image_story", "stock_story"] }, status: { $in: ["pending", "running"] } }, { $set: { status: "cancelled" } });
  await db.collection(COLLECTIONS.jobs).deleteMany({ run_id: runId, kind: { $in: ["author_start", "author_rank", "author_story", "image_story", "stock_story"] } });
  await collectedItems(db).updateMany({ run_id: runId, step: { $ne: "reader" } }, { $set: { status: "collected", reason: null, step: "reader", section: null, rank: null, score: null, why: null } });
  await runs(db).updateOne({ _id: runId }, { $set: { status: "awaiting_authoring", draft_id: null, error: null, updated_at: at }, $push: { stage_transitions: { status: "awaiting_authoring", by, at } } });
  return { reassemble: true };
}

export async function setOverride(db: Db, runId: string, kind: "include" | "exclude" | "pin", itemId: string, on = true) {
  const run = await getRun(db, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  await getLocation(db, run.location_id);
  if (!(await collectedItems(db).findOne({ _id: itemId, run_id: runId }, { projection: { _id: 1 } }))) throw new Error(`Unknown item: ${itemId}`);
  const others = (["include", "exclude", "pin"] as const).filter((value) => value !== kind && !(kind === "pin" && value === "include"));
  await runs(db).updateOne({ _id: runId }, on
    ? { $addToSet: { [`overrides.${kind}`]: itemId }, $pull: Object.fromEntries(others.map((value) => [`overrides.${value}`, itemId])) as never }
    : { $pull: { [`overrides.${kind}`]: itemId } as never });
  return { overrides: (await getRun(db, runId))?.overrides ?? {} };
}

/** Extract details again and rewrite one story (while waiting for the front page). */
export async function rewriteStory(db: Db, runId: string, storyId: string, by: string) {
  const run = await getRun(db, runId);
  if (!run?.draft_id) throw new Error(`Unknown run or no draft: ${runId}`);
  await getLocation(db, run.location_id);
  if (!["awaiting_finish", "authoring"].includes(run.status)) throw new RunConflict("Stories can be rewritten while authoring or before the front page is written");
  await db.collection(COLLECTIONS.editionEntries).deleteOne({ edition_id: run.draft_id, story_id: storyId });
  await db.collection(STORY_DETAILS).deleteOne({ _id: `${run.location_id}:${storyId}:${EXTRACTION_POLICY}` as never });
  await db.collection(COLLECTIONS.storyCache).deleteMany({ location_id: run.location_id, "result.story.id": storyId });
  await db.collection(COLLECTIONS.editions).updateOne({ id: run.draft_id }, { $set: { status: "drafting" }, $inc: { image_revision: 1 } });
  await db.collection(COLLECTIONS.jobs).updateMany({ run_id: runId, kind: { $in: ["image_story", "stock_story"] }, status: { $in: ["pending", "running"] } }, { $set: { status: "cancelled" } });
  const at = now();
  await runs(db).updateOne({ _id: runId }, { $set: { status: "authoring", updated_at: at, stage_started_at: at }, $push: { stage_transitions: { status: "authoring", by, at } } });
  const steps = (await runJobs(db, runId)).filter((job) => job.kind === "author_story").map((job) => Number(job.payload.step ?? 0));
  const step = (steps.length ? Math.max(...steps) : -1) + 1;
  await enqueue(db, { kind: "author_story", run_id: runId, location_id: run.location_id, payload: { draft_id: run.draft_id, step }, dedupe_key: `author_story:${runId}:${step}` });
  return { rewriting: storyId };
}
