import { adminRoute, jsonBody } from "@/lib/admin-api";
import inventory from "../../../../../../shared/source-sheet-inventory.json";
import { importSheetInventory, type SheetInventory } from "@/pipeline/sourcemap/sheet-import";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const location = new URL(request.url).searchParams.get("location");
  return adminRoute(request, async () => {
    const keys = Object.entries(inventory.communities).filter(([, value]) => !location || value.id === location).map(([key]) => key);
    return { spreadsheet_url: inventory.spreadsheet_url, checked_on: inventory.checked_on,
      sources: inventory.sources.filter((source) => source.communities.some((key) => keys.includes(key))) };
  });
}

export async function POST(request: Request) {
  return adminRoute(request, async ({ db }) => {
    const body = await jsonBody<{ apply?: unknown }>(request);
    return importSheetInventory(db, inventory as SheetInventory, body.apply === true);
  });
}
