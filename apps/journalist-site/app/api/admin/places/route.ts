import { adminRoute } from "@/lib/admin-api";
import { geographicSuggestion, searchPlaces } from "@/pipeline/communities/directory";
import { ensureDirectories } from "@/pipeline/communities/bootstrap";
import { searchGeography } from "@/pipeline/communities/geocoder";

export const maxDuration = 300;

/** Local suggestions while typing; explicit discovery queries the configurable Photon provider. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").slice(0, 80);
  return adminRoute(request, async ({ db }) => {
    if (query.trim().length < 2) return { query, results: [] };
    const explicit = params.get("discover") === "1";
    const results = explicit ? (await searchGeography(db, query)).map(geographicSuggestion) : [];
    if (!explicit) await ensureDirectories(db);
    const local = await searchPlaces(db, query, params.get("state") ?? undefined);
    return { query, results: [...new Map([...results, ...local].map((place) => [place.id, place])).values()].slice(0, 20) };
  });
}
