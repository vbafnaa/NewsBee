import type { APIRoute } from "astro";
import { readerData, searchLocations } from "../../../lib/reader-data";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const query = url.searchParams.get("q") ?? "";
  if (query.length > 80) return Response.json({ detail: "Search query is too long" }, { status: 422 });
  try {
    const { locations } = await readerData();
    return Response.json(
      { query, results: searchLocations(locations, query) },
      { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } },
    );
  } catch (error) {
    console.error("Drive location search unavailable", error);
    return Response.json({ detail: "Location search unavailable" }, { status: 503 });
  }
};
