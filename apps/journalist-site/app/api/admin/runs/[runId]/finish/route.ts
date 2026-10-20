import { adminRoute, kickPipeline } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { triggerStage } from "@/pipeline/orchestration/orchestrator";

export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  return adminRoute(request, async (deps) => {
    const run = await triggerStage(deps, runId, "finish", (await currentAdmin()) ?? "admin");
    kickPipeline(deps, request.url);
    return { run };
  });
}
