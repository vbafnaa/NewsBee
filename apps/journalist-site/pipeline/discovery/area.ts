/**
 * Everything a connector needs to know about a location's surroundings, discovered at run
 * time and cached in MongoDB (`discovered_sources`), never configured in code:
 *
 *   area       nearby Census places (for "nearby" tiering), the county (Census geocoder),
 *              and place names that also exist in other states (ambiguity checks);
 *   newsrooms  news outlets published in or near the location (Wikidata), each kept only
 *              if its site offers a working, recently updated RSS/Atom feed;
 *   athletics  the state's school athletic association feed (Wikidata + feed check);
 *   topics     notable nearby places with a Wikipedia article, for trend watching.
 *
 * Editors add anything discovery misses through manual source links in the journalist
 * portal; those are stored per location and run alongside the discovered sources.
 * The result keeps the shape the connectors already use (`StateConfig`).
 */
import type { ConnectorContext, LocationProfile } from "../connectors/types";
import { distanceKm, type StateConfig } from "../connectors/wider/regions";
import { ensureDirectories } from "../communities/bootstrap";
import { COLLECTIONS } from "../storage/mongo";
import { US_STATES } from "../../../../shared/geography";
import { cachedDiscovery, rejectedUrls } from "./cache";
import { findFeed } from "./feeds";
import { athleticsAssociations, nearbyOutlets, nearbyTopics, type Topic } from "./wikidata";

export const NEARBY_KM = 50;
export const OUTLET_RADIUS_KM = 25;
export const MAX_OUTLETS_CHECKED = 12;
export const AREA_TTL_DAYS = 30;
export const SOURCES_TTL_DAYS = 14;
export const CENSUS_COUNTY = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates";

export type AreaNeeds = { newsrooms?: boolean; athletics?: boolean; topics?: boolean };
export type AreaFacts = { county: string | null; places: Record<string, [number, number]>; ambiguous: string[] };
export type DiscoveredFeed = { name: string; feed: string; website: string; latest: string; provenance: { method: string; detail: string } };

type Context = Pick<ConnectorContext, "db" | "transport" | "fetcher" | "location" | "today" | "log">;

export function townOf(location: LocationProfile) {
  return location.community?.name ?? location.name.split(",")[0].trim();
}
export function centreOf(location: LocationProfile): [number, number] | null {
  const lat = location.community?.latitude ?? location.latitude ?? Number(location.systems.find((system) => system.latitude != null)?.latitude ?? NaN);
  const lon = location.community?.longitude ?? location.longitude ?? Number(location.systems.find((system) => system.longitude != null)?.longitude ?? NaN);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat as number, lon as number] : null;
}

type PlaceRow = { name: string; state: string; latitude: number; longitude: number; name_lower?: string };
/** Census places within NEARBY_KM, nearest first, plus names that also exist in other states. */
export async function areaFacts(context: Context): Promise<AreaFacts> {
  const { location } = context;
  const centre = centreOf(location);
  const entry = await cachedDiscovery<AreaFacts>(context.db, location.id, "area", AREA_TTL_DAYS, async () => {
    if (!centre) return { items: [{ county: null, places: {}, ambiguous: [] }], detail: "Location has no coordinates" };
    const [lat, lon] = centre;
    const places = context.db.collection<PlaceRow>(COLLECTIONS.places);
    if (!(await places.findOne({}, { projection: { _id: 1 } }))) await ensureDirectories(context.db, context.transport);
    const box = await places.find({ state: location.state, latitude: { $gte: lat - 0.5, $lte: lat + 0.5 }, longitude: { $gte: lon - 0.75, $lte: lon + 0.75 } }).toArray();
    const town = townOf(location);
    const near = box.map((place) => ({ place, km: distanceKm(lat, lon, place.latitude, place.longitude) }))
      .filter(({ km }) => km <= NEARBY_KM).sort((a, b) => a.km - b.km).slice(0, 60);
    const named: Record<string, [number, number]> = { [town]: [lat, lon] };
    for (const { place } of near) named[place.name] ??= [place.latitude, place.longitude];
    const elsewhere = await places.aggregate<{ _id: string }>([
      { $match: { name_lower: { $in: Object.keys(named).map((name) => name.toLowerCase()) }, state: { $ne: location.state } } },
      { $group: { _id: "$name_lower" } },
    ]).toArray();
    const ambiguous = Object.keys(named).filter((name) => elsewhere.some((row) => row._id === name.toLowerCase()));
    let county: string | null = null;
    try {
      const url = `${CENSUS_COUNTY}?x=${lon.toFixed(5)}&y=${lat.toFixed(5)}&benchmark=Public_AR_Current&vintage=Current_Current&layers=Counties&format=json`;
      const [, body] = await context.fetcher.get(url, 512 * 1024, "application/json");
      const data = JSON.parse(new TextDecoder().decode(body)) as { result?: { geographies?: { Counties?: Array<{ NAME?: string }> } } };
      county = data.result?.geographies?.Counties?.[0]?.NAME ?? null;
    } catch (error) {
      context.log.info("county_lookup_unavailable", { location_id: location.id, error: error instanceof Error ? error.message : String(error) });
    }
    return { items: [{ county, places: named, ambiguous }], detail: `${near.length} Census places within ${NEARBY_KM} km${county ? `; ${county}` : ""}` };
  });
  return entry.items[0] ?? { county: null, places: {}, ambiguous: [] };
}

