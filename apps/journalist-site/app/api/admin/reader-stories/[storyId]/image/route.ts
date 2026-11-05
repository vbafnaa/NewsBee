import { adminRoute } from "@/lib/admin-api";
import { readerStories } from "@/pipeline/connectors/neighbours";
import { storyImageResponse } from "../../../../../../../../shared/reader-stories";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ storyId: string }> }) {
  return adminRoute(request, async ({ db }) => {
    const { storyId } = await params;
    const story = await readerStories(db).findOne({ _id: storyId }, { projection: { image: 1 } });
    return story?.image ? storyImageResponse(story.image) : new Response("Photo not available", { status: 404, headers: { "Cache-Control": "no-store" } });
  });
}
