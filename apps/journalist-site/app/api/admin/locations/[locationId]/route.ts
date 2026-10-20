import { adminRoute } from "@/lib/admin-api";
import { getLocation, removeLocation } from "@/pipeline/communities/locations";
import { channels, refreshChannelDirectory } from "@/pipeline/orchestration/publish";

type Context = { params: Promise<{ locationId: string }> };

export async function GET(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db }) => ({ location: await getLocation(db, locationId) }));
}

/** Remove a location and take it off every output channel's directory. */
export async function DELETE(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db, store }) => {
    const removed = await removeLocation(db, locationId);
    const affected = await channels(db).find({ $or: [{ selected_location_ids: locationId }, { published_location_ids: locationId }] }).toArray();
    for (const channel of affected) {
      await channels(db).updateOne({ _id: channel._id }, { $pull: { selected_location_ids: locationId, published_location_ids: locationId } });
      await refreshChannelDirectory(db, store, channel._id);
    }
    return { removed };
  });
}
