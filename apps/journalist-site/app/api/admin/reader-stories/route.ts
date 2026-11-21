import { newsroomScopedRoute } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { decideReaderStory, listReaderStories, readerStories } from "@/pipeline/connectors/neighbours";
import { assertLocationInScope, scopedLocationFilter } from "@/pipeline/publications/newsroom-scope";

export const dynamic = "force-dynamic";

/** Stories neighbours submitted, waiting for an editor (or all, with ?status=all), limited to the newsroom's communities for journalists. */
export async function GET(request: Request) {
  return newsroomScopedRoute(request, async ({ db }, scope) => {
    const query = new URL(request.url).searchParams;
    const status = query.get("status");
    return { submissions: await listReaderStories(db, status === "all" || status === "approved" || status === "rejected" ? status : "pending",
      scopedLocationFilter(scope, query.get("location"))) };
  });
}

/** Approve or reject one story: { id, decision: "approved" | "rejected", reason? }. */
export async function POST(request: Request) {
  return newsroomScopedRoute(request, async ({ db }, scope) => {
    const body = await request.json().catch(() => null) as { id?: unknown; decision?: unknown; reason?: unknown } | null;
    if (!body || typeof body.id !== "string" || (body.decision !== "approved" && body.decision !== "rejected")) throw new Error("Invalid decision: send an id and approved or rejected");
    const story = await readerStories(db).findOne({ _id: body.id }, { projection: { location_id: 1 } });
    if (!story) throw new Error(`Invalid submission id: ${body.id}`);
    assertLocationInScope(scope, story.location_id, "Story");
    const editor = (await currentAdmin()) ?? "unknown editor";
    return { submission: await decideReaderStory(db, body.id, body.decision, editor, typeof body.reason === "string" ? body.reason : undefined) };
  });
}
