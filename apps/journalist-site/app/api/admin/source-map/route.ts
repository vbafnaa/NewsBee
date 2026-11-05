import { adminRoute } from "@/lib/admin-api";
import { sourceInventory } from "@/lib/map-data";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return adminRoute(request, ({ db }) => sourceInventory(db));
}
