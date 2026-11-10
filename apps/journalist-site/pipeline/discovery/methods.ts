/**
 * The fixed pipeline: code that goes where we already know to look, run once before the agent.
 * Each method finds one kind of source for a location and returns candidates for the source map.
 * They run as separate jobs at the start of a run when due (each has its own refresh period), so
 * a slow method never blocks the others. `FIXED_READERS` is the one list, by reader:
 *
 *   City and county
 *     government    the city's and county's own websites (the checked city site, OpenStreetMap
 *                   via Nominatim), read in depth: their category pages (agendas, hearings,
 *                   boards, police and fire, permits, business, parks, volunteering), their
 *                   CivicPlus feeds (news, calendar, agendas, alerts), and the groups they link to
 *     meetings      Legistar, CivicClerk and PrimeGov accounts for the city and county
 *   Open data
 *     opendata      Socrata portals for the city, county and state and their police, fire,
 *                   permit, inspection, licence and 311 datasets
 *   Schools
 *     schools       the school districts covering the place (Census, NCES), their board
 *                   meetings, calendars and news, and each local school's PTA, PTSA or PTO
 *   Local groups
 *     groups        chambers, downtown and neighbourhood groups at their usual addresses, and
 *                   funeral homes' obituary pages
 *   Local institutions
 *     institutions  libraries, police and fire stations and community centres, and the clubs and
 *                   high schools serving the place from just outside it, read in depth; every
 *                   other place with a website on OpenStreetMap inside the area by its home page
 *   News and wider sources
 *     newsrooms     Wikidata outlets published nearby with a current feed
 *     publishers    outlets news search keeps finding covering the place
 *     athletics     the state's school athletic association (Wikidata)
 *     national      the national public-data readers (NWS, USGS, EPA, Census, Justice
 *                   Department, Wikipedia), library systems, the city's meetings, news
 *                   search, reader stories and family notices
 *   Home sales
 *     homesales     ATTOM sale prices for the place's postal code, only when a key is set
 *
 * Every page a fixed reader adds goes through `evaluateLeads`, with the same check groups and
 * evidence facts as any other page (./checks.ts), and every source from every route then goes
 * through the shared Model check when it is saved (./gemini-check.ts, from ./run.ts). Structured sources keep their own checks: open
 * data datasets, meeting-system accounts, CivicPlus feeds the official site lists, the national
 * readers and ATTOM. Gemini suggestions (`llm`) are no longer part of it: the agent replaces them.
 * The agentic flow adds the agent after it (../agent/map-sources.ts), whose tools include operator
 * search: there is no fixed batch of template searches. The query patterns stay in the playbook,
 * where the agent's skill shows them as examples.
 */
import type { Db } from "mongodb";
import type { Settings } from "../core/config";
import type { HttpTransport } from "../core/http";
import type { Logger } from "../core/log";
import type { ModelRuntime } from "../model/runtime";
import type { ConnectorContext, LocationProfile } from "../connectors/types";
import type { PriorityTopic } from "../core/run-values";
import { DiscoveryBlockedError, Fetcher } from "../connectors/fetcher";
import { publicSourceTransport } from "../connectors/public-http";
import { httpsLink } from "../connectors/common";
import { publicApiGet } from "../connectors/public-api";
import { locationCenter, townName, areaBox, TOWN_RADIUS_KM } from "../connectors/locality";
import { mentions } from "../connectors/community";
import { CONNECTORS, selectSources } from "../connectors/registry";
import { newsPublishers, aggregator } from "../connectors/newssearch";
import { TOPIC_SECTION, type Topic } from "../connectors/opendata";
import { distanceKm, US_STATES, withinArea, type Point } from "../../../../shared/geography";
import { areaFacts, discoveredAthletics, discoveredNewsrooms } from "./area";
import { hashId, hostOf, normaliseUrl, webSourceId, type DiscoveryMethod, type SourceCandidate } from "../sourcemap/store";
import type { SectionId } from "../sourcemap/sections";
import { canSpend, groundedSearch, jsonArray, usageRecorder } from "../model/budget";
import { pythonJson } from "../model/newsworthiness";
import { itemCap } from "../core/run-options";
import { fill, limit, list, regex, ruleSet, setting, table, template } from "../playbook";
import { recordDecision } from "../trace/decisions";
import { verifiedCitySite } from "./city-site";
import { evaluateLeads, JOB_DEADLINE_MS, type Lead } from "./evaluate";
import { localInstitutions, OVERPASS_MIRRORS, type Institution } from "./institutions";
import { districtSites, localSchools, schoolLinks } from "./schools";
import type { OutsideLink } from "./inspect";
import { checkGroups, scanSite, type Site } from "./site-pages";
import { queryOverpass, QUERY_SECONDS } from "../connectors/overpass";
import { buildSearchKit, postcode } from "./topics";
import { linkedPages } from "./linked-pages";

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
  /** The model check's model, when it isn't `model` (the agent's model is never its judge). */
  judgeModel?: ModelRuntime | null;
};

