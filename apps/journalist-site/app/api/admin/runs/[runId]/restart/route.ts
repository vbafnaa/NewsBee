import { adminRoute, kickPipeline } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { expireOverdueRuns } from "@/pipeline/orchestration/diagnostics";
import { startRun } from "@/pipeline/orchestration/orchestrator";
import { getRun, RunConflict } from "@/pipeline/orchestration/runs";

type Context = { params: Promise<{ runId: string }> };

/** Rerun a completed/cancelled attempt as a new run, preserving the original history. */
export async function POST(request: Request, context: Context) {
  const { runId } = await context.params;
  return adminRoute(request, async (deps) => {
    await expireOverdueRuns(deps.db, deps.settings.runTimeoutSeconds);
    const previous = await getRun(deps.db, runId);
    if (!previous) throw new Error(`Unknown run: ${runId}`);
    if (!["published", "failed", "cancelled"].includes(previous.status)) {
      throw new RunConflict("Cancel the active run before restarting it");
    }
    const { run, started } = await startRun(deps, previous.location_id, { by: (await currentAdmin()) ?? "admin", kind: "manual" });
    if (!started) throw new RunConflict("A run is already active for this location");
    kickPipeline(deps, request.url);
    return { run_id: run._id, restarted_from: previous._id, started: true };
  });
}
