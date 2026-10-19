import type { APIRoute } from "astro";
import { readerChannelSettings, readerData } from "../../../lib/reader-data";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  try {
    const channel = await readerChannelSettings();
    if (!channel.enabled) {
      return Response.json(
        { detail: "The reader channel is currently disabled" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const { locations, editions } = await readerData(channel.driveFolderId);
    const location = locations.find((item) => item.id === params.location_id);
    if (!location) {
      return Response.json({ detail: "Unknown location" }, { status: 404 });
    }
    const edition = editions
      .filter((item) => item.location_id === location.id)
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
