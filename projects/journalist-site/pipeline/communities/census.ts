import { unzipSync } from "fflate";
import { parse } from "csv-parse/sync";
import type { Db } from "mongodb";
import type { HttpTransport } from "../core/http";
import { HttpStatusError, isRedirect } from "../core/http";
import { COLLECTIONS } from "../storage/mongo";
import { logger } from "../core/log";
const log = logger("communities.census");
import { placeId, type Place } from "./directory";
export { searchPlaces } from "./directory";

export const CENSUS_PLACES_URL = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_place_national.zip";
export const MAX_CENSUS_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const SUFFIX = /\s+(?:city|town|village|borough|municipality|plantation|township|CDP)$/i;

export function cleanCensusName(value: string) { return value.trim().replace(SUFFIX, "").trim(); }

export async function importCensusPlaces(db: Db, zipBytes: Uint8Array): Promise<{ places: number; duplicates: number }> {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(zipBytes); } catch (error) { throw new Error("Census download is not a ZIP archive", { cause: error }); }
  const names = Object.keys(files).filter((name) => /gaz_place_national.*\.txt$/i.test(name));
  if (names.length !== 1) throw new Error("Expected one national places Gazetteer file in the archive");
  const text = new TextDecoder("utf-8").decode(files[names[0]]).replace(/^\uFEFF/, "");
  const records = parse(text, { columns: (header: string[]) => header.map((name) => name.trim()), delimiter: "\t", skip_empty_lines: true, bom: true, relax_column_count: true }) as Record<string, string>[];
  if (!records.length || !["GEOID", "USPS", "NAME", "FUNCSTAT", "INTPTLAT", "INTPTLONG"].every((field) => field in records[0])) {
    throw new Error("Census Gazetteer is missing expected columns");
  }
  const sorted = records.filter((row) => row.FUNCSTAT.trim() === "A" && row.GEOID && row.USPS && row.NAME)
    .sort((a, b) => a.GEOID.localeCompare(b.GEOID));
  const chosen = new Map<string, Place>();
  let duplicates = 0;
  for (const row of sorted) {
    const name = cleanCensusName(row.NAME);
    const id = placeId(name, row.USPS);
    if (chosen.has(id)) { duplicates += 1; continue; }
    const latitude = Number(row.INTPTLAT);
    const longitude = Number(row.INTPTLONG);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    chosen.set(id, { _id: id, geoid: row.GEOID, state: row.USPS, name, census_name: row.NAME,
      latitude, longitude });
  }
  const collection = db.collection<Place & { name_lower: string }>(COLLECTIONS.places);
  await collection.deleteMany({});
  const docs = [...chosen.values()].map((place) => ({ ...place, name_lower: place.name.toLowerCase() }));
  if (docs.length) await collection.insertMany(docs);
  const result = { places: docs.length, duplicates };
  log.info("census_places_imported", result);
  return result;
}

export async function downloadCensusPlaces(transport: HttpTransport, url = CENSUS_PLACES_URL): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; hop <= 3; hop += 1) {
    let parsed: URL;
    try { parsed = new URL(current); } catch { throw new Error(`Refusing non-HTTPS URL: ${current}`); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(`Refusing non-HTTPS URL: ${current}`);
    let response;
    try { response = await transport({ url: current, maxBytes: MAX_CENSUS_DOWNLOAD_BYTES }); }
    catch (error) { if (error instanceof Error && error.name === "ResponseTooLargeError") throw new Error("Census download exceeds 20 MiB", { cause: error }); throw error; }
    if (isRedirect(response.status)) { current = new URL(response.headers.location ?? "", current).toString(); continue; }
    if (response.status >= 400) throw new HttpStatusError(response.status, current);
    if (response.body.byteLength > MAX_CENSUS_DOWNLOAD_BYTES) throw new Error("Census download exceeds 20 MiB");
    return response.body;
  }
  throw new Error("More than 3 redirects");
}
