import { adminRoute } from "@/lib/admin-api";
import { getLocation } from "@/pipeline/communities/locations";
import { finishedEditions } from "@/pipeline/orchestration/publish";

type Context = { params: Promise<{ locationId: string }> };
export const dynamic = "force-dynamic";

/** The location's finished editions, built or published, and which one the reader shows. */
export async function GET(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db }) => {
    await getLocation(db, locationId);
    return { editions: await finishedEditions(db, locationId) };
  });
}
