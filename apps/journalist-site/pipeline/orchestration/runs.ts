/**
 * Pipeline runs: one per trigger per location. A map run only writes the source map; an edition
 * run reads it, and tracks every source task, the authoring draft and the published edition.
 * The health page summarises both.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { SourceResult, SourceTask, SourceType } from "../connectors/types";
import { logger } from "../core/log";
import type { RunOptions } from "../core/run-values";
import { COLLECTIONS } from "../storage/mongo";
import { cancelRunJobs, type JobKind } from "./jobs";
import { editionPeriodStart } from "../core/time";
import { collectedItems } from "../editions/assemble";
import type { ExecutionBinding } from "../accounts/execution";
import type { CategoryCoverage } from "../sourcemap/store";
import { PLAYBOOK_VERSION } from "../playbook";

/** Count retained inputs in the store authoring reads, not connector/run summary counters. */
export async function collectionCandidateCount(db: Db, runId: string): Promise<number> {
  return collectedItems(db).countDocuments({ run_id: runId, status: { $ne: "dropped" }, facts: { $ne: null } });
}

export type RunStatus = "mapping" | "mapped" | "collecting" | "awaiting_authoring" | "authoring" | "awaiting_finish" | "finishing" | "publishing" | "built" | "published" | "failed" | "cancelled";
export const PROCESSING_RUN_STATUSES: RunStatus[] = ["mapping", "collecting", "authoring", "finishing", "publishing"];
export const ACTIVE_RUN_STATUSES: RunStatus[] = [...PROCESSING_RUN_STATUSES, "awaiting_authoring", "awaiting_finish"];
export const CANCELLABLE_RUN_STATUSES = ACTIVE_RUN_STATUSES.filter((status) => status !== "publishing");
/**
 * Runs that finished: a map run is `mapped`; an edition run is `built` (written, waiting for someone to
 * publish it) and `published` once a person published it to the reader.
 */
export const FINISHED_RUN_STATUSES: RunStatus[] = ["mapped", "built", "published"];
/** Runs that may be restarted as a new run. */
export const RESTARTABLE_RUN_STATUSES: RunStatus[] = [...FINISHED_RUN_STATUSES, "failed", "cancelled"];

/** The jobs each stage may run. Discovery stays under collecting for runs started before map runs. */
const STAGE_KINDS: Partial<Record<RunStatus, JobKind[]>> = {
  mapping: ["discover", "agent_round", "review_map", "finish_map"],
  collecting: ["discover", "agent_round", "plan_sources", "collect_source"],
  authoring: ["author_start", "author_rank", "author_story", "image_story", "stock_story"],
  finishing: ["author_finish"],
  publishing: ["author_finish"],
};
export function stageKinds(run: Pick<PipelineRun, "status">): JobKind[] { return STAGE_KINDS[run.status] ?? []; }

/** Runs with work to do. Editions come before map runs, then oldest first, so each finishes in turn. */
export async function workableRuns(db: Db) {
  return runs(db).aggregate<PipelineRun>([
    { $match: { status: { $in: PROCESSING_RUN_STATUSES }, execution_blocked: { $exists: false } } },
    { $addFields: { is_map: { $eq: ["$kind", "map"] } } },
    { $sort: { is_map: 1, created_at: 1, _id: 1 } },
    { $lookup: {
      from: COLLECTIONS.jobs, let: { runId: "$_id", stage: "$status" }, as: "work",
      pipeline: [
        { $match: { status: { $in: ["pending", "running"] }, $expr: { $and: [
          { $eq: ["$run_id", "$$runId"] },
          { $or: Object.entries(STAGE_KINDS).map(([stage, kinds]) => ({ $and: [{ $eq: ["$$stage", stage] }, { $in: ["$kind", kinds] }] })) },
        ] } } },
        { $limit: 1 },
      ],
    } },
    { $match: { "work.0": { $exists: true } } },
    { $project: { work: 0, is_map: 0 } },
  ]).toArray();
}

/** `not_reached`: collection ran out of time before this source's turn. */
export type SourceStatus = "pending" | "completed" | "failed" | "not_reached";

