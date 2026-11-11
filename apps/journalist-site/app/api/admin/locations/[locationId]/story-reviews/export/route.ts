import { adminRoute } from "@/lib/admin-api";
import { getLocation } from "@/pipeline/communities/locations";
import { reviewedStories, storyReviewCsv, storyReviewJsonl } from "@/pipeline/editions/story-reviews";

type Context = { params: Promise<{ locationId: string }> };
export const dynamic = "force-dynamic";

/** Every reviewed story at this location, across runs: CSV, or `?format=jsonl` for the whole snapshot. */
export async function GET(request: Request, context: Context) {
  const { locationId } = await context.params;
  const jsonl = new URL(request.url).searchParams.get("format") === "jsonl";
  return adminRoute(request, async ({ db }) => {
    await getLocation(db, locationId);
    const docs = await reviewedStories(db, { locationId });
    const name = `story-reviews-${locationId}-${new Date().toISOString().slice(0, 10)}.${jsonl ? "jsonl" : "csv"}`.replace(/[^A-Za-z0-9._-]/g, "_");
    return new Response(jsonl ? storyReviewJsonl(docs) : storyReviewCsv(docs), {
      headers: { "Content-Type": jsonl ? "application/x-ndjson; charset=utf-8" : "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
    });
  });
}
