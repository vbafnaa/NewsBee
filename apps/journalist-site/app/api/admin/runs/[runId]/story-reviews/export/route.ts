import { adminRoute } from "@/lib/admin-api";
import { getRun } from "@/pipeline/orchestration/runs";
import { reviewedStories, storyReviewCsv, storyReviewJsonl } from "@/pipeline/editions/story-reviews";

type Context = { params: Promise<{ runId: string }> };
export const dynamic = "force-dynamic";

/**
 * This run's reviewed stories: CSV with one column per fact (the default), or `?format=jsonl` for the
 * whole snapshot, one story per line.
 */
export async function GET(request: Request, context: Context) {
  const { runId } = await context.params;
  const jsonl = new URL(request.url).searchParams.get("format") === "jsonl";
  return adminRoute(request, async ({ db }) => {
    const run = await getRun(db, runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const docs = await reviewedStories(db, { runId });
    const name = `story-reviews-${run.location_id}-${run.today}-${runId.slice(0, 8)}.${jsonl ? "jsonl" : "csv"}`.replace(/[^A-Za-z0-9._-]/g, "_");
    return new Response(jsonl ? storyReviewJsonl(docs) : storyReviewCsv(docs), {
      headers: { "Content-Type": jsonl ? "application/x-ndjson; charset=utf-8" : "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
    });
  });
}
