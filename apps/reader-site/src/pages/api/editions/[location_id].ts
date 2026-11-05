import type { APIRoute } from "astro";
import { readerData } from "../../../lib/reader-data";

export const prerender = false;

export const GET: APIRoute = async ({ params, url }) => {
  try {
    const { locations, editions } = await readerData();
    const location = locations.find((item) => item.id === params.location_id);
    if (!location) {
      return Response.json({ detail: "Unknown location" }, { status: 404 });
    }
    const requestedEdition = url.searchParams.get("edition");
    const edition = editions
      .filter((item) => item.location_id === location.id && (!requestedEdition || item.id === requestedEdition))
      .sort((left, right) => right.published_at - left.published_at)[0];
    if (!edition) return Response.json({ detail: "No edition yet" }, { status: 404 });
    return Response.json(edition, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Drive edition unavailable", error);
    return Response.json({ detail: "Edition unavailable" }, { status: 503 });
  }
};
