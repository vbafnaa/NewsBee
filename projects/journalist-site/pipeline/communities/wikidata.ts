import type { HttpTransport } from "../core/http";
import { HttpStatusError } from "../core/http";
import { json } from "../core/http";

export const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
export const MAX_DISTANCE_KM = 50;
const USER_AGENT = "Newsbee-LocalPrototype/0.1 (local library onboarding)";

type Entity = { claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value: unknown } } }>> };
function values(claims: Entity["claims"], prop: string): unknown[] {
  return (claims?.[prop] ?? []).flatMap((claim) => claim.mainsnak?.datavalue ? [claim.mainsnak.datavalue.value] : []);
}
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const a = Math.sin((phi2 - phi1) / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin((lon2 - lon1) * Math.PI / 360) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
export function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return `https://${url.hostname}${url.pathname || "/"}`;
  } catch { return null; }
}
function unresolved(detail: string) { return { status: "unresolved", website: null, wikidata_id: null, detail }; }

export async function lookupWebsite(transport: HttpTransport, name: string, latitude: number | null | undefined, longitude: number | null | undefined) {
  const searchUrl = new URL(WIKIDATA_API);
  for (const [key, value] of Object.entries({ action: "wbsearchentities", search: name, language: "en", type: "item", limit: "10", format: "json" })) searchUrl.searchParams.set(key, value);
  const response = await transport({ url: searchUrl.toString(), headers: { "User-Agent": USER_AGENT } });
  if (response.status >= 400) throw new HttpStatusError(response.status, searchUrl.toString());
  const found = json<{ search?: Array<{ id: string; label?: string }> }>(response);
  const ids = (found.search ?? []).filter((item) => (item.label ?? "").toLowerCase() === name.toLowerCase()).map((item) => item.id);
  if (!ids.length) return unresolved(`No Wikidata item labelled exactly ${JSON.stringify(name)}`);
  const entitiesUrl = new URL(WIKIDATA_API);
  for (const [key, value] of Object.entries({ action: "wbgetentities", ids: ids.join("|"), props: "claims", format: "json" })) entitiesUrl.searchParams.set(key, value);
  const entityResponse = await transport({ url: entitiesUrl.toString(), headers: { "User-Agent": USER_AGENT } });
  if (entityResponse.status >= 400) throw new HttpStatusError(entityResponse.status, entitiesUrl.toString());
  const entities = json<{ entities?: Record<string, Entity> }>(entityResponse).entities ?? {};
  if (latitude == null || longitude == null) return unresolved("Directory has no coordinates to confirm the Wikidata match");
  const candidates = new Map<string, string>();
  for (const [id, entity] of Object.entries(entities)) {
    const claims = entity.claims ?? {};
    const countries = values(claims, "P17").map((item) => (item as { id?: string }).id);
    const points = values(claims, "P625") as Array<{ latitude: number; longitude: number }>;
    const websites = values(claims, "P856").map((item) => typeof item === "string" ? httpsOrigin(item) : null);
    const near = points.some((point) => distanceKm(latitude, longitude, point.latitude, point.longitude) <= MAX_DISTANCE_KM);
    if (countries.includes("Q30") && near) for (const website of websites.filter((item): item is string => Boolean(item))) candidates.set(website, id);
  }
  if (candidates.size === 1) {
    const [website, id] = [...candidates.entries()][0];
    return { status: "resolved", website, wikidata_id: id, detail: `Official website from Wikidata ${id}` };
  }
  if (!candidates.size) return unresolved(`No Wikidata match for ${JSON.stringify(name)} with a website and coordinates within ${MAX_DISTANCE_KM} km`);
  return unresolved(`Ambiguous Wikidata websites for ${JSON.stringify(name)}: ${JSON.stringify([...candidates.keys()].sort())}`);
}
