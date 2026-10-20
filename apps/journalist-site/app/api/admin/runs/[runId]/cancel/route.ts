import { adminRoute } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { cancelRunJobs } from "@/pipeline/orchestration/jobs";
import { cancelRun } from "@/pipeline/orchestration/runs";

type Context = { params: Promise<{ runId: string }> };

export async function POST(request: Request, context: Context) {
  const { runId } = await context.params;
  return adminRoute(request, async ({ db }) => {
    const run = await cancelRun(db, runId, (await currentAdmin()) ?? "admin");
    await cancelRunJobs(db, runId);
    return { run_id: run._id, status: run.status };
  });
}
