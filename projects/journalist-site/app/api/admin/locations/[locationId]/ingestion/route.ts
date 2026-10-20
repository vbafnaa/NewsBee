import { adminRoute, kickPipeline } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { startRun } from "@/pipeline/orchestration/orchestrator";

export const maxDuration = 300;

type Context = { params: Promise<{ locationId: string }> };

/** Run the whole pipeline for one location: collect every source, author, publish. */
export async function POST(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async (deps) => {
    const { run, started } = await startRun(deps, locationId, { by: (await currentAdmin()) ?? "admin", kind: "manual" });
    kickPipeline(deps);
    return { run_id: run._id, started, jobs: started ? run.sources.map((source) => ({ job_id: source.job_id })) : [] };
  });
}
