import type { APIRoute } from "astro";
import { readerData, saveEngagement } from "../../lib/reader-data";

export const prerender = false;
const ID = /^[A-Za-z0-9:_-]{1,100}$/;
const ACTIONS = new Set(["view", "open", "share"]);

/**
 * Anonymous reading signals for ranking: an edition was viewed (with the stories shown), or
 * a full story was opened or the story was shared. No cookies, IP addresses or user
 * identifiers are stored.
 */
export const POST: APIRoute = async ({ request, url }) => {
  if (request.headers.get("origin") !== url.origin) return Response.json({ detail: "Cross-origin requests are not allowed" }, { status: 403 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ detail: "Request body must be valid JSON" }, { status: 400 }); }
  const { location_id, edition_id, action, story_id, story_ids } = body ?? {};
  if (typeof location_id !== "string" || !ID.test(location_id) || typeof edition_id !== "string" || !ID.test(edition_id) || typeof action !== "string" || !ACTIONS.has(action)) {
    return Response.json({ detail: "Invalid engagement event" }, { status: 422 });
  }
  const stories = action === "view"
    ? (Array.isArray(story_ids) ? story_ids.filter((id): id is string => typeof id === "string" && ID.test(id)).slice(0, 40) : [])
    : (typeof story_id === "string" && ID.test(story_id) ? [story_id] : []);
  if (!stories.length && action !== "view") return Response.json({ detail: "Invalid engagement event" }, { status: 422 });
  try {
    const { editions } = await readerData();
    const edition = editions.find((edition) => edition.id === edition_id && edition.location_id === location_id);
    if (!edition || stories.some((story) => !edition.items.some((item) => item.story_id === story))) {
      return Response.json({ detail: "Unknown edition or story" }, { status: 422 });
    }
    await saveEngagement({ location_id, edition_id, action: action as "view" | "open" | "share", story_ids: stories });
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Engagement event could not be saved", error);
    return Response.json({ detail: "Not saved" }, { status: 503 });
  }
};
