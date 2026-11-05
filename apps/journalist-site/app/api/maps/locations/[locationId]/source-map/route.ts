import { internalRoute } from "@/lib/admin-api";
import { sourceInventory } from "@/lib/map-data";

type Context = { params: Promise<{ locationId: string }> };
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: Context) {
  const { locationId } = await context.params;
  return internalRoute(request, ({ db }) => sourceInventory(db, locationId));
}
