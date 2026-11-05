import { adminRoute, kickPipeline } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { retryFailedStep } from "@/pipeline/orchestration/retry-step";

export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ runId: string; jobId: string }> }) {
  const { runId, jobId } = await context.params;
  return adminRoute(request, async (deps) => {
    const retried = await retryFailedStep(deps.db, runId, jobId, (await currentAdmin()) ?? "admin");
    kickPipeline(deps, request.url);
    return retried;
  });
}
