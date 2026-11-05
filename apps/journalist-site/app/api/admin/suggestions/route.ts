import { adminRoute, jsonBody } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { decideSuggestion, listSuggestions } from "@/pipeline/connectors/manual-links";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  return adminRoute(request, async ({ db }) => ({ suggestions: await listSuggestions(db, new URL(request.url).searchParams.get("status") === "all" ? "all" : "pending") }));
}

/** Approve (the source is checked, then joins the map) or reject a reader's source suggestion: { id, decision, reason? }. */
export async function POST(request: Request) {
  return adminRoute(request, async ({ db, settings, transport }) => {
    const body = await jsonBody<{ id?: unknown; decision?: unknown; reason?: unknown }>(request);
    if (typeof body.id !== "string" || (body.decision !== "approved" && body.decision !== "rejected")) throw new Error("Invalid decision: send an id and approved or rejected");
    return { suggestion: await decideSuggestion(db, settings, body.id, body.decision, (await currentAdmin()) ?? "editor", typeof body.reason === "string" ? body.reason : undefined, transport) };
  });
}
