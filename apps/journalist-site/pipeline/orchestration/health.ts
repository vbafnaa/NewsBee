/**
 * Product health at a glance: one row per location (last run, stage, published/held,
 * failed sources, model errors, why an active run is stalled) plus scheduler, queue,
 * model status and model usage.
 */
import type { Db } from "mongodb";
import { listLocations } from "../communities/locations";
import type { Settings } from "../core/config";
import type { ModelRuntime } from "../model/runtime";
import type { ManagedHealthSettings } from "../accounts/execution";
import { modelUsageSummary } from "../model/usage";
import { modelBudget } from "../model/budget";
import { COLLECTIONS } from "../storage/mongo";
import { diagnoseRuns, type RunDiagnostics } from "./diagnostics";
import { openRunIds, collectionCandidateCount, partialCollectionSources, runs, type PipelineRun, type RunSource } from "./runs";
import { schedulerState } from "./scheduler";
import { SOURCE_HEALTH, type SourceHealth } from "./source-health";
import { collectedItems } from "../editions/assemble";

export { STALE_TICK_SECONDS } from "./scheduler";

export type HealthLevel = "ok" | "warning" | "failed" | "idle" | "cancelled";
type HealthSettings = Pick<Settings, "runTimeoutSeconds"> & {
  modelProviders: Array<ManagedHealthSettings["modelProviders"][number] | Settings["modelProviders"][number]>;
  modelDailyCalls?: number;
  integrationFlags?: ManagedHealthSettings["integrationFlags"];
  wiring?: ManagedHealthSettings["wiring"];
};

export type LocationFreshness = {
  location_id: string;
  mapped_at: number | null;
  built_at: number | null;
  published_at: number | null;
  live_published_at: number | null;
  availability: "never_published" | "live" | "historical_only";
};

/** Separate last successful stages from the latest attempt, which may have failed. */
async function stageFreshness(db: Db, locationIds: string[]): Promise<LocationFreshness[]> {
  if (!locationIds.length) return [];
  type StageRow = { _id: string; at: number | null; published_at: number | null; live_at: number | null };
  const [mapped, editions] = await Promise.all([
    runs(db).aggregate<StageRow>([
      { $match: { location_id: { $in: locationIds }, kind: "map", status: "mapped", isolated: { $ne: true } } },
      { $group: { _id: "$location_id", at: { $max: "$completed_at" } } },
    ]).toArray(),
    db.collection(COLLECTIONS.editions).aggregate<StageRow>([
      { $match: { location_id: { $in: locationIds } } },
      { $group: {
        _id: "$location_id",
        at: { $max: "$built_at" },
        published_at: { $max: { $ifNull: ["$last_published_at", { $ifNull: ["$first_published_at", { $cond: [{ $eq: ["$status", "published"] }, "$published_at", null] }] }] } },
        live_at: { $max: { $cond: [{ $and: [{ $eq: ["$status", "published"] }, { $ne: ["$withdrawn", true] }] }, "$published_at", null] } },
      } },
    ]).toArray(),
  ]);
  return locationIds.map((id) => {
    const edition = editions.find((row) => row._id === id);
    const published = edition?.published_at ?? null;
    const live = edition?.live_at ?? null;
    return {
      location_id: id, mapped_at: mapped.find((row) => row._id === id)?.at ?? null,
      built_at: edition?.at ?? null, published_at: published, live_published_at: live,
      availability: live !== null ? "live" : published !== null ? "historical_only" : "never_published",
    };
  });
}

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
  candidate_count: number;
  can_author_partial_collection: boolean;
  published_items: number | null;
  built_items: number | null;
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
  context: {
    runTimeoutSeconds?: number | null;
    diagnostics?: RunDiagnostics | null;
    modelErrors?: string[];
    candidateCount?: number;
  } = {},
): Promise<LocationHealth> {
  const diagnostics = context.diagnostics !== undefined || !run
    ? context.diagnostics ?? null
    : (await diagnoseRuns(db, [run], context.runTimeoutSeconds ?? null)).get(run._id) ?? null;
  let modelErrors: string[] = context.modelErrors ?? [];
  if (context.modelErrors === undefined && run?.draft_id) {
    const draft = await db.collection(COLLECTIONS.editions).findOne({ id: run.draft_id }, { projection: { model_errors: 1 } });
    modelErrors = Array.isArray(draft?.model_errors) ? draft.model_errors.map(String) : [];
  }
  const sources = run?.sources ?? [];
  const partialSources = run ? partialCollectionSources(run) : undefined;
  const candidateCount = context.candidateCount ?? (run ? await collectionCandidateCount(db, run._id, partialSources ?? run.partial_collection_source_ids) : 0);
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
    candidate_count: candidateCount,
    can_author_partial_collection: Boolean(partialSources && candidateCount > 0),
    published_items: run?.status === "published" ? run.published?.items ?? null : null,
    built_items: run?.published?.items ?? null,
    held: run?.published?.held ?? null,
    held_reasons: run?.published?.held_reasons ?? {},
    model_errors: modelErrors,
    error: run?.error ?? null,
    diagnostics,
  };
}

