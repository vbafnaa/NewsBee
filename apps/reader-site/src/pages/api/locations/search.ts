import type { APIRoute } from "astro";
import { discoverReaderCommunities, searchTownDirectory } from "../../../lib/reader-data";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const query = url.searchParams.get("q") ?? "";
  if (query.length > 80) return Response.json({ detail: "Search query is too long" }, { status: 422 });
  const discover = url.searchParams.get("discover") === "true";
  try {
    return Response.json(
      { query, results: discover ? await discoverReaderCommunities(query) : await searchTownDirectory(query) },
      { headers: { "Cache-Control": discover ? "no-store" : "public, max-age=60, stale-while-revalidate=300" } },
    );
  } catch (error) {
    console.error("Community location search unavailable", error);
    return Response.json({ detail: "Location search unavailable" }, { status: 503 });
  }
};
