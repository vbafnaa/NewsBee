import { adminRoute, kickPipeline } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { expireOverdueRuns } from "@/pipeline/orchestration/diagnostics";
import { startMapRun, startRun } from "@/pipeline/orchestration/orchestrator";
import { getRun, RunConflict } from "@/pipeline/orchestration/runs";
import { resolveRunOptions } from "@/pipeline/core/run-options";

type Context = { params: Promise<{ runId: string }> };

export const maxDuration = 300;

/** Rerun a completed/cancelled attempt as a new run, preserving the original history. */
export async function POST(request: Request, context: Context) {
  const { runId } = await context.params;
  return adminRoute(request, async (deps) => {
    await expireOverdueRuns(deps.db, deps.settings.runTimeoutSeconds);
    const previous = await getRun(deps.db, runId);
    if (!previous) throw new Error(`Unknown run: ${runId}`);
    if (!["mapped", "published", "failed", "cancelled"].includes(previous.status)) {
      throw new RunConflict("Cancel the active run before restarting it");
    }
    // A restart keeps the choices the run was started with.
    const { admin_approval_id: _approval, ...choices } = previous.options ?? resolveRunOptions({ mode: "manual" });
    const trigger = { by: (await currentAdmin()) ?? "admin", kind: "manual" as const };
    const { run, started } = previous.kind === "map"
      ? await startMapRun(deps, previous.location_id, trigger, choices, choices.rebuild === true)
      : await startRun(deps, previous.location_id, trigger, choices);
    if (!started) throw new RunConflict("A run is already active for this location");
    kickPipeline(deps, request.url);
    return { run_id: run._id, restarted_from: previous._id, started: true };
  });
}
