import { adminRoute, kickPipeline } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { resumeRun } from "@/pipeline/orchestration/orchestrator";
import { assertStandaloneRunControl } from "@/pipeline/orchestration/runs";

export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  return adminRoute(request, async (deps) => {
    await assertStandaloneRunControl(deps.db, runId);
    const run = await resumeRun(deps, runId, (await currentAdmin()) ?? "admin");
    kickPipeline(deps, request.url);
    return { run };
  });
}
