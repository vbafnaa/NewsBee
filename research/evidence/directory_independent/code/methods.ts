/**
 * Discovery methods: each finds one kind of source for a location and returns candidates
 * for the source map. They run as separate jobs at the start of a run when due (each has
 * its own refresh period), so a slow method never blocks the others.
 *
 *   government  the city's and county's own websites (location profile, OpenStreetMap
 *               via Nominatim) and the feeds they publish (CivicPlus news, calendar,
 *               agendas, alerts)
 *   osm         websites of town halls, libraries, community centres, schools, colleges,
 *               arts venues, theatres, museums, markets and associations inside the area
 *   meetings    Legistar, CivicClerk and PrimeGov accounts for the city and county
 *   opendata    Socrata portals for the city, county and state and their police, fire,
 *               permit, inspection, licence and 311 datasets
 *   newsrooms   Wikidata outlets published nearby with a current feed
 *   athletics   the state's school athletic association (Wikidata)
 *   publishers  outlets news search keeps finding covering the place
 *   llm         Gemini suggestions (school district, PTAs, leagues, funeral homes,
 *               business groups, community councils), each fetched and checked
 *   national    the national public-data readers (NWS, USGS, EPA, Census, Justice
 *               Department, Wikipedia), library systems, the city's meetings, news
 *               search, reader stories and family notices
 */
import type { Db } from "mongodb";
import type { Settings } from "../core/config";
import type { HttpTransport } from "../core/http";
import type { Logger } from "../core/log";
import type { ModelRuntime } from "../model/runtime";
import type { ConnectorContext, LocationProfile } from "../connectors/types";
import { DiscoveryBlockedError, Fetcher } from "../connectors/fetcher";
import { publicSourceTransport } from "../connectors/public-http";
import { httpsLink } from "../connectors/common";
import { publicApiGet } from "../connectors/public-api";
import { locationCenter, townName, OVERPASS, OVERPASS_TIMEOUT_MS, TOWN_RADIUS_KM } from "../connectors/locality";
import { mentions } from "../connectors/community";
import { CONNECTORS, selectSources } from "../connectors/registry";
import { newsPublishers, aggregator } from "../connectors/newssearch";
import { TOPIC_SECTION, type Topic } from "../connectors/opendata";
import { distanceKm, US_STATES, withinArea, type Point } from "../../../../shared/geography";
import { areaFacts, discoveredAthletics, discoveredNewsrooms } from "./area";
import { findFeed } from "./feeds";
import { hashId, hostOf, normaliseUrl, webSourceId, type DiscoveryMethod, type SourceCandidate } from "../sourcemap/store";
import type { SectionId } from "../sourcemap/sections";
import { canSpend, groundedSearch, jsonArray, usageRecorder } from "../model/budget";
import { pythonJson } from "../model/newsworthiness";
import { currentOptions } from "../core/run-options";
import { recordDecision } from "../trace/decisions";
import { evaluateQueries, JOB_DEADLINE_MS } from "./evaluate";
import { OVERPASS_MIRRORS } from "./institutions";
import { buildSearchKit, stage1Queries } from "./topics";
import { linkedPages } from "./linked-pages";
import { directories } from "./directories";

export type DiscoveryContext = {
  db: Db;
  settings: Settings;
  transport: HttpTransport;
  fetcher: Fetcher;
  location: LocationProfile;
  today: string;
  log: Logger;
  /** The light model (Flash-Lite first), for LLM discovery. */
  model?: ModelRuntime | null;
};

export type MethodDefinition = { method: DiscoveryMethod; label: string; refreshDays: number; run(context: DiscoveryContext): Promise<{ candidates: SourceCandidate[]; detail: string }> };

