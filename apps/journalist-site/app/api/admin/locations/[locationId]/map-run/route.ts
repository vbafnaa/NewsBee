import { adminRoute, kickPipeline } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { startMapRun } from "@/pipeline/orchestration/orchestrator";

export const maxDuration = 300;

type Context = { params: Promise<{ locationId: string }> };

/** Refresh one location's source map: the methods that are due, or all of them with { rebuild: true }. */
export async function POST(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async (deps) => {
    const body = await request.json().catch(() => ({})) as { options?: unknown; rebuild?: unknown };
    const { run, started } = await startMapRun(deps, locationId, { by: (await currentAdmin()) ?? "admin", kind: "manual" }, body.options, body.rebuild === true);
    kickPipeline(deps, request.url);
    return { run_id: run._id, started };
  });
}
