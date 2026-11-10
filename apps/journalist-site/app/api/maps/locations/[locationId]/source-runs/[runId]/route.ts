import { internalRoute } from "@/lib/admin-api";
import { sourceRunDetail } from "@/pipeline/trace/source-runs";

type Context = { params: Promise<{ locationId: string; runId: string }> };
export const dynamic = "force-dynamic";

/** One source map run: the settings it used, how it ended, its limits, stages and categories, every page, each tool and the agent's log. */
export async function GET(request: Request, context: Context) {
  const { locationId, runId } = await context.params;
  return internalRoute(request, async ({ db }) => await sourceRunDetail(db, locationId, runId) ?? Response.json({ detail: "Source run not found for this location." }, { status: 404 }));
}
