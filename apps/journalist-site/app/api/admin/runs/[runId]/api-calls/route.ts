import { adminRoute } from "@/lib/admin-api";
import { apiCalls } from "@/pipeline/trace/gateway";

type Context = { params: Promise<{ runId: string }> };
export const dynamic = "force-dynamic";

/** Every external and paid call a run made or skipped, with estimated cost. */
export async function GET(request: Request, context: Context) {
  const { runId } = await context.params;
  return adminRoute(request, async ({ db }) => ({ calls: await apiCalls(db).find({ run_id: runId }).sort({ created_at: 1 }).limit(5000).toArray() }));
}
