/**
 * Product health at a glance: one row per location (last run, stage, published/held,
 * failed sources, model errors) plus scheduler, queue and model status.
 */
import type { Db } from "mongodb";
import { listLocations } from "../communities/locations";
import type { ComponentHealth, ModelRuntime } from "../model/runtime";
import { COLLECTIONS } from "../storage/mongo";
import { runs, type PipelineRun, type RunSource } from "./runs";

export type HealthLevel = "ok" | "warning" | "failed" | "idle";
type ModelHealth = Omit<ComponentHealth, "status"> & { status: ComponentHealth["status"] | "failed" };

export type LocationHealth = {
  location_id: string;
  location_name: string;
  level: HealthLevel;
  run_id: string | null;
  stage: PipelineRun["status"] | "never_run";
  started_at: number | null;
  completed_at: number | null;
  sources: { total: number; completed: number; failed: number; pending: number };
  failed_sources: { source_id: string; name: string; error: string | null }[];
  empty_sources: { source_id: string; name: string; detail: string | null }[];
  published_items: number | null;
  held: number | null;
  held_reasons: Record<string, number>;
  model_errors: string[];
  error: string | null;
};

/** Scheduler ticks are expected every minute; older than this means cron is not running. */
export const STALE_TICK_SECONDS = 180;

function sourceFailed(source: RunSource) {
  return source.status === "failed" || source.result_status === "failed";
}

function level(run: PipelineRun | null, modelErrors: string[]): HealthLevel {
  if (!run) return "idle";
  if (run.status === "failed") return "failed";
  const failed = run.sources.some(sourceFailed);
  if (failed || modelErrors.length || (run.published?.held ?? 0) > 0) return "warning";
  return "ok";
}

export async function locationHealth(db: Db, run: PipelineRun | null, location: { id: string; name: string }): Promise<LocationHealth> {
  let modelErrors: string[] = [];
  if (run?.draft_id) {
    const draft = await db.collection(COLLECTIONS.editions).findOne({ id: run.draft_id }, { projection: { model_errors: 1 } });
    modelErrors = Array.isArray(draft?.model_errors) ? draft.model_errors.map(String) : [];
  }
  const sources = run?.sources ?? [];
  return {
    location_id: location.id,
    location_name: location.name,
    level: level(run, modelErrors),
    run_id: run?._id ?? null,
    stage: run?.status ?? "never_run",
    started_at: run?.created_at ?? null,
    completed_at: run?.completed_at ?? null,
    sources: {
      total: sources.length,
      completed: sources.filter((source) => source.status === "completed" && !sourceFailed(source)).length,
      failed: sources.filter(sourceFailed).length,
      pending: sources.filter((source) => source.status === "pending").length,
    },
    failed_sources: sources.filter(sourceFailed).map((source) => ({ source_id: source.source_id, name: source.name, error: source.error ?? source.detail })),
    empty_sources: sources.filter((source) => source.status === "completed" && !sourceFailed(source) && source.event_count === 0).map((source) => ({ source_id: source.source_id, name: source.name, detail: source.detail })),
    published_items: run?.published?.items ?? null,
    held: run?.published?.held ?? null,
    held_reasons: run?.published?.held_reasons ?? {},
    model_errors: modelErrors,
    error: run?.error ?? null,
  };
}

export async function healthSummary(db: Db, model: ModelRuntime | null) {
  const locations = await listLocations(db);
  const rows: LocationHealth[] = [];
  for (const location of locations) {
    const latest = await runs(db).find({ location_id: location.id }).sort({ created_at: -1 }).limit(1).next();
    rows.push(await locationHealth(db, latest, location));
  }
  const heartbeat = await db.collection(COLLECTIONS.heartbeat).findOne({ _id: "scheduler" as never });
  const lastTick = typeof heartbeat?.last_tick_at === "number" ? heartbeat.last_tick_at : null;
  const age = lastTick === null ? null : Math.round(Date.now() / 1000 - lastTick);
  const counts = await db.collection(COLLECTIONS.jobs).aggregate<{ _id: string; count: number }>([
    { $match: { status: { $in: ["pending", "running", "failed"] } } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]).toArray();
  const queue = Object.fromEntries(["pending", "running", "failed"].map((status) => [status, counts.find((item) => item._id === status)?.count ?? 0]));
  const modelHealth: ModelHealth | null = model ? await model.health().catch((error: unknown): ModelHealth => ({ status: "failed", detail: error instanceof Error ? error.message : String(error) })) : null;
  const schedulerStatus = age !== null && age <= STALE_TICK_SECONDS ? "ok" : "stale";
  // At a glance: failed when no model provider can write stories; warning when the scheduler is
  // stale or the pipeline is running on a fallback provider.
  const modelReady = modelHealth?.status === "ok" || modelHealth?.status === "degraded";
  return {
    generated_at: Date.now() / 1000,
    status: !modelReady ? "failed" : schedulerStatus !== "ok" || modelHealth?.status === "degraded" ? "warning" : "ok",
    scheduler: { last_tick_at: lastTick, seconds_since_tick: age, status: schedulerStatus },
    queue,
    model: modelHealth ? { provider: model?.provider ?? null, name: model?.model ?? null, ...modelHealth } : null,
    totals: {
      locations: rows.length,
      ok: rows.filter((row) => row.level === "ok").length,
      warning: rows.filter((row) => row.level === "warning").length,
      failed: rows.filter((row) => row.level === "failed").length,
      never_run: rows.filter((row) => row.level === "idle").length,
    },
    locations: rows,
  };
}
