import type { APIRoute } from "astro";
import { directoryTown, saveReaderStory } from "../../../../lib/reader-data";
import { validateReaderStory } from "../../../../../../../shared/reader-stories";
import { storySubmission, StorySubmissionError } from "../../../../lib/story-submission";

export const prerender = false;

/** A neighbour's story, stored for an editor to review; nothing is published until approved. */
export const POST: APIRoute = async ({ params, request, url }) => {
  if (request.headers.get("origin") !== url.origin) return Response.json({ detail: "Cross-origin submissions are not allowed" }, { status: 403 });
  try {
    const { body, image } = await storySubmission(request);
    const checked = validateReaderStory(body);
    if ("error" in checked) return Response.json({ detail: checked.error }, { status: 422 });
    const location = await directoryTown(params.location_id ?? "");
    if (!location) return Response.json({ detail: "Unknown location" }, { status: 404 });
    await saveReaderStory(location, checked.input, image);
    return Response.json({ status: "pending_review" });
  } catch (error) {
    if (error instanceof StorySubmissionError) return Response.json({ detail: error.message }, { status: error.status });
    console.error("Neighbour story could not be saved", error);
    return Response.json({ detail: "Your story could not be saved. Please try again." }, { status: 503 });
  }
};
