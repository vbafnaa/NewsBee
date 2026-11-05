import { adminRoute, kickPipeline } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { startAll } from "@/pipeline/orchestration/orchestrator";

export const maxDuration = 300;

/** Start a run for every onboarded location with the kick-off options. */
export async function POST(request: Request) {
  return adminRoute(request, async (deps) => {
    const body = await request.json().catch(() => ({})) as { options?: unknown };
    const started = await startAll(deps, (await currentAdmin()) ?? "admin", body.options);
    kickPipeline(deps, request.url);
    return { jobs: started.map(({ run, started: fresh }) => ({ job_id: run._id, location_id: run.location_id, started: fresh })) };
  });
}
