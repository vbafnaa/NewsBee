import { adminRoute, kickPipeline } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { startAll } from "@/pipeline/orchestration/orchestrator";

export const maxDuration = 300;

/** Start collection for every onboarded location; later stages require editor actions. */
export async function POST(request: Request) {
  return adminRoute(request, async (deps) => {
    const started = await startAll(deps, (await currentAdmin()) ?? "admin");
    kickPipeline(deps, request.url);
    return { jobs: started.map(({ run, started: fresh }) => ({ job_id: run._id, location_id: run.location_id, started: fresh })) };
  });
}
