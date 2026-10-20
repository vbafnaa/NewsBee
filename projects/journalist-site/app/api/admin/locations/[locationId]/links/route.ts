import { adminRoute } from "@/lib/admin-api";
import { getLocation } from "@/pipeline/communities/locations";
import { MongoLinkCache } from "@/pipeline/storage/link-cache";

type Context = { params: Promise<{ locationId: string }> };

/** Force link rediscovery: forget cached source links so the next run finds them again. */
export async function DELETE(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db }) => {
    await getLocation(db, locationId);
    await new MongoLinkCache(db).invalidate(locationId);
    return { refreshed: true };
  });
}
