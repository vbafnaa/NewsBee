/**
 * Stronger "is this about here?" evidence, ported from the NewsBee exploration pipeline's
 * locality checks. communityEvidence (names, coverage terms, coordinates, selected venues)
 * runs first; when it finds nothing this module tries, in order:
 *
 *   1. landmark   - a named park, school, library or community centre inside the area
 *                   (OpenStreetMap via Overpass, fetched once per location and cached),
 *   2. address    - a street address in the text, geocoded with the U.S. Census geocoder
 *                   (cached) and checked against the area, or against the town for towns,
 *   3. article    - the linked article itself, read once through the robots-checked
 *                   Fetcher, and checked with 1-2 again.
 *
 * Every step is bounded per source by a budget so a large feed cannot fan out into
 * hundreds of lookups. The evidence method is stored on the event as `locality` so the
 * run inspection shows why an item was kept.
 */
import type { Db } from "mongodb";
import { plainText } from "./common";
import { communityEvidence, mentions, type CommunityEvidence } from "./community";
import type { Fetcher } from "./fetcher";
import { queryOverpass, QUERY_SECONDS } from "./overpass";
import type { ConnectorContext, LocationProfile } from "./types";
import { distanceKm, withinArea, type Area, type Point } from "../../../../shared/geography";

export const CENSUS_GEOCODER = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
export const OVERPASS = "https://overpass-api.de/api/interpreter";
export const GEOCODE_CACHE = "geocode_cache";
export const LANDMARK_CACHE = "location_landmarks";
export const LANDMARK_MAX_AGE_DAYS = 90;
/** Overpass queues busy requests; a small area query can take 30-60 s to start. */
export const OVERPASS_TIMEOUT_MS = 30_000;
export const TOWN_RADIUS_KM = 8;
export const DEFAULT_BUDGET = { geocodes: 8, articles: 4 } as const;
const ARTICLE_BYTES = 2 * 1024 * 1024;
const ACCEPT_HTML = "text/html, application/xhtml+xml";

export type LocalityMethod = CommunityEvidence["method"] | "town_mention" | "landmark" | "address_boundary" | "address_town" | "article";
export type LocalityEvidence = { method: LocalityMethod; matches: string[]; via?: LocalityMethod };

export type GeocodeMatch = { point: Point; matched: string; city: string | null; state: string | null };
export interface Geocoder { geocode(address: string): Promise<GeocodeMatch | null> }

const SUFFIX = "St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Way|Dr|Drive|Ln|Lane|Pl|Place|Ct|Court|Pkwy|Parkway|Hwy|Highway|Ter|Terrace|Cir|Circle|Sq|Square|Loop|Trl|Trail";
const ADDRESS = new RegExp(`\\b\\d{1,6}(?:-\\d{1,5})?\\s+(?:(?:N|S|E|W|NE|NW|SE|SW)\\.?\\s+)?(?:[A-Z0-9][\\w'.-]*\\s+){1,4}(?:${SUFFIX})\\b\\.?(?:\\s+(?:N|S|E|W|NE|NW|SE|SW)\\b)?`, "g");
/** Street addresses written in the text (house number, street name, suffix). */
export function extractAddresses(text: string | null | undefined, limit = 3): string[] {
  if (!text) return [];
  const found = [...text.matchAll(ADDRESS)].map((match) => match[0].replace(/\s+/g, " ").replace(/\.$/, "").trim());
  return [...new Set(found)].slice(0, limit);
}