export type MethodDefinition = { method: DiscoveryMethod; label: string; refreshDays: number; run(context: DiscoveryContext): Promise<{ candidates: SourceCandidate[]; detail: string }> };

const ACCEPT_HTML = "text/html, application/xhtml+xml";
const REFRESH_DAYS = table<number>("general.stop.method_refresh_days");
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
const CIVICPLUS_MODULES = table<{ title: string; section: SectionId }>("general.prefer.civicplus_modules");
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
/**
 * A CivicPlus site's feeds, from the feed directory the official site publishes: structured
 * sources, like a meeting system's account. Its Agenda Center is a page, so it comes back as a
 * lead for the page checks.
 */
async function civicPlusFeeds(context: DiscoveryContext, site: string, label: string, inside: boolean, scope: Site["scope"]): Promise<{ feeds: SourceCandidate[]; leads: Lead[] }> {
  const out: SourceCandidate[] = [];
  const leads: Lead[] = [];
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
      if (link) out.push({ ...webCandidate(root, `${label}: ${title}`, section, "government", "CivicPlus feed on the government website", { feed: link, inside }), section_page: true });
    }
  } catch { /* not CivicPlus, or not allowed */ }
  try {
    const [url, html] = await context.fetcher.getText(`${root}/AgendaCenter`, 2 * 1024 * 1024, ACCEPT_HTML);
    if (/agendacenter/i.test(html)) leads.push({ url, title: `${label}: Agenda Center`, snippet: "", topic: "government", family: "civicplus_agenda_center", section: "civic", scope });
  } catch { /* none */ }
  return { feeds: out, leads };
}
/** What a county adds for a place: its sheriff, its assessor and its commissioners' meetings. */
const COUNTY_SECTIONS = list("civic.prefer.county_sections") as SectionId[];
const government: MethodDefinition = {
  method: "government", label: "City and county websites", refreshDays: REFRESH_DAYS.government,
  async run(context) {
    const candidates: SourceCandidate[] = [];
    const town = townName(context.location);
    const started = Date.now();
    // The checked site first: a location record can have no website, or the wrong one.
    const checked = await verifiedCitySite(context).catch(() => null);
    const city = httpsLink(checked?.url ?? context.location.government?.website ?? null);
    // A town's own government is local by construction; for a neighbourhood it is city-wide.
    const cityInside = !context.location.community;
    const seen = new Set<string>();
    const outside: OutsideLink[] = [];
    // The home page is checked like every page inside the site, so it is a source only if it passes.
    const scanned = async (url: string, site: Omit<Site, "url" | "kind">, label: string, inside: boolean, deadline: number) => {
      const civic = await civicPlusFeeds(context, url, label, inside, site.scope);
      candidates.push(...civic.feeds);
      candidates.push(...(await evaluateLeads(context, civic.leads, { method: "government", seen, deadline, fixed: true, siteKind: "government" })).candidates);
      const scan = await scanSite(context, { ...site, url, kind: "government", home: { section: "civic", topic: "government", family: "official_site" } }, "government", seen, deadline, new Set(civic.feeds.flatMap((feed) => feed.feed_url ? [feed.feed_url] : [])));
      candidates.push(...scan.candidates);
      outside.push(...scan.outside);
    };
    if (city) await scanned(city, { name: `City of ${town}`, scope: cityInside ? "place" : "city" }, `City of ${town}`, cityInside, started + JOB_DEADLINE_MS * 0.6);
    const facts = await areaFacts(context as unknown as ConnectorContext).catch(() => null);
    if (facts?.county) {
      const county = await countyWebsite(context, facts.county);
      if (county && hostOf(county) !== hostOf(city)) {
        await scanned(county, { name: facts.county, scope: "county", sections: COUNTY_SECTIONS, pages: limit("civic.stop.county_pages"), hubs: limit("civic.stop.county_hub_pages") }, facts.county, false, started + JOB_DEADLINE_MS * 0.85);
      }
    }
    const groups = await checkGroups(context, outside, list("civic.prefer.linked_group_sections") as SectionId[], "government", seen, started + JOB_DEADLINE_MS);
    candidates.push(...groups.candidates);
    return { candidates, detail: `${city ? `city site ${hostOf(city)}` : "no city site"}${facts?.county ? `, ${facts.county}` : ""}; ${candidates.length} sources, ${groups.candidates.length} from groups they link to` };
  },
};