const ACCEPT_HTML = "text/html, application/xhtml+xml";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
export const SOCRATA_CATALOG = "https://api.us.socrata.com/api/catalog/v1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function webCandidate(url: string, name: string, section: SectionId, method: DiscoveryMethod, detail: string, options: { feed?: string | null; kind?: string; inside?: boolean; linkOnly?: boolean } = {}): SourceCandidate {
  return {
    source_id: webSourceId(options.feed ?? url), name, url, feed_url: options.feed ?? null, reader: "web",
    params: { url, feed_url: options.feed ?? null, kind: options.kind ?? "local_news", section, inside_area: Boolean(options.inside) },
    section, found_by: { method, detail }, inside_area: Boolean(options.inside), link_only: options.linkOnly ?? false,
  };
}
function place(location: LocationProfile) { return location.community?.name ?? townName(location); }
function slug(text: string | null | undefined) { return (text ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

// --- government ---------------------------------------------------------------------------
const CIVICPLUS_MODULES: Record<string, { title: string; section: SectionId }> = {
  "1": { title: "News flash", section: "news" }, "58": { title: "Calendar", section: "events" },
  "65": { title: "Agendas", section: "civic" }, "63": { title: "Alerts", section: "safety" },
};
async function countyWebsite(context: DiscoveryContext, county: string): Promise<string | null> {
  const state = US_STATES[context.location.state];
  if (!state) return null;
  const params = new URLSearchParams({ county, state, country: "United States", format: "jsonv2", extratags: "1", limit: "5" });
  try {
    const body = await publicApiGet(context.transport, `${NOMINATIM}?${params.toString()}`, "application/json", 512 * 1024, 20_000);
    const hits = JSON.parse(new TextDecoder().decode(body)) as Array<{ category?: string; class?: string; extratags?: Record<string, string> }>;
    for (const hit of hits) {
      const site = httpsLink((hit.extratags?.website ?? hit.extratags?.["contact:website"] ?? "").split(";")[0].trim().replace(/^http:/, "https:"));
      if (site && ["boundary", "place"].includes(hit.category ?? hit.class ?? "")) return site;
    }
  } catch (error) { context.log.info("county_website_unavailable", { county, error: String(error) }); }
  return null;
}
async function civicPlusFeeds(context: DiscoveryContext, site: string, label: string, inside: boolean): Promise<SourceCandidate[]> {
  const out: SourceCandidate[] = [];
  const root = site.replace(/\/+$/, "");
  try {
    const [url, html] = await context.fetcher.getText(`${root}/rss.aspx`, 2 * 1024 * 1024, ACCEPT_HTML);
    const seen = new Set<string>();
    for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']*RSSFeed\.aspx\?[^"']+)["'][^>]*>/gi)) {
      let feed: URL;
      try { feed = new URL(match[1].replace(/&amp;/g, "&"), url); } catch { continue; }
      const module = feed.searchParams.get("ModID") ?? "";
      if (!CIVICPLUS_MODULES[module] || seen.has(module) || !/All/i.test(feed.search)) continue;
      seen.add(module);
      const { title, section } = CIVICPLUS_MODULES[module];
      const link = httpsLink(feed.toString());
      if (link) out.push(webCandidate(root, `${label}: ${title}`, section, "government", "CivicPlus feed on the government website", { feed: link, inside }));
    }
  } catch { /* not CivicPlus, or not allowed */ }
  try {
    const [url, html] = await context.fetcher.getText(`${root}/AgendaCenter`, 2 * 1024 * 1024, ACCEPT_HTML);
    if (/agendacenter/i.test(html)) out.push(webCandidate(url, `${label}: Agenda Center`, "civic", "government", "CivicPlus Agenda Center (agendas are PDFs: listed with a link)", { inside, linkOnly: true }));
  } catch { /* none */ }
  return out;
}
const government: MethodDefinition = {
  method: "government", label: "City and county websites", refreshDays: 30,
  async run(context) {
    const candidates: SourceCandidate[] = [];
    const town = townName(context.location);
    const city = httpsLink(context.location.government?.website ?? null);
    // A town's own government is local by construction; for a neighbourhood it is city-wide.
    const cityInside = !context.location.community;
    if (city) {
      candidates.push(webCandidate(city, `City of ${town}`, "civic", "government", "The city's official website", { inside: cityInside }));
      candidates.push(...await civicPlusFeeds(context, city, `City of ${town}`, cityInside));
    }
    const facts = await areaFacts(context as unknown as ConnectorContext).catch(() => null);
    if (facts?.county) {
      const county = await countyWebsite(context, facts.county);
      if (county && hostOf(county) !== hostOf(city)) {
        candidates.push(webCandidate(county, facts.county, "civic", "government", "The county's official website (OpenStreetMap)"));
        candidates.push(...await civicPlusFeeds(context, county, facts.county, false));
      }
    }
    // Root-site crawls otherwise spend their budget on unrelated municipal pages.
    for (const parent of [...candidates].filter((item) => item.reader === "web" && !item.feed_url && !item.link_only).slice(0, 2)) {
      try {
        const [, html] = await context.fetcher.getText(parent.url!, 2 * 1024 * 1024, ACCEPT_HTML);
        const linked = await linkedPages(new Fetcher(publicSourceTransport(context.transport)), parent, html, context.today, place(context.location), 6);
        candidates.push(...linked.candidates);
        for (const item of linked.rejected) await recordDecision({ stage: "source", actor: "rule", subject: item.url, decision: "rejected", reason: item.reason, rule: "linked_page_check" });
      } catch (error) { context.log.info("government_navigation_unavailable", { url: parent.url, error: String(error) }); }
    }
    return { candidates, detail: `${city ? "city site" : "no city site"}${facts?.county ? `, ${facts.county}` : ""}; ${candidates.length} sources` };
  },
};

