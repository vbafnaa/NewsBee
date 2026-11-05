import { adminRoute } from "@/lib/admin-api";
import { listItems } from "@/pipeline/orchestration/inspect";

type Context = { params: Promise<{ runId: string }> };
export const dynamic = "force-dynamic";

/** A run's items with their outcome: ?q=&status=&source=&section=&offset=. */
export async function GET(request: Request, context: Context) {
  const { runId } = await context.params;
  const params = new URL(request.url).searchParams;
  return adminRoute(request, async ({ db }) => listItems(db, runId, { q: params.get("q"), status: params.get("status"), source: params.get("source"), section: params.get("section"), offset: Number(params.get("offset") ?? 0) || 0 }));
}