// --- local institutions -----------------------------------------------------------------------
const OSM_RULES = ruleSet("osm_kinds");
const OSM_KINDS: Record<string, { priority: number; section: SectionId; kind?: string }> = Object.fromEntries(OSM_RULES.map((rule) => [rule.osm!.kind, { priority: rule.osm!.priority, section: rule.section as SectionId, kind: rule.osm!.story_kind }]));
export const OSM_CAP = limit("general.stop.osm_cap");
/** No one section may fill the list: a big city has dozens of schools and places of worship. */
export const OSM_SECTION_CAP = limit("general.stop.osm_section_cap");
const OSM_PER_HOST = limit("general.stop.osm_per_host");
/** Groups OpenStreetMap files as one kind of office, sorted by what their name says they are. */
const GROUP_SECTIONS = ruleSet("osm_group_names").map((rule): [RegExp, SectionId] => [rule.test, rule.section as SectionId]);
export function osmSection(kind: string, name: string): SectionId {
  const section = OSM_KINDS[kind].section;
  return section === "community" ? GROUP_SECTIONS.find(([test]) => test.test(name))?.[1] ?? section : section;
}
export { OVERPASS_MIRRORS };
function websiteOf(tags: Record<string, string>) {
  const raw = (tags.website ?? tags["contact:website"] ?? tags.url ?? "").split(";")[0].trim();
  if (!raw) return null;
  const url = raw.startsWith("http") ? raw.replace(/^http:/, "https:") : `https://${raw.replace(/^\/+/, "")}`;
  return httpsLink(url);
}
export type OsmPlace = { name: string; url: string; kind: string; section: SectionId };
/** Places with a website inside the area, most useful first, within the per-host, per-section and overall caps. */
export async function osmPlaces(context: DiscoveryContext): Promise<{ places: OsmPlace[]; detail: string }> {
  const { center, area } = locationCenter(context.location);
  if (!center) return { places: [], detail: "Location has no coordinates" };
  const [west, south, east, north] = areaBox(area, center);
  // Query the actual bbox (polygon candidates are filtered below), not an unrelated
  // 3 km circle. One indexed name/website scan avoids five overlapping nwr scans.
  const box = `(${south},${west},${north},${east})`;
  const query = `[out:json][timeout:${QUERY_SECONDS}];nwr${box}["name"][~"^(website|contact:website)$"~"."];out tags center;`;
  const response = await queryOverpass(context.transport, query);
  const elements = response.data.elements;
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
  const perSection = new Map<SectionId, number>();
  const seen = new Set<string>();
  const places: OsmPlace[] = [];
  for (const item of found) {
    const host = hostOf(item.url), key = normaliseUrl(item.url), section = osmSection(item.kind, item.name);
    if (seen.has(key) || (perHost.get(host) ?? 0) >= itemCap(OSM_PER_HOST) || (perSection.get(section) ?? 0) >= itemCap(OSM_SECTION_CAP)) continue;
    seen.add(key);
    perHost.set(host, (perHost.get(host) ?? 0) + 1);
    perSection.set(section, (perSection.get(section) ?? 0) + 1);
    places.push({ name: item.name, url: item.url, kind: item.kind, section });
    if (places.length >= itemCap(OSM_CAP)) break;
  }
  return { places, detail: `${elements.length} places with websites in bounding box; ${places.length} qualifying inside the area; ${response.attempts.join("; ")}` };
}

/** Libraries, police and fire stations and community centres: their sites are read in depth. */
const DEEP_KINDS = new Set(list("general.prefer.institution_deep_kinds"));
const INSTITUTION_SECTIONS = table<SectionId>("general.prefer.institution_sections");
export const INSTITUTION_TOPICS = table<PriorityTopic | null>("general.prefer.institution_topics");
const INSTITUTION_SITES = limit("general.stop.institution_sites");
const OTHER_READERS = new Set(["school", "funeral_directors"]);
export type DeepSite = { name: string; url: string; kind: string; inside: boolean };
/**
 * The institutions whose sites are read in depth: libraries, police and fire stations and community
 * centres inside the place, and the clubs and high schools `localInstitutions` keeps for serving it
 * from just outside. The map of the area adds any the nearby search left out. One site per address.
 */
