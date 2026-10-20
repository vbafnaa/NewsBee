/**
 * Pipeline runs: one per trigger per location. A run tracks every source task, the
 * authoring draft and the published edition, and is what the health page summarises.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { SourceResult, SourceTask, SourceType } from "../connectors/types";
import { COLLECTIONS } from "../storage/mongo";

export type RunStatus = "collecting" | "authoring" | "publishing" | "published" | "failed" | "cancelled";
export const ACTIVE_RUN_STATUSES: RunStatus[] = ["collecting", "authoring", "publishing"];
export type SourceStatus = "pending" | "completed" | "failed";

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
};

export type PipelineRun = {
  _id: string;
  location_id: string;
  location_name: string;
  trigger: { by: string; kind: "manual" | "all" | "cron" };
  status: RunStatus;
  today: string;
  window: [string, string];
  sources: RunSource[];
  draft_id: string | null;
  edition_id: string | null;
  published: {
    items: number;
    held: number;
    held_reasons: Record<string, number>;
    channels: string[];
    artifacts: Record<string, string>;
  } | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  authoring_started_at: number | null;
  completed_at: number | null;
};

const now = () => Date.now() / 1000;

export function runs(db: Db) {
  return db.collection<PipelineRun>(COLLECTIONS.runs);
}

export async function ensureRunIndexes(db: Db) {
  // Install the stronger index before retiring the earlier collecting-only one.
  await runs(db).createIndexes([
    { key: { location_id: 1, created_at: -1 } },
    { key: { status: 1, created_at: -1 } },
    {
      key: { location_id: 1 },
      unique: true,
      name: "one_active_run_per_location",
      partialFilterExpression: { status: { $in: ACTIVE_RUN_STATUSES } },
    },
  ]);
  if ((await runs(db).indexes()).some((index) => index.name === "one_collecting_run_per_location")) {
    try {
      await runs(db).dropIndex("one_collecting_run_per_location");
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
): PipelineRun {
  const created = now();
  return {
    _id: randomUUID(),
    location_id: location.id,
    location_name: location.name,
    trigger,
    status: "collecting",
    today,
    window,
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
    draft_id: null,
    edition_id: null,
    published: null,
    error: null,
    created_at: created,
    updated_at: created,
    authoring_started_at: null,
    completed_at: null,
  };
}

export async function getRun(db: Db, runId: string) {
  return runs(db).findOne({ _id: runId });
}

export async function updateSource(db: Db, runId: string, sourceId: string, values: Partial<RunSource>) {
  const set: Record<string, unknown> = { updated_at: now() };
  for (const [key, value] of Object.entries(values)) set[`sources.$[source].${key}`] = value;
  await runs(db).updateOne({ _id: runId, status: "collecting" }, { $set: set }, { arrayFilters: [{ "source.source_id": sourceId }] });
}

/**
 * Atomically move a run from collecting to authoring once every source is finished
 * (completed or failed). Returns true for exactly one caller.
 */
export async function startAuthoringWhenReady(db: Db, runId: string): Promise<boolean> {
  const updated = await runs(db).updateOne(
    { _id: runId, status: "collecting", sources: { $not: { $elemMatch: { status: "pending" } } } },
    { $set: { status: "authoring", authoring_started_at: now(), updated_at: now() } },
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
}

export class RunConflict extends Error {}

/** A terminal transition; competing publication must acquire the publishing stage first. */
export async function cancelRun(db: Db, runId: string, by: string) {
  const current = now();
  const result = await runs(db).findOneAndUpdate(
    { _id: runId, status: { $in: ["collecting", "authoring"] } },
    { $set: { status: "cancelled", error: `Cancelled by ${by}`, completed_at: current, updated_at: current } },
    { returnDocument: "after" },
  );
  if (result) return result;
  if (!(await getRun(db, runId))) throw new Error(`Unknown run: ${runId}`);
  throw new RunConflict("Only collecting or authoring runs can be cancelled; publication may already have started");
}

export async function recentRuns(db: Db, options: { locationId?: string; limit?: number } = {}) {
  return runs(db)
    .find(options.locationId ? { location_id: options.locationId } : {})
    .sort({ created_at: -1 })
    .limit(options.limit ?? 20)
    .toArray();
}
