import type { APIRoute } from "astro";
import { directoryTown, saveRemembrance } from "../../../../lib/reader-data";
import { validateRemembrance } from "../../../../../../../shared/remembrance";

export const prerender = false;

/** A family's death notice, stored for an editor to confirm; nothing is published until approved. */
export const POST: APIRoute = async ({ params, request, url }) => {
  if (request.headers.get("origin") !== url.origin) {
    return Response.json({ detail: "Cross-origin submissions are not allowed" }, { status: 403 });
  }
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ detail: "Request body must be valid JSON" }, { status: 400 }); }
  const checked = validateRemembrance(body);
  if ("error" in checked) return Response.json({ detail: checked.error }, { status: 422 });
  try {
    const location = await directoryTown(params.location_id ?? "");
    if (!location) return Response.json({ detail: "Unknown location" }, { status: 404 });
    await saveRemembrance(location, checked.input);
    return Response.json({ status: "pending_review" });
  } catch (error) {
    console.error("Remembrance submission could not be saved", error);
    return Response.json({ detail: "Your notice could not be saved. Please try again." }, { status: 503 });
  }
};
