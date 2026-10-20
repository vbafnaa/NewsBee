import { adminRoute, jsonBody } from "@/lib/admin-api";
import { updateSources } from "@/pipeline/communities/locations";
import { MongoLinkCache } from "@/pipeline/storage/link-cache";

type Context = { params: Promise<{ locationId: string }> };
type Body = {
  systems?: { fscskey: string; website: string | null }[];
  government?: { platform: string; tenant: string } | null;
};

/** Save reviewed library websites and the local-government platform for a location. */
export async function PATCH(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db }) => {
    const body = await jsonBody<Body>(request);
    const websites = Object.fromEntries((body.systems ?? []).map((system) => [String(system.fscskey), system.website ? String(system.website) : null]));
    const government = body.government ? { platform: String(body.government.platform), tenant: String(body.government.tenant) } : null;
    const location = await updateSources(db, locationId, websites, government);
    await new MongoLinkCache(db).invalidate(locationId);
    return { location };
  });
}
