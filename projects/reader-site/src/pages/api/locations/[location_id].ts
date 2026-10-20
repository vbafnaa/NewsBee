import type { APIRoute } from "astro";
import { directoryTown } from "../../../lib/reader-data";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  try {
    const location = await directoryTown(params.location_id ?? "");
    if (!location) return Response.json({ detail: "Unknown location" }, { status: 404 });
    return Response.json({ id: location.id, name: location.name });
  } catch (error) {
    console.error("Census location lookup unavailable", error);
    return Response.json({ detail: "Location unavailable" }, { status: 503 });
  }
};