export type RunSource = {
  source_id: string;
  name: string;
  type: SourceType;
  job_id: string | null;
  status: SourceStatus;
  /** Connector outcome (e.g. "ok", "no_feed", "failed") once collected. */
  result_status: string | null;
  detail: string | null;
  event_count: number;
  shortlisted: number;
  link_discovery: SourceResult["link_discovery"] | null;
  error: string | null;
  /** Streak-based health after this collection: failing (3+ failures) or quiet (4+ empty runs). */
  health?: "healthy" | "failing" | "quiet";
};

/** A source as it stood when the run planned collection; the map itself changes later. */
export type RunSourceSnapshot = { source_id: string; name: string; url: string | null; reader: string; status: string; section: string; found_by: string; detail: string; tier: string | null; topics: string[]; collected: boolean; skip_reason: string | null };

export type PipelineRun = {
  _id: string;
  admission?: "newsroom";
  execution?: ExecutionBinding;
  execution_blocked?: { reason: string; at: number };
  /** A map run only writes the source map. Absent on runs from before the split, which were editions. */
  kind?: "map" | "edition";
  /** A finished map run's sources per category, as they stood when it ended. */
  category_coverage?: CategoryCoverage[];
  location_id: string;
  location_name: string;
  trigger: { by: string; kind: "manual" | "all" | "cron" };
  /** Chosen at kick-off and fixed for the run. Absent on runs from before run options. */
  options?: RunOptions;
  /** Content hash of the playbook this run used, so its results can be tied to a set of rules. Absent on older runs. */
  playbook_version?: string;
  source_snapshot?: RunSourceSnapshot[];
  status: RunStatus;
  today: string;
  window: [string, string];
  /** The `today` of this location's last published run; connectors looking back since the last edition start here. */
  last_edition_day?: string | null;
  sources: RunSource[];
  collection_tasks?: SourceTask[];
  /** False until the source map has been read into collection tasks (after discovery). */
  planned?: boolean;
  /** A test-mode map run (NEWSBEE_SOURCE_RUNS_ISOLATED): its sources are in its own store, not the source map. */
  isolated?: boolean;
  /** Map runs: the discovery methods this run refreshes. */
  discovery?: string[];
  /** Edition runs: the version of the source map this run read. */
  map_version?: number | null;
  /** When the first source started, which starts collection's time budget. */
  collect_started_at?: number;
  /** Editor overrides applied when items are assembled. */
  overrides?: { include?: string[]; exclude?: string[]; pin?: string[] };
  draft_id: string | null;
  edition_id: string | null;
  published: {
    items: number;
    held: number;
    held_reasons: Record<string, number>;
    /** The reader folder the edition was published to (older runs: channel ids). */
    reader_folder?: string;
    channels?: string[];
    artifacts: Record<string, string>;
  } | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  authoring_started_at: number | null;
  /** Resets only on an editor-triggered stage, never on a resume. */
  stage_started_at?: number;
  stage_transitions?: { status: RunStatus; by: string; at: number }[];
  completed_at: number | null;
};

const now = () => Date.now() / 1000;
const log = logger("runs");

export function runs(db: Db) {
  return db.collection<PipelineRun>(COLLECTIONS.runs);
}

