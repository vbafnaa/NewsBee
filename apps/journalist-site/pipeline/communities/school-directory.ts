/**
 * School districts and their websites, from the NCES Common Core of Data, loaded once into
 * MongoDB like the library directory. A district's NCES id is also its Census GEOID, so a place's
 * coordinates lead straight to its district's own website. NCES's search pages disallow robots;
 * this published data file does not.
 */
import { parse } from "csv-parse/sync";
import { unzipSync } from "fflate";
import type { Db } from "mongodb";
import { HttpStatusError, type HttpTransport } from "../core/http";
import { httpsLink } from "../connectors/common";
import { COLLECTIONS } from "../storage/mongo";

export const CCD_LEA_URL = "https://nces.ed.gov/ccd/data/zip/ccd_lea_029_2324_w_1a_073124.zip";
export const CCD_EDITION = "2023-24";
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

export type SchoolDistrict = { _id: string; name: string; state: string; website: string; edition: string };

export function schoolDistricts(db: Db) { return db.collection<SchoolDistrict>(COLLECTIONS.schoolDistricts); }

/** Rows of the CCD agency file with a usable website. */
export function parseDistricts(zipBytes: Uint8Array): SchoolDistrict[] {
  const entry = Object.entries(unzipSync(zipBytes, { filter: (file) => /\.csv$/i.test(file.name) }))[0];
  if (!entry) throw new Error("The school district file has no CSV");
  const rows = parse(new TextDecoder("latin1").decode(entry[1]), { columns: true, skip_empty_lines: true, relax_column_count: true }) as Array<Record<string, string>>;
  return rows.flatMap((row) => {
    const raw = (row.WEBSITE ?? "").trim();
    const website = raw ? httpsLink(/^https?:/i.test(raw) ? raw.replace(/^http:/i, "https:") : `https://${raw}`) : null;
    return website && row.LEAID && row.SY_STATUS !== "2" ? [{ _id: row.LEAID, name: row.LEA_NAME, state: row.ST, website, edition: CCD_EDITION }] : [];
  });
}

/** Loads the directory the first time it is needed. Loading twice is harmless: ids are the keys. */
export async function ensureSchoolDistricts(db: Db, transport: HttpTransport) {
  if (await schoolDistricts(db).findOne({}, { projection: { _id: 1 } })) return;
  const response = await transport({ url: CCD_LEA_URL, maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: 120_000 });
  if (response.status >= 400) throw new HttpStatusError(response.status, CCD_LEA_URL);
  const rows = parseDistricts(response.body);
  if (rows.length) await schoolDistricts(db).bulkWrite(rows.map((row) => ({ replaceOne: { filter: { _id: row._id }, replacement: row, upsert: true } })), { ordered: false });
}