export function deepSites(known: Institution[], places: OsmPlace[], cap = INSTITUTION_SITES): DeepSite[] {
  const sites: DeepSite[] = [
    ...known.flatMap((item) => item.website && (DEEP_KINDS.has(item.kind) || (!item.inside && ["club", "school"].includes(item.kind))) ? [{ name: item.name, url: item.website, kind: item.kind, inside: item.inside }] : []),
    ...places.filter((item) => DEEP_KINDS.has(item.kind)).map((item) => ({ name: item.name, url: item.url, kind: item.kind, inside: true })),
  ];
  const perHost = new Map<string, number>();
  return sites.filter((site, index) => sites.findIndex((other) => normaliseUrl(other.url) === normaliseUrl(site.url)) === index).filter((site) => {
    const count = perHost.get(hostOf(site.url)) ?? 0;
    perHost.set(hostOf(site.url), count + 1);
    return count < OSM_PER_HOST;
  }).slice(0, cap);
}
const institutions: MethodDefinition = {
  method: "institutions", label: "Local institutions, read in depth", refreshDays: REFRESH_DAYS.institutions,
  async run(context) {
    const started = Date.now();
    const known = await localInstitutions(context).catch(() => [] as Institution[]);
    let map: { places: OsmPlace[]; detail: string };
    try { map = await osmPlaces(context); }
    catch (error) {
      // Nothing to read at all: fail, so this retries within the hour.
      if (!deepSites(known, []).length) throw error;
      map = { places: [], detail: `OpenStreetMap area search failed: ${String(error)}` };
    }
    const deep = deepSites(known, map.places);
    const seen = new Set<string>();
    const candidates: SourceCandidate[] = [];
    let read = 0;
    // Each site's events, news and notices pages, the way the schools method reads a school's site.
    for (const site of deep) {
      if (Date.now() >= started + JOB_DEADLINE_MS * 0.7) break;
      const home = { section: INSTITUTION_SECTIONS[site.kind] ?? "community", topic: INSTITUTION_TOPICS[site.kind] ?? null, family: `institution:${site.kind}` };
      const scan = await scanSite(context, { url: site.url, name: site.name, kind: site.kind === "school" ? "school" : "organisation", scope: site.inside ? "place" : "city", hubs: limit("general.stop.institution_hub_pages"), pages: limit("general.stop.institution_pages"), home }, "institutions", seen, started + JOB_DEADLINE_MS * 0.7);
      candidates.push(...scan.candidates);
      read += 1;
    }
    // Every other place on the map (town halls, courts, venues, nonprofits): its home page, checked like any other page.
    // Schools and funeral homes are read in depth by the schools and local groups readers.
    const deepKeys = new Set(deep.map((site) => normaliseUrl(site.url)));
    const leads = map.places.filter((item) => !DEEP_KINDS.has(item.kind) && !OTHER_READERS.has(item.kind) && !deepKeys.has(normaliseUrl(item.url))).map((item): Lead => ({
      url: item.url, title: item.name, snippet: `${item.kind.replace(/_/g, " ")} inside ${place(context.location)}`, topic: INSTITUTION_TOPICS[item.kind] ?? null, family: `institution:${item.kind}`, section: item.section, scope: "place", kind: OSM_KINDS[item.kind].kind,
    }));
    const homes = await evaluateLeads(context, leads, { method: "institutions", seen, deadline: started + JOB_DEADLINE_MS, fixed: true, siteKind: "organisation" });
    candidates.push(...homes.candidates);
    return { candidates, detail: `${read} of ${deep.length} institution sites read in depth (${[...new Set(deep.map((site) => site.kind.replace(/_/g, " ")))].join(", ") || "none with a website"}); ${leads.length - homes.leftover.length} other places' home pages checked; ${candidates.length} sources; ${map.detail}` };
  },
};

