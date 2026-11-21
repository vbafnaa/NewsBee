import { adminRoute } from "@/lib/admin-api";
import { getLocation } from "@/pipeline/communities/locations";
import { removeLocation } from "@/pipeline/communities/removal";
import { ownerGuard } from "@/lib/admin-session";
import { jsonBody } from "@/lib/admin-api";
import { locationEvidenceCandidates, repairLocationEvidence } from "@/pipeline/communities/evidence";

type Context = { params: Promise<{ locationId: string }> };
export const maxDuration = 300;

export async function GET(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db }) => {
    const location = await getLocation(db, locationId, true);
    return { location, evidence_candidates: await locationEvidenceCandidates(db, location) };
  });
}

export async function PATCH(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db, principal }) => {
    const body = await jsonBody<Parameters<typeof repairLocationEvidence>[2] | null>(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid evidence repair: send an evidence object");
    return { location: await repairLocationEvidence(db, locationId, body, principal!) };
  });
}

/** Remove a location and take it off the reader site's directory. */
export async function DELETE(request: Request, context: Context) {
  const denied = await ownerGuard(request);
  if (denied) return denied;
  const { locationId } = await context.params;
  return adminRoute(request, ({ db, store, principal }) => removeLocation(db, store, locationId, principal));
}
