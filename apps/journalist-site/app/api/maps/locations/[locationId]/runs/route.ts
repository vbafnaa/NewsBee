import { internalRoute } from "@/lib/admin-api";
import { runList } from "@/pipeline/trace/funnel";

type Context = { params: Promise<{ locationId: string }> };
export const dynamic = "force-dynamic";

/** Every run for a location, including failed and in-progress ones. */
export async function GET(request: Request, context: Context) {
  const { locationId } = await context.params;
  return internalRoute(request, async ({ db }) => ({ runs: await runList(db, locationId) }));
}