// --- meeting platforms ---------------------------------------------------------------------
async function probeJson(context: DiscoveryContext, url: string) {
  try { return JSON.parse(new TextDecoder().decode(await publicApiGet(context.transport, url, "application/json", 512 * 1024, 15_000))) as unknown; }
  catch { return null; }
}
const MIN_TENANT = limit("civic.stop.min_tenant_chars");
const meetings: MethodDefinition = {
  method: "meetings", label: "Meeting platforms", refreshDays: REFRESH_DAYS.meetings,
  async run(context) {
    const state = context.location.state.toLowerCase();
    const town = townName(context.location);
    const facts = await areaFacts(context as unknown as ConnectorContext).catch(() => null);
    const governments: Array<{ name: string; level: "city" | "county"; slugs: string[] }> = [];
    const c = slug(town);
    if (c.length >= MIN_TENANT) governments.push({ name: town, level: "city", slugs: list("civic.prefer.meeting_tenants_city").map((name) => fill(name, { city: c, state })) });
    if (facts?.county) {
      const k = slug(facts.county), bare = k.replace(/county$/, "");
      governments.push({ name: facts.county, level: "county", slugs: list("civic.prefer.meeting_tenants_county").map((name) => fill(name, { county: k, state, bare })) });
    }
    const existing = context.location.government;
    const candidates: SourceCandidate[] = [];
    for (const government of governments) {
      for (const tenant of [...new Set(government.slugs)].filter((value) => value.length >= MIN_TENANT)) {
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
const TOPICS = ruleSet("opendata_topics").map((rule) => ({ topic: rule.opendata!.topic as Topic, query: rule.opendata!.query, rule: rule.test, stateLevel: rule.opendata!.state_level }));

/** A Socrata portal's home sale dataset, read by the property reader. */
const SALES_RULE = regex("real_estate.prefer.opendata_sales");
const STALE_NAME = regex("general.reject.stale_dataset_names");
const DATE_TYPES = new Set(["calendar_date", "floating_timestamp", "fixed_timestamp", "date"]);
type CatalogResult = { resource?: { id?: string; name?: string; attribution?: string | null; columns_field_name?: string[]; columns_datatype?: string[]; data_updated_at?: string; updatedAt?: string; page_views?: { page_views_total?: number } }; metadata?: { domain?: string; license?: string | null } };
export function matchPortals(domains: string[], location: LocationProfile, county: string | null): Array<[string, "city" | "county" | "state"]> {
  const city = slug(townName(location)), countySlug = slug(county), state = location.state.toLowerCase(), stateName = slug(US_STATES[location.state]);
  const found: Array<[string, "city" | "county" | "state"]> = [];
  for (const domain of domains) {
    const labels = domain.toLowerCase().replace(/^www\./, "").split(".");
    const names = new Set(labels.slice(0, -1));
    if (city.length >= limit("civic.stop.min_city_portal_chars") && list("civic.prefer.portal_names_city").some((name) => names.has(fill(name, { city, state })))) found.push([domain, "city"]);
    else if (countySlug.length >= limit("civic.stop.min_county_portal_chars") && list("civic.prefer.portal_names_county").some((name) => names.has(fill(name, { county: countySlug, state })))) found.push([domain, "county"]);
    else if (labels.at(-1) === "gov" && (names.has(state) || names.has(stateName)) && names.size <= limit("civic.stop.state_portal_labels")) found.push([domain, "state"]);
  }
  const order = { city: 0, county: 1, state: 2 };
  return [...new Map(found.map((item) => [item[0], item])).values()].sort((a, b) => order[a[1]] - order[b[1]]).slice(0, limit("civic.stop.portals"));
}
const opendata: MethodDefinition = {
  method: "opendata", label: "Open-data portals", refreshDays: REFRESH_DAYS.opendata,
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
      for (const host of list("civic.prefer.portal_hosts").map((address) => fill(address, { name }))) {
        if (domains.has(host)) continue;
        try {
          const body = await publicApiGet(context.transport, `${SOCRATA_CATALOG}?${new URLSearchParams({ domains: host, limit: "1" }).toString()}`, "application/json", 1024 * 1024, 20_000);
          if (((JSON.parse(new TextDecoder().decode(body)) as { results?: unknown[] }).results ?? []).length) domains.add(host);
        } catch { /* not a portal */ }
      }
    }
    const portals = matchPortals([...domains], context.location, facts?.county ?? null);
    const freshAfter = Date.now() - limit("civic.stop.dataset_recent_days") * 86400_000;
    const candidates: SourceCandidate[] = [];
    for (const [domain, level] of portals) {
      for (const topic of TOPICS) {
        if (level === "state" && !topic.stateLevel) continue;
        if (candidates.some((candidate) => candidate.params.topic === topic.topic && level !== "city")) continue;
        const params = new URLSearchParams({ domains: domain, only: "dataset", q: topic.query, limit: "20" });
        let results: CatalogResult[] = [];
        try { results = ((JSON.parse(new TextDecoder().decode(await publicApiGet(context.transport, `${SOCRATA_CATALOG}?${params.toString()}`, "application/json", 4 * 1024 * 1024, 30_000))) as { results?: CatalogResult[] }).results ?? []); }
        catch { continue; }
        let best: { views: number; id: string; name: string; attribution: string; license: string | null; filter: "radius" | "city"; updated: number } | null = null;
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
          if (!best || views > best.views) best = { views, id, name, attribution: resource.attribution?.trim() || domain, license: result.metadata?.license ?? null, filter: geo && level !== "state" ? "radius" : "city", updated };
        }
        if (!best) continue;
        candidates.push({
          source_id: `opendata:${domain}:${best.id}`, name: `${best.name} (${best.attribution})`, url: `https://${domain}/d/${best.id}`, reader: "opendata",
          params: { domain, dataset: best.id, topic: topic.topic, filter: best.filter, agency: best.attribution, license: best.license },
          section: TOPIC_SECTION[topic.topic] as SectionId, found_by: { method: "opendata", detail: `${topic.query} on the ${level} portal ${domain}` }, inside_area: false,
          // When its rows last changed, for the model check.
          ...(Number.isFinite(best.updated) ? { latest_day: new Date(best.updated).toISOString().slice(0, 10) } : {}),
        });
      }
    }
    for (const [domain] of portals.slice(0, limit("real_estate.stop.sales_portals"))) {
      try {
        const rows = (JSON.parse(new TextDecoder().decode(await publicApiGet(context.transport, `${SOCRATA_CATALOG}?${new URLSearchParams({ domains: domain, only: "dataset", q: template("real_estate.prefer.opendata_sales_query"), limit: "20" })}`, "application/json", 4 * 1024 * 1024, 30_000))) as { results?: CatalogResult[] }).results ?? [];
        const hit = rows.find((row) => /^[a-z0-9]{4}-[a-z0-9]{4}$/.test(row.resource?.id ?? "") && SALES_RULE.test(row.resource?.name ?? "") && !STALE_NAME.test(row.resource?.name ?? ""));
        if (hit?.resource?.id) candidates.push({ source_id: `property:${domain}:${hit.resource.id}`, name: `${hit.resource.name} (${hit.resource.attribution?.trim() || domain})`, url: `https://${domain}/d/${hit.resource.id}`, reader: "property", params: { backend: "socrata", domain, dataset: hit.resource.id }, section: "real_estate", found_by: { method: "opendata", detail: `property sales on the portal ${domain}` }, inside_area: false, topics: ["home_sales"] });
      } catch { /* the portal has no sales data */ }
    }
    return { candidates, detail: `${portals.length} portals (${portals.map(([domain]) => domain).join(", ") || "none"}); ${candidates.length} datasets` };
  },
};

// --- newsrooms, athletics, publishers --------------------------------------------------------
// Each outlet's site is checked like any other page. Where it was found says what it covers, so it
// carries that scope; the feed already found is tried first, and still has to work.
const newsrooms: MethodDefinition = {
  method: "newsrooms", label: "Wikidata newsrooms", refreshDays: REFRESH_DAYS.newsrooms,
  async run(context) {
    const found = await discoveredNewsrooms(context as unknown as ConnectorContext);
    const leads = found.map((item): Lead => ({ url: item.website, title: item.name, snippet: item.provenance.detail, topic: "news", family: "wikidata_newsroom", section: "news", scope: "city", kind: "news_report", feeds: [item.feed] }));
    const checked = await evaluateLeads(context, leads, { method: "newsrooms", seen: new Set(), deadline: Date.now() + JOB_DEADLINE_MS, fixed: true });
    return { candidates: checked.candidates, detail: `${found.length} newsrooms with a current feed; ${checked.candidates.length} passed the page checks` };
  },
};
const athletics: MethodDefinition = {
  method: "athletics", label: "State athletic association", refreshDays: REFRESH_DAYS.athletics,
  async run(context) {
    const found = await discoveredAthletics(context as unknown as ConnectorContext);
    const leads = found.map((item): Lead => ({ url: item.website, title: item.name, snippet: `Wikidata ${item.provenance.detail}`, topic: "sports", family: "state_athletics", section: setting("sports.prefer.athletics_association_section") as SectionId, scope: "state", kind: "school_sports", feeds: [item.feed] }));
    const checked = await evaluateLeads(context, leads, { method: "athletics", seen: new Set(), deadline: Date.now() + JOB_DEADLINE_MS, fixed: true });
    return { candidates: checked.candidates, detail: `${found.length} associations with a current feed; ${checked.candidates.length} passed the page checks` };
  },
};

// --- schools --------------------------------------------------------------------------------
const MAX_DISTRICTS = limit("schools.stop.districts");
const MAX_SCHOOLS = limit("schools.stop.schools");
const schools: MethodDefinition = {
  method: "schools", label: "School districts, boards and PTAs", refreshDays: REFRESH_DAYS.schools,
  async run(context) {
    const started = Date.now();
    const districts = (await districtSites(context)).slice(0, MAX_DISTRICTS);
    const known = (await localInstitutions(context).catch(() => [])).filter((item) => item.kind === "school");
    const seen = new Set<string>();
    const candidates: SourceCandidate[] = [];
    const outside: OutsideLink[] = [];
    const pages: Array<[string, string]> = [];
    for (const [index, district] of districts.entries()) {
      const scan = await scanSite(context, { url: district.website, name: district.name, kind: "school", scope: "city", home: { section: "schools", topic: "schools" } }, "schools", seen, started + JOB_DEADLINE_MS * 0.5 * (index + 1) / districts.length);
      candidates.push(...scan.candidates);
      outside.push(...scan.outside);
      pages.push(...scan.read);
    }
    // Each school's own site, for the parent group and athletics pages that a district never lists.
    const local = localSchools(schoolLinks(pages), known, Boolean(context.location.community), MAX_SCHOOLS);
    for (const school of local) {
      if (Date.now() >= started + JOB_DEADLINE_MS * 0.85) break;
      const scan = await scanSite(context, { url: school.url, name: school.name, kind: "school", scope: "city", sections: ["schools"], hubs: limit("schools.stop.school_hub_pages"), pages: limit("schools.stop.school_pages"), bestRank: limit("schools.stop.school_best_rank"), sportsPages: limit("sports.stop.school_pages"), home: { section: "schools", topic: "schools" } }, "schools", seen, started + JOB_DEADLINE_MS * 0.85);
      candidates.push(...scan.candidates);
      outside.push(...scan.outside);
    }
    const groups = await checkGroups(context, outside, list("schools.prefer.linked_group_sections") as SectionId[], "schools", seen, started + JOB_DEADLINE_MS);
    candidates.push(...groups.candidates);
    return { candidates, detail: `${districts.map((district) => district.name).join(", ") || "no district website on record"}; ${local.length} schools read; ${candidates.length} sources, ${groups.candidates.length} parent groups off-site` };
  },
};

// --- local groups ---------------------------------------------------------------------------
/**
 * Where groups usually live, from the place's name alone. A guess proves nothing: the page must
 * say what it is and name the place, then pass every check a search result would.
 */
export function groupAddresses(city: string, place: string) {
  const c = slug(city), p = slug(place);
  return ruleSet("usual_addresses").map((rule) => ({ label: rule.address!.label, section: rule.section as SectionId, topic: rule.topic as PriorityTopic, proof: rule.test, hosts: rule.values!.map((host) => fill(host, { city: c, place: p })) }));
}
const MAX_FUNERAL_HOMES = limit("obituaries.stop.funeral_homes");
const groups: MethodDefinition = {
  method: "groups", label: "Chambers, neighbourhood groups and funeral homes", refreshDays: REFRESH_DAYS.groups,
  async run(context) {
    const deadline = Date.now() + JOB_DEADLINE_MS;
    const name = place(context.location), city = context.location.community?.parent_name ?? name;
    const seen = new Set<string>();
    const candidates: SourceCandidate[] = [];
    for (const group of groupAddresses(city, name)) {
      for (const host of [...new Set(group.hosts)]) {
        if (Date.now() >= deadline) break;
        let page: [string, string];
        try { page = await context.fetcher.getText(`https://www.${host}/`, 2 * 1024 * 1024, ACCEPT_HTML); }
        catch { continue; }
        const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page[1])?.[1] ?? "").replace(/\s+/g, " ").trim();
        if (!group.proof.test(`${title} ${page[1].slice(0, 20_000)}`) || !(mentions(title, name) || mentions(title, city))) continue;
        const checked = await evaluateLeads(context, [{ url: page[0], title: title.slice(0, 120) || host, snippet: "", topic: group.topic, family: `usual_address:${group.label}`, section: group.section }], { method: "groups", seen, deadline, fixed: true, siteKind: "organisation" });
        candidates.push(...checked.candidates);
        if (checked.candidates.length) break;
      }
    }
    const homes = (await localInstitutions(context).catch(() => [])).filter((item) => item.kind === "funeral_directors" && item.website).slice(0, MAX_FUNERAL_HOMES);
    for (const home of homes) {
      if (Date.now() >= deadline) break;
      const scan = await scanSite(context, { url: home.website!, name: home.name, kind: "organisation", scope: home.inside ? "place" : "city", sections: ["obituaries"], hubs: limit("obituaries.stop.funeral_hub_pages"), pages: limit("obituaries.stop.funeral_pages") }, "groups", seen, deadline);
      candidates.push(...scan.candidates);
    }
    return { candidates, detail: `${candidates.length} sources; ${homes.length} funeral homes read` };
  },
};