// --- OpenStreetMap places -------------------------------------------------------------------
const OSM_KINDS: Record<string, { priority: number; section: SectionId; kind?: string }> = {
  townhall: { priority: 0, section: "civic" }, government: { priority: 0, section: "civic" }, library: { priority: 1, section: "events" },
  community_centre: { priority: 1, section: "community" }, marketplace: { priority: 2, section: "events" }, social_centre: { priority: 2, section: "community" },
  school: { priority: 3, section: "schools" }, college: { priority: 4, section: "schools" }, university: { priority: 4, section: "schools" },
  arts_centre: { priority: 4, section: "events" }, theatre: { priority: 5, section: "events" }, museum: { priority: 5, section: "events" },
  association: { priority: 6, section: "community" }, place_of_worship: { priority: 7, section: "community" }, funeral_directors: { priority: 7, section: "obituaries", kind: "obituary" },
  park: { priority: 8, section: "events" }, sports_centre: { priority: 8, section: "schools" },
};
export const OSM_CAP = 40;
export { OVERPASS_MIRRORS };
function websiteOf(tags: Record<string, string>) {
  const raw = (tags.website ?? tags["contact:website"] ?? tags.url ?? "").split(";")[0].trim();
  if (!raw) return null;
  const url = raw.startsWith("http") ? raw.replace(/^http:/, "https:") : `https://${raw.replace(/^\/+/, "")}`;
  return httpsLink(url);
}
const osm: MethodDefinition = {
  method: "osm", label: "OpenStreetMap places inside the area", refreshDays: 30,
  async run(context) {
    const { center, area } = locationCenter(context.location);
    if (!center) return { candidates: [], detail: "Location has no coordinates" };
    const reach = Math.round((area?.radius_km ?? (area ? 3 : TOWN_RADIUS_KM)) * 1000);
    const around = `(around:${reach},${center[1]},${center[0]})`;
    const site = '[~"^(website|contact:website)$"~"."]';
    const query = `[out:json][timeout:60];(nwr${around}["name"]["amenity"~"^(townhall|library|community_centre|marketplace|social_centre|school|college|university|arts_centre|theatre|place_of_worship)$"]${site};nwr${around}["name"]["tourism"="museum"]${site};nwr${around}["name"]["office"~"^(government|association)$"]${site};nwr${around}["name"]["shop"="funeral_directors"]${site};nwr${around}["name"]["leisure"~"^(park|sports_centre)$"]${site};);out tags center 400;`;
    let body: Uint8Array | null = null;
    let lastError: unknown = null;
    for (const endpoint of [OVERPASS, ...OVERPASS_MIRRORS]) {
      try { body = await publicApiGet(context.transport, `${endpoint}?data=${encodeURIComponent(query)}`, "application/json", 4 * 1024 * 1024, OVERPASS_TIMEOUT_MS); break; }
      catch (error) { lastError = error; }
    }
    if (!body) throw lastError instanceof Error ? lastError : new Error("Overpass is unavailable");
    const elements = (JSON.parse(new TextDecoder().decode(body)) as { elements?: Array<{ tags?: Record<string, string>; lat?: number; lon?: number; center?: { lat: number; lon: number } }> }).elements ?? [];
    const found: Array<{ name: string; url: string; kind: string; point: Point }> = [];
    for (const element of elements) {
      const tags = element.tags ?? {};
      const kind = tags.amenity ?? (tags.tourism === "museum" ? "museum" : tags.office ?? (tags.shop === "funeral_directors" ? "funeral_directors" : tags.leisure)) ?? "";
      const url = websiteOf(tags);
      const lat = element.lat ?? element.center?.lat, lon = element.lon ?? element.center?.lon;
      if (!tags.name || !url || !OSM_KINDS[kind] || typeof lat !== "number" || typeof lon !== "number") continue;
      const point: Point = [lon, lat];
      if (area ? !withinArea(area, center, point) : distanceKm(center, point) > TOWN_RADIUS_KM) continue;
      found.push({ name: tags.name, url, kind, point });
    }
    found.sort((a, b) => OSM_KINDS[a.kind].priority - OSM_KINDS[b.kind].priority || a.name.localeCompare(b.name));
    const perHost = new Map<string, number>();
    const seen = new Set<string>();
    const candidates: SourceCandidate[] = [];
    for (const item of found) {
      const host = hostOf(item.url), key = normaliseUrl(item.url);
      if (seen.has(key) || (perHost.get(host) ?? 0) >= 2) continue;
      seen.add(key);
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      const definition = OSM_KINDS[item.kind];
      candidates.push(webCandidate(item.url, item.name, definition.section, "osm", `${item.kind.replace(/_/g, " ")} inside ${place(context.location)}`, { inside: true, kind: definition.kind }));
      if (candidates.length >= OSM_CAP) break;
    }
    return { candidates, detail: `${elements.length} places with websites nearby; ${candidates.length} inside the area` };
  },
};

