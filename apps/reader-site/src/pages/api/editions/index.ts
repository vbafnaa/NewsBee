import type { APIRoute } from "astro";
import { legacyReaderDiscovery, publicationDirectory } from "../../../lib/reader-data";

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    const [{ locations, editions }, publications] = await Promise.all([
      legacyReaderDiscovery({ indexOnly: true }),
      publicationDirectory(),
    ]);
    const latestByLocation = new Map<string, (typeof editions)[number]>();
    for (const edition of editions) {
      const current = latestByLocation.get(edition.location_id);
      if (!current || edition.published_at > current.published_at) {
        latestByLocation.set(edition.location_id, edition);
      }
    }
    const publicationsByLocation = new Map<string, typeof publications>();
    for (const publication of publications) {
      for (const location of publication.locations) {
        const values = publicationsByLocation.get(location.id) ?? [];
        values.push(publication);
        publicationsByLocation.set(location.id, values);
      }
    }
    const allLocations = new Map(locations.map((location) => [location.id, location]));
    for (const publication of publications) {
      for (const location of publication.locations) {
        if (!allLocations.has(location.id)) allLocations.set(location.id, location);
      }
    }
    return Response.json(
      {
        usage: "local_evaluation_only",
        locations: [...allLocations.values()].map((location) => {
          const edition = latestByLocation.get(location.id);
          const locationPublications = publicationsByLocation.get(location.id) ?? [];
          return {
            location_id: location.id,
            location_name: location.name,
            edition_id: edition?.id ?? null,
            published_at: edition?.published_at ?? null,
            window_start: edition?.window_start ?? null,
            window_end: edition?.window_end ?? null,
            publication_count: locationPublications.length,
            publications: locationPublications,
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