export async function ensureRunIndexes(db: Db) {
  await runs(db).createIndex({ admission: 1 }, {
    unique: true, name: "one_unfinished_newsroom_run",
    partialFilterExpression: { admission: "newsroom", status: { $in: ACTIVE_RUN_STATUSES } },
  });
  await runs(db).createIndexes([
    { key: { location_id: 1, created_at: -1 } },
    { key: { status: 1, created_at: -1 } },
  ]);
  // The index's statuses grew with map runs, and an index's filter can't be changed in place.
  const open = (await runs(db).indexes()).find((index) => index.name === "one_open_run_per_location");
  if (open && !JSON.stringify(open.partialFilterExpression ?? {}).includes("mapping")) {
    await runs(db).dropIndex("one_open_run_per_location").catch((error: { codeName?: string }) => { if (error.codeName !== "IndexNotFound") throw error; });
  }
  // Index builds are repeated across serverless instances. Reconciliation is idempotent,
  // and the collecting-only index remains in place until the stronger index exists.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const active = await runs(db).find({ status: { $in: ACTIVE_RUN_STATUSES } }).toArray();
    if (active.length > 1) {
      await runs(db).updateMany({ _id: { $in: active.map((run) => run._id) } }, {
        $set: { execution_blocked: { reason: "Historical unfinished runs conflict with the global newsroom slot. Cancel excess runs explicitly before reconnecting or claiming the remaining run.", at: now() } },
      });
      log.error("historical_newsroom_conflict", { runs: active.map((run) => run._id) });
      return;
    }
    if (active[0] && !active[0].execution) await runs(db).updateOne({ _id: active[0]._id }, {
      $set: { execution_blocked: { reason: "Legacy run has no credential sponsor. The owner must explicitly claim it or cancel it.", at: now() } },
    });
    try {
      await runs(db).createIndex(
        { location_id: 1 },
        {
          unique: true,
          name: "one_open_run_per_location",
          partialFilterExpression: { status: { $in: ACTIVE_RUN_STATUSES } },
        },
      );
      break;
    } catch (error) {
      if ((error as { code?: number }).code !== 11000 || attempt === 2) throw error;
    }
  }
  for (const name of ["one_collecting_run_per_location", "one_active_run_per_location"]) {
    if (!(await runs(db).indexes()).some((index) => index.name === name)) continue;
    try {
      await runs(db).dropIndex(name);
    } catch (error) {
      if ((error as { codeName?: string }).codeName !== "IndexNotFound") throw error;
    }
  }
}

export function newRun(
  location: { id: string; name: string },
  trigger: PipelineRun["trigger"],
  today: string,
  window: [string, string],
  tasks: SourceTask[],
  lastEditionDay: string | null = null,
  discovery: string[] | null = null,
  options?: RunOptions,
): PipelineRun {
  const created = now();
  return {
    ...(discovery ? { planned: false, discovery } : {}),
    ...(options ? { options } : {}),
    playbook_version: PLAYBOOK_VERSION,
    _id: randomUUID(),
    kind: "edition",
    location_id: location.id,
    location_name: location.name,
    trigger,
    status: "collecting",
    today,
    window,
    last_edition_day: lastEditionDay,
    sources: tasks.map((task) => ({
      source_id: task.source_id,
      name: task.name,
      type: task.type,
      job_id: null,
      status: "pending",
      result_status: null,
      detail: null,
      event_count: 0,
      shortlisted: 0,
      link_discovery: null,
      error: null,
    })),
    collection_tasks: tasks,
    draft_id: null,
    edition_id: null,
    published: null,
    error: null,
    created_at: created,
    updated_at: created,
    authoring_started_at: null,
    stage_started_at: created,
    stage_transitions: [{ status: "collecting", by: trigger.by, at: created }],
    completed_at: null,
  };
}

export async function getRun(db: Db, runId: string) {
  return runs(db).findOne({ _id: runId });
}

export function runSource(task: SourceTask): RunSource {
  return { source_id: task.source_id, name: task.name, type: task.type, job_id: null, status: "pending", result_status: null, detail: null, event_count: 0, shortlisted: 0, link_discovery: null, error: null };
}

/** Records the planned collection tasks once (after discovery). Returns false when already planned. */
export async function planRun(db: Db, runId: string, tasks: SourceTask[], jobIds: Map<string, string>) {
  const result = await runs(db).updateOne({ _id: runId, status: "collecting", planned: false }, { $set: { planned: true, collection_tasks: tasks, sources: tasks.map((task) => ({ ...runSource(task), job_id: jobIds.get(task.source_id) ?? null })), updated_at: now() } });
  return result.modifiedCount === 1;
}

/** Sources collection didn't get to. They aren't failures, and are shown as not reached. */
export async function markNotReached(db: Db, runId: string, sourceIds: string[], detail: string) {
  if (!sourceIds.length) return;
  await runs(db).updateOne({ _id: runId, status: "collecting" }, {
    $set: { "sources.$[source].status": "not_reached", "sources.$[source].result_status": "not_reached", "sources.$[source].detail": detail, updated_at: now() },
  }, { arrayFilters: [{ "source.source_id": { $in: sourceIds }, "source.status": "pending" }] });
}

