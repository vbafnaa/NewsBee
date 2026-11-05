import { adminRoute } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { decideReaderStory, listReaderStories } from "@/pipeline/connectors/neighbours";

export const dynamic = "force-dynamic";

/** Stories neighbours submitted, waiting for an editor (or all, with ?status=all). */
export async function GET(request: Request) {
  return adminRoute(request, async ({ db }) => {
    const status = new URL(request.url).searchParams.get("status");
    return { submissions: await listReaderStories(db, status === "all" || status === "approved" || status === "rejected" ? status : "pending", new URL(request.url).searchParams.get("location") || undefined) };
  });
}

/** Approve or reject one story: { id, decision: "approved" | "rejected", reason? }. */
export async function POST(request: Request) {
  return adminRoute(request, async ({ db }) => {
    const body = await request.json().catch(() => null) as { id?: unknown; decision?: unknown; reason?: unknown } | null;
    if (!body || typeof body.id !== "string" || (body.decision !== "approved" && body.decision !== "rejected")) throw new Error("Invalid decision: send an id and approved or rejected");
    const editor = (await currentAdmin()) ?? "unknown editor";
    return { submission: await decideReaderStory(db, body.id, body.decision, editor, typeof body.reason === "string" ? body.reason : undefined) };
  });
}
