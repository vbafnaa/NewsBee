import { jsonBody, newsroomScopedRoute } from "@/lib/admin-api";
import { assertLocationInScope } from "@/pipeline/publications/newsroom-scope";
import { getLocation } from "@/pipeline/communities/locations";
import { canAddAcceptedSources } from "@/pipeline/orchestration/map-stage-availability";
import { runs } from "@/pipeline/orchestration/runs";
import { MAX_BULK_REVIEW, reviewChange, savePageDecisions } from "@/pipeline/sourcemap/store";

type Context = { params: Promise<{ locationId: string; runId: string }> };
export const dynamic = "force-dynamic";

/**
 * A decision on pages a test-mode source run found: { source_ids, decision, reason_code, reason? }.
 * Kept by page so it shows on that page's row in every run. An explicit accept from a failed run
 * also adds the saved source to All sources. One id saves what changed; several take one decision and
 * reason for them all, as bulk accept or reject does.
 */
export async function POST(request: Request, context: Context) {
  const { locationId, runId } = await context.params;
  return newsroomScopedRoute(request, async ({ db, principal }, scope) => {
    assertLocationInScope(scope, locationId, "Community");
    await getLocation(db, locationId);
    const run = await runs(db).findOne({ _id: runId, location_id: locationId, kind: "map" }, { projection: { isolated: 1, status: 1, stage_transitions: 1 } });
    if (!run) return Response.json({ detail: "Source run not found for this location." }, { status: 404 });
    if (!run.isolated) throw new Error("Invalid request: this run wrote to the source map, so decide its sources in All sources");
    const body = await jsonBody<{ source_ids?: unknown; decision?: unknown; reason_code?: unknown; reason?: unknown }>(request);
    const ids = Array.isArray(body.source_ids) ? body.source_ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    if (!ids.length || ids.length !== (body.source_ids as unknown[]).length) throw new Error("Invalid request: send source_ids, a list of source ids");
    if (ids.length > MAX_BULK_REVIEW) throw new Error(`Invalid request: label at most ${MAX_BULK_REVIEW} sources at once`);
    if (ids.length > 1 && body.decision !== "accept" && body.decision !== "reject") throw new Error("Invalid decision: send accept or reject");
    if (ids.length > 1 && typeof body.reason_code !== "string") throw new Error("Invalid reason code: choose one reason for them all");
    const change = reviewChange(body);
    if (!principal) throw new Error("Sign in as an approved journalist.");
    return savePageDecisions(db, locationId, runId, ids, change, principal.email, canAddAcceptedSources(run));
  });
}
