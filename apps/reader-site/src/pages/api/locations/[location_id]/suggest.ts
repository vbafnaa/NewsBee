import type { APIRoute } from "astro";
import { directoryTown, saveSourceSuggestion, validateSuggestion } from "../../../../lib/reader-data";

export const prerender = false;

/** A reader's source suggestion, stored for an editor; it joins the source map only once approved and checked. */
export const POST: APIRoute = async ({ params, request, url }) => {
  if (request.headers.get("origin") !== url.origin) return Response.json({ detail: "Cross-origin submissions are not allowed" }, { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ detail: "Request body must be valid JSON" }, { status: 400 }); }
  const checked = validateSuggestion(body);
  if ("error" in checked) return Response.json({ detail: checked.error }, { status: 422 });
  try {
    const location = await directoryTown(params.location_id ?? "");
    if (!location) return Response.json({ detail: "Unknown location" }, { status: 404 });
    await saveSourceSuggestion(location, checked.input);
    return Response.json({ status: "pending_review" });
  } catch (error) {
    console.error("Source suggestion could not be saved", error);
    return Response.json({ detail: "Your suggestion could not be saved. Please try again." }, { status: 503 });
  }
};
