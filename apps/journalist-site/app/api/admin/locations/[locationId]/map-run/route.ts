import { kickPipeline, newsroomScopedRoute } from "@/lib/admin-api";
import { startMapRun } from "@/pipeline/orchestration/orchestrator";
import { assertLocationInScope } from "@/pipeline/publications/newsroom-scope";

export const maxDuration = 300;

type Context = { params: Promise<{ locationId: string }> };

/**
 * Refresh one location's source map: the methods that are due, or all of them with { rebuild: true }.
 * Operators as before; a journalist only from their newsroom (`?publication=`) for a community it covers,
 * paid from that newsroom's managed allowance. The run records who started it.
 */
export async function POST(request: Request, context: Context) {
  const { locationId } = await context.params;
  return newsroomScopedRoute(request, async (deps, scope) => {
    assertLocationInScope(scope, locationId, "Community");
    const body = await request.json().catch(() => ({})) as { options?: unknown; rebuild?: unknown };
    const { run, started } = await startMapRun(deps, locationId, { by: deps.principal?.email ?? "admin", kind: "manual" }, body.options, body.rebuild === true,
      scope.operator ? undefined : scope.publicationId ?? undefined);
    kickPipeline(deps, request.url);
    return { run_id: run._id, started };
  });
}