// --- meeting platforms ---------------------------------------------------------------------
async function probeJson(context: DiscoveryContext, url: string) {
  try { return JSON.parse(new TextDecoder().decode(await publicApiGet(context.transport, url, "application/json", 512 * 1024, 15_000))) as unknown; }
  catch { return null; }
}
const meetings: MethodDefinition = {
  method: "meetings", label: "Meeting platforms", refreshDays: 30,
  async run(context) {
    const state = context.location.state.toLowerCase();
    const town = townName(context.location);
    const facts = await areaFacts(context as unknown as ConnectorContext).catch(() => null);
    const governments: Array<{ name: string; level: "city" | "county"; slugs: string[] }> = [];
    const c = slug(town);
    if (c.length >= 4) governments.push({ name: town, level: "city", slugs: [c, `${c}${state}`, `cityof${c}`, `cityof${c}${state}`] });
    if (facts?.county) {
      const k = slug(facts.county), bare = k.replace(/county$/, "");
      governments.push({ name: facts.county, level: "county", slugs: [k, `${k}${state}`, `${bare}county${state}`, `${bare}co`] });
    }
    const existing = context.location.government;
    const candidates: SourceCandidate[] = [];
    for (const government of governments) {
      for (const tenant of [...new Set(government.slugs)].filter((value) => value.length >= 4)) {
        if (existing?.tenant === tenant) break;
        const legistar = await probeJson(context, `https://webapi.legistar.com/v1/${tenant}/bodies?$top=1`);
        if (Array.isArray(legistar) && legistar.length) {
          candidates.push(meetingCandidate(government, "legistar", tenant, `https://${tenant}.legistar.com/`));
          break;
        }
        const civic = await probeJson(context, `https://${tenant}.api.civicclerk.com/v1/Events?$top=1`) as { value?: unknown } | null;
        if (civic && Array.isArray(civic.value)) {
          candidates.push(meetingCandidate(government, "civicclerk", tenant, `https://${tenant}.portal.civicclerk.com/`));
          break;
        }
        try {
          const [url, html] = await context.fetcher.getText(`https://${tenant}.primegov.com/public/portal`, 2 * 1024 * 1024, ACCEPT_HTML);
          if (slug(html.slice(0, 20000)).includes(slug(government.name.split(" ")[0]))) {
            candidates.push(webCandidate(url, `${government.name} meetings (PrimeGov)`, "civic", "meetings", "PrimeGov portal found by name; agendas are PDFs (listed with a link)", { linkOnly: true }));
            break;
          }
        } catch { /* none */ }
      }
    }
    return { candidates, detail: `${governments.map((value) => value.name).join(" and ")}: ${candidates.length} accounts found` };
  },
};
function meetingCandidate(government: { name: string; level: "city" | "county" }, platform: "legistar" | "civicclerk", tenant: string, url: string): SourceCandidate {
  return {
    source_id: `meetings:${platform}:${tenant}`, name: `${government.name} public meetings`, url, reader: "meetings",
    params: { government: { status: "override", platform, tenant, website: url, wikidata_id: null, pages_checked: [url], detail: `${platform} account '${tenant}' matched by name` }, fixed: true, level: government.level },
    section: "civic", found_by: { method: "meetings", detail: `${platform} account '${tenant}' matched by name; confirm it is ${government.name}` },
    inside_area: government.level === "city" && !government.name.includes(" County"),
  };
}

// --- open data ------------------------------------------------------------------------------
const TOPICS: Array<{ topic: Topic; query: string; rule: RegExp; stateLevel: boolean }> = [
  { topic: "police", query: "police calls", rule: /police|crime|incident|calls? for service|offen[cs]e|dispatch/i, stateLevel: false },
  { topic: "fire", query: "fire 911", rule: /fire|\bems\b|911|emergency/i, stateLevel: false },
  { topic: "permits", query: "building permits", rule: /permit|construction|land use|development|building/i, stateLevel: false },
  { topic: "inspections", query: "food inspections", rule: /inspection|restaurant|food establishment/i, stateLevel: false },
  { topic: "licences", query: "license applications", rule: /business licen|liquor|licen[cs]e appl|new business|licen[cs]e/i, stateLevel: true },
  { topic: "311", query: "311 service requests", rule: /\b311\b|service request|code (enforcement|violation|complaint)/i, stateLevel: false },
];

