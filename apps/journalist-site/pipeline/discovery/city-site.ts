/**
 * The city's real website, checked before anything is built on it. The address on a location
 * can point at a chamber of commerce or a tourism site, and every `site:` query from it would
 * then miss the city. Candidates come from the location, OpenStreetMap and the Wikidata item it
 * links to, and if none is clearly official, one search. A page must name the town and read like a government's.
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
import { fill, limit, regex, ruleSet, template } from "../playbook";
import { recordDecision } from "../trace/decisions";
import { search } from "../search/provider";
import { hostOf } from "../sourcemap/store";
import { US_STATES } from "../../../../shared/geography";
import { cachedDiscovery } from "./cache";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const SIGNALS = ruleSet("government_signals").map((rule) => rule.test);
const NOT_GOVERNMENT = regex("civic.reject.not_government");
const LOOKS_OFFICIAL_HOST = regex("civic.page.official_host");
const MIN_SIGNALS = limit("civic.stop.min_signals");
const OFFICIAL_HOST_BONUS = limit("civic.stop.official_host_bonus");
const CONFIDENT_SCORE = limit("civic.stop.confident_score");

export type CitySite = { url: string; host: string; source: string; score: number };
type Context = { db: Db; settings: Settings; transport: HttpTransport; fetcher: Fetcher; location: LocationProfile };

/** How much a page reads like this town's government; 0 when it doesn't. */
export function governmentScore(html: string, town: string, url: string) {
  const head = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  if (!mentions(html.slice(0, 200_000), town) || NOT_GOVERNMENT.test(head)) return 0;
  const signals = SIGNALS.filter((signal) => signal.test(html)).length;
  return signals >= MIN_SIGNALS ? signals + (LOOKS_OFFICIAL_HOST.test(hostOf(url)) ? OFFICIAL_HOST_BONUS : 0) : 0;
}

async function openStreetMapSite(context: Context, town: string) {
  const params = new URLSearchParams({ city: town, state: US_STATES[context.location.state] ?? context.location.state, country: "United States", format: "jsonv2", extratags: "1", limit: "3" });
  try {
    const hits = JSON.parse(new TextDecoder().decode(await publicApiGet(context.transport, `${NOMINATIM}?${params}`, "application/json", 512 * 1024, 20_000))) as Array<{ extratags?: Record<string, string> }>;
    const sites = hits.map((hit) => httpsLink((hit.extratags?.website ?? hit.extratags?.["contact:website"] ?? "").split(";")[0].trim().replace(/^http:/, "https:"))).filter((url): url is string => Boolean(url));
    // Town boundaries often carry only a Wikidata link, and the website is on that item.
    for (const hit of hits) if (hit.extratags?.wikidata) sites.push(...await wikidataSites(context, hit.extratags.wikidata));
    return sites;
  } catch { return []; }
}

async function wikidataSites(context: Context, id: string) {
  if (!/^Q\d+$/.test(id)) return [];
  try {
    const data = JSON.parse(new TextDecoder().decode(await publicApiGet(context.transport, `https://www.wikidata.org/wiki/Special:EntityData/${id}.json`, "application/json", 4 * 1024 * 1024, 20_000))) as { entities?: Record<string, { claims?: { P856?: Array<{ mainsnak?: { datavalue?: { value?: string } } }> } }> };
    return (data.entities?.[id]?.claims?.P856 ?? []).map((claim) => httpsLink((claim.mainsnak?.datavalue?.value ?? "").replace(/^http:/, "https:"))).filter((url): url is string => Boolean(url));
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
    if (!best.some((site) => LOOKS_OFFICIAL_HOST.test(site.host) || site.score >= CONFIDENT_SCORE)) {
      const outcome = await search({ db: context.db, settings: context.settings, transport: context.transport, query: fill(template("civic.lookup.city_site"), { town, state: US_STATES[context.location.state] ?? context.location.state }), topic: null, family: "city_site", stage: "stage1" });
      for (const result of outcome.results.slice(0, limit("civic.stop.city_site_results"))) await check(result.url, "search");
    }
    const chosen = best.sort((a, b) => b.score - a.score)[0];
    const stored = hostOf(context.location.government?.website ?? null);
    if (chosen && stored && chosen.host !== stored) await recordDecision({ stage: "source", actor: "rule", subject: chosen.url, decision: "city_site_corrected", reason: `${stored} doesn't read as ${town}'s government; using ${chosen.host} (${chosen.source})`, rule: "city_site" });
    return { items: chosen ? [chosen] : [], detail: chosen ? `${chosen.host} (${chosen.source})` : `No site reads as ${town}'s government` };
  });
  return entry.items[0] ?? null;
}
