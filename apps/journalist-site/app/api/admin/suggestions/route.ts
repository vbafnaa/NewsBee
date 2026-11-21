import { adminRoute, jsonBody, newsroomScopedRoute } from "@/lib/admin-api";
import { decideSuggestion, listSuggestions, sourceSuggestions } from "@/pipeline/connectors/manual-links";
import { assertLocationInScope, NewsroomScopeNotFound } from "@/pipeline/publications/newsroom-scope";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  return adminRoute(request, async ({ db }) => ({ suggestions: await listSuggestions(db, new URL(request.url).searchParams.get("status") === "all" ? "all" : "pending") }));
}

/**
 * Approve (the source is checked, then joins the map) or reject a reader's source suggestion: { id, decision, reason? }.
 * Journalists may decide suggestions for their newsroom's communities and their own newsroom's source feedback.
 */
export async function POST(request: Request) {
  return newsroomScopedRoute(request, async ({ db, settings, transport, principal }, scope) => {
    const body = await jsonBody<{ id?: unknown; decision?: unknown; reason?: unknown }>(request);
    if (typeof body.id !== "string" || (body.decision !== "approved" && body.decision !== "rejected")) throw new Error("Invalid decision: send an id and approved or rejected");
    const item = await sourceSuggestions(db).findOne({ _id: body.id }, { projection: { location_id: 1, kind: 1, publication_id: 1 } });
    if (!item) throw new Error(`Unknown suggestion: ${body.id}`);
    assertLocationInScope(scope, item.location_id, "Suggestion");
    if (!scope.operator && item.kind === "publication_source_feedback" && (item as { publication_id?: string }).publication_id !== scope.publicationId) {
      throw new NewsroomScopeNotFound("Feedback not found for this newsroom.");
    }
    return { suggestion: await decideSuggestion(db, settings, body.id, body.decision, principal!, typeof body.reason === "string" ? body.reason : undefined, transport) };
  });
}