/** A Socrata portal's home sale dataset, read by the property reader. */
const SALES_RULE = /real property sales|property sales|home sales|parcel sales|deed|sales? (history|transactions?)/i;
const STALE_NAME = /archiv|historic|summary|statistic|totals|\bby (year|month)\b|\b(19\d\d|20[01]\d|202[0-4])\b|renewal|rental|child ?care|marriage|firearm|contractor|professional/i;
const DATE_TYPES = new Set(["calendar_date", "floating_timestamp", "fixed_timestamp", "date"]);
type CatalogResult = { resource?: { id?: string; name?: string; attribution?: string | null; columns_field_name?: string[]; columns_datatype?: string[]; data_updated_at?: string; updatedAt?: string; page_views?: { page_views_total?: number } }; metadata?: { domain?: string; license?: string | null } };
export function matchPortals(domains: string[], location: LocationProfile, county: string | null): Array<[string, "city" | "county" | "state"]> {
  const city = slug(townName(location)), countySlug = slug(county), state = location.state.toLowerCase(), stateName = slug(US_STATES[location.state]);
  const found: Array<[string, "city" | "county" | "state"]> = [];
  for (const domain of domains) {
    const labels = domain.toLowerCase().replace(/^www\./, "").split(".");
    const names = new Set(labels.slice(0, -1));
    if (city.length >= 4 && [city, `cityof${city}`, `${city}${state}`, `${city}gov`].some((name) => names.has(name))) found.push([domain, "city"]);
    else if (countySlug.length >= 6 && [countySlug, `${countySlug}${state}`].some((name) => names.has(name))) found.push([domain, "county"]);
    else if (labels.at(-1) === "gov" && (names.has(state) || names.has(stateName)) && names.size <= 2) found.push([domain, "state"]);
  }
  const order = { city: 0, county: 1, state: 2 };
  return [...new Map(found.map((item) => [item[0], item])).values()].sort((a, b) => order[a[1]] - order[b[1]]).slice(0, 4);
}
const opendata: MethodDefinition = {
  method: "opendata", label: "Open-data portals", refreshDays: 14,
  async run(context) {
    const facts = await areaFacts(context as unknown as ConnectorContext).catch(() => null);
    // The catalogue no longer lists its domains, so portals are found from searches for the
    // city, county and state, plus the conventional data.<name>.gov hostnames.
    const town = townName(context.location), state = US_STATES[context.location.state] ?? context.location.state;
    const domains = new Set<string>();
    for (const query of [town, facts?.county, state].filter((value): value is string => Boolean(value))) {
      try {
        const body = await publicApiGet(context.transport, `${SOCRATA_CATALOG}?${new URLSearchParams({ q: query, only: "dataset", limit: "100" }).toString()}`, "application/json", 8 * 1024 * 1024, 30_000);
        for (const row of (JSON.parse(new TextDecoder().decode(body)) as { results?: CatalogResult[] }).results ?? []) if (row.metadata?.domain) domains.add(row.metadata.domain);
      } catch { /* try the next query */ }
    }
    for (const name of [slug(town), slug(facts?.county), context.location.state.toLowerCase(), slug(state)].filter((value) => value.length >= 2)) {
      for (const host of [`data.${name}.gov`, `data.cityof${name}.gov`]) {
        if (domains.has(host)) continue;
        try {
          const body = await publicApiGet(context.transport, `${SOCRATA_CATALOG}?${new URLSearchParams({ domains: host, limit: "1" }).toString()}`, "application/json", 1024 * 1024, 20_000);
          if (((JSON.parse(new TextDecoder().decode(body)) as { results?: unknown[] }).results ?? []).length) domains.add(host);
        } catch { /* not a portal */ }
      }
    }
    const portals = matchPortals([...domains], context.location, facts?.county ?? null);
    const freshAfter = Date.now() - 60 * 86400_000;
    const candidates: SourceCandidate[] = [];
    for (const [domain, level] of portals) {
      for (const topic of TOPICS) {
        if (level === "state" && !topic.stateLevel) continue;
        if (candidates.some((candidate) => candidate.params.topic === topic.topic && level !== "city")) continue;
        const params = new URLSearchParams({ domains: domain, only: "dataset", q: topic.query, limit: "20" });
        let results: CatalogResult[] = [];
        try { results = ((JSON.parse(new TextDecoder().decode(await publicApiGet(context.transport, `${SOCRATA_CATALOG}?${params.toString()}`, "application/json", 4 * 1024 * 1024, 30_000))) as { results?: CatalogResult[] }).results ?? []); }
        catch { continue; }
        let best: { views: number; id: string; name: string; attribution: string; license: string | null; filter: "radius" | "city" } | null = null;
        for (const result of results) {
          const resource = result.resource ?? {};
          const id = resource.id ?? "", name = resource.name ?? "";
          if (!/^[a-z0-9]{4}-[a-z0-9]{4}$/.test(id) || !topic.rule.test(name) || STALE_NAME.test(name)) continue;
          const updated = Date.parse(resource.data_updated_at ?? resource.updatedAt ?? "");
          if (Number.isFinite(updated) && updated < freshAfter) continue;
          const types = (resource.columns_datatype ?? []).map((type) => String(type).toLowerCase().replace(/\s+/g, "_"));
          const fields = (resource.columns_field_name ?? []).map((field) => String(field).toLowerCase());
          if (types.length && !types.some((type) => DATE_TYPES.has(type))) continue;
          const geo = types.some((type) => ["point", "location", "multipoint"].includes(type)) || fields.some((field) => /(^|_)lat(itude)?$/.test(field));
          const city = fields.some((field) => /city/.test(field));
          if (!geo && !(city && level !== "city")) continue;
          const views = resource.page_views?.page_views_total ?? 0;
          if (!best || views > best.views) best = { views, id, name, attribution: resource.attribution?.trim() || domain, license: result.metadata?.license ?? null, filter: geo && level !== "state" ? "radius" : "city" };
        }
        if (!best) continue;
        candidates.push({
          source_id: `opendata:${domain}:${best.id}`, name: `${best.name} (${best.attribution})`, url: `https://${domain}/d/${best.id}`, reader: "opendata",
          params: { domain, dataset: best.id, topic: topic.topic, filter: best.filter, agency: best.attribution, license: best.license },
          section: TOPIC_SECTION[topic.topic] as SectionId, found_by: { method: "opendata", detail: `${topic.query} on the ${level} portal ${domain}` }, inside_area: false,
        });
      }
    }
    for (const [domain] of portals.slice(0, 2)) {
      try {
        const rows = (JSON.parse(new TextDecoder().decode(await publicApiGet(context.transport, `${SOCRATA_CATALOG}?${new URLSearchParams({ domains: domain, only: "dataset", q: "property sales", limit: "20" })}`, "application/json", 4 * 1024 * 1024, 30_000))) as { results?: CatalogResult[] }).results ?? [];
        const hit = rows.find((row) => /^[a-z0-9]{4}-[a-z0-9]{4}$/.test(row.resource?.id ?? "") && SALES_RULE.test(row.resource?.name ?? "") && !STALE_NAME.test(row.resource?.name ?? ""));
        if (hit?.resource?.id) candidates.push({ source_id: `property:${domain}:${hit.resource.id}`, name: `${hit.resource.name} (${hit.resource.attribution?.trim() || domain})`, url: `https://${domain}/d/${hit.resource.id}`, reader: "property", params: { backend: "socrata", domain, dataset: hit.resource.id }, section: "real_estate", found_by: { method: "opendata", detail: `property sales on the portal ${domain}` }, inside_area: false, topics: ["home_sales"] });
      } catch { /* the portal has no sales data */ }
    }
    return { candidates, detail: `${portals.length} portals (${portals.map(([domain]) => domain).join(", ") || "none"}); ${candidates.length} datasets` };
  },
};

