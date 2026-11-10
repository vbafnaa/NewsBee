import { adminRoute, jsonBody } from "@/lib/admin-api";
import { saveStoryReview, storyReviewChange } from "@/pipeline/editions/story-reviews";

type Context = { params: Promise<{ runId: string }> };
export const dynamic = "force-dynamic";

/**
 * An editor's Accept or Reject on a story this run pulled, for every copy of its link:
 * { item_id, decision: "accept" | "reject" | null, reason_code, reason }. A null decision clears it.
 */
export async function POST(request: Request, context: Context) {
  const { runId } = await context.params;
  return adminRoute(request, async ({ db, principal }) => {
    const body = await jsonBody<{ item_id?: unknown; decision?: unknown; reason_code?: unknown; reason?: unknown }>(request);
    if (typeof body.item_id !== "string" || !body.item_id) throw new Error("Invalid request: send an item_id");
    if (!principal) throw new Error("Sign in as an approved journalist.");
    const saved = await saveStoryReview(db, runId, body.item_id, storyReviewChange(body), principal.email);
    return { key: saved.key, decision: saved.decision, reason_code: saved.reason_code, reason_label: saved.reason_label, reason: saved.reason, by: saved.by, at: saved.at, copies: saved.item_ids.length };
  });
}
