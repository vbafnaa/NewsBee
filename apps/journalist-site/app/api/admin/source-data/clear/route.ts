import { adminRoute, jsonBody } from "@/lib/admin-api";
import { currentAdmin, ownerGuard } from "@/lib/admin-session";
import { ALL_LOCATIONS_CONFIRMATION } from "@/pipeline/analytics/clear-scope";
import { clearSourceData, exportReviews, sourceClearPreview } from "@/pipeline/sourcemap/source-data-clear";

export const dynamic = "force-dynamic";

/** The counts for each category, or with ?export=reviews a copy of the reviews and labels. */
export async function GET(request: Request) {
  const denied = await ownerGuard(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  return adminRoute(request, ({ db }) => params.get("export") === "reviews" ? exportReviews(db, params.get("location") || null) : sourceClearPreview(db));
}

export async function POST(request: Request) {
  const denied = await ownerGuard(request);
  if (denied) return denied;
  return adminRoute(request, async ({ db }) => {
    const { scope, location_id, confirm, data_types } = await jsonBody<Record<string, unknown>>(request);
    // Scope must be explicit, so a malformed body can never mean "everything".
    const target = scope === "all" ? null : scope === "location" && typeof location_id === "string" && location_id.trim() ? location_id : undefined;
    if (target === undefined) throw new Error('Invalid scope: use "all" or "location" with a location_id.');
    if (confirm !== (target ?? ALL_LOCATIONS_CONFIRMATION)) throw new Error("Invalid confirmation: it must match the selected scope.");
    return clearSourceData(db, { location_id: target, data_types }, (await currentAdmin()) ?? "admin");
  });
}