export async function healthSummary(
  db: Db,
  _model: ModelRuntime | null,
  settings?: HealthSettings,
  evidence: { freshness?: LocationFreshness[] } = {},
) {
  const locations = await listLocations(db);
  const latestRows = locations.length ? await runs(db).aggregate<{ _id: string; run: PipelineRun }>([
    { $match: { location_id: { $in: locations.map((location) => location.id) } } },
    { $sort: { location_id: 1, created_at: -1, _id: -1 } },
    { $group: { _id: "$location_id", run: { $first: "$$ROOT" } } },
  ]).toArray() : [];
  const latestRuns = new Map(latestRows.map((row) => [row._id, row.run]));
  const timeout = settings?.runTimeoutSeconds ?? null;
  const latest = [...latestRuns.values()];
  const diagnostics = await diagnoseRuns(db, latest, timeout);
  const draftIds = latest.flatMap((run) => run.draft_id ? [run.draft_id] : []);
  const runIds = latest.map((run) => run._id);
  const [drafts, candidateRows] = await Promise.all([
    draftIds.length ? db.collection(COLLECTIONS.editions)
      .find({ id: { $in: draftIds } }, { projection: { id: 1, model_errors: 1 } }).toArray() : [],
    runIds.length ? collectedItems(db).aggregate<{ _id: { run_id: string; source_id: string }; count: number }>([
      { $match: { run_id: { $in: runIds }, status: { $ne: "dropped" }, facts: { $ne: null } } },
      { $group: { _id: { run_id: "$run_id", source_id: "$source_id" }, count: { $sum: 1 } } },
    ]).toArray() : [],
  ]);
  const errorsByDraft = new Map(drafts.map((draft) => [
    String(draft.id),
    Array.isArray(draft.model_errors) ? draft.model_errors.map(String) : [],
  ]));
  const candidatesByRun = new Map<string, Map<string, number>>();
  for (const row of candidateRows) {
    const sources = candidatesByRun.get(row._id.run_id) ?? new Map<string, number>();
    sources.set(row._id.source_id, row.count);
    candidatesByRun.set(row._id.run_id, sources);
  }
  const rows: LocationHealth[] = [];
  for (const location of locations) {
    const latest = latestRuns.get(location.id) ?? null;
    const partialSources = latest ? partialCollectionSources(latest) ?? latest.partial_collection_source_ids : undefined;
    const sourceCounts = latest ? candidatesByRun.get(latest._id) ?? new Map<string, number>() : new Map<string, number>();
    const candidateCount = partialSources
      ? partialSources.reduce((sum, sourceId) => sum + (sourceCounts.get(sourceId) ?? 0), 0)
      : [...sourceCounts.values()].reduce((sum, count) => sum + count, 0);
    rows.push(await locationHealth(db, latest, location, {
      diagnostics: latest ? diagnostics.get(latest._id) ?? null : null,
      modelErrors: latest?.draft_id ? errorsByDraft.get(latest.draft_id) ?? [] : [],
      candidateCount,
    }));
  }
  const scheduler = await schedulerState(db);
  const open = await openRunIds(db);
  const counts = await db.collection(COLLECTIONS.jobs).aggregate<{ _id: string; count: number }>([
    { $match: { $or: [{ status: "failed" }, { status: { $in: ["pending", "running"] }, run_id: { $in: open } }] } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]).toArray();
  const queue = Object.fromEntries(["pending", "running", "failed"].map((status) => [status, counts.find((item) => item._id === status)?.count ?? 0]));
  const modelUsage = await modelUsageSummary(db, settings?.modelProviders ?? []);
  const providers = (settings?.modelProviders ?? []).map((provider) => ({
    name: provider.name,
    model: provider.model,
    configured: "configured" in provider ? provider.configured : Boolean(provider.model && (provider.kind === "ollama" || provider.apiKey)),
    limits: { requests_per_minute: provider.usage.requestsPerMinute, requests_per_day: provider.usage.requestsPerDay },
    pricing: { input_per_mtok: provider.usage.inputCostPerMTok, output_per_mtok: provider.usage.outputCostPerMTok },
  }));
  const modelReady = providers.some((provider) => provider.configured);
  const modelHealth = {
    scope: "managed_platform" as const,
    status: modelReady ? "configured" as const : "not_configured" as const,
    live_tested: false,
    detail: modelReady ? "Managed provider configuration is present; no live provider check was made." : "No managed model provider is configured for new work.",
    providers,
  };
  const budget = settings?.modelDailyCalls === undefined ? null : await modelBudget(db, { modelDailyCalls: settings.modelDailyCalls });
  const freshness = evidence.freshness ?? await stageFreshness(db, locations.map((location) => location.id));
  const [publicationStages, publications] = await Promise.all([
    db.collection(COLLECTIONS.publicationDrafts).aggregate<{ _id: string; built_at: number | null; published_at: number | null }>([
      { $group: {
        _id: "$publication_id", built_at: { $max: "$created_at" },
        published_at: { $max: { $cond: [{ $isNumber: "$release.manifest_revision" }, "$release.published_at", null] } },
      } },
    ]).toArray(),
    db.collection(COLLECTIONS.outputChannels).find(
      { "reader_publication.manifest_revision": { $exists: true } },
      { projection: { _id: 1, "reader_publication.latest_release_id": 1, "reader_publication.latest_published_at": 1 } },
    ).toArray(),
  ]);
  const pendingWork = queue.pending + queue.running > 0;
  const schedulerProblem = pendingWork && (scheduler.status !== "ok" || scheduler.issues.length > 0);
  const warning = schedulerProblem || scheduler.issues.length > 0 || budget?.near || modelUsage.providers.some((item) => item.warnings.length > 0);
  return {
    generated_at: Date.now() / 1000,
    status: !modelReady || budget?.exhausted || (pendingWork && schedulerProblem) ? "failed" : warning ? "warning" : "ok",
    scheduler,
    run_timeout_seconds: timeout,
    queue,
    model: modelHealth,
    configuration: { integrations: settings?.integrationFlags ?? {}, wiring: settings?.wiring ?? null },
    observations: { live_probes_performed: false, last_consumer_delivery_at: scheduler.last_queue_at, scheduler_issues: scheduler.issues },
    model_budget: budget,
    model_usage: modelUsage,
    freshness,
    publication_freshness: publicationStages.map((stage) => {
      const pointer = publications.find((publication) => String(publication._id) === stage._id)?.reader_publication;
      return {
        publication_id: stage._id, built_at: stage.built_at ?? null, published_at: stage.published_at ?? null,
        live_published_at: pointer?.latest_published_at ?? null,
        availability: pointer?.latest_release_id ? "live" : stage.published_at !== null && stage.published_at !== undefined ? pointer ? "withdrawn" : "historical_only" : "never_published",
      };
    }),
    /** Sources that keep failing (3+ runs) or keep returning nothing (4+ runs). */
    source_attention: await db.collection<SourceHealth>(SOURCE_HEALTH).find({ flag: { $ne: "healthy" } }).sort({ flag: 1, location_id: 1, source_id: 1 }).limit(100).toArray(),
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
