import type { APIRoute } from "astro";
import { readerChannelSettings, readerData } from "../../../lib/reader-data";

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    const channel = await readerChannelSettings();
    if (!channel.enabled) {
      return Response.json(
        { detail: "The reader channel is currently disabled" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const { locations, editions } = await readerData(channel.driveFolderId);
    const latestByLocation = new Map<string, (typeof editions)[number]>();
    for (const edition of editions) {
      const current = latestByLocation.get(edition.location_id);
      if (!current || edition.published_at > current.published_at) {
        latestByLocation.set(edition.location_id, edition);
      }
    }
    return Response.json(
      {
        usage: "local_evaluation_only",
        locations: locations.map((location) => {
          const edition = latestByLocation.get(location.id);
          return {
            location_id: location.id,
            location_name: location.name,
            edition_id: edition?.id ?? null,
            published_at: edition?.published_at ?? null,
            window_start: edition?.window_start ?? null,
            window_end: edition?.window_end ?? null,
          };
        }),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Drive editions listing unavailable", error);
    return Response.json({ detail: "Editions unavailable" }, { status: 503 });
  }
};
