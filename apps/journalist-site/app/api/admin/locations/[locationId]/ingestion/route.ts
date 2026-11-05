import { adminRoute, kickPipeline } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { startRun } from "@/pipeline/orchestration/orchestrator";

export const maxDuration = 300;

type Context = { params: Promise<{ locationId: string }> };

/** Start a run for one location with the kick-off options; autopilot runs through to the edition. */
export async function POST(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async (deps) => {
    const body = await request.json().catch(() => ({})) as { options?: unknown };
    const { run, started } = await startRun(deps, locationId, { by: (await currentAdmin()) ?? "admin", kind: "manual" }, body.options);
    kickPipeline(deps, request.url);
    return { run_id: run._id, started, jobs: started ? run.sources.map((source) => ({ job_id: source.job_id })) : [] };
  });
}
