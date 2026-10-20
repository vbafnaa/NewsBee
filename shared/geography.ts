export type Point = [number, number]; // longitude, latitude
export type Polygon = { type: "Polygon"; coordinates: Point[][] };
export type MultiPolygon = { type: "MultiPolygon"; coordinates: Point[][][] };
export type Area = {
  method: "boundary" | "approximate_bbox" | "approximate_radius";
  boundary?: Polygon | MultiPolygon;
  bbox?: [number, number, number, number];
  radius_km?: number;
};
export type GeographicPlace = {
  id: string;
  name: string;
  label: string;
  state: string;
  state_name: string;
  kind: string;
  parent_name: string | null;
  parent_kind: "city" | "county" | null;
  latitude: number;
  longitude: number;
  area: Area;
  provider: "photon";
  osm_type: "N" | "W" | "R";
  osm_id: number;
  website: string | null;
  attribution: string;
};

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
export const GEOGRAPHIC_PLACES = "geographic_places";
export const US_STATES: Record<string, string> = Object.fromEntries(
  ("AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|DC:District of Columbia|" +
    "FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|" +
    "MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|" +
    "NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|" +
    "OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|" +
    "VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming|PR:Puerto Rico|VI:United States Virgin Islands|" +
    "GU:Guam|AS:American Samoa|MP:Northern Mariana Islands").split("|").map((entry) => entry.split(":")),
);

