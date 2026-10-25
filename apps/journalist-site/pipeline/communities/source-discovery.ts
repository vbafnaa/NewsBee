/**
 * Automatic local source discovery. For a location, find the organizations inside it that
 * publish something Newsbee can read (schools, libraries, community centers, faith
 * communities, museums, parks, community groups and local news sites) and keep every
 * RSS/Atom feed or event calendar that parses. Nobody has to supply these sources.
 *
 * Places come from OpenStreetMap through the public Overpass API (one query per discovery,
 * a documented API used within its usage policy, like the Photon geocoder) and from the
 * external links of the place's Wikipedia article. Every organization website and feed is
 * fetched through the robots.txt-respecting Fetcher.
 */
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { COMMUNITY_USER_AGENT, US_STATES } from "../../../../shared/geography";
import { httpsLink, MAX_FEED_BYTES } from "../connectors/common";
import { Fetcher } from "../connectors/fetcher";
import { findEvents, jsonLdBlocks, parseIcal, parseJsonLd, parseTrumba } from "../connectors/library/parsers";
import { publicOnlyTransport, publicSourceTransport } from "../connectors/public-http";
import type { LocationProfile } from "../connectors/types";
import { parseNewsFeed } from "../connectors/wider/adapters";
import type { HttpTransport } from "../core/http";
import { logger } from "../core/log";
import { COLLECTIONS } from "../storage/mongo";
import { feedLinks } from "./news-discovery";

const log = logger("communities.source-discovery");

/** Overpass servers in the order tried; the public servers are often busy, so each round tries all of them. */
export const OVERPASS_ENDPOINTS = ["https://lz4.overpass-api.de/api/interpreter", "https://overpass-api.de/api/interpreter", "https://z.overpass-api.de/api/interpreter"];
export const OVERPASS_ROUNDS = 3;
/** Search radius around a neighborhood's center, and around a whole town's center. */
export const NEIGHBORHOOD_RADIUS_M = 1500;
export const TOWN_RADIUS_M = 4000;
/** Rediscover a location's sources after this long. */
export const REDISCOVER_AFTER_DAYS = 7;
/** Time budget for one discovery, so it fits inside a single 300-second pipeline job. */
export const DISCOVERY_BUDGET_MS = 150_000;
const CONCURRENCY = 6;
const PAGE_BYTES = 2 * 1024 * 1024;
const ACCEPT_HTML = "text/html,application/xhtml+xml";
const ACCEPT_FEED = "application/rss+xml,application/atom+xml,application/xml,text/xml,text/calendar,*/*;q=0.5";

/** OpenStreetMap tags for organizations that serve the neighborhood, and the reader category for each. */
const PLACE_TAGS: Array<{ key: string; values: string[]; category: string }> = [
  { key: "amenity", values: ["school", "college"], category: "Schools" },
  { key: "amenity", values: ["library"], category: "Library" },
  { key: "amenity", values: ["community_centre", "townhall", "social_facility", "marketplace"], category: "Community" },
  { key: "amenity", values: ["place_of_worship"], category: "Faith communities" },
  { key: "amenity", values: ["arts_centre", "theatre"], category: "Arts & culture" },
  { key: "amenity", values: ["police", "fire_station"], category: "Public safety" },
  { key: "tourism", values: ["museum", "gallery", "attraction"], category: "Arts & culture" },
  { key: "leisure", values: ["park"], category: "Parks & recreation" },
  { key: "office", values: ["association", "ngo", "government"], category: "Community organizations" },
];
/** Feeds that are not the organization's own news. */
const SKIP_FEED = /\/comments\/feed|\/feed\/podcast|\/podcast|wp-json/i;
/** City-wide calendars whose events must name the area to count as local. */
const SHARED_CALENDAR_HOSTS = /(^|\.)trumba\.com$/i;

export type LocalPlace = { name: string; category: string; tag: string; website: string; found_via: "openstreetmap" | "wikipedia" | "community_website" };
export type DiscoveredSource = {
  id: string;
  name: string;
  category: string;
  site: string;
  feed_url: string;
  feed_kind: "rss" | "ical" | "trumba" | "jsonld";
  /** "local": the organization's own feed, all items count. "shared": a city-wide calendar filtered to the area. */
  scope: "local" | "shared";
  found_via: LocalPlace["found_via"];
  items_at_discovery: number;
};
export type SourceDiscovery = {
  _id: string;
  location_id: string;
  checked_at: string;
  places: LocalPlace[];
  sources: DiscoveredSource[];
  /** Words that mark a shared-calendar event as local: coverage terms and in-area place names. */
  area_terms: string[];
  gaps: string[];
  /** False when OpenStreetMap was unavailable or time ran out; the next run tries again. */
  complete: boolean;
};
export type DiscoveryOptions = { budgetMs?: number; retryDelayMs?: number };

