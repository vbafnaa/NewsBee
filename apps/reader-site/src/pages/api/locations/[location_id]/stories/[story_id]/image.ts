import type { APIRoute } from "astro";
import { approvedStoryImage } from "../../../../../../lib/reader-data";
import { storyImageResponse } from "../../../../../../../../../shared/reader-stories";

export const prerender = false;
export const GET: APIRoute = async ({ params }) => {
  try {
    const image = await approvedStoryImage(params.location_id ?? "", params.story_id ?? "");
    if (!image) return new Response("Photo not available", { status: 404, headers: { "Cache-Control": "no-store" } });
    return storyImageResponse(image);
  } catch (error) {
    console.error("Approved story photo unavailable", error);
    return new Response("Photo temporarily unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
};