export const PUBLISHER_MIN_HITS = limit("general.stop.publisher_min_hits");
const publishers: MethodDefinition = {
  method: "publishers", label: "Publishers found by news search", refreshDays: REFRESH_DAYS.publishers,
  async run(context) {
    const rows = await newsPublishers(context.db).find({ location_id: context.location.id, hits: { $gte: PUBLISHER_MIN_HITS } }).sort({ hits: -1 }).limit(limit("general.stop.publisher_rows")).toArray();
    const leads = rows.filter((row) => !aggregator(row.url)).slice(0, limit("general.stop.publisher_sources")).map((row): Lead => ({
      url: row.url, title: row.name || row.host, snippet: `Covered ${place(context.location)} in ${row.hits} news search results`, topic: "news", family: "news_search_publisher", section: "news", scope: "city", kind: "news_report",
    }));
    const { candidates } = await evaluateLeads(context, leads, { method: "publishers", seen: new Set(), deadline: Date.now() + JOB_DEADLINE_MS, fixed: true });
    return { candidates, detail: `${rows.length} publishers with ${PUBLISHER_MIN_HITS}+ results; ${leads.length} checked, ${candidates.length} added` };
  },
};

// --- LLM discovery ----------------------------------------------------------------------------
// Not part of the fixed pipeline any more: the agent replaces it. Kept for reference, unregistered.
const LLM_SECTIONS = list("general.prefer.suggestion_sections");
const LLM_STORY_KINDS = table("general.evidence.suggestion_story_kinds");
function llmPrompt(location: LocationProfile, links: string[]) {
  const state = US_STATES[location.state] ?? location.state;
  const where = location.community ? fill(template("general.search.gemini_where_neighbourhood"), { place: location.community.name, parent: location.community.parent_name, state }) : fill(template("general.search.gemini_where_town"), { place: townName(location), state });
  return fill(template("general.search.gemini_prompt"), { where, sections: pythonJson(LLM_SECTIONS), links: links.length ? fill(template("general.search.gemini_links"), { links: links.slice(0, limit("general.stop.suggestion_city_links")).join("\n") }) : "" });
}
const LLM_SCHEMA = { type: "object", properties: { sources: { type: "array", items: { type: "object", properties: { name: { type: "string" }, url: { type: "string" }, section: { type: "string" }, located_inside: { type: "boolean" }, why: { type: "string" } }, required: ["name", "url", "section", "located_inside", "why"] } } }, required: ["sources"] };
const llm: MethodDefinition = {
  method: "llm", label: "Model suggestions (checked)", refreshDays: REFRESH_DAYS.llm,
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
    for (const value of raw.slice(0, limit("general.stop.suggestions_read"))) {
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
      const parent = webCandidate(url, item.name.slice(0, 120), section, "llm", `${typeof item.why === "string" ? item.why.slice(0, 120) : "Suggested by model"}${grounded ? " (from search)" : ""}`, { inside: false, kind: LLM_STORY_KINDS[section] ?? LLM_STORY_KINDS.default });
      candidates.push(parent);
      const linked = await linkedPages(navigationFetcher, parent, home, context.today, name, 3);
      candidates.push(...linked.candidates);
      for (const item of linked.rejected) await recordDecision({ stage: "source", actor: "rule", subject: item.url, decision: "rejected", reason: item.reason, rule: "linked_page_check" });
      if (candidates.length >= limit("general.stop.suggestions_kept")) break;
    }
    return { candidates, detail: `${raw.length} suggestions; ${candidates.length} checked and kept` };
  },
};

