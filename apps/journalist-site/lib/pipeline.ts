import { ensureUsageIndexes } from "@/pipeline/model/usage";
import { infrastructureSettings } from "@/pipeline/accounts/execution";
import { NO_MODEL, runtimesForRun } from "@/pipeline/accounts/runtime";
import { safeError } from "@/pipeline/core/redaction";
import { ensureJobIndexes, ensureJobLogIndexes } from "@/pipeline/orchestration/jobs";
import { ensureFetchStateIndexes, shareFetchState } from "@/pipeline/connectors/fetch-state";
import type { OrchestratorDeps } from "@/pipeline/orchestration/orchestrator";
import { ensureRunIndexes } from "@/pipeline/orchestration/runs";
import { getArtifacts } from "@/pipeline/storage/artifacts";
import { getDatabase } from "@/pipeline/storage/mongo";
import { ensureSourceMapIndexes } from "@/pipeline/sourcemap/store";
import { ensureItemIndexes } from "@/pipeline/editions/assemble";
import { ensureStoryReviewIndexes } from "@/pipeline/editions/story-reviews";
import { ensureTextIndexes } from "@/pipeline/editions/details";
import { ensureSearchIndexes } from "@/pipeline/search/provider";
import { ensureDecisionIndexes } from "@/pipeline/trace/decisions";
import { ensureApiCallIndexes } from "@/pipeline/trace/gateway";
import { ensureVideoProductionIndexes } from "@/pipeline/video-production";

let indexes: Promise<void> | null = null;

/** Shared infrastructure only; sponsor-specific runtimes are built after claiming a job. */
export async function pipelineDeps(): Promise<OrchestratorDeps> {
  const settings = infrastructureSettings();
  const db = await getDatabase();
  indexes ??= Promise.all([ensureJobIndexes(db), ensureJobLogIndexes(db), ensureFetchStateIndexes(db), ensureRunIndexes(db), ensureUsageIndexes(db), ensureSourceMapIndexes(db), ensureItemIndexes(db), ensureStoryReviewIndexes(db), ensureTextIndexes(db), ensureDecisionIndexes(db), ensureApiCallIndexes(db), ensureSearchIndexes(db), ensureVideoProductionIndexes(db)]).then(() => undefined).catch((error) => {
    indexes = null;
    throw error;
  });
  await indexes;
  shareFetchState(db);
  const deps: OrchestratorDeps = {
    db,
    settings,
    store: getArtifacts(),
    model: NO_MODEL,
  };
  deps.runtimeForRun = (run) => runtimesForRun(deps, run);
  return deps;
}

export function errorResponse(error: unknown, status = 500) {
  const detail = safeError(error);
  return Response.json({ detail }, { status });
}
