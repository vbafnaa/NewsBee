import { adminRoute, jsonBody, kickPipeline } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { triggerMapStage, type MapStage } from "@/pipeline/orchestration/map-stage";
import { assertStandaloneRunControl } from "@/pipeline/orchestration/runs";

export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  return adminRoute(request, async (deps) => {
    await assertStandaloneRunControl(deps.db, runId);
    const { stage } = await jsonBody<{ stage: MapStage }>(request);
    const result = await triggerMapStage(deps.db, runId, stage, (await currentAdmin()) ?? "admin");
    kickPipeline(deps, request.url);
    return result;
  });
}