export function stateCode(name: string) {
  return Object.keys(US_STATES).find((code) => code === name.toUpperCase() || US_STATES[code].toLowerCase() === name.toLowerCase()) ?? null;
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function point(value: unknown): value is Point {
  return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number" && Number.isFinite(item))
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}
export function boundary(value: unknown): Polygon | MultiPolygon | null {
  if (!record(value)) return null;
  const ring = (value: unknown): value is Point[] => Array.isArray(value) && value.length >= 4 && value.every(point)
    && value[0][0] === value.at(-1)?.[0] && value[0][1] === value.at(-1)?.[1];
  const polygon = (value: unknown): value is Point[][] => Array.isArray(value) && value.length > 0 && value.every(ring);
  if (value.type === "Polygon" && polygon(value.coordinates)) return { type: "Polygon", coordinates: value.coordinates };
  if (value.type === "MultiPolygon" && Array.isArray(value.coordinates) && value.coordinates.length && value.coordinates.every(polygon)) {
    return { type: "MultiPolygon", coordinates: value.coordinates };
  }
  return null;
}
export function distanceKm(a: Point, b: Point) {
  const radians = (value: number) => value * Math.PI / 180;
  const dlat = radians(b[1] - a[1]), dlon = radians(b[0] - a[0]);
  return 6371 * 2 * Math.asin(Math.sqrt(Math.sin(dlat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dlon / 2) ** 2));
}
function inRing([x, y]: Point, ring: Point[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
    if (Math.abs(cross) < 1e-10 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return true;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function withinArea(area: Area, center: Point, location: Point) {
  if (area.method === "boundary" && area.boundary) {
    const polygons = area.boundary.type === "Polygon" ? [area.boundary.coordinates] : area.boundary.coordinates;
    return polygons.some((rings) => inRing(location, rings[0]) && !rings.slice(1).some((ring) => inRing(location, ring)));
  }
  if (area.method === "approximate_bbox" && area.bbox) {
    const [west, south, east, north] = area.bbox;
    return location[0] >= west && location[0] <= east && location[1] >= south && location[1] <= north;
  }
  return area.method === "approximate_radius" && distanceKm(center, location) <= (area.radius_km ?? 2);
}
export function areaLabel(area: Area) {
  return area.method === "boundary" ? "Provider boundary" : area.method === "approximate_bbox" ? "Approximate provider bounding box (not a boundary)"
    : `Approximate ${area.radius_km ?? 2} km radius (not a boundary)`;
}

const SETTLEMENTS = new Set(["neighbourhood", "neighborhood", "suburb", "quarter", "city_district", "borough", "locality", "hamlet", "village", "town", "city", "isolated_dwelling"]);
export function parsePhoton(value: unknown): GeographicPlace[] {
  if (!record(value) || value.type !== "FeatureCollection" || !Array.isArray(value.features)) throw new Error("Geocoder response is not a FeatureCollection");
  const results: GeographicPlace[] = [];
  for (const feature of value.features) {
    if (!record(feature) || feature.type !== "Feature" || !record(feature.properties) || !record(feature.geometry)) continue;
    const p = feature.properties;
    const settlement = p.osm_key === "place" && SETTLEMENTS.has(String(p.osm_value));
    const districtBoundary = p.osm_key === "boundary" && p.osm_value === "administrative" && ["district", "locality", "city"].includes(String(p.type));
    if (String(p.countrycode).toUpperCase() !== "US" || (!settlement && !districtBoundary)) continue;
    if (typeof p.name !== "string" || !p.name.trim() || typeof p.state !== "string") continue;
    const state = stateCode(p.state);
    if (!state || !["N", "W", "R"].includes(String(p.osm_type)) || typeof p.osm_id !== "number" || !Number.isSafeInteger(p.osm_id) || p.osm_id <= 0) continue;
    const polygon = boundary(feature.geometry);
    const extent = p.extent;
    const bbox = Array.isArray(extent) && extent.length === 4 && point([extent[0], extent[3]]) && point([extent[2], extent[1]])
      && extent[0] < extent[2] && extent[3] < extent[1] ? [extent[0], extent[3], extent[2], extent[1]] as [number, number, number, number] : null;
    const outline = polygon ? (polygon.type === "Polygon" ? polygon.coordinates[0] : polygon.coordinates.flatMap((rings) => rings[0])) : [];
    const bounds = outline.reduce(([west, south, east, north], [x, y]) =>
      [Math.min(west, x), Math.min(south, y), Math.max(east, x), Math.max(north, y)], [Infinity, Infinity, -Infinity, -Infinity]);
    const center = feature.geometry.type === "Point" && point(feature.geometry.coordinates) ? feature.geometry.coordinates
      : bbox ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] as Point
        : outline.length ? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2] as Point : null;
    if (!center) continue;
    const city = typeof p.city === "string" && p.city.toLowerCase() !== p.name.toLowerCase() ? p.city : null;
    const county = typeof p.county === "string" ? (/\b(county|parish|borough|census area|municipality)\b/i.test(p.county) ? p.county : `${p.county} County`) : null;
    const municipal = ["city", "town", "village", "borough"].includes(String(p.osm_value)) || (districtBoundary && p.type === "city");
    const parent = municipal ? p.name : city ?? county;
    const parentKind = municipal || city ? "city" : county ? "county" : null;
    let website: string | null = null;
    if (record(p.extra)) {
      const raw = p.extra.website ?? p.extra["contact:website"];
      if (typeof raw === "string") {
        try { const url = new URL(raw); if (url.protocol === "https:" && !url.username && !url.password) website = url.toString(); } catch { /* Optional OSM website is not a valid URL. */ }
      }
    }
    const place: GeographicPlace = {
      id: `osm-${String(p.osm_type).toLowerCase()}${p.osm_id}-${state.toLowerCase()}`,
      name: p.name, label: [p.name, ...(parent && parent !== p.name ? [parent] : []), state].join(", "),
      state, state_name: US_STATES[state], kind: districtBoundary ? String(p.type) : String(p.osm_value), parent_name: typeof parent === "string" ? parent : null, parent_kind: parentKind,
      latitude: center[1], longitude: center[0], area: polygon ? { method: "boundary", boundary: polygon }
        : bbox ? { method: "approximate_bbox", bbox } : { method: "approximate_radius", radius_km: 2 },
      provider: "photon", osm_type: p.osm_type as GeographicPlace["osm_type"], osm_id: p.osm_id, website, attribution: OSM_ATTRIBUTION,
    };
    if (!results.some((entry) => entry.id === place.id)) results.push(place);
  }
  return results;
}
