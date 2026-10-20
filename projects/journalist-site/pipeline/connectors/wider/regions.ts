import { httpsLink } from "../common";
import type { LocationProfile } from "../types";

export const LOCAL_KM = 15;
export const NEARBY_KM = 50;
export const STATE_CODE = /^[A-Z]{2}$/;
export const ARTICLE = /^[^\s#<>\[\]{}|]{1,200}$/;
export type Point = [number, number];
export type Newsroom = { name: string; feed: string; page?: string; website?: string; [key: string]: unknown };
export type WatchlistEntry = { article: string; about: string; place: string };
export type StateConfig = {
  name: string;
  place_suffix?: string;
  aliases?: string[];
  ambiguous_places?: string[];
  locations?: Record<string, { county?: string; point?: Point }>;
  places?: Record<string, Point>;
  newsrooms?: Newsroom[];
  watchlist?: WatchlistEntry[];
};
export type Region = {
  location_id: string; town: string; state_code: string; state_name: string | null; county: string | null;
  latitude: number | null; longitude: number | null; aliases: string[]; place_suffix: string | null;
  newsrooms: Newsroom[]; watchlist: WatchlistEntry[]; nearby: string[]; nearby_topics: WatchlistEntry[];
  ambiguous: Set<string>; configured: boolean;
};

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const phi1 = radians(lat1), phi2 = radians(lat2);
  const dphi = phi2 - phi1, dlambda = radians(lon2 - lon1);
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function validPoint(value: unknown): value is Point {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    value[0] >= -90 && value[0] <= 90 && value[1] >= -180 && value[1] <= 180;
}

export function validateStateSources(value: unknown): Record<string, StateConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("state-sources.json must map state codes to their sources");
  const states = value as Record<string, StateConfig>;
  for (const [code, state] of Object.entries(states)) {
    const where = `state-sources.json entry ${code}`;
    if (!STATE_CODE.test(code) || !state || typeof state !== "object" || !state.name) throw new Error(`${where} needs an uppercase state code and a name`);
    for (const newsroom of state.newsrooms ?? []) if (!newsroom.name || httpsLink(newsroom.feed) === null) throw new Error(`${where}: every newsroom needs a name and an HTTPS feed`);
    for (const [name, point] of Object.entries(state.places ?? {})) if (!validPoint(point)) throw new Error(`${where}: place ${name} needs [latitude, longitude]`);
    for (const entry of state.watchlist ?? []) {
      if (!ARTICLE.test(String(entry.article ?? "")) || !entry.about) throw new Error(`${where}: every watchlist entry needs an article and about`);
      if (!(entry.place in (state.places ?? {}))) throw new Error(`${where}: watchlist ${entry.article} needs a known place`);
    }
    for (const [id, entry] of Object.entries(state.locations ?? {})) if (entry.point && !validPoint(entry.point)) throw new Error(`${where}: ${id} point needs [latitude, longitude]`);
  }
  return states;
}
export function mentions(text: string | null | undefined, name: string | null | undefined): boolean {
  if (!text || !name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i").test(text);
}

function named(place: Region, texts: Array<string | null | undefined>, name: string, qualified: boolean) {
  if (!texts.some((text) => mentions(text, name))) return false;
  if (qualified || !place.ambiguous.has(name)) return true;
  return texts.some((text) => [place.state_name, place.state_code, place.county].some((anchor) => mentions(text, anchor)));
}

export function tierFor(place: Region, texts: Array<string | null | undefined>, qualified = false): "local" | "region" | "nearby" | null {
  if (named(place, texts, place.town, qualified)) return "local";
  if (place.county && texts.some((text) => mentions(text, place.county))) return "region";
  if (place.nearby.some((name) => named(place, texts, name, qualified))) return "nearby";
  return null;
}

export function itemTier(place: Region, title: string | null | undefined, body: string | null | undefined, qualified = false) {
  const tier = tierFor(place, [title, body], qualified);
  if (tier === "nearby" && tierFor(place, [title], qualified) !== "nearby") return null;
  return tier;
}

export function section(place: Region, tier: "local" | "region" | "nearby") {
  if (tier === "local") return `${place.town} in the news`;
  if (tier === "region" && place.county) return `Around ${place.county}`;
  return `Near ${place.town}`;
}

export function resolveRegion(location: LocationProfile, states: Record<string, StateConfig>): Region {
  const stateCode = location.id.split("-").at(-1)?.toUpperCase() ?? "";
  const town = location.name.split(",")[0].trim();
  // The Python profile uses the first library system with reviewed coordinates. Census coordinates
  // are the approved fallback for towns without a configured centre or library coordinates.
  const system: { latitude?: string | number | null; longitude?: string | number | null } = location.systems.find((entry) => entry.latitude !== undefined && entry.latitude !== null) ?? {};
  const systemLat = system.latitude === undefined || system.latitude === null ? null : Number(system.latitude);
  const systemLon = system.longitude === undefined || system.longitude === null ? null : Number(system.longitude);
  const state = states[stateCode];
  if (!state) return { location_id: location.id, town, state_code: stateCode, state_name: null, county: null,
    latitude: systemLat, longitude: systemLon,
    aliases: [], place_suffix: null, newsrooms: [], watchlist: [], nearby: [], nearby_topics: [], ambiguous: new Set(), configured: false };
  const local = state.locations?.[location.id] ?? {};
  const latitude = local.point?.[0] ?? location.latitude ?? systemLat;
  const longitude = local.point?.[1] ?? location.longitude ?? systemLon;
  const near = Object.entries(state.places ?? {}).map(([name, point]) => [name, distanceKm(latitude ?? NaN, longitude ?? NaN, point[0], point[1])] as const)
    .filter(([, km]) => latitude !== null && latitude !== undefined && longitude !== null && longitude !== undefined && km <= NEARBY_KM)
    .sort((a, b) => a[1] - b[1]).map(([name]) => name);
  return { location_id: location.id, town, state_code: stateCode, state_name: state.name, county: local.county ?? null,
    latitude: latitude ?? null, longitude: longitude ?? null, aliases: state.aliases ?? [], place_suffix: state.place_suffix ?? null,
    newsrooms: state.newsrooms ?? [], watchlist: state.watchlist ?? [], nearby: near.filter((name) => name !== town),
    nearby_topics: (state.watchlist ?? []).filter((entry) => near.includes(entry.place)),
    ambiguous: new Set(state.ambiguous_places ?? []), configured: true };
}
