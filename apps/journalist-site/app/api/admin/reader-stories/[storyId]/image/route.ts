import { newsroomScopedRoute } from "@/lib/admin-api";
import { readerStories } from "@/pipeline/connectors/neighbours";
import { locationInScope } from "@/pipeline/publications/newsroom-scope";
import { storyImageResponse } from "../../../../../../../../shared/reader-stories";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ storyId: string }> }) {
  return newsroomScopedRoute(request, async ({ db }, scope) => {
    const { storyId } = await params;
    const story = await readerStories(db).findOne({ _id: storyId }, { projection: { image: 1, location_id: 1 } });
    return story?.image && locationInScope(scope, story.location_id)
      ? storyImageResponse(story.image) : new Response("Photo not available", { status: 404, headers: { "Cache-Control": "no-store" } });
  });
}
