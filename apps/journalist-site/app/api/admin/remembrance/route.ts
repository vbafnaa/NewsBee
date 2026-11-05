import { adminRoute } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { decideRemembrance, listRemembrance } from "@/pipeline/connectors/remembrance";

export const dynamic = "force-dynamic";

/** Family-submitted death notices awaiting an editor (or all, with ?status=all). */
export async function GET(request: Request) {
  return adminRoute(request, async ({ db }) => {
    const status = new URL(request.url).searchParams.get("status");
    const submissions = await listRemembrance(db, status === "all" || status === "approved" || status === "rejected" ? status : "pending", new URL(request.url).searchParams.get("location") || undefined);
    return { submissions };
  });
}

/** Approve or reject one submission: { id, decision: "approved" | "rejected", reason? }. */
export async function POST(request: Request) {
  return adminRoute(request, async ({ db }) => {
    const body = await request.json().catch(() => null) as { id?: unknown; decision?: unknown; reason?: unknown } | null;
    if (!body || typeof body.id !== "string" || (body.decision !== "approved" && body.decision !== "rejected")) {
      throw new Error("Invalid decision: send an id and approved or rejected");
    }
    const editor = (await currentAdmin()) ?? "unknown editor";
    return { submission: await decideRemembrance(db, body.id, body.decision, editor, typeof body.reason === "string" ? body.reason : undefined) };
  });
}