function radiusFor(location: LocationProfile) {
  return location.community ? NEIGHBORHOOD_RADIUS_M : TOWN_RADIUS_M;
}

function center(location: LocationProfile) {
  const latitude = location.community?.latitude ?? location.latitude;
  const longitude = location.community?.longitude ?? location.longitude;
  return typeof latitude === "number" && typeof longitude === "number" ? { latitude, longitude } : null;
}

export function overpassQuery(latitude: number, longitude: number, radius: number) {
  const around = `around:${radius},${latitude},${longitude}`;
  const parts = PLACE_TAGS.map(({ key, values }) => `nwr(${around})["website"]["${key}"~"^(${values.join("|")})$"];`);
  return `[out:json][timeout:60];(${parts.join("")});out tags center;`;
}

/** Organizations with a website inside the area, from OpenStreetMap. */
export async function openStreetMapPlaces(transport: HttpTransport, latitude: number, longitude: number, radius: number, retryDelayMs = 2000): Promise<LocalPlace[]> {
  const query = overpassQuery(latitude, longitude, radius);
  const errors: string[] = [];
  for (let round = 0; round < OVERPASS_ROUNDS; round += 1) {
    if (round) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * round));
    const places = await overpassRound(transport, query, errors);
    if (places) return places;
  }
  throw new Error(`OpenStreetMap places unavailable (${errors.join("; ")})`);
}

