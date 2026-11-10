import { adminRoute } from "@/lib/admin-api";
import { getRun } from "@/pipeline/orchestration/runs";
import { reviewedStories, storyReviewCsv } from "@/pipeline/editions/story-reviews";

type Context = { params: Promise<{ runId: string }> };
export const dynamic = "force-dynamic";

/** This run's reviewed stories as CSV: story, link, story date, sources, location, decision, reason, reviewer and export date. */
export async function GET(request: Request, context: Context) {
  const { runId } = await context.params;
  return adminRoute(request, async ({ db }) => {
    const run = await getRun(db, runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const csv = storyReviewCsv(await reviewedStories(db, { runId }));
    const name = `story-reviews-${run.location_id}-${run.today}-${runId.slice(0, 8)}.csv`.replace(/[^A-Za-z0-9._-]/g, "_");
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` } });
  });
}
