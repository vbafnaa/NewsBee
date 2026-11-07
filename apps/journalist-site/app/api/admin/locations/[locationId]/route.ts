import { adminRoute } from "@/lib/admin-api";
import { getLocation } from "@/pipeline/communities/locations";
import { removeLocation } from "@/pipeline/communities/removal";
import { ownerGuard } from "@/lib/admin-session";

type Context = { params: Promise<{ locationId: string }> };
export const maxDuration = 300;

export async function GET(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db }) => ({ location: await getLocation(db, locationId, true) }));
}

/** Remove a location and take it off the reader site's directory. */
export async function DELETE(request: Request, context: Context) {
  const denied = await ownerGuard(request);
  if (denied) return denied;
  const { locationId } = await context.params;
  return adminRoute(request, ({ db, store }) => removeLocation(db, store, locationId));
}