async function overpassRound(transport: HttpTransport, query: string, errors: string[]): Promise<LocalPlace[] | null> {
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await publicOnlyTransport(transport)({
        url: `${endpoint}?data=${encodeURIComponent(query)}`,
        headers: { "User-Agent": COMMUNITY_USER_AGENT, Accept: "application/json" },
        maxBytes: 8 * 1024 * 1024,
        timeoutMs: 60_000,
      });
      if (response.status !== 200) { errors.push(`${endpoint}: HTTP ${response.status}`); continue; }
      const data = JSON.parse(new TextDecoder().decode(response.body)) as { elements?: Array<{ tags?: Record<string, string> }> };
      const places: LocalPlace[] = [];
      for (const element of data.elements ?? []) {
        const tags = element.tags ?? {};
        const website = httpsLink((tags.website ?? tags["contact:website"] ?? "").replace(/^http:\/\//i, "https://"));
        const match = PLACE_TAGS.find(({ key, values }) => values.includes(tags[key] ?? ""));
        if (!website || !match || !tags.name) continue;
        places.push({ name: tags.name, category: match.category, tag: `${match.key}=${tags[match.key]}`, website, found_via: "openstreetmap" });
      }
      return places;
    } catch (error) {
      errors.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}

/** Websites listed under "External links" in the place's Wikipedia article, often local news and history sites. */
export async function wikipediaLinks(fetcher: Fetcher, titles: string[]): Promise<LocalPlace[]> {
  for (const title of titles) {
    try {
      const [, html] = await fetcher.getText(`https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`, PAGE_BYTES, ACCEPT_HTML);
      const start = html.indexOf('id="External_links"');
      if (start < 0) continue;
      const section = html.slice(start, start + 30_000);
      const links = [...section.matchAll(/<a[^>]*class="external text"[^>]*>/g)]
        .map((tag) => /href="([^"]+)"/.exec(tag[0])?.[1] ?? "")
        .map((href) => httpsLink(href.replace(/^http:\/\//i, "https://")))
        .filter((href): href is string => Boolean(href) && !/wikipedia\.org|wikimedia\.org|archive\.org|\.gov\/|\.edu\//i.test(href!));
      return [...new Set(links)].map((website) => ({ name: new URL(website).hostname.replace(/^www\./, ""), category: "Local news & history", tag: "wikipedia", website, found_via: "wikipedia" as const }));
    } catch {
      // Try the next title form.
    }
  }
  return [];
}

function decodeEntities(value: string) {
  return value.replace(/&#0*38;|&amp;/g, "&");
}

/** Feed and calendar links a page advertises: RSS/Atom, iCalendar exports, Trumba calendars and schema.org events on the page itself. */
export function pageFeeds(html: string, page: string): Array<{ url: string; kind: DiscoveredSource["feed_kind"] }> {
  const found = new Map<string, DiscoveredSource["feed_kind"]>();
  if (jsonLdBlocks(html).some((block) => findEvents(block).length > 0)) found.set(page, "jsonld");
  for (const url of feedLinks(html, page)) if (!SKIP_FEED.test(url)) found.set(url, "rss");
  for (const match of html.matchAll(/(?:href|src)="([^"]*(?:\.ics\b|[?&](?:amp;|#0*38;)?ical=1|webcal:)[^"]*)"/gi)) {
    try {
      const url = httpsLink(new URL(decodeEntities(match[1]).replace(/^webcal:/i, "https:"), page).toString());
      if (url) found.set(url, "ical");
    } catch { /* Ignore malformed calendar links. */ }
  }
  for (const match of html.matchAll(/trumba\.com\/calendars\/([a-z0-9_-]+)|webName["']?\s*:\s*["']([a-z0-9_-]+)["']/gi)) {
    found.set(`https://www.trumba.com/calendars/${match[1] ?? match[2]}.rss`, "trumba");
  }
  return [...found].map(([url, kind]) => ({ url, kind }));
}

/** The site's own events or calendar pages, which often carry the calendar the homepage does not. */
export function eventPages(html: string, page: string) {
  const origin = new URL(page).origin;
  const pages = new Set<string>();
  for (const match of html.matchAll(/href="([^"#]+)"/gi)) {
    try {
      const url = new URL(decodeEntities(match[1]), page);
      const link = httpsLink(url.toString());
      if (link && url.origin === origin && /\/(events?|calendar)(\/|$)/i.test(url.pathname) && link !== page) pages.add(link);
    } catch { /* Ignore malformed links. */ }
  }
  return [...pages];
}

/** Parse a feed the way collection will; returns how many items it has. Throws when it is not a usable feed. */
export function feedItemCount(kind: DiscoveredSource["feed_kind"], bytes: Uint8Array, place?: Pick<LocalPlace, "name" | "website">) {
  if (kind === "rss") return parseNewsFeed(bytes).length;
  if (kind === "trumba") return parseTrumba(bytes).events.length;
  if (kind === "jsonld") return parseJsonLd(bytes).events.length;
  return parseIcal(bytes, { venue: place?.name, link: place?.website }).events.length;
}

async function pool<T>(items: T[], deadline: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  let skipped = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const item = queue.shift()!;
      if (Date.now() > deadline) { skipped += 1; continue; }
      await work(item);
    }
  }));
  return skipped;
}

function wikipediaTitles(location: LocationProfile) {
  const community = location.community;
  const town = location.name.replace(/,\s*[A-Z]{2}$/, "");
  const stateName = community?.state_name ?? US_STATES[location.state] ?? location.state;
  return community ? [`${community.name}, ${community.parent_name}`, `${community.name}, ${stateName}`] : [`${town}, ${stateName}`];
}

/** Find, validate and store every readable source for a location. */
export async function discoverSources(db: Db, transport: HttpTransport, location: LocationProfile, options: DiscoveryOptions = {}): Promise<SourceDiscovery> {
  const deadline = Date.now() + (options.budgetMs ?? DISCOVERY_BUDGET_MS);
  const fetcher = new Fetcher(publicSourceTransport(transport, 15_000));
  const gaps: string[] = [];
  const places: LocalPlace[] = [];
  let complete = true;
  const middle = center(location);
  if (middle) {
    try { places.push(...await openStreetMapPlaces(transport, middle.latitude, middle.longitude, radiusFor(location), options.retryDelayMs)); }
    catch (error) { gaps.push(error instanceof Error ? error.message : String(error)); complete = false; }
  } else gaps.push("The location has no coordinates, so OpenStreetMap places were not searched.");
  places.push(...await wikipediaLinks(fetcher, wikipediaTitles(location)));
  const website = location.community?.geography?.website;
  if (website) places.push({ name: `${location.community!.name} community website`, category: "Community", tag: "community_website", website, found_via: "community_website" });

  const sites = [...new Map(places.map((place) => [place.website.replace(/\/$/, ""), place])).values()];
  // Candidates are grouped per site and kind: a site often offers the same content several ways
  // (RSS and Atom, several iCalendar exports), so the first that parses is kept for each kind.
  const candidates = new Map<string, { place: LocalPlace; kind: DiscoveredSource["feed_kind"]; urls: string[] }>();
  const addCandidates = (place: LocalPlace, feeds: Array<{ url: string; kind: DiscoveredSource["feed_kind"] }>) => {
    for (const feed of feeds) {
      const key = `${place.website}\u0000${feed.kind}`;
      const group = candidates.get(key) ?? { place, kind: feed.kind, urls: [] };
      if (!group.urls.includes(feed.url)) group.urls.push(feed.url);
      candidates.set(key, group);
    }
  };
  const unreachable: string[] = [];
  const skippedSites = await pool(sites, deadline, async (place) => {
    try {
      const [page, html] = await fetcher.getText(place.website, PAGE_BYTES, ACCEPT_HTML);
      addCandidates(place, pageFeeds(html, page));
      for (const eventsPage of eventPages(html, page)) {
        try {
          const [final, eventsHtml] = await fetcher.getText(eventsPage, PAGE_BYTES, ACCEPT_HTML);
          addCandidates(place, pageFeeds(eventsHtml, final));
        } catch { /* An unreadable events page only loses that page's calendars. */ }
      }
    } catch (error) {
      unreachable.push(`${place.name} <${place.website}>: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const sources: DiscoveredSource[] = [];
  const kept = new Set<string>();
  const skippedFeeds = await pool([...candidates.values()], deadline, async ({ place, kind, urls }) => {
    for (const url of urls) {
      try {
        const html = kind === "jsonld";
        const [final, bytes] = await fetcher.get(url, html ? PAGE_BYTES : MAX_FEED_BYTES, html ? ACCEPT_HTML : ACCEPT_FEED);
        // An empty but valid feed is kept: schools and churches post again after quiet weeks.
        const items = feedItemCount(kind, bytes, place);
        if (kept.has(final)) return;
        kept.add(final);
        sources.push({
          id: createHash("sha256").update(final).digest("hex").slice(0, 16),
          name: place.name, category: place.category, site: place.website, feed_url: final, feed_kind: kind,
          scope: SHARED_CALENDAR_HOSTS.test(new URL(final).hostname) ? "shared" : "local", found_via: place.found_via, items_at_discovery: items,
        });
        return;
      } catch (error) {
        log.info("discovered_feed_unusable", { location_id: location.id, url, error: String(error) });
      }
    }
  });

  const unique = [...new Map(sources.map((source) => [source.feed_url, source])).values()]
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  if (unreachable.length) gaps.push(`${unreachable.length} place websites could not be read: ${unreachable.join("; ")}`);
  if (skippedSites || skippedFeeds) complete = false;
  if (skippedSites || skippedFeeds) gaps.push(`Discovery time budget reached; ${skippedSites} websites and ${skippedFeeds} feeds were not checked and will be retried next time.`);
  const areaTerms = [...new Set([...(location.community?.coverage_terms ?? [location.name.replace(/,\s*[A-Z]{2}$/, "")]), ...places.filter((place) => place.found_via === "openstreetmap").map((place) => place.name)])];
  const discovery: SourceDiscovery = { _id: location.id, location_id: location.id, checked_at: new Date().toISOString(), places, sources: unique, area_terms: areaTerms, gaps, complete };
  await db.collection<SourceDiscovery>(COLLECTIONS.discoveredSources).replaceOne({ _id: location.id }, discovery, { upsert: true });
  log.info("sources_discovered", { location_id: location.id, places: places.length, sites: sites.length, candidates: candidates.size, sources: unique.length, gaps: gaps.length });
  return discovery;
}

/** The stored discovery, refreshed when missing, incomplete or older than REDISCOVER_AFTER_DAYS. */
export async function currentDiscovery(db: Db, transport: HttpTransport, location: LocationProfile, options: DiscoveryOptions & { now?: number } = {}) {
  const stored = await db.collection<SourceDiscovery>(COLLECTIONS.discoveredSources).findOne({ _id: location.id });
  const fresh = stored && stored.complete !== false && (options.now ?? Date.now()) - Date.parse(stored.checked_at) < REDISCOVER_AFTER_DAYS * 86_400_000;
  return fresh ? stored : discoverSources(db, transport, location, options);
}