// --- newsrooms, athletics, publishers --------------------------------------------------------
const newsrooms: MethodDefinition = {
  method: "newsrooms", label: "Wikidata newsrooms", refreshDays: 14,
  async run(context) {
    const found = await discoveredNewsrooms(context as unknown as ConnectorContext);
    return { candidates: found.map((item) => webCandidate(item.website, item.name, "news", "newsrooms", item.provenance.detail, { feed: item.feed, kind: "news_report" })), detail: `${found.length} newsrooms with a current feed` };
  },
};
const athletics: MethodDefinition = {
  method: "athletics", label: "State athletic association", refreshDays: 30,
  async run(context) {
    const found = await discoveredAthletics(context as unknown as ConnectorContext);
    return { candidates: found.map((item) => webCandidate(item.website, item.name, "schools", "athletics", `Wikidata ${item.provenance.detail}`, { feed: item.feed, kind: "school_sports" })), detail: `${found.length} associations with a current feed` };
  },
};
export const PUBLISHER_MIN_HITS = 2;
const publishers: MethodDefinition = {
  method: "publishers", label: "Publishers found by news search", refreshDays: 7,
  async run(context) {
    const rows = await newsPublishers(context.db).find({ location_id: context.location.id, hits: { $gte: PUBLISHER_MIN_HITS } }).sort({ hits: -1 }).limit(15).toArray();
    const candidates: SourceCandidate[] = [];
    for (const row of rows) {
      if (aggregator(row.url) || candidates.length >= 8) continue;
      const feed = await findFeed(context.fetcher, row.url, context.today).catch(() => null);
      candidates.push(webCandidate(row.url, row.name || row.host, "news", "publishers", `Covered ${place(context.location)} in ${row.hits} news search results`, { feed: feed?.feed ?? null, kind: "news_report" }));
    }
    return { candidates, detail: `${rows.length} publishers with ${PUBLISHER_MIN_HITS}+ results; ${candidates.length} added` };
  },
};

