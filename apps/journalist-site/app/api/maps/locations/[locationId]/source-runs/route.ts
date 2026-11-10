import { internalRoute } from "@/lib/admin-api";
import { sourceRunList } from "@/pipeline/trace/source-runs";

type Context = { params: Promise<{ locationId: string }> };
export const dynamic = "force-dynamic";

/** A location's source map runs, newest first, and how many have finished. */
export async function GET(request: Request, context: Context) {
  const { locationId } = await context.params;
  return internalRoute(request, async ({ db }) => sourceRunList(db, locationId));
}
