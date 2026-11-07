/** Bounded, read-only Overpass requests shared by source discovery. */
import { COMMUNITY_USER_AGENT } from "../../../../shared/geography";
import type { HttpTransport } from "../core/http";

export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  // kumi.systems is the previous name of private.coffee, not an independent mirror.
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
] as const;
export type OverpassElement = { type?: string; id?: number; tags?: Record<string, string>; lat?: number; lon?: number; center?: { lat: number; lon: number } };
export type OverpassData = { elements: OverpassElement[]; osm3s?: { timestamp_osm_base?: string }; remark?: string };
const coolUntil = new Map<string, number>();
export const QUERY_SECONDS = 20;
export const REQUEST_MS = 30_000;

export async function queryOverpass(transport: HttpTransport, query: string, endpoints: readonly string[] = OVERPASS_ENDPOINTS): Promise<{ data: OverpassData; endpoint: string; attempts: string[] }> {
  const attempts: string[] = [];
  for (const endpoint of [...new Set(endpoints)]) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Overpass endpoint must use HTTPS without credentials");
    if ((coolUntil.get(endpoint) ?? 0) > Date.now()) { attempts.push(`${endpoint}: cooling down after service refusal`); continue; }
    try {
      url.searchParams.set("data", query);
      const response = await transport({ url: url.toString(), method: "GET", headers: { "User-Agent": COMMUNITY_USER_AGENT, Accept: "application/json" }, maxBytes: 4 * 1024 * 1024, timeoutMs: REQUEST_MS });
      if (response.status === 406 || response.status === 429) {
        const retry = response.headers["retry-after"] ?? "";
        const seconds = /^\d+$/.test(retry) ? Number(retry) : Math.max(0, (Date.parse(retry) - Date.now()) / 1000) || 30;
        coolUntil.set(endpoint, Date.now() + Math.max(30, seconds) * 1000);
      }
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const data = JSON.parse(new TextDecoder().decode(response.body)) as OverpassData;
      // Overpass may return HTTP 200 with an error remark and incomplete/empty elements.
      if (data.remark) throw new Error(`Overpass error: ${data.remark}`);
      if (!Array.isArray(data.elements)) throw new Error("Invalid Overpass response: missing elements array");
      attempts.push(`${endpoint}: success (${data.elements.length} elements)`);
      return { data, endpoint, attempts };
    } catch (error) { attempts.push(`${endpoint}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`); }
  }
  throw new Error(`Overpass unavailable; ${attempts.join("; ")}`);
}
