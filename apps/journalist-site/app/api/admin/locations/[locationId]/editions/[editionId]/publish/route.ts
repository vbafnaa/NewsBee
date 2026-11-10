import { adminRoute } from "@/lib/admin-api";
import { getLocation } from "@/pipeline/communities/locations";
import { PublishConflict, publishEdition } from "@/pipeline/orchestration/publish";

type Context = { params: Promise<{ locationId: string; editionId: string }> };
export const dynamic = "force-dynamic";

/**
 * Publish a finished edition to the reader, making it the location's live edition. Any signed-in
 * journalist may publish: it spends nothing, so it needs no keys and no newsroom slot.
 */
export async function POST(request: Request, context: Context) {
  const { locationId, editionId } = await context.params;
  return adminRoute(request, async ({ db, store, principal }) => {
    if (!principal) return Response.json({ detail: "Sign in as an approved journalist." }, { status: 403 });
    await getLocation(db, locationId);
    try { return await publishEdition(db, store, locationId, editionId, principal.email); }
    catch (error) {
      if (error instanceof PublishConflict) return Response.json({ detail: error.message }, { status: 409 });
      throw error;
    }
  });
}
