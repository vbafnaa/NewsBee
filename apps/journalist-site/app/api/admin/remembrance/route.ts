import { newsroomScopedRoute } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { decideRemembrance, listRemembrance, remembranceSubmissions } from "@/pipeline/connectors/remembrance";
import { assertLocationInScope, scopedLocationFilter } from "@/pipeline/publications/newsroom-scope";

export const dynamic = "force-dynamic";

/** Family-submitted death notices awaiting an editor (or all, with ?status=all), limited to the newsroom's communities for journalists. */
export async function GET(request: Request) {
  return newsroomScopedRoute(request, async ({ db }, scope) => {
    const query = new URL(request.url).searchParams;
    const status = query.get("status");
    const submissions = await listRemembrance(db, status === "all" || status === "approved" || status === "rejected" ? status : "pending",
      scopedLocationFilter(scope, query.get("location")));
    return { submissions };
  });
}

/** Approve or reject one submission: { id, decision: "approved" | "rejected", reason? }. */
export async function POST(request: Request) {
  return newsroomScopedRoute(request, async ({ db }, scope) => {
    const body = await request.json().catch(() => null) as { id?: unknown; decision?: unknown; reason?: unknown } | null;
    if (!body || typeof body.id !== "string" || (body.decision !== "approved" && body.decision !== "rejected")) {
      throw new Error("Invalid decision: send an id and approved or rejected");
    }
    const submission = await remembranceSubmissions(db).findOne({ _id: body.id }, { projection: { location_id: 1 } });
    if (!submission) throw new Error(`Invalid submission id: ${body.id}`);
    assertLocationInScope(scope, submission.location_id, "Notice");
    const editor = (await currentAdmin()) ?? "unknown editor";
    return { submission: await decideRemembrance(db, body.id, body.decision, editor, typeof body.reason === "string" ? body.reason : undefined) };
  });
}
