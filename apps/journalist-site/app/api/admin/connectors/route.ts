import { adminRoute } from "@/lib/admin-api";
import { connectorInventory } from "@/pipeline/connectors/inventory";

export async function GET(request: Request) {
  return adminRoute(request, ({ db, settings }) => connectorInventory(db, settings));
}
