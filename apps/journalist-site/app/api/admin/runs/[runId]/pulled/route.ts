import { adminRoute } from "@/lib/admin-api";
import { pulledStories } from "@/pipeline/editions/pulled";

type Context = { params: Promise<{ runId: string }> };
export const dynamic = "force-dynamic";

/**
 * Everything a run pulled: one row per link with its copies, outcome and review, and one row per
 * source. ?q=&status=&source=&decision=accept|reject|unreviewed&reason=&offset=&limit=.
 */
export async function GET(request: Request, context: Context) {
  const { runId } = await context.params;
  const params = new URL(request.url).searchParams;
  return adminRoute(request, async ({ db }) => pulledStories(db, runId, {
    q: params.get("q"), status: params.get("status"), source: params.get("source"), decision: params.get("decision"), reason: params.get("reason"),
    offset: Number(params.get("offset") ?? 0) || 0, limit: Number(params.get("limit") ?? 100) || 100,
  }));
}
