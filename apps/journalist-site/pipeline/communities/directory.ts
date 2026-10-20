import { unzipSync } from "fflate";
import { parse } from "csv-parse/sync";
import type { Db } from "mongodb";
import type { HttpTransport } from "../core/http";
import { HttpStatusError, isRedirect } from "../core/http";
import { COLLECTIONS } from "../storage/mongo";
import { logger } from "../core/log";
import { loadSourceConfig } from "../storage/source-configs";
import { communityDirectory, communityName, matchingCommunities, type Community } from "../../../../shared/community-directory";
import { nameKey } from "./venues";
import { GEOGRAPHIC_PLACES, withinArea, stateCode, type GeographicPlace } from "../../../../shared/geography";
import type { GeographicDocument } from "./geocoder";
const log = logger("communities.directory");

export const PLS_URL = "https://imls.gov/sites/default/files/2024-06/pls_fy2022_csv.zip";
export const PLS_EDITION = "FY2022";
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const SEARCH_LIMIT = 10;
export const VENUE_TYPES = new Set(["CE", "BR"]);
type DirectoryDocument = { _id?: string; type: string; fscskey: string; name: string; address: string; city: string; state: string; place_id?: string; latitude?: number | null; longitude?: number | null; edition: string; [key: string]: any };
const DIRECTIONS = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW"]);

export function placeId(city: string, state: string) {
  return `${city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-${state.toLowerCase()}`;
}

export function display(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/[A-Za-z0-9]+/g, (part) => {
    const upper = part.toUpperCase();
    return DIRECTIONS.has(upper) ? upper : `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`;
  })).join(" ");
}

function rows(bytes: Uint8Array, pattern: RegExp, delimiter = ",") {
  const files = Object.keys(unzipSync(bytes)).filter((name) => pattern.test(name));
  if (files.length !== 1) throw new Error(`Expected one file matching ${pattern} in the archive`);
  const text = new TextDecoder("windows-1252").decode(unzipSync(bytes)[files[0]]);
  return parse(text, { columns: true, bom: true, skip_empty_lines: true, delimiter, relax_column_count: true }) as Record<string, string>[];
}

