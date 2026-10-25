import { adminRoute, jsonBody } from "@/lib/admin-api";
import { listLocations, onboardLocation } from "@/pipeline/communities/locations";
import { discoverGovernment, overrides } from "@/pipeline/connectors/meetings/discovery";
import { fetchTransport } from "@/pipeline/core/http";
import { publicOnlyTransport } from "@/pipeline/connectors/public-http";
import { selectSources } from "@/pipeline/connectors/registry";
import { logLocationSources } from "@/pipeline/orchestration/source-log";
import { ensureDirectories } from "@/pipeline/communities/bootstrap";
import { logger } from "@/pipeline/core/log";

export const maxDuration = 300;

export async function GET(request: Request) {
  return adminRoute(request, async ({ db }) => ({ locations: await listLocations(db) }));
}

/** Onboard a town or saved geographic community with scoped sources. */
export async function POST(request: Request) {
  return adminRoute(request, async ({ db, settings }) => {
    const body = await jsonBody<{ place_id?: unknown }>(request);
    if (typeof body.place_id !== "string" || !body.place_id) throw new Error("Invalid place_id");
    const geographic = body.place_id.startsWith("osm-");
    const discoveryGaps: string[] = [];
    try {
      await ensureDirectories(db, fetchTransport, { libraryCoordinates: geographic, skipCensus: geographic });
    } catch (error) {
      if (!geographic) throw error;
      const detail = `Reference library directory unavailable: ${error instanceof Error ? error.message : String(error)}`;
      logger("communities").warn("community_directory_unavailable", { location_id: body.place_id, detail });
      discoveryGaps.push(detail);
    }
    const governmentOverrides = await overrides(settings.root, db);
    // Discovery follows homepage and feed links from OSM and Wikidata, so only public hosts are reachable.
    const transport = publicOnlyTransport(fetchTransport);
    const location = await onboardLocation(db, transport, body.place_id, {
      settings, discoveryGaps,
      discoverGovernment: (profile) => discoverGovernment(transport, profile, governmentOverrides[profile.id] ?? governmentOverrides[profile.community?.parent_id ?? ""] ?? null),
    });
    logLocationSources(location, selectSources(location, settings));
    return { location };
  });
}
