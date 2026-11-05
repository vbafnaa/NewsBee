/**
 * Who is in a place, before any searching: schools, libraries, community centres, police and
 * fire stations, funeral homes, clubs and venues from OpenStreetMap. Most local news starts with
 * one of these, and many have a website on record, which needs no paid search to find. Those
 * without one are looked up by name. Cached per location in `discovered_sources`.
 */
import type { HttpTransport } from "../core/http";
import type { Db } from "mongodb";
import { httpsLink } from "../connectors/common";
import { locationCenter, OVERPASS, TOWN_RADIUS_KM } from "../connectors/locality";
import { publicApiGet } from "../connectors/public-api";
import type { LocationProfile } from "../connectors/types";
import { distanceKm, withinArea, type Point } from "../../../../shared/geography";
import { cachedDiscovery } from "./cache";

/** Public Overpass instances tried when the main one is busy. */
export const OVERPASS_MIRRORS = ["https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const TTL_DAYS = 30;
const CAP = 40;
/** Funeral homes and high schools serve a wider area than a neighbourhood. */
const SERVING_KM = 10;
/** A busy Overpass must not use up a job's time: failing is cached and retried within the hour. */
const TIMEOUT_MS = 30_000;

export type Institution = { name: string; kind: string; website: string | null; inside: boolean };
const PRIORITY: Record<string, number> = { school: 0, library: 1, community_centre: 2, police: 3, fire_station: 4, funeral_directors: 5, townhall: 6, club: 7, sports_centre: 8, arts_centre: 9, theatre: 10, park: 11 };

export async function overpassJson(transport: HttpTransport, query: string) {
  let lastError: unknown = null;
  for (const endpoint of [OVERPASS, ...OVERPASS_MIRRORS]) {
    try { return JSON.parse(new TextDecoder().decode(await publicApiGet(transport, `${endpoint}?data=${encodeURIComponent(query)}`, "application/json", 4 * 1024 * 1024, TIMEOUT_MS))) as { elements?: Array<{ tags?: Record<string, string>; lat?: number; lon?: number; center?: { lat: number; lon: number } }> }; }
    catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error("Overpass is unavailable");
}

function websiteOf(tags: Record<string, string>) {
  const raw = (tags.website ?? tags["contact:website"] ?? tags.url ?? "").split(";")[0].trim();
  return raw ? httpsLink(raw.startsWith("http") ? raw.replace(/^http:/, "https:") : `https://${raw.replace(/^\/+/, "")}`) : null;
}

export async function localInstitutions(context: { db: Db; transport: HttpTransport; location: LocationProfile }): Promise<Institution[]> {
  const entry = await cachedDiscovery<Institution>(context.db, context.location.id, "institutions", TTL_DAYS, async () => {
    const { center, area } = locationCenter(context.location);
    if (!center) return { items: [], detail: "Location has no coordinates" };
    const reach = Math.round(Math.max(area?.radius_km ?? 0, SERVING_KM, TOWN_RADIUS_KM) * 1000);
    const around = `(around:${reach},${center[1]},${center[0]})`;
    const query = `[out:json][timeout:25];(nwr${around}["name"]["amenity"~"^(school|library|community_centre|police|fire_station|townhall|arts_centre|theatre)$"];nwr${around}["name"]["shop"="funeral_directors"];nwr${around}["name"]["club"="sport"];nwr${around}["name"]["leisure"~"^(sports_centre|park)$"]["website"];);out tags center 600;`;
    const found: Array<Institution & { km: number }> = [];
    for (const element of (await overpassJson(context.transport, query)).elements ?? []) {
      const tags = element.tags ?? {};
      const kind = tags.amenity ?? (tags.shop === "funeral_directors" ? "funeral_directors" : tags.club === "sport" ? "club" : tags.leisure) ?? "";
      const lat = element.lat ?? element.center?.lat, lon = element.lon ?? element.center?.lon;
      if (!tags.name || PRIORITY[kind] === undefined || typeof lat !== "number" || typeof lon !== "number") continue;
      const point: Point = [lon, lat];
      const inside = area ? withinArea(area, center, point) : distanceKm(center, point) <= TOWN_RADIUS_KM;
      // Outside the area, only what serves it: its nearest funeral homes, high schools and clubs.
      if (!inside && !(kind === "funeral_directors" || kind === "club" || /\bhigh\b/i.test(tags.name))) continue;
      found.push({ name: tags.name, kind, website: websiteOf(tags), inside, km: distanceKm(center, point) });
    }
    found.sort((a, b) => Number(b.inside) - Number(a.inside) || PRIORITY[a.kind] - PRIORITY[b.kind] || a.km - b.km);
    return { items: found.slice(0, CAP).map(({ km: _km, ...item }) => item), detail: `${found.length} places found` };
  });
  return entry.items;
}
