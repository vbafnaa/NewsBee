import { adminRoute } from "@/lib/admin-api";
import { getLocation } from "@/pipeline/communities/locations";
import { reviewedStories, storyReviewCsv } from "@/pipeline/editions/story-reviews";

type Context = { params: Promise<{ locationId: string }> };
export const dynamic = "force-dynamic";

/** Every reviewed story at this location, across runs, as CSV. */
export async function GET(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db }) => {
    await getLocation(db, locationId);
    const csv = storyReviewCsv(await reviewedStories(db, { locationId }));
    const name = `story-reviews-${locationId}-${new Date().toISOString().slice(0, 10)}.csv`.replace(/[^A-Za-z0-9._-]/g, "_");
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` } });
  });
}
