import { adminRoute, jsonBody } from "@/lib/admin-api";
import { getLocation } from "@/pipeline/communities/locations";
import { MongoLinkCache } from "@/pipeline/storage/link-cache";
import { addManualLink, manualLinks } from "@/pipeline/connectors/manual-links";
import { logger } from "@/pipeline/core/log";

type Context = { params: Promise<{ locationId: string }> };

/** Force link rediscovery: forget cached source links so the next run finds them again. */
export async function DELETE(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db }) => {
    await getLocation(db, locationId);
    const manualId = new URL(request.url).searchParams.get("manual");
    if (manualId) {
      const removed = await manualLinks(db).deleteOne({ _id: manualId, location_id: locationId });
      if (!removed.deletedCount) return Response.json({ detail: "Manual link not found for this location" }, { status: 404 });
      logger("manual-links").info("manual_link_removed", { location_id: locationId, id: manualId });
      return { removed: true };
    }
    await new MongoLinkCache(db).invalidate(locationId);
    return { refreshed: true };
  });
}

export async function POST(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db, settings, transport }) => ({
    link: await addManualLink(db, settings, locationId, await jsonBody<unknown>(request), transport),
  }));
}