function numeric(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export type LibraryDirectoryCounts = { systems: number; outlets: number; places: number };

/** Systems and outlets share one Mongo collection; `type` discriminates each document. */
export async function importLibraryDirectory(db: Db, zipBytes: Uint8Array): Promise<LibraryDirectoryCounts> {
  let systems: Record<string, string>[];
  let outlets: Record<string, string>[];
  try {
    systems = rows(zipBytes, /_AE_.*\.csv$/i);
    outlets = rows(zipBytes, /outlet.*\.csv$/i);
  } catch (error) {
    if (error instanceof Error && error.message.includes("matching")) throw error;
    throw new Error("Directory download is not a valid ZIP archive", { cause: error });
  }
  const systemFields = ["STABR", "FSCSKEY", "LIBNAME", "ADDRESS", "CITY"];
  const outletFields = [...systemFields, "C_OUT_TY"];
  if (!systems.length || !outlets.length || systemFields.some((key) => !(key in systems[0])) || outletFields.some((key) => !(key in outlets[0]))) {
    throw new Error("Directory archive is missing expected columns");
  }
  const systemDocs = systems.map((row) => ({
    _id: `system:${row.FSCSKEY.trim()}`, type: "system", fscskey: row.FSCSKEY.trim(),
    name: row.LIBNAME.trim(), address: row.ADDRESS.trim(), city: row.CITY.trim(), state: row.STABR.trim(),
    latitude: numeric(row.LATITUDE), longitude: numeric(row.LONGITUD), edition: PLS_EDITION,
    coordinate_schema: 1,
  }));
  const outletDocs = outlets.filter((row) => VENUE_TYPES.has(row.C_OUT_TY) && row.CITY.trim()).map((row) => ({
    type: "outlet", fscskey: row.FSCSKEY.trim(), name: row.LIBNAME.trim(), address: row.ADDRESS.trim(),
    city: row.CITY.trim(), state: row.STABR.trim(), place_id: placeId(row.CITY.trim(), row.STABR.trim()), edition: PLS_EDITION,
    latitude: numeric(row.LATITUDE), longitude: numeric(row.LONGITUD),
  }));
  const collection = db.collection<DirectoryDocument>(COLLECTIONS.libraryOutlets);
  await collection.deleteMany({});
  if (systemDocs.length || outletDocs.length) await collection.insertMany([...systemDocs, ...outletDocs]);
  const counts = { systems: systemDocs.length, outlets: outletDocs.length, places: new Set(outletDocs.map((item) => item.place_id)).size };
  log.info("library_directory_imported", counts);
  return counts;
}

export async function downloadLibraryDirectory(transport: HttpTransport, url = PLS_URL): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; hop <= 3; hop += 1) {
    let parsed: URL;
    try { parsed = new URL(current); } catch { throw new Error(`Refusing non-HTTPS URL: ${current}`); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(`Refusing non-HTTPS URL: ${current}`);
    let response;
    try { response = await transport({ url: current, maxBytes: MAX_DOWNLOAD_BYTES }); }
    catch (error) { if (error instanceof Error && error.name === "ResponseTooLargeError") throw new Error("Directory download exceeds 20 MiB", { cause: error }); throw error; }
    if (isRedirect(response.status)) { current = new URL(response.headers.location ?? "", current).toString(); continue; }
    if (response.status >= 400) throw new HttpStatusError(response.status, current);
    if (response.body.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("Directory download exceeds 20 MiB");
    return response.body;
  }
  throw new Error("More than 3 redirects");
}

export async function systemsForPlace(db: Db, identity: string, branches?: string[]) {
  const outlets = await db.collection<DirectoryDocument>(COLLECTIONS.libraryOutlets).find({ type: "outlet", place_id: identity }).sort({ fscskey: 1, name: 1 }).toArray();
  return systemsForOutlets(db, outlets.filter((outlet) => !branches || branches.some((name) => nameKey(name) === nameKey(outlet.name))));
}

export async function systemsInArea(db: Db, place: GeographicPlace) {
  const outlets = await db.collection<DirectoryDocument>(COLLECTIONS.libraryOutlets).find({ type: "outlet", state: place.state }).sort({ fscskey: 1, name: 1 }).toArray();
  return systemsForOutlets(db, outlets.filter((outlet) => typeof outlet.latitude === "number" && typeof outlet.longitude === "number"
    && withinArea(place.area, [place.longitude, place.latitude], [outlet.longitude, outlet.latitude])));
}

async function systemsForOutlets(db: Db, outlets: Array<{ fscskey: string; name: string; address: string; latitude?: number | null; longitude?: number | null }>) {
  const byKey = new Map<string, typeof outlets>();
  for (const outlet of outlets) {
    const items = byKey.get(outlet.fscskey) ?? [];
    items.push(outlet);
    byKey.set(outlet.fscskey, items);
  }
  const systems = [];
  for (const [key, items] of byKey) {
    const system = await db.collection(COLLECTIONS.libraryOutlets).findOne({ type: "system", fscskey: key });
    if (!system) throw new Error(`Directory is missing library system ${key}`);
    systems.push({
      fscskey: key, name: display(system.name), latitude: system.latitude ?? null, longitude: system.longitude ?? null,
      branches: items.map((item) => ({ name: display(item.name), address: display(item.address), latitude: item.latitude ?? null, longitude: item.longitude ?? null })),
    });
  }
  return { systems, edition: PLS_EDITION };
}

export type Place = { _id: string; geoid: string; state: string; name: string; census_name: string; latitude: number; longitude: number };
export type PlaceSearch = { id: string; name: string; state: string; geoid: string | null; latitude: number; longitude: number; branch_count: number; system_count: number; kind?: "neighborhood"; parent_id?: string; provider?: string; area?: string };

export function geographicSuggestion(place: GeographicPlace): PlaceSearch {
  return { id: place.id, name: place.label, state: place.state, geoid: null, latitude: place.latitude, longitude: place.longitude,
    branch_count: 0, system_count: 0, kind: "neighborhood", provider: "OpenStreetMap", area: place.area.method };
}

export async function loadCommunities(db: Db): Promise<Record<string, Community>> {
  return communityDirectory(await loadSourceConfig(db, process.cwd(), "communities"));
}

export async function searchPlaces(db: Db, query: string, state?: string, limit = SEARCH_LIMIT): Promise<PlaceSearch[]> {
  const [rawCity, embeddedState] = query.split(",", 2).map((part) => part.trim());
  const city = rawCity ?? "";
  const selectedState = stateCode(state ?? query.split(",").at(-1)?.trim() ?? "") ?? (state ?? embeddedState ?? "").toUpperCase();
  if (city.length < 2 || limit <= 0) return [];
  const matches = await db.collection<Place & { name_lower: string }>(COLLECTIONS.places).find({
    name_lower: { $regex: `^${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, $options: "i" },
    ...(selectedState ? { state: selectedState } : {}),
  }).toArray();
  const out: PlaceSearch[] = [];
  const resolved = await db.collection<GeographicDocument>(GEOGRAPHIC_PLACES).find({
    name_lower: { $regex: `^${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, $options: "i" },
    ...(selectedState ? { state: selectedState } : {}),
    ...(query.split(",").length > 2 ? { parent_name: { $regex: `^${query.split(",").slice(1, -1).join(",").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } } : {}),
  }).limit(SEARCH_LIMIT).toArray();
  out.push(...resolved.map(geographicSuggestion));
  for (const [id, community] of matchingCommunities(await loadCommunities(db), query, state)) {
    const { systems } = await systemsForPlace(db, community.parent_id, community.library_branches);
    out.push({ id, name: communityName(community), state: community.state, geoid: null,
      latitude: community.latitude, longitude: community.longitude, kind: "neighborhood", parent_id: community.parent_id,
      branch_count: systems.reduce((sum, system) => sum + system.branches.length, 0), system_count: systems.length });
  }
  for (const place of matches) {
    const outlets = await db.collection(COLLECTIONS.libraryOutlets).find({ type: "outlet", place_id: place._id }).toArray();
    out.push({ id: place._id, name: `${place.name}, ${place.state}`, state: place.state, geoid: place.geoid,
      latitude: place.latitude, longitude: place.longitude, branch_count: outlets.length,
      system_count: new Set(outlets.map((item) => item.fscskey)).size });
  }
  return out.sort((a, b) => Number(a.name.split(",")[0].toLowerCase() !== city.toLowerCase()) - Number(b.name.split(",")[0].toLowerCase() !== city.toLowerCase())
    || Number(b.kind === "neighborhood") - Number(a.kind === "neighborhood")
    || b.branch_count - a.branch_count || a.name.localeCompare(b.name) || a.state.localeCompare(b.state)).slice(0, limit);
}