// --- national readers -----------------------------------------------------------------------
const READER_SECTIONS = table<SectionId>("general.prefer.reader_sections");
const national: MethodDefinition = {
  method: "national", label: "National public data and onboarding sources", refreshDays: REFRESH_DAYS.national,
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

// --- home sales -------------------------------------------------------------------------------
/** ATTOM's sale prices for the place's postal code: the only paid reader, so only with a key. Collection pays only when a run ticks ATTOM. */
const homesales: MethodDefinition = {
  method: "homesales", label: "Home sales (ATTOM)", refreshDays: REFRESH_DAYS.homesales,
  async run(context) {
    if (!context.settings.integrations?.attomKey) return { candidates: [], detail: "No ATTOM key set" };
    const zip = (await postcode(context.transport, context.location))[0];
    if (!zip) return { candidates: [], detail: "No postal code found for the place" };
    return {
      candidates: [{ source_id: `property:attom:${zip}`, name: `ATTOM sales for ${zip}`, url: null, feed_url: null, reader: "property", params: { backend: "attom", postal_code: zip }, section: "real_estate", found_by: { method: "homesales", detail: "Paid property data: read only in runs that tick ATTOM" }, inside_area: true, source_tier: "business", topics: ["home_sales"], why: "Sale prices from ATTOM" }],
      detail: `ATTOM sales for ${zip}`,
    };
  },
};

/** The fixed pipeline's one list of readers, each with the methods that make it up. */
export const FIXED_READERS: Array<{ reader: string; methods: MethodDefinition[] }> = [
  { reader: "City and county", methods: [government, meetings] },
  { reader: "Open data", methods: [opendata] },
  { reader: "Schools", methods: [schools] },
  { reader: "Local groups", methods: [groups] },
  { reader: "Local institutions", methods: [institutions] },
  { reader: "News and wider sources", methods: [newsrooms, publishers, athletics, national] },
  { reader: "Home sales", methods: [homesales] },
];
export const FIXED_METHODS = new Set<string>(FIXED_READERS.flatMap((entry) => entry.methods.map((definition) => definition.method)));
export const METHODS: MethodDefinition[] = FIXED_READERS.flatMap((entry) => entry.methods);
export function methodDefinition(method: string) { return METHODS.find((definition) => definition.method === method); }
export { hashId };
