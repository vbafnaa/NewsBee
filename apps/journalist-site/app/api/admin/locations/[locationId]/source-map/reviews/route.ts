import { adminRoute, jsonBody } from "@/lib/admin-api";
import { getLocation } from "@/pipeline/communities/locations";
import { MAX_BULK_REVIEW, reviewChange, saveSourceReviews } from "@/pipeline/sourcemap/store";

type Context = { params: Promise<{ locationId: string }> };
export const dynamic = "force-dynamic";

/**
 * Bulk accept or reject: { source_ids, decision: accept|reject, reason_code, reason? }. One decision
 * and reason for every selected source, each saved as its own label, as in the source network.
 */
export async function POST(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db, principal }) => {
    await getLocation(db, locationId);
    const body = await jsonBody<{ source_ids?: unknown; decision?: unknown; reason_code?: unknown; reason?: unknown }>(request);
    const ids = Array.isArray(body.source_ids) ? body.source_ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    if (!ids.length || ids.length !== (body.source_ids as unknown[]).length) throw new Error("Invalid request: send source_ids, a list of source ids");
    if (ids.length > MAX_BULK_REVIEW) throw new Error(`Invalid request: label at most ${MAX_BULK_REVIEW} sources at once`);
    if (body.decision !== "accept" && body.decision !== "reject") throw new Error("Invalid decision: send accept or reject");
    if (typeof body.reason_code !== "string") throw new Error("Invalid reason code: choose one reason for them all");
    const change = reviewChange(body);
    if (!principal) throw new Error("Sign in as an approved journalist.");
    return saveSourceReviews(db, locationId, ids, change, principal.email);
  });
}