// --- LLM discovery ----------------------------------------------------------------------------
const LLM_SECTIONS = ["events", "civic", "schools", "sports", "safety", "real_estate", "business", "obituaries", "community", "weather", "news"];
function llmPrompt(location: LocationProfile, links: string[]) {
  const where = location.community ? `${location.community.name}, a neighbourhood of ${location.community.parent_name}, ${US_STATES[location.state] ?? location.state}` : `${townName(location)}, ${US_STATES[location.state] ?? location.state}`;
  return `You are building a source map for a hyperlocal weekly newsletter about ${where}. Find 15 to 25 publicly accessible sources of local information for THIS place: the school district and individual schools, PTAs, youth sports leagues, police, fire and sheriff news pages, library and parks event calendars, community centres, chambers of commerce and business associations, community councils, local news sites and blogs, farmers markets, festivals, and local funeral homes. Prefer pages that list many items (news listings, calendars) and organisations located inside the place. Do not include Facebook, Nextdoor, Instagram, X/Twitter, Reddit, TikTok or Legacy.com. Reply with ONLY a JSON array; each item: {"name": str, "url": str, "section": one of ${pythonJson(LLM_SECTIONS)}, "located_inside": true or false, "why": str under 15 words}.${links.length ? `\nLinks found on the official city pages, for reference:\n${links.slice(0, 80).join("\n")}` : ""}`;
}
const LLM_SCHEMA = { type: "object", properties: { sources: { type: "array", items: { type: "object", properties: { name: { type: "string" }, url: { type: "string" }, section: { type: "string" }, located_inside: { type: "boolean" }, why: { type: "string" } }, required: ["name", "url", "section", "located_inside", "why"] } } }, required: ["sources"] };
const llm: MethodDefinition = {
  method: "llm", label: "Gemini suggestions (checked)", refreshDays: 30,
  async run(context) {
    if (!context.settings.llmDiscovery) return { candidates: [], detail: "LLM discovery is off (NEWSBEE_LLM_DISCOVERY)" };
    if (!(await canSpend(context.db, context.settings, 2))) throw new Error("Daily model-call cap reached; LLM discovery waits until tomorrow");
    const links: string[] = [];
    const city = httpsLink(context.location.government?.website ?? null);
    if (city) {
      try {
        const [url, html] = await context.fetcher.getText(city, 2 * 1024 * 1024, ACCEPT_HTML);
        for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) { try { const link = httpsLink(new URL(match[1], url).toString()); if (link && !links.includes(link)) links.push(link); } catch { /* ignore */ } }
      } catch { /* the city site may block us */ }
    }
    const prompt = llmPrompt(context.location, links);
    let raw: unknown[] = [];
    const grounded = await groundedSearch(context.settings, prompt, context.transport, usageRecorder(context.db, context.settings, "discovery"));
    if (grounded?.text) raw = jsonArray(grounded.text);
    if (!raw.length && context.model) {
      if (context.model.provider === "ollama") {
        const health = await context.model.health();
        if (health.status === "unavailable" || health.status === "not_configured") {
          throw new Error(`Discovery model is not ready: ${health.detail}. Configure an installed model before retrying; no automatic download is attempted.`);
        }
      }
      const generated = await context.model.generateStructured(prompt, LLM_SCHEMA, { numPredict: 3000 });
      try { raw = ((JSON.parse(generated.response) as { sources?: unknown[] }).sources ?? []); } catch { raw = []; }
    }
    const candidates: SourceCandidate[] = [];
    const name = place(context.location);
    const navigationFetcher = new Fetcher(publicSourceTransport(context.transport));
    const deadline = Date.now() + 150_000;
    for (const value of raw.slice(0, 30)) {
      if (Date.now() >= deadline) {
        await recordDecision({ stage: "source", actor: "rule", subject: "llm_navigation", decision: "not_reached", reason: "150-second source validation budget exhausted", rule: "deadline" });
        break;
      }
      const item = value as { name?: unknown; url?: unknown; section?: unknown; located_inside?: unknown; why?: unknown };
      const url = httpsLink(typeof item.url === "string" ? item.url.replace(/^http:/, "https:") : null);
      if (!url || typeof item.name !== "string" || aggregator(url)) continue;
      // Every suggestion is fetched: it must exist and allow us to read it.
      let home: string;
      try { home = (await context.fetcher.getText(url, 2 * 1024 * 1024, ACCEPT_HTML))[1]; }
      catch (error) {
        const detail = error instanceof DiscoveryBlockedError ? error.message : String(error);
        context.log.info("llm_source_rejected", { url, error: detail });
        await recordDecision({ stage: "source", actor: "rule", subject: url, decision: "rejected", reason: detail, rule: "fetch_check", evidence: { method: "llm", name: item.name } });
        continue;
      }
      const section = (LLM_SECTIONS.includes(String(item.section)) ? item.section : "community") as SectionId;
      // A model assertion or a Seattle mention is not proof that every item concerns
      // this neighborhood. Keep item-level locality checks for all model suggestions.
      const parent = webCandidate(url, item.name.slice(0, 120), section, "llm", `${typeof item.why === "string" ? item.why.slice(0, 120) : "Suggested by model"}${grounded ? " (from search)" : ""}`, { inside: false, kind: section === "obituaries" ? "obituary" : section === "news" ? "news_report" : "local_news" });
      candidates.push(parent);
      const linked = await linkedPages(navigationFetcher, parent, home, context.today, name, 3);
      candidates.push(...linked.candidates);
      for (const item of linked.rejected) await recordDecision({ stage: "source", actor: "rule", subject: item.url, decision: "rejected", reason: item.reason, rule: "linked_page_check" });
      if (candidates.length >= 60) break;
    }
    return { candidates, detail: `${raw.length} suggestions; ${candidates.length} checked and kept` };
  },
};

