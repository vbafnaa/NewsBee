/**
 * Product health at a glance: one row per location (last run, stage, published/held,
 * failed sources, model errors, why an active run is stalled) plus scheduler, queue,
 * model status and model usage.
 */
import type { Db } from "mongodb";
import { listLocations } from "../communities/locations";
import type { Settings } from "../core/config";
import type { ComponentHealth, ModelRuntime } from "../model/runtime";
import { modelUsageSummary } from "../model/usage";
import { COLLECTIONS } from "../storage/mongo";
import { diagnoseRuns, type RunDiagnostics } from "./diagnostics";
import { runs, type PipelineRun, type RunSource } from "./runs";
import { schedulerState } from "./scheduler";

export { STALE_TICK_SECONDS } from "./scheduler";

export type HealthLevel = "ok" | "warning" | "failed" | "idle" | "cancelled";
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
  /** Why an active run is not advancing, and its timeout; null for finished runs. */
  diagnostics: RunDiagnostics | null;
};

function sourceFailed(source: RunSource) {
  return source.status === "failed" || source.result_status === "failed";
}

function level(run: PipelineRun | null, modelErrors: string[], diagnostics: RunDiagnostics | null): HealthLevel {
  if (!run) return "idle";
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "failed") return "failed";
  if (diagnostics?.issues.some((issue) => issue.severity === "failed")) return "failed";
  if (diagnostics?.issues.some((issue) => issue.severity === "warning")) return "warning";
  const failed = run.sources.some(sourceFailed);
  if (failed || modelErrors.length || (run.published?.held ?? 0) > 0) return "warning";
  return "ok";
}

export async function locationHealth(
  db: Db,
  run: PipelineRun | null,
  location: { id: string; name: string },
  context: { runTimeoutSeconds?: number | null; diagnostics?: RunDiagnostics | null } = {},
): Promise<LocationHealth> {
  const diagnostics = context.diagnostics !== undefined || !run
    ? context.diagnostics ?? null
    : (await diagnoseRuns(db, [run], context.runTimeoutSeconds ?? null)).get(run._id) ?? null;
  let modelErrors: string[] = [];
  if (run?.draft_id) {
    const draft = await db.collection(COLLECTIONS.editions).findOne({ id: run.draft_id }, { projection: { model_errors: 1 } });
    modelErrors = Array.isArray(draft?.model_errors) ? draft.model_errors.map(String) : [];
  }
  const sources = run?.sources ?? [];
  return {
    location_id: location.id,
    location_name: location.name,
    level: level(run, modelErrors, diagnostics),
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
    diagnostics,
  };
}

export async function healthSummary(db: Db, model: ModelRuntime | null, settings?: Pick<Settings, "runTimeoutSeconds" | "modelProviders">) {
  const locations = await listLocations(db);
  const latestRuns = new Map<string, PipelineRun | null>();
  for (const location of locations) {
    latestRuns.set(location.id, await runs(db).find({ location_id: location.id }).sort({ created_at: -1 }).limit(1).next());
  }
  const timeout = settings?.runTimeoutSeconds ?? null;
  const diagnostics = await diagnoseRuns(db, [...latestRuns.values()].filter((run): run is PipelineRun => run !== null), timeout);
  const rows: LocationHealth[] = [];
  for (const location of locations) {
    const latest = latestRuns.get(location.id) ?? null;
    rows.push(await locationHealth(db, latest, location, { diagnostics: latest ? diagnostics.get(latest._id) ?? null : null }));
  }
  const scheduler = await schedulerState(db);
  const counts = await db.collection(COLLECTIONS.jobs).aggregate<{ _id: string; count: number }>([
    { $match: { status: { $in: ["pending", "running", "failed"] } } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]).toArray();
  const queue = Object.fromEntries(["pending", "running", "failed"].map((status) => [status, counts.find((item) => item._id === status)?.count ?? 0]));
  const modelHealth: ModelHealth | null = model ? await model.health().catch((error: unknown): ModelHealth => ({ status: "failed", detail: error instanceof Error ? error.message : String(error) })) : null;
  const modelUsage = await modelUsageSummary(db, settings?.modelProviders ?? []);
  const schedulerProblem = scheduler.status !== "ok" || scheduler.issues.length > 0;
  const pendingWork = queue.pending + queue.running > 0;
  // At a glance: failed when no model provider can write stories or queued work cannot advance;
  // warning when the scheduler is stale or erroring, a fallback provider is in use, or usage is
  // near configured limits.
  const modelReady = modelHealth?.status === "ok" || modelHealth?.status === "degraded";
  const warning = schedulerProblem || modelHealth?.status === "degraded" || modelUsage.providers.some((item) => item.warnings.length > 0);
  return {
    generated_at: Date.now() / 1000,
    status: !modelReady || (pendingWork && schedulerProblem) ? "failed" : warning ? "warning" : "ok",
    scheduler,
    run_timeout_seconds: timeout,
    queue,
    model: modelHealth ? { provider: model?.provider ?? null, name: model?.model ?? null, ...modelHealth } : null,
    model_usage: modelUsage,
    totals: {
      locations: rows.length,
      ok: rows.filter((row) => row.level === "ok").length,
      warning: rows.filter((row) => row.level === "warning").length,
      failed: rows.filter((row) => row.level === "failed").length,
      cancelled: rows.filter((row) => row.level === "cancelled").length,
      never_run: rows.filter((row) => row.level === "idle").length,
    },
    locations: rows,
  };
}
