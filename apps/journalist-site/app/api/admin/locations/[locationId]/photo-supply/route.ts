import { adminGuard, currentAdmin } from "@/lib/admin-session";
import { boundedJson } from "@/lib/bounded-json";
import { getDatabase } from "@/pipeline/storage/mongo";
import { getLocation } from "@/pipeline/communities/locations";
import { listPhotoCatalog } from "@/pipeline/images/catalog";
import { photoSupplyOpportunities } from "@/pipeline/images/opportunities";
import { approvePhotoSupply, createPhotoInvite, photoSupplyInbox, rejectPhotoSupply, revokePhotoInvite, revokePhotoSource } from "@/pipeline/images/supply";

type Context = { params: Promise<{ locationId: string }> };
export const dynamic = "force-dynamic";
async function handle(request: Request, context: Context) {
  const denied = await adminGuard(request);
  if (denied) return denied;
  try {
    const { locationId } = await context.params;
    const db = await getDatabase(), location = await getLocation(db, locationId);
    if (request.method === "GET") return Response.json({ ...await photoSupplyInbox(db, locationId),
      sources: await listPhotoCatalog(db, locationId), opportunities: photoSupplyOpportunities(locationId) });
    const input = await boundedJson(request);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid photo supply request");
    const raw = input as Record<string, unknown>, by = await currentAdmin();
    if (!by) return Response.json({ detail: "Sign in as an administrator" }, { status: 401 });
    let result: unknown;
    switch (raw.action) {
      case "create_invite": result = await createPhotoInvite(db, locationId, location.name, raw, by); break;
      case "approve": result = await approvePhotoSupply(db, locationId, String(raw.id), by); break;
      case "reject": result = await rejectPhotoSupply(db, locationId, String(raw.id), String(raw.reason ?? ""), by); break;
      case "revoke_invite": result = await revokePhotoInvite(db, locationId, String(raw.id)); break;
      case "revoke_source": result = await revokePhotoSource(db, locationId, String(raw.id), by); break;
      default: throw Error("Invalid photo supply action");
    }
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = message.startsWith("Invalid ") ? 400 : message.startsWith("Location is not onboarded") ? 404 : 500;
    return Response.json({ detail: status === 500 ? "Photo supply is temporarily unavailable." : message }, { status });
  }
}
async function respond(request: Request, context: Context) {
  const response = await handle(request, context);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const GET = respond;
export const POST = respond;
