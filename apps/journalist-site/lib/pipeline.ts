import { lightSettings, loadSettings, rankingSettings } from "@/pipeline/core/config";
import { createRuntime } from "@/pipeline/model/runtime";
import { ensureUsageIndexes, mongoUsageSink } from "@/pipeline/model/usage";
import { ensureJobIndexes, ensureJobLogIndexes } from "@/pipeline/orchestration/jobs";
import { ensureFetchStateIndexes, shareFetchState } from "@/pipeline/connectors/fetch-state";
import type { OrchestratorDeps } from "@/pipeline/orchestration/orchestrator";
import { ensureRunIndexes } from "@/pipeline/orchestration/runs";
import { getArtifacts } from "@/pipeline/storage/artifacts";
import { getDatabase } from "@/pipeline/storage/mongo";
import { ensureSourceMapIndexes } from "@/pipeline/sourcemap/store";
import { ensureItemIndexes } from "@/pipeline/editions/assemble";
import { ensureTextIndexes } from "@/pipeline/editions/details";
import { ensureSearchIndexes } from "@/pipeline/search/provider";
import { ensureDecisionIndexes } from "@/pipeline/trace/decisions";
import { ensureApiCallIndexes } from "@/pipeline/trace/gateway";

let indexes: Promise<void> | null = null;

/** Everything the pipeline needs, built from environment settings (local or cloud). */
export async function pipelineDeps(): Promise<OrchestratorDeps> {
  const settings = loadSettings();
  const db = await getDatabase();
  indexes ??= Promise.all([ensureJobIndexes(db), ensureJobLogIndexes(db), ensureFetchStateIndexes(db), ensureRunIndexes(db), ensureUsageIndexes(db), ensureSourceMapIndexes(db), ensureItemIndexes(db), ensureTextIndexes(db), ensureDecisionIndexes(db), ensureApiCallIndexes(db), ensureSearchIndexes(db)]).then(() => undefined).catch((error) => {
    indexes = null;
    throw error;
  });
  await indexes;
  shareFetchState(db);
  const sink = mongoUsageSink(db);
  return {
    db,
    settings,
    store: getArtifacts(),
    model: createRuntime(settings, undefined, undefined, { role: "writing", sink }),
    rankingModel: createRuntime(rankingSettings(settings), undefined, undefined, { role: "ranking", sink }),
    lightModel: createRuntime(lightSettings(settings), undefined, undefined, { role: "extraction", sink }),
    discoveryModel: createRuntime(lightSettings(settings), undefined, undefined, { role: "discovery", sink }),
    agentModel: createRuntime(settings, undefined, undefined, { role: "agent", sink }),
    agentLightModel: createRuntime(lightSettings(settings), undefined, undefined, { role: "agent", sink }),
  };
}

export function errorResponse(error: unknown, status = 500) {
  const detail = error instanceof Error ? error.message : String(error);
  return Response.json({ detail }, { status });
}