export async function updateSource(db: Db, runId: string, sourceId: string, values: Partial<RunSource>) {
  const set: Record<string, unknown> = { updated_at: now() };
  for (const [key, value] of Object.entries(values)) set[`sources.$[source].${key}`] = value;
  await runs(db).updateOne({ _id: runId, status: "collecting" }, { $set: set }, { arrayFilters: [{ "source.source_id": sourceId }] });
}

/**
 * Atomically stop at the editor gate once every source is finished
 * (completed or failed). Returns true for exactly one caller.
 */
export async function awaitAuthoringWhenReady(db: Db, runId: string): Promise<boolean> {
  const at = now();
  const updated = await runs(db).updateOne(
    { _id: runId, status: "collecting", planned: { $ne: false }, sources: { $not: { $elemMatch: { status: "pending" } } } },
    { $set: { status: "awaiting_authoring", updated_at: at }, $push: { stage_transitions: { status: "awaiting_authoring", by: "worker", at } } },
  );
  return updated.modifiedCount === 1;
}

export async function setRun(db: Db, runId: string, values: Partial<PipelineRun>) {
  await runs(db).updateOne({ _id: runId, status: { $in: ACTIVE_RUN_STATUSES } }, { $set: { ...values, updated_at: now() } });
}

export async function failRun(db: Db, runId: string, error: string) {
  await runs(db).updateOne(
    { _id: runId, status: { $in: ACTIVE_RUN_STATUSES } },
    { $set: { status: "failed", error, completed_at: now(), updated_at: now() } },
  );
  await cancelRunJobs(db, runId);
}

/** Runs that are still open, for counting only the work that can still happen. */
export async function openRunIds(db: Db) {
  return (await runs(db).find({ status: { $in: ACTIVE_RUN_STATUSES } }, { projection: { _id: 1 } }).toArray()).map((run) => run._id);
}

export class RunConflict extends Error {}

/** A terminal transition; competing publication must acquire the publishing stage first. */
export async function cancelRun(db: Db, runId: string, by: string) {
  const current = now();
  const result = await runs(db).findOneAndUpdate(
    { _id: runId, status: { $in: CANCELLABLE_RUN_STATUSES } },
    { $set: { status: "cancelled", error: `Cancelled by ${by}`, completed_at: current, updated_at: current } },
    { returnDocument: "after" },
  );
  if (result) return result;
  if (!(await getRun(db, runId))) throw new Error(`Unknown run: ${runId}`);
  throw new RunConflict("Only waiting or in-progress stages can be cancelled; publication may already have started");
}

export type CurrentRun = Pick<PipelineRun, "_id" | "location_id" | "location_name" | "kind" | "status" | "created_at" | "execution_blocked">;

export async function currentRuns(db: Db): Promise<CurrentRun[]> {
  return runs(db)
    .find({ status: { $in: ACTIVE_RUN_STATUSES } })
    .sort({ created_at: -1, _id: -1 })
    .project<CurrentRun>({ _id: 1, location_id: 1, location_name: 1, kind: 1, status: 1, created_at: 1, execution_blocked: 1 })
    .toArray();
}

export async function recentRuns(db: Db, options: { locationId?: string; limit?: number; offset?: number } = {}) {
  return runs(db)
    .find(options.locationId ? { location_id: options.locationId } : {})
    .sort({ created_at: -1, _id: -1 })
    .skip(options.offset ?? 0)
    .limit(options.limit ?? 20)
    .toArray();
}

/**
 * The `today` of the location's most recent published run from an earlier edition period,
 * or null before its first edition. A rerun in the same week looks back past the edition
 * it replaces, so it sees everything that edition saw.
 */
export async function lastEditionDay(db: Db, locationId: string, today: string) {
  const last = await runs(db).findOne(
    // Comparison runs don't count toward story history.
    { location_id: locationId, status: "published", today: { $lt: editionPeriodStart(today) }, "options.count_history": { $ne: false } },
    { sort: { today: -1, completed_at: -1 }, projection: { today: 1 } },
  );
  return last?.today ?? null;
}
