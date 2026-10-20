import { HttpStatusError, text, type HttpTransport } from "../../core/http";

export const API = "https://www.wikidata.org/w/api.php";
const HEADERS = { "User-Agent": "Newsbee-LocalPrototype/0.1 (local library onboarding)" };
const MAX_DISTANCE_KM = 50;
const UNITED_STATES = "Q30";
type WikiValue = Record<string, unknown>;
function values(claims: Record<string, unknown>, property: string): unknown[] {
  const entries = claims[property];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((claim) => {
    if (!claim || typeof claim !== "object") return [];
    const mainsnak = (claim as WikiValue).mainsnak;
    if (!mainsnak || typeof mainsnak !== "object") return [];
    const datavalue = (mainsnak as WikiValue).datavalue;
    return datavalue && typeof datavalue === "object" && "value" in datavalue ? [(datavalue as WikiValue).value] : [];
  });
}
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const phi1 = radians(lat1), phi2 = radians(lat2);
  const a = Math.sin((phi2 - phi1) / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(radians(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
function httpsOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username) return null;
    return `https://${url.hostname}${url.pathname || "/"}`;
  } catch { return null; }
}
function pyRepr(value: string) { return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`; }
function unresolved(detail: string) { return { status: "unresolved", website: null, wikidata_id: null, detail }; }
async function getJson(transport: HttpTransport, params: Record<string, string>) {
  const url = `${API}?${new URLSearchParams(params)}`;
  const response = await transport({ url, headers: HEADERS, maxBytes: 4 * 1024 * 1024 });
  if (response.status >= 400) throw new HttpStatusError(response.status, url);
  try { return JSON.parse(text(response)) as WikiValue; } catch { throw new Error("Wikidata response is not JSON"); }
}
/** Minimal P856 lookup matching the official-town website resolution used by Python discovery. */
export async function lookup(transport: HttpTransport, name: string, latitude: number | null, longitude: number | null) {
  const found = await getJson(transport, { action: "wbsearchentities", search: name, language: "en", type: "item", limit: "10", format: "json" });
  const results = found.search;
  const ids = Array.isArray(results) ? results.flatMap((item) => item && typeof item === "object" && String((item as WikiValue).label ?? "").toLocaleLowerCase("und") === name.toLocaleLowerCase("und") ? [String((item as WikiValue).id)] : []) : [];
  if (!ids.length) return unresolved(`No Wikidata item labelled exactly ${pyRepr(name)}`);
  const data = await getJson(transport, { action: "wbgetentities", ids: ids.join("|"), props: "claims", format: "json" });
  if (latitude === null || longitude === null) return unresolved("Directory has no coordinates to confirm the Wikidata match");
  const entities = data.entities && typeof data.entities === "object" ? data.entities as Record<string, WikiValue> : {};
  const candidates = new Map<string, string>();
  for (const [identity, entity] of Object.entries(entities)) {
    const claims = entity.claims && typeof entity.claims === "object" ? entity.claims as Record<string, unknown> : {};
    const countries = new Set(values(claims, "P17").flatMap((value) => value && typeof value === "object" && typeof (value as WikiValue).id === "string" ? [(value as WikiValue).id as string] : []));
    const coords = values(claims, "P625");
    const websites = values(claims, "P856").map(httpsOrigin).filter((value): value is string => value !== null);
    const nearby = coords.some((point) => point && typeof point === "object" && distanceKm(latitude, longitude, Number((point as WikiValue).latitude), Number((point as WikiValue).longitude)) <= MAX_DISTANCE_KM);
    if (countries.has(UNITED_STATES) && nearby) for (const website of websites) candidates.set(website, identity);
  }
  if (candidates.size === 1) {
    const [website, identity] = [...candidates.entries()][0];
    return { status: "resolved", website, wikidata_id: identity, detail: `Official website from Wikidata ${identity}` };
  }
  if (!candidates.size) return unresolved(`No Wikidata match for ${pyRepr(name)} with a website and coordinates within ${MAX_DISTANCE_KM} km`);
  return unresolved(`Ambiguous Wikidata websites for ${pyRepr(name)}: [${[...candidates.keys()].sort().map(pyRepr).join(", ")}]`);
}