// --- national readers -----------------------------------------------------------------------
const READER_SECTIONS: Record<string, SectionId> = { hazards: "weather", trending: "news", homesafety: "weather", housing: "real_estate", justice: "safety", community: "community", remembrance: "obituaries", newssearch: "news", library: "events", meetings: "civic" };
const national: MethodDefinition = {
  method: "national", label: "National public data and onboarding sources", refreshDays: 7,
  async run(context) {
    const tasks = selectSources(context.location, context.settings);
    const candidates: SourceCandidate[] = tasks.filter((task) => !["web", "opendata"].includes(task.type)).map((task) => ({
      source_id: task.source_id, name: task.name, url: null, reader: task.type, params: task.params ?? {},
      section: READER_SECTIONS[task.type] ?? "news",
      found_by: { method: task.type === "library" ? "library" : "national", detail: CONNECTORS[task.type]?.meta.formats ?? task.type },
      inside_area: task.type === "library" || task.type === "community" || task.type === "remembrance",
    }));
    return { candidates, detail: `${candidates.length} national and onboarding sources` };
  },
};

// --- operator search (agentic flow only) ----------------------------------------------------
/** Query budget per run for the template families; the agent's rounds have their own. */
export const DORK_QUERIES = 36;
const dork: MethodDefinition = {
  method: "dork", label: "Google operator search", refreshDays: 7,
  async run(context) {
    const options = currentOptions();
    const kit = await buildSearchKit(context);
    const queries = stage1Queries(kit, options.topics, DORK_QUERIES);
    const { candidates, counts, rejected } = await evaluateQueries(context, queries, { method: "dork", seen: new Set(), deadline: Date.now() + JOB_DEADLINE_MS });
    // No search worked: fail, so this retries soon rather than counting as done for a week.
    if (counts.queries && counts.skipped + counts.failed === counts.queries) throw new Error(`No search could run: ${rejected[0]?.reason ?? "every query was skipped by the run's budget or settings"}`);
    if (kit.zips[0] && options.paid.attom !== undefined && context.settings.integrations.attomKey) {
      candidates.push({ source_id: `property:attom:${kit.zips[0]}`, name: `ATTOM sales for ${kit.zips[0]}`, url: null, feed_url: null, reader: "property", params: { backend: "attom", postal_code: kit.zips[0] }, section: "real_estate", found_by: { method: "dork", detail: "Paid property data, ticked for this run" }, inside_area: true, status: "proposed", source_tier: "business", topics: ["home_sales"], why: "Sale prices from ATTOM" });
    }
    return { candidates, detail: `${counts.queries} queries (${counts.skipped} skipped, ${counts.failed} failed, ${counts.not_run} out of time), ${counts.results} results, ${counts.fetched} pages checked, ${candidates.length} sources` };
  },
};

export const METHODS: MethodDefinition[] = [national, government, directories, osm, meetings, opendata, newsrooms, athletics, publishers, llm, dork];
export function methodDefinition(method: string) { return METHODS.find((definition) => definition.method === method); }
export { hashId };
