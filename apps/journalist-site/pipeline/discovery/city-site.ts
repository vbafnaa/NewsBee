/**
 * The city's real website, checked before anything is built on it. The address on a location
 * can point at a chamber of commerce or a tourism site, and every `site:` query from it would
 * then miss the city. Candidates come from the location, OpenStreetMap, and if neither is
 * clearly official, one search. A page must name the town and read like a government's.
 */
import type { Db } from "mongodb";
import type { Settings } from "../core/config";
import type { HttpTransport } from "../core/http";
import { httpsLink } from "../connectors/common";
import { mentions } from "../connectors/community";
import type { Fetcher } from "../connectors/fetcher";
import { townName } from "../connectors/locality";
import { publicApiGet } from "../connectors/public-api";
import type { LocationProfile } from "../connectors/types";
import { recordDecision } from "../trace/decisions";
import { search } from "../search/provider";
import { hostOf } from "../sourcemap/store";
import { US_STATES } from "../../../../shared/geography";
import { cachedDiscovery } from "./cache";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const SIGNALS = [/city council|town council|board of (?:selectmen|aldermen)/i, /\bmayor\b|city manager|town manager/i, /\bagendas?\b|\bminutes\b/i, /departments?\b/i, /city hall|town hall|municipal/i, /official website/i, /\bpermits?\b/i];
const NOT_GOVERNMENT = /chamber of commerce|visitors? (?:bureau|guide)|tourism|real estate|\bvisit\b/i;
const LOOKS_OFFICIAL_HOST = /\.gov$|\.us$|(^|\.)(cityof|townof|ci\.)/i;

export type CitySite = { url: string; host: string; source: string; score: number };
type Context = { db: Db; settings: Settings; transport: HttpTransport; fetcher: Fetcher; location: LocationProfile };

/** How much a page reads like this town's government; 0 when it doesn't. */
export function governmentScore(html: string, town: string, url: string) {
  const head = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  if (!mentions(html.slice(0, 200_000), town) || NOT_GOVERNMENT.test(head)) return 0;
  const signals = SIGNALS.filter((signal) => signal.test(html)).length;
  return signals >= 3 ? signals + (LOOKS_OFFICIAL_HOST.test(hostOf(url)) ? 3 : 0) : 0;
}

async function openStreetMapSite(context: Context, town: string) {
  const params = new URLSearchParams({ city: town, state: US_STATES[context.location.state] ?? context.location.state, country: "United States", format: "jsonv2", extratags: "1", limit: "3" });
  try {
    const hits = JSON.parse(new TextDecoder().decode(await publicApiGet(context.transport, `${NOMINATIM}?${params}`, "application/json", 512 * 1024, 20_000))) as Array<{ extratags?: Record<string, string> }>;
    return hits.map((hit) => httpsLink((hit.extratags?.website ?? hit.extratags?.["contact:website"] ?? "").split(";")[0].trim().replace(/^http:/, "https:"))).filter((url): url is string => Boolean(url));
  } catch { return []; }
}

export async function verifiedCitySite(context: Context): Promise<CitySite | null> {
  const town = townName(context.location);
  const entry = await cachedDiscovery<CitySite>(context.db, context.location.id, "city_site", 30, async () => {
    const tried = new Set<string>();
    const best: CitySite[] = [];
    const check = async (url: string | null, source: string) => {
      if (!url || tried.has(hostOf(url))) return;
      tried.add(hostOf(url));
      try {
        const [final, html] = await context.fetcher.getText(url, 2 * 1024 * 1024, "text/html, application/xhtml+xml");
        const score = governmentScore(html, town, final);
        if (score) best.push({ url: final, host: hostOf(final), source, score });
      } catch { /* blocked or down: try the next one */ }
    };
    await check(httpsLink(context.location.government?.website ?? null), "location record");
    for (const url of await openStreetMapSite(context, town)) await check(url, "OpenStreetMap");
    if (!best.some((site) => LOOKS_OFFICIAL_HOST.test(site.host) || site.score >= 6)) {
      const outcome = await search({ db: context.db, settings: context.settings, transport: context.transport, query: `"City of ${town}" "${US_STATES[context.location.state] ?? context.location.state}" official website "city council"`, topic: null, family: "city_site", stage: "stage1" });
      for (const result of outcome.results.slice(0, 4)) await check(result.url, "search");
    }
    const chosen = best.sort((a, b) => b.score - a.score)[0];
    const stored = hostOf(context.location.government?.website ?? null);
    if (chosen && stored && chosen.host !== stored) await recordDecision({ stage: "source", actor: "rule", subject: chosen.url, decision: "city_site_corrected", reason: `${stored} doesn't read as ${town}'s government; using ${chosen.host} (${chosen.source})`, rule: "city_site" });
    return { items: chosen ? [chosen] : [], detail: chosen ? `${chosen.host} (${chosen.source})` : `No site reads as ${town}'s government` };
  });
  return entry.items[0] ?? null;
}
