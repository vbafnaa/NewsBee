import { adminRoute } from "@/lib/admin-api";
import { itemTrace } from "@/pipeline/orchestration/inspect";

type Context = { params: Promise<{ runId: string; itemId: string }> };
export const dynamic = "force-dynamic";

/** One item traced from its source to the story: window, locality, merge group, section, ranking, details, writing and floor checks. */
export async function GET(request: Request, context: Context) {
  const { runId, itemId } = await context.params;
  return adminRoute(request, async ({ db }) => itemTrace(db, runId, decodeURIComponent(itemId)));
}