/** The U.S. Census Bureau geocoder (public domain data, no key), cached in MongoDB forever. */
export function censusGeocoder(fetcher: Fetcher, db?: Db): Geocoder {
  return {
    async geocode(address: string) {
      const key = address.toLowerCase().replace(/\s+/g, " ").trim();
      const cache = db?.collection<{ _id: string; match: GeocodeMatch | null; cached_at: string }>(GEOCODE_CACHE);
      const hit = await cache?.findOne({ _id: key });
      if (hit) return hit.match;
      const url = `${CENSUS_GEOCODER}?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
      const [, body] = await fetcher.get(url, 512 * 1024, "application/json");
      const match = parseCensus(JSON.parse(new TextDecoder().decode(body)));
      await cache?.updateOne({ _id: key }, { $set: { match, cached_at: new Date().toISOString() } }, { upsert: true });
      return match;
    },
  };
}
export function parseCensus(value: unknown): GeocodeMatch | null {
  const best = (value as { result?: { addressMatches?: Array<{ coordinates?: { x?: number; y?: number }; matchedAddress?: string; addressComponents?: { city?: string; state?: string } }> } })?.result?.addressMatches?.[0];
  const x = best?.coordinates?.x, y = best?.coordinates?.y;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { point: [x, y], matched: String(best?.matchedAddress ?? ""), city: best?.addressComponents?.city ?? null, state: best?.addressComponents?.state ?? null };
}

/** Distinctive named places (two words or more, not generic) inside the area. */
const GENERIC_LANDMARK = /^(?:the )?(?:park|playground|library|school|community cent(?:er|re)|city hall|post office|elementary|middle school|high school|field|garden|dog park)$/i;
export function overpassQuery(bbox: [number, number, number, number]) {
  const [west, south, east, north] = bbox;
  const box = `${south},${west},${north},${east}`;
  return `[out:json][timeout:${QUERY_SECONDS}];(nwr["leisure"~"^(park|playground|stadium|sports_centre|marina)$"]["name"](${box});nwr["amenity"~"^(school|library|community_centre|townhall|marketplace|college|university|theatre|arts_centre|hospital|fire_station)$"]["name"](${box});nwr["tourism"~"^(museum|attraction|zoo|aquarium)$"]["name"](${box}););out tags center 400;`;
}
export function parseLandmarks(value: unknown, area: Area | null, center: Point): string[] {
  const elements = (value as { elements?: Array<{ tags?: Record<string, string>; lat?: number; lon?: number; center?: { lat: number; lon: number } }> })?.elements ?? [];
  const names = new Set<string>();
  for (const element of elements) {
    const name = element.tags?.name?.trim();
    const lat = element.lat ?? element.center?.lat, lon = element.lon ?? element.center?.lon;
    if (!name || name.split(/\s+/).length < 2 || name.length > 80 || GENERIC_LANDMARK.test(name)) continue;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    const point: Point = [lon, lat];
    if (area ? !withinArea(area, center, point) : distanceKm(center, point) > TOWN_RADIUS_KM) continue;
    names.add(name);
    // Aliases come from the same geolocated map object, never a model guess.
    for (const alias of [element.tags?.alt_name, element.tags?.short_name, element.tags?.official_name].flatMap(value => (value ?? "").split(";"))) {
      const trimmed = alias.trim();
      if (trimmed.split(/\s+/).length >= 2 && trimmed.length <= 80 && !GENERIC_LANDMARK.test(trimmed)) names.add(trimmed);
    }
    if (/\bplayfield\b/i.test(name)) names.add(name.replace(/\bplayfield\b/i, "Field"));
  }
  return [...names].sort();
}
/** Websites of community venues (community centres, arts venues, museums...) inside the area. */
const SITE_KINDS = /^(community_centre|arts_centre|theatre|museum|marketplace|library|townhall|park)$/;
export type LocalSite = { name: string; url: string; kind: string };
export function parseSites(value: unknown, area: Area | null, center: Point): LocalSite[] {
  const elements = (value as { elements?: Array<{ tags?: Record<string, string>; lat?: number; lon?: number; center?: { lat: number; lon: number } }> })?.elements ?? [];
  const sites = new Map<string, LocalSite>();
  for (const element of elements) {
    const tags = element.tags ?? {};
    const kind = tags.amenity ?? tags.tourism ?? tags.leisure ?? "";
    const raw = tags.website ?? tags["contact:website"];
    const lat = element.lat ?? element.center?.lat, lon = element.lon ?? element.center?.lon;
    if (!tags.name || !raw || !SITE_KINDS.test(kind) || typeof lat !== "number" || typeof lon !== "number") continue;
    if (area ? !withinArea(area, center, [lon, lat]) : distanceKm(center, [lon, lat]) > TOWN_RADIUS_KM) continue;
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    if (url.protocol !== "https:" || url.username || url.password) continue;
    const key = url.hostname.replace(/^www\./, "");
    if (!sites.has(key)) sites.set(key, { name: tags.name, url: `${url.origin}${url.pathname}`, kind });
  }
  return [...sites.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function areaBox(area: Area | null, center: Point): [number, number, number, number] {
  if (area?.method === "approximate_bbox" && area.bbox) return area.bbox;
  if (area?.method === "boundary" && area.boundary) {
    const rings = area.boundary.type === "Polygon" ? [area.boundary.coordinates[0]] : area.boundary.coordinates.map((polygon) => polygon[0]);
    const points = rings.flat();
    return [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])), Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))];
  }
  const km = area?.radius_km ?? TOWN_RADIUS_KM;
  const dLat = km / 111, dLon = km / (111 * Math.cos(center[1] * Math.PI / 180));
  return [center[0] - dLon, center[1] - dLat, center[0] + dLon, center[1] + dLat];
}

/** Everything the evidence checks need for one location, built once per source run. */
export type Locality = {
  location: LocationProfile;
  town: string;
  state: string;
  center: Point | null;
  area: Area | null;
  landmarks: string[];
  geocoder: Geocoder | null;
  fetcher: Fetcher | null;
  budget: { geocodes: number; articles: number };
};

export function townName(location: LocationProfile) {
  const community = location.community;
  if (community) return community.parent_kind === "city" || !community.parent_kind ? community.parent_name : community.name;
  return location.name.split(",")[0].trim();
}

/** Cached landmarks for the location; looked up once (then every 90 days) and never fatal. */
type PlacesContext = Pick<ConnectorContext, "db" | "transport" | "location" | "today" | "log">;
type PlaceCache = { _id: string; names: string[]; sites?: LocalSite[]; checked_at: string; failed?: boolean; failed_at?: string | null; refreshing_until?: number; area_key?: string };
/** Named places and venue websites in the area; looked up once (then every 90 days) and never fatal. */
export async function areaPlaces(context: PlacesContext, center: Point | null, area: Area | null): Promise<{ names: string[]; sites: LocalSite[] }> {
  if (!center) return { names: [], sites: [] };
  const collection = context.db.collection<PlaceCache>(LANDMARK_CACHE);
  const cached = await collection.findOne({ _id: context.location.id });
  const area_key = JSON.stringify({ area, center });
  const sameArea = cached?.area_key === area_key;
  const age = cached ? (Date.parse(`${context.today}T00:00:00Z`) - Date.parse(cached.checked_at)) / 86400000 : Infinity;
  // A failed lookup (Overpass is often busy) is retried after an hour, a good one after 90 days.
  const failedRecently = cached?.failed && cached.failed_at && Date.now() - Date.parse(cached.failed_at) < 3600_000;
  if (sameArea && cached && cached.sites && (failedRecently || (!cached.failed && age < LANDMARK_MAX_AGE_DAYS))) return { names: cached.names, sites: cached.sites };
  // One refresher per location across workers; other readers use the last valid snapshot.
  const claimed = await collection.findOneAndUpdate({ _id: context.location.id, $or: [{ refreshing_until: { $exists: false } }, { refreshing_until: { $lt: Date.now() } }] },
    { $set: { refreshing_until: Date.now() + 120_000 } }, { upsert: true, returnDocument: "after" }).catch((error: { code?: number }) => { if (error.code === 11000) return null; throw error; });
  if (!claimed) return { names: sameArea ? cached?.names ?? [] : [], sites: sameArea ? cached?.sites ?? [] : [] };
  let names: string[] = [], sites: LocalSite[] = [], failed = false;
  try {
    const { data: parsed } = await queryOverpass(context.transport, overpassQuery(areaBox(area, center)));
    names = parseLandmarks(parsed, area, center); sites = parseSites(parsed, area, center);
  } catch (error) {
    failed = true; names = sameArea ? cached?.names ?? [] : []; sites = sameArea ? cached?.sites ?? [] : [];
    context.log.info("landmarks_unavailable", { location_id: context.location.id, error: error instanceof Error ? error.message : String(error) });
  }
  const checked_at = failed && cached ? cached.checked_at : `${context.today}T00:00:00Z`;
  await collection.updateOne({ _id: context.location.id }, { $set: { names, sites, checked_at, failed, area_key, refreshing_until: 0, failed_at: failed ? new Date().toISOString() : null } }, { upsert: true });
  return { names, sites };
}
export async function landmarksFor(context: PlacesContext, center: Point | null, area: Area | null): Promise<string[]> {
  return (await areaPlaces(context, center, area)).names;
}
export function locationCenter(location: LocationProfile): { center: Point | null; area: Area | null } {
  const lat = location.community?.latitude ?? location.latitude, lon = location.community?.longitude ?? location.longitude;
  return { center: typeof lat === "number" && typeof lon === "number" ? [lon, lat] : null, area: location.community?.geography?.area ?? null };
}

export async function localityFor(context: ConnectorContext, budget: { geocodes: number; articles: number } = { ...DEFAULT_BUDGET }): Promise<Locality> {
  const location = context.location;
  const { center, area } = locationCenter(location);
  const landmarks = await landmarksFor(context, center, area).catch(() => []);
  return { location, town: townName(location), state: location.state, center, area, landmarks, geocoder: censusGeocoder(context.fetcher, context.db), fetcher: context.fetcher, budget };
}

/** Name, coverage-term, coordinate, venue and landmark evidence: no network. */
export function quickEvidence(locality: Locality, texts: Array<string | null | undefined>, coordinates?: Point): LocalityEvidence | null {
  const { location } = locality;
  if (location.community) {
    const found = communityEvidence(location, texts, coordinates);
    if (found) return found;
  } else {
    if (texts.some((text) => mentions(text, locality.town))) return { method: "town_mention", matches: [locality.town] };
    if (coordinates && locality.center && distanceKm(locality.center, coordinates) <= TOWN_RADIUS_KM) return { method: "approximate_area", matches: [`${coordinates[1]}, ${coordinates[0]}`] };
  }
  const landmark = locality.landmarks.find((name) => texts.some((text) => mentions(text, name)));
  return landmark ? { method: "landmark", matches: [landmark] } : null;
}

/** Geocodes up to the budget's worth of written addresses and checks them against the area. */
export async function addressEvidence(locality: Locality, texts: Array<string | null | undefined>): Promise<LocalityEvidence | null> {
  if (!locality.geocoder) return null;
  for (const address of texts.flatMap((text) => extractAddresses(text))) {
    if (locality.budget.geocodes <= 0) return null;
    locality.budget.geocodes -= 1;
    const query = /,\s*[A-Z]{2}\b/.test(address) ? address : `${address}, ${locality.town}, ${locality.state}`;
    let match: GeocodeMatch | null = null;
    try { match = await locality.geocoder.geocode(query); } catch { continue; }
    if (!match) continue;
    if (locality.area && locality.center && withinArea(locality.area, locality.center, match.point)) return { method: "address_boundary", matches: [match.matched || address] };
    if (!locality.area && match.city && match.city.toLowerCase() === locality.town.toLowerCase() && (!match.state || match.state === locality.state)) {
      return { method: "address_town", matches: [match.matched || address] };
    }
  }
  return null;
}

/** Reads the linked article once (budgeted) and looks for evidence in its text. */
export async function articleText(locality: Locality, url: string | null | undefined): Promise<string | null> {
  if (!url || !locality.fetcher || locality.budget.articles <= 0) return null;
  locality.budget.articles -= 1;
  try {
    const [, html] = await locality.fetcher.getText(url, ARTICLE_BYTES, ACCEPT_HTML);
    const body = html.replace(/<(script|style|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
    return plainText(body, 20000);
  } catch { return null; }
}

/** The full evidence ladder: quick checks, then addresses, then the article itself. */
export async function localEvidence(locality: Locality, texts: Array<string | null | undefined>, options: { coordinates?: Point; url?: string | null } = {}): Promise<LocalityEvidence | null> {
  const quick = quickEvidence(locality, texts, options.coordinates);
  if (quick) return quick;
  const address = await addressEvidence(locality, texts);
  if (address) return address;
  const article = await articleText(locality, options.url);
  if (!article) return null;
  const found = quickEvidence(locality, [article]) ?? await addressEvidence(locality, [article]);
  return found ? { method: "article", matches: found.matches, via: found.method } : null;
}

/** An event's explicitly labeled venue is stronger than the school site's navigation. */
export async function outsideEventVenue(locality: Locality, description: string | null | undefined): Promise<string | null> {
  if (!locality.area || !locality.center || !locality.geocoder || locality.budget.geocodes <= 0) return null;
  const locationText = /\blocation\s*:\s*([^\n]{1,240})/i.exec(description ?? "")?.[1];
  const address = locationText && extractAddresses(locationText, 1)[0];
  if (!address) return null;
  locality.budget.geocodes -= 1;
  const match = await locality.geocoder.geocode(`${address}, ${locality.town}, ${locality.state}`).catch(() => null);
  return match && !withinArea(locality.area, locality.center, match.point) ? match.matched || address : null;
}
