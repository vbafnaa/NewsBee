import type { APIRoute } from "astro";
import { directoryTown, saveStoryReport } from "../../../../lib/reader-data";

export const prerender = false;

/** A reader reports a problem with a published story; it goes to the editor Inbox. */
export const POST: APIRoute = async ({ params, request, url }) => {
  if (request.headers.get("origin") !== url.origin) return Response.json({ detail: "Cross-origin submissions are not allowed" }, { status: 403 });
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ detail: "Request body must be valid JSON" }, { status: 400 }); }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length < 5 || message.length > 2000) return Response.json({ detail: "Tell us what is wrong in 5-2000 characters" }, { status: 422 });
  const text = (value: unknown, limit: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
  try {
    const location = await directoryTown(params.location_id ?? "");
    if (!location) return Response.json({ detail: "Unknown location" }, { status: 404 });
    await saveStoryReport(location, { edition_id: text(body.edition_id, 100), story_id: text(body.story_id, 100), headline: text(body.headline, 300), message });
    return Response.json({ status: "received" });
  } catch (error) {
    console.error("Story report could not be saved", error);
    return Response.json({ detail: "Your report could not be saved. Please try again." }, { status: 503 });
  }
};
