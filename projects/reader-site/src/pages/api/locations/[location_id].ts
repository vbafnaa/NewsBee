import type { APIRoute } from "astro";
import { readerData } from "../../../lib/reader-data";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  try {
    const { locations } = await readerData();
    const location = locations.find((item) => item.id === params.location_id);
    if (!location) return Response.json({ detail: "Unknown location" }, { status: 404 });
    return Response.json({ id: location.id, name: location.name });
  } catch (error) {
    console.error("Drive location lookup unavailable", error);
    return Response.json({ detail: "Location unavailable" }, { status: 503 });
  }
};
