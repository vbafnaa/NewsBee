import { loadSettings } from "@/pipeline/core/config";
import { createRuntime } from "@/pipeline/model/runtime";
import { ensureJobIndexes } from "@/pipeline/orchestration/jobs";
import type { OrchestratorDeps } from "@/pipeline/orchestration/orchestrator";
import { ensureRunIndexes } from "@/pipeline/orchestration/runs";
import { getArtifacts } from "@/pipeline/storage/artifacts";
import { getDatabase } from "@/pipeline/storage/mongo";

let indexes: Promise<void> | null = null;

/** Everything the pipeline needs, built from environment settings (local or cloud). */
export async function pipelineDeps(): Promise<OrchestratorDeps> {
  const settings = loadSettings();
  const db = await getDatabase();
  indexes ??= Promise.all([ensureJobIndexes(db), ensureRunIndexes(db)]).then(() => undefined).catch((error) => {
    indexes = null;
    throw error;
  });
  await indexes;
  return { db, settings, store: getArtifacts(), model: createRuntime(settings) };
}

export function errorResponse(error: unknown, status = 500) {
  const detail = error instanceof Error ? error.message : String(error);
  return Response.json({ detail }, { status });
}
