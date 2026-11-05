import { adminRoute } from "@/lib/admin-api";
import { runDecisions } from "@/pipeline/trace/decisions";

type Context = { params: Promise<{ runId: string }> };
export const dynamic = "force-dynamic";

/** The decision log for a run. */
export async function GET(request: Request, context: Context) {
  const { runId } = await context.params;
  return adminRoute(request, async ({ db }) => ({ decisions: await runDecisions(db).find({ run_id: runId }).sort({ at: 1 }).limit(2000).toArray() }));
}