/** Outlets near the location that publish a working feed. */
export async function discoveredNewsrooms(context: Context): Promise<DiscoveredFeed[]> {
  const centre = centreOf(context.location);
  if (!centre) return [];
  const rejected = await rejectedUrls(context.db, context.location.id, "newsrooms");
  const entry = await cachedDiscovery<DiscoveredFeed>(context.db, context.location.id, "newsrooms", SOURCES_TTL_DAYS, async () => {
    const outlets = await nearbyOutlets(context.transport, centre[0], centre[1], OUTLET_RADIUS_KM);
    const found: DiscoveredFeed[] = [];
    for (const outlet of outlets.slice(0, MAX_OUTLETS_CHECKED)) {
      const feed = await findFeed(context.fetcher, outlet.website, context.today);
      if (feed) found.push({ name: outlet.name, feed: feed.feed, website: outlet.website, latest: feed.latest, provenance: { method: "wikidata", detail: `Published in ${outlet.place} (${outlet.wikidata})` } });
    }
    return { items: found, detail: `${outlets.length} outlets on Wikidata within ${OUTLET_RADIUS_KM} km; ${found.length} with a current feed` };
  });
  return entry.items.filter((item) => !rejected.has(item.feed));
}

/** The state's school athletic association feed. */
export async function discoveredAthletics(context: Context): Promise<DiscoveredFeed[]> {
  const state = context.location.state;
  if (!US_STATES[state]) return [];
  const entry = await cachedDiscovery<DiscoveredFeed>(context.db, state, "athletics", 30, async () => {
    const found: DiscoveredFeed[] = [];
    for (const org of await athleticsAssociations(context.transport, state)) {
      const feed = await findFeed(context.fetcher, org.website, context.today);
      if (feed) found.push({ name: org.name, feed: feed.feed, website: org.website, latest: feed.latest, provenance: { method: "wikidata", detail: org.wikidata } });
    }
    return { items: found, detail: found.length ? null : `No athletic association with a current feed found for ${state}` };
  });
  const rejected = await rejectedUrls(context.db, state, "athletics");
  return entry.items.filter((item) => !rejected.has(item.feed));
}

export async function discoveredTopics(context: Context): Promise<Topic[]> {
  const centre = centreOf(context.location);
  if (!centre) return [];
  const entry = await cachedDiscovery<Topic>(context.db, context.location.id, "topics", SOURCES_TTL_DAYS, async () => ({
    items: await nearbyTopics(context.transport, centre[0], centre[1], townOf(context.location)),
  }));
  return entry.items;
}

/**
 * The location's surroundings and discovered sources, in the StateConfig shape the
 * connectors read. Only the discoveries a connector asks for are run.
 */
export async function stateSourcesFor(context: Context, needs: AreaNeeds = {}): Promise<Record<string, StateConfig>> {
  const { location } = context;
  const name = US_STATES[location.state];
  if (!name) return {};
  const centre = centreOf(location);
  const [facts, newsrooms, athletics, topics] = await Promise.all([
    areaFacts(context),
    needs.newsrooms ? discoveredNewsrooms(context) : Promise.resolve([]),
    needs.athletics ? discoveredAthletics(context) : Promise.resolve([]),
    needs.topics ? discoveredTopics(context) : Promise.resolve([]),
  ]);
  return {
    [location.state]: {
      name,
      place_suffix: `, ${name}`,
      aliases: [`${name} (state)`, `${name} State`, `State of ${name}`],
      ambiguous_places: facts.ambiguous,
      locations: { [location.id]: { ...(facts.county ? { county: facts.county } : {}), ...(centre ? { point: centre } : {}) } },
      places: facts.places,
      newsrooms: newsrooms.map((item) => ({ name: item.name, feed: item.feed, website: item.website, discovered: item.provenance.detail })),
      watchlist: topics.filter((topic) => topic.place in facts.places),
      athletics: athletics.map((item) => ({ name: item.name, feed: item.feed })),
    },
  };
}
