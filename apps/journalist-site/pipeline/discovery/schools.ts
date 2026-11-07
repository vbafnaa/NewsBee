/**
 * From a place to its school board and PTAs, with no paid search. The Census says which school
 * districts cover the coordinates, the NCES directory gives each district's website, the
 * district's pages give its board meetings, calendars and schools, and each school's pages give
 * its PTA, PTSA or PTO. No state's systems are assumed.
 */
import { httpsLink } from "../connectors/common";
import { ensureSchoolDistricts, schoolDistricts } from "../communities/school-directory";
import { limit, regex } from "../playbook";
import { hostOf } from "../sourcemap/store";
import { centreOf, CENSUS_COUNTY } from "./area";
import { cachedDiscovery } from "./cache";
import type { DiscoveryContext } from "./methods";

const TTL_DAYS = 30;
const LAYERS = ["Unified School Districts", "Secondary School Districts", "Elementary School Districts"];
const SCHOOL_TITLE = regex("schools.page.school_title");
const SCHOOL_TITLE_MAX = limit("schools.stop.school_title_max");
export type DistrictSite = { name: string; website: string };

/** Districts covering a point, from the Census geocoder's response. */
export function districtIds(response: unknown) {
  const geographies = (response as { result?: { geographies?: Record<string, Array<{ NAME?: string; GEOID?: string }>> } }).result?.geographies ?? {};
  return LAYERS.flatMap((layer) => geographies[layer] ?? []).flatMap((row) => row.GEOID ? [{ id: row.GEOID, name: row.NAME ?? row.GEOID }] : []);
}

export async function districtSites(context: DiscoveryContext): Promise<DistrictSite[]> {
  const centre = centreOf(context.location);
  if (!centre) return [];
  const entry = await cachedDiscovery<DistrictSite>(context.db, context.location.id, "school_districts", TTL_DAYS, async () => {
    const [lat, lon] = centre;
    const [, body] = await context.fetcher.get(`${CENSUS_COUNTY}?x=${lon.toFixed(5)}&y=${lat.toFixed(5)}&benchmark=Public_AR_Current&vintage=Current_Current&layers=all&format=json`, 512 * 1024, "application/json");
    const ids = districtIds(JSON.parse(new TextDecoder().decode(body)));
    await ensureSchoolDistricts(context.db, context.transport);
    const rows = await schoolDistricts(context.db).find({ _id: { $in: ids.map((row) => row.id) } }).toArray();
    return { items: rows.map((row) => ({ name: row.name, website: row.website })), detail: `${ids.length} districts here; ${rows.length} with a website on record` };
  });
  return entry.items;
}

/** Schools a district's pages link to, by name. */
export function schoolLinks(pages: Array<[string, string]>) {
  const found = new Map<string, { name: string; url: string }>();
  for (const [pageUrl, html] of pages) {
    for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const name = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!SCHOOL_TITLE.test(name) || name.length > SCHOOL_TITLE_MAX) continue;
      let url: string | null = null;
      try { url = httpsLink(new URL(match[1], pageUrl).toString().replace(/^http:/, "https:")); } catch { continue; }
      if (url && !found.has(name.toLowerCase())) found.set(name.toLowerCase(), { name, url });
    }
  }
  return [...found.values()];
}

/** School sites worth reading: those named on the map of the place first, for a neighbourhood only those. */
export function localSchools(linked: Array<{ name: string; url: string }>, known: Array<{ name: string; website: string | null; inside: boolean }>, neighbourhood: boolean, cap: number) {
  const key = (name: string) => name.toLowerCase().replace(/\b(school|elementary|middle|high|k-8|k-12|the)\b/g, "").replace(/[^a-z0-9]/g, "");
  const inside = known.filter((school) => school.inside);
  const sites = inside.flatMap((school) => school.website ? [{ name: school.name, url: school.website }] : []);
  const named = new Set(inside.map((school) => key(school.name)));
  const fromDistrict = linked.filter((school) => !neighbourhood || named.has(key(school.name)));
  const all = [...sites, ...fromDistrict];
  return all.filter((school, index) => all.findIndex((other) => hostOf(other.url) === hostOf(school.url) && other.url === school.url) === index).slice(0, cap);
}

