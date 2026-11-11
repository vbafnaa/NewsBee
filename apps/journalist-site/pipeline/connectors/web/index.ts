import { distanceKm, withinArea, type Point } from "../../../../../shared/geography";
import { locationCenter } from "../locality";
/**
 * The website reader: one source on the map (a newsroom, a city site, a school, a venue, a
 * funeral home...) read with every method the site offers, within a budget of
 * PAGE_BUDGET requests:
 *
 *   1. its feed (the one on record, else one the homepage advertises, else common paths);
 *   2. iCalendar links on the homepage;
 *   3. schema.org data on the homepage (events, articles);
 *   4. pages from the sitemap changed since the window start, newest first;
 *   5. homepage links that look like stories, events or obituaries;
 *   6. for each page read: title, date, description, authors, image and main text.
 *
 * News items look back over the source's window; events look ahead. Page usage signals are
 * honoured: opt-outs skip the page, "nosnippet" and paywalls keep only headline and link.
 * Full text is stored (30 days) for detail extraction and locality, never republished.
 *
 * Items from a site inside the area are local by construction; others carry
 * `needs_locality` and are checked centrally before ranking.
 */
import pLimit from "p-limit";
import { addDays, httpsLink, MAX_FEED_BYTES, plainText } from "../common";
import { DiscoveryBlockedError, FetchDeadlineExceededError, Fetcher } from "../fetcher";
import { advertisedFeeds } from "../feeds";
import { parseIcal, parseJsonLd, parseTrumba } from "../library/parsers";
import { parseNewsFeed, publishedText, sha256, sponsoredItem } from "../wider/adapters";
import { runCollector, transient } from "../parents/shared";
import type { CollectedEvent, Connector, ConnectorContext, DroppedItem, SourceResult, SourceTask } from "../types";
import type { Story } from "../../editions/stories";
import { currentOptions, limits } from "../../core/run-options";
import { rangesFor } from "../../core/time";
import { extractItems } from "../../agent/extract";
import { recordDecision } from "../../trace/decisions";
import { WEB_WINDOW, effectiveWindow } from "../../sourcemap/windows";
import { saveText, type Details } from "../../editions/details";
import { jinaRead } from "./jina";
import { normalizeStoryImage } from "../../../../../shared/story-image";
import { articleMeta, venuePoint, calendarLinks, deepLinks, listingLinks, trumbaFeeds, FEED_GUESSES, imagesAllowed, mainText, meta, pageRights, parseSitemap, readablePage, rightsAction, SITEMAP_GUESSES, SKIP_PATH, storyLinks, supportingLinks, type ListingLink, type PageArticle, type RightsAction } from "./page";
import { siteNameProblem, urlDate } from "../../editions/title-rules";

/**
 * The site's own name, from the page that opened it: `og:site_name`, else the part of the title
 * after its last separator ("Story | Columbia Basin Herald"), else a home page's whole title.
 */
export function siteNameOf(html: string, pageUrl: string): string | null {
  const named = meta(html, "og:site_name", "application-name").trim();
  if (named) return named;
  const title = (plainText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "", 200) ?? "").replace(/\.$/, "").trim();
  const suffix = /\s[|–—-]\s([^|–—-]{3,80})$/.exec(title)?.[1]?.trim();
  if (suffix) return suffix;
  try { return new URL(pageUrl).pathname.replace(/\/+$/, "") === "" && title ? title : null; } catch { return null; }
}

export const SOURCE_BUDGET_MS = 120_000;
export const SOURCE_REQUEST_TIMEOUT_MS = 15_000;

const MAX_EXTRACTIONS = 2;
/** Pages of one site read at once; each host's pacing still applies. */
const PAGES_AT_ONCE = 3;
/** A page with less text than this was probably built by script. */
const THIN_TEXT = 300;
const ACCEPT_HTML = "text/html, application/xhtml+xml";
const ACCEPT_FEED = "application/rss+xml, application/atom+xml, application/xml, text/xml, text/calendar;q=0.9, */*;q=0.5";
const ACCEPT_XML = "application/xml, text/xml";

export type WebParams = { url: string; feed_url?: string | null; kind?: string; section?: string; inside_area?: boolean; window?: unknown; calendar_urls?: string[] };

type Budget = { used: number; max: number; deadline: number; limited: boolean };

function budgetAvailable(budget: Budget) {
  if (Date.now() >= budget.deadline) budget.limited = true;
  return !budget.limited;
}
type Fetched = { url: string; body: Uint8Array; headers: Record<string, string> };

async function fetchWithin(context: ConnectorContext, budget: Budget, record: SourceResult, url: string, accept: string): Promise<Fetched | null> {
  if (budget.used >= budget.max || !budgetAvailable(budget)) return null;
  if (context.deadline && Date.now() >= context.deadline) { record.out_of_time = true; budget.limited = true; return null; }
  budget.used += 1;
  try {
    const response = await context.fetcher.getResponse(url, MAX_FEED_BYTES, accept);
    record.pages_checked.push(url);
    return response;
  } catch (error) {
    if (error instanceof FetchDeadlineExceededError) budget.limited = true;
    budgetAvailable(budget);
    if (transient(error)) throw error;
    const reason = error instanceof DiscoveryBlockedError ? error.message : error instanceof Error ? error.constructor.name : "error";
    record.pages_checked.push(`${url} (${reason})`);
    if (error instanceof DiscoveryBlockedError && budget.used === 1) throw error;
    return null;
  }
}

function decode(body: Uint8Array) { return new TextDecoder().decode(body); }
function looksLikeFeed(body: Uint8Array) { return /^(﻿)?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)\b/i.test(decode(body.slice(0, 3000))); }
function looksLikeIcal(body: Uint8Array) { return decode(body.slice(0, 200)).trimStart().startsWith("BEGIN:VCALENDAR"); }

/** Newest news first, then soonest events (the section rankers decide the final order). */
export const newestFirst = (stories: Story[]) => [...stories].sort((a, b) => (b.first.event_date > a.first.event_date ? 1 : b.first.event_date < a.first.event_date ? -1 : a.title.localeCompare(b.title)));
export const webConnector: Connector = {
  type: "web",
  meta: {
    name: "Websites and feeds",
    formats: "RSS/Atom, iCalendar, schema.org events and articles, sitemaps and story pages on any site on the source map (robots-checked, 10 requests per site)",
    manual: true,
    coverage: { group: "local", label: "local websites and newsrooms" },
    storyKinds: ["event", "local_news", "news_report", "obituary", "school_sports"],
  },
  window: WEB_WINDOW,
  rank: newestFirst,
  sources() { return []; },
  collect(task, context) { return runCollector(task, context, (record) => readSite(task, context, record)); },
};

export async function readSite(task: SourceTask, context: ConnectorContext, record: SourceResult, dropped: DroppedItem[] = []): Promise<CollectedEvent[]> {
  const params = (task.params ?? {}) as WebParams;
  const site = httpsLink(params.url);
  if (!site) throw new Error("Source has no HTTPS website");
  record.website = site;
  record.feed_kind = "website";
  const window = effectiveWindow(WEB_WINDOW, (params.window as never) ?? null);
  const ranges = rangesFor(context, window);
  const since = ranges.back?.[0] ?? addDays(context.today, -14);
  const [from, until] = ranges.ahead ?? [addDays(context.today, 1), addDays(context.today, 14)];
  const kind = params.kind ?? "local_news";
  const local = Boolean(params.inside_area);
  const caps = limits();
  // Website depth 2 also reads the site's listing pages and what they link to, with its own extra requests.
  const depth = currentOptions().scrape_depth ?? 1;

  const MAX_ITEMS = caps.webMaxItems, MAX_PAGES = caps.webMaxPages, PAGE_BUDGET = caps.webPageBudget + (depth > 1 ? caps.webDeepBudget : 0);
  const budget: Budget = { used: 0, max: PAGE_BUDGET, deadline: Math.min(context.deadline ?? Infinity, Date.now() + SOURCE_BUDGET_MS), limited: false };
  const transport = context.fetcher.transport ?? context.transport;
  // Apply the remaining site budget to robots, redirects and response-body reads too.
  // Fetcher continues to enforce the publisher's full crawl delay before each request.
  context = { ...context, fetcher: new Fetcher(async (request) => {
    if (!budgetAvailable(budget)) throw new FetchDeadlineExceededError("Website collection time budget reached");
    return transport({ ...request, timeoutMs: Math.min(request.timeoutMs ?? SOURCE_REQUEST_TIMEOUT_MS,
      SOURCE_REQUEST_TIMEOUT_MS, budget.deadline - Date.now()) });
  }, context.fetcher.userAgent, context.fetcher.pace, budget.deadline) };
  const items: CollectedEvent[] = [];
  const seen = new Set<string>();
  let siteRights: RightsAction = "ok";
  let siteImages = true;
  /** The site's own name: a page titled only this is a page of the site, not a story. */
  let siteName: string | null = null;
  // A source saved as one dated story is named after that story, so its name says nothing about the site.
  const sourceName = urlDate(site) ? null : task.name;
  let verifiedVenue: { url: string; point: Point; km: number; inside: boolean } | null = null;

  const base = (title: string, url: string, day: string, extra: Partial<CollectedEvent>): CollectedEvent => ({
    source_event_id: sha256(url + (extra.event_date ?? day)).slice(0, 16), title, event_date: day, schedule_text: publishedText(day),
    venue: task.name, room: null, source_url: url, description: null, kind, source_name: task.name, ...(siteName ? { site_name: siteName } : {}),
    ...(local ? { tier: "local", locality: { method: "local_site", matches: [site] } } : { needs_locality: true }),
    section_hint: params.section ?? null, ...extra,
  } as CollectedEvent);
  const drop = (id: string, title: string, url: string | null, reason: string, day?: string | null) => { dropped.push({ source_event_id: id, title, url, reason, event_date: day ?? null }); };
  const add = (item: CollectedEvent) => {
    const key = item.source_url + item.event_date;
    if (seen.has(key) || items.length >= MAX_ITEMS) return;
    seen.add(key);
    if (siteRights === "link-only") { item.description = null; item.link_only = true; }
    if (!siteImages || item.link_only) item.image_blocked = true;
    if (item.image_blocked && item.details) {
      const { image: _image, image_credit: _credit, image_source_url: _source, image_alt: _alt, image_width: _width, image_height: _height,
        image_candidates: _candidates, ...details } = item.details as Partial<Details> & { image_candidates?: unknown };
      item.details = details;
    }
    items.push(item);
  };

  const readFeed = (body: Uint8Array, headers: Record<string, string> = {}) => {
    const flags = pageRights(headers);
    const action = rightsAction(flags);
    if (action === "skip") return false;
    if (looksLikeIcal(body)) { readCalendar(body, record.feed_url ?? site); return true; }
    if (!looksLikeFeed(body)) return false;
    let parsed;
    try { parsed = parseNewsFeed(body); } catch { return false; }
    for (const entry of parsed) {
      const id = sha256(entry.id).slice(0, 16);
      if (entry.published_day < since || entry.published_day > context.today) { drop(id, entry.title, entry.link, "outside_window", entry.published_day); continue; }
      if (sponsoredItem(entry)) { drop(id, entry.title, entry.link, "sponsored", entry.published_day); continue; }
      add(base(entry.title, entry.link, entry.published_day, {
        source_event_id: id, description: action === "ok" ? entry.summary : null,
        ...(action === "link-only" ? { link_only: true } : {}),
        ...(!imagesAllowed(flags) ? { image_blocked: true } : {}),
        ...(entry.coordinates ? { coordinates: entry.coordinates } : {}),
        details: { links: [entry.link], ...(imagesAllowed(flags) && entry.image ? normalizeStoryImage(entry.image, { source_url: entry.link, source_name: task.name }) : {}) } as Partial<Details>,
      }));
    }
    return true;
  };
  /** Read a calendar file or a page's schema.org events. `where` records how deep it was and a listing's section. */
  const readCalendar = (body: Uint8Array, url: string, trumba = false, where: { crawl_depth?: number; section_hint?: string } = {}) => {
    let events;
    try {
      const parsed = trumba ? parseTrumba(body) : looksLikeIcal(body) ? parseIcal(body, { allowMissingVenue: true }) : parseJsonLd(body);
      events = parsed.events;
      for (const [reason, count] of Object.entries(parsed.skipped)) record.skipped_unusable[reason] = (record.skipped_unusable[reason] ?? 0) + count;
    } catch (error) { record.pages_checked.push(`${url}: calendar parse failed: ${String(error)}`); return false; }
    for (const event of events) {
      const id = sha256(`${url}:${event.source_event_id}`).slice(0, 16);
      const branch = new URL(site).pathname.match(/^\/hours-and-locations\/[^/]+-branch/)?.[0];
      if (trumba && branch && (!event.venue_url || new URL(event.venue_url).hostname !== new URL(site).hostname || new URL(event.venue_url).pathname.replace(/\/$/, "") !== branch)) {
        drop(id, event.title, event.source_url, "different_or_unknown_branch", event.event_date); continue;
      }
      if (event.event_date < from || event.event_date > until) { drop(id, event.title, event.source_url, "outside_window", event.event_date); continue; }
      const venueEvidence = verifiedVenue && event.venue_url && new URL(event.venue_url).href.replace(/\/$/, "") === verifiedVenue.url.replace(/\/$/, "") && verifiedVenue.km <= 3 ? verifiedVenue : null;
      add({ ...event, source_event_id: id, venue: event.venue, kind: "event", source_name: task.name,
        ...(local ? { tier: "local", locality: { method: "local_site", matches: [site] } } : { needs_locality: true }),
        ...(venueEvidence ? { needs_locality: false, tier: venueEvidence.inside ? "local" : "nearby", coordinates: venueEvidence.point,
          locality: { method: "verified_venue", matches: [venueEvidence.url], distance_km: venueEvidence.km }, serves_community: true } : {}),
        section_hint: params.section ?? null, details: { places: [event.venue].filter(Boolean), when: event.schedule_text, links: [event.source_url] }, ...where } as CollectedEvent);
    }
    return events.length > 0;
  };
  let extractions = 0;
  /**
   * Read one page into items. `found` says where it came from: a listing page's section (a hint for the
   * newsletter section), how deep it is (1: linked from the home page; 2: from a listing page), and the
   * page itself when it was already fetched.
   */
  const readPage = async (url: string, how: string, found: { section?: string | null; depth?: number; prefetched?: Fetched } = {}) => {
    const page = found.prefetched ?? await fetchWithin(context, budget, record, url, ACCEPT_HTML);
    if (!page) return;
    const where = { crawl_depth: found.depth ?? 1, ...(found.section ? { section_hint: found.section } : {}) };
    const html = decode(page.body);
    const flags = pageRights(page.headers, html);
    const action = rightsAction(flags);
    if (action === "skip") { drop(sha256(url).slice(0, 16), url, url, "page opts out of reuse"); return; }
    if (/application\/ld\+json/i.test(html) && /"@type"\s*:\s*"(?:Event|[A-Za-z]+Event)"/.test(html) && readCalendar(page.body, page.url, false, where)) return;
    let article: PageArticle | null = articleMeta(html, page.url);
    let body = mainText(html);
    const undated = () => !article || !article.date;
    const withDate = (date: string, title: string | null, text: string | null): PageArticle => ({ ...article, title: article?.title ?? title ?? url, date, description: article?.description ?? plainText(text, 600), authors: article?.authors ?? [], image: article?.image ?? null, section: article?.section ?? null, keywords: article?.keywords ?? [] });
    // A parser first, then a free reader for pages built by script. The model is the last resort.
    if (undated() && action === "ok") {
      const readable = readablePage(html);
      if (readable?.date) article = withDate(readable.date, readable.title, readable.text ?? body);
      if ((body?.length ?? 0) < THIN_TEXT && readable?.text && readable.text.length > (body?.length ?? 0)) body = readable.text;
    }
    // A date written in the story's own address (/2026/nov/08/) is the publisher's.
    const addressed = undated() && article ? urlDate(page.url) : null;
    if (addressed) article = withDate(addressed, null, body);
    if (undated() && action === "ok" && (body?.length ?? 0) < THIN_TEXT && extractions < MAX_EXTRACTIONS) {
      extractions += 1;
      const read = await jinaRead(context.transport, context.settings.integrations?.jinaKey, page.url);
      if (read) body = read.markdown;
      if (read?.date) article = withDate(read.date, read.title, read.markdown);
    }
    // Agentic runs let the agent read pages the rules can't date, with a verbatim quote per item.
    if (undated() && action === "ok" && context.agentModel && extractions < MAX_EXTRACTIONS) {
      extractions += 1;
      const extracted = body ? await extractItems(context.agentModel, body, context.location.community?.name ?? context.location.name.split(",")[0], since, context.today).catch(() => []) : [];
      if (extracted.length) {
        await recordDecision({ stage: "collect", actor: "agent", subject: page.url, decision: "extracted", reason: `${extracted.length} items, each with a verbatim quote${where.crawl_depth > 1 ? ` (depth ${where.crawl_depth})` : ""}`, model: context.agentModel.servedModel ?? context.agentModel.model });
        await saveText(context.db, page.url, body, { canonical_url: page.url, reuse_allowed: true }).catch(() => undefined);
        for (const item of extracted) add(base(item.title, page.url, item.date, { source_event_id: sha256(`${page.url}:${item.title}`).slice(0, 16), description: item.summary, found_by: "agent extraction", found_via: how, extracted_quote: item.quote, extracted_by: "agent", ...where }));
        return;
      }
    }
    if (!article) return;
    const day = article.date;
    const id = sha256(page.url).slice(0, 16);
    // A page titled only with the site's name, or a listing heading, is a page of the site (its home
    // page, a section front), not a story: it is left out with that reason rather than "undated".
    const navigation = siteNameProblem(article.title, [siteName, siteNameOf(html, page.url), sourceName]);
    if (navigation) { drop(id, article.title, page.url, navigation, day); return; }
    if (!day) { drop(id, article.title, page.url, "undated"); return; }
    if (day < since || day > context.today) { drop(id, article.title, page.url, "outside_window", day); return; }
    const text = action === "ok" ? body : null;
    if (text) await saveText(context.db, page.url, text, { canonical_url: page.url, reuse_allowed: true, supporting_urls: supportingLinks(html, page.url) }).catch((error) => context.log.warn("article_text_cache_failed", { url: page.url, error: String(error) }));
    add(base(article.title, page.url, day, {
      source_event_id: id, description: action === "ok" ? article.description ?? plainText(text, 600) : null, found_by: how, ...where,
      ...(action === "link-only" ? { link_only: true } : {}),
      ...(!imagesAllowed(flags) ? { image_blocked: true } : {}),
      details: { people: article.authors.map((name) => `${name}, author`), links: [page.url],
        ...(imagesAllowed(flags) ? { ...normalizeStoryImage(article, { source_url: page.url, source_name: task.name }),
          ...(article.image_candidates ? { image_candidates: article.image_candidates } : {}) } : {}) } as Partial<Details>,
    }));
  };

  type DeepPage = { url: string; listing: ListingLink };
  let listingsRead = 0;
  /**
   * Website depth 2: read one listing page. Its own schema.org events and calendar file are read, and
   * the single stories and events it links to are queued for reading. A listing with neither is read
   * as a page, so in agentic runs the agent can pick out its items, each with a verbatim quote.
   */
  const readListing = async (listing: ListingLink, queue: DeepPage[], known: Set<string>) => {
    if (known.has(listing.url) || !budgetAvailable(budget) || budget.used >= PAGE_BUDGET) return;
    known.add(listing.url);
    const page = await fetchWithin(context, budget, record, listing.url, ACCEPT_HTML);
    if (!page) return;
    listingsRead += 1;
    const html = decode(page.body);
    const id = sha256(listing.url).slice(0, 16);
    if (rightsAction(pageRights(page.headers, html)) === "skip") { drop(id, listing.label || listing.url, listing.url, "page opts out of reuse"); return; }
    const before = items.length;
    const onListing = { crawl_depth: 1, ...(listing.section ? { section_hint: listing.section } : {}) };
    if (/application\/ld\+json/i.test(html) && /"@type"\s*:\s*"(?:Event|[A-Za-z]+Event)"/.test(html)) readCalendar(page.body, page.url, false, onListing);
    for (const url of calendarLinks(html, page.url).slice(0, 1)) {
      if (known.has(url)) continue;
      known.add(url);
      const calendar = await fetchWithin(context, budget, record, url, ACCEPT_FEED);
      if (calendar && rightsAction(pageRights(calendar.headers, "")) !== "skip" && readCalendar(calendar.body, calendar.url, false, { ...onListing, crawl_depth: 2 })) record.calendar_feeds = [...((record.calendar_feeds as string[] | undefined) ?? []), calendar.url];
    }
    // Stories dated in their address before the window would only be left out, so they aren't fetched.
    const links = deepLinks(html, page.url, caps.webDeepPages).filter((url) => !known.has(url) && !((urlDate(url) ?? "9999") < since));
    for (const url of links) queue.push({ url, listing });
    const structured = items.length - before;
    if (!links.length && !structured) { await readPage(listing.url, `listing page (${listing.kind})`, { section: listing.section, depth: 1, prefetched: page }); return; }
    drop(id, listing.label || listing.url, listing.url, `listing page (${listing.kind}): ${structured ? `${structured} events read, ` : ""}${links.length} links followed (depth 2)`);
  };
  /** Website depth 2: read the queued stories and events from listing pages, within the site's budgets. */
  const readDeep = async (queue: DeepPage[], known: Set<string>) => {
    let count = 0;
    const atOnce = pLimit(PAGES_AT_ONCE);
    const reading: Array<Promise<void>> = [];
    for (const { url, listing } of queue) {
      if (count >= caps.webDeepPages || budget.used + reading.length >= PAGE_BUDGET || items.length >= MAX_ITEMS || !budgetAvailable(budget)) break;
      if (known.has(url)) continue;
      known.add(url);
      count += 1;
      reading.push(atOnce(() => readPage(url, `listing link (${listing.kind})`, { section: listing.section, depth: 2 })));
    }
    await Promise.all(reading);
    return count;
  };

  // 1. Homepage: usage signals, advertised feed, calendars, structured data.
  const home = await fetchWithin(context, budget, record, site, ACCEPT_HTML);
  if (!home) throw new Error(`${budget.limited ? "Website collection time budget reached before homepage completed" : "Homepage could not be read"}: ${record.pages_checked.at(-1) ?? site}`);
  const homeHtml = decode(home.body);
  siteRights = rightsAction(pageRights(home.headers, homeHtml));
  siteImages = imagesAllowed(pageRights(home.headers, homeHtml));
  siteName = siteNameOf(homeHtml, home.url);
  if (siteRights === "skip") {
    record.status = "blocked";
    record.detail = "Site opts out of reuse (noindex, noai or a mining reservation)";
    return [];
  }
  const branchPath = new URL(site).pathname.match(/^\/hours-and-locations\/[^/]+-branch/)?.[0];
  if (branchPath && trumbaFeeds(homeHtml).length) {
    const venueUrl = new URL(branchPath, home.url).toString();
    const venue = venueUrl === home.url ? home : await fetchWithin(context, budget, record, venueUrl, ACCEPT_HTML);
    const point = venue && rightsAction(pageRights(venue.headers, decode(venue.body))) !== "skip" ? venuePoint(decode(venue.body)) : null;
    const { center, area } = locationCenter(context.location);
    if (point && center) verifiedVenue = { url: venueUrl, point, km: distanceKm(center, point), inside: area ? withinArea(area, center, point) : distanceKm(center, point) <= 8 };
  }
  let calendarRead = false;
  // Explicit calendars precede guesses so a small request budget still reaches dated events.
  for (const url of [...new Set([...trumbaFeeds(homeHtml), ...calendarLinks(homeHtml, home.url), ...(params.calendar_urls ?? []).filter(url => Boolean(httpsLink(url)))])].slice(0, 2)) {
    const calendar = await fetchWithin(context, budget, record, url, ACCEPT_FEED);
    if (!calendar || rightsAction(pageRights(calendar.headers, "")) === "skip") continue;
    const trumba = new URL(url).hostname === "www.trumba.com";
    if (readCalendar(calendar.body, calendar.url, trumba)) {
      calendarRead = true;
      record.calendar_feeds = [...((record.calendar_feeds as string[] | undefined) ?? []), calendar.url];
      record.feed_url = calendar.url;
      record.feed_kind = trumba ? "trumba_rss" : "ical";
    }
  }
  const feeds = [params.feed_url, ...advertisedFeeds(homeHtml, home.url)].map((url) => httpsLink(url)).filter((url): url is string => Boolean(url));
  // A source saved as one dated story (/news/2026/nov/08/...) stands for its publisher: the story page
  // rarely links the feed, so ask the site's home page for it before falling back to page links.
  if (!feeds.length && !params.feed_url && urlDate(home.url)) {
    const root = await fetchWithin(context, budget, record, new URL("/", home.url).toString(), ACCEPT_HTML);
    if (root) {
      const rootHtml = decode(root.body);
      siteName = siteName ?? siteNameOf(rootHtml, root.url);
      feeds.push(...advertisedFeeds(rootHtml, root.url).map((url) => httpsLink(url)).filter((url): url is string => Boolean(url)));
    }
  }
  let feedRead = false;
  for (const url of [...new Set(feeds)].slice(0, 2)) {
    const feed = await fetchWithin(context, budget, record, url, ACCEPT_FEED);
    if (feed && readFeed(feed.body, feed.headers)) { feedRead = true; record.news_feed_url = feed.url; if (!calendarRead) record.feed_url = feed.url; break; }
  }
  if (!calendarRead && !feedRead && !looksLikeFeed(home.body)) {
    for (const path of FEED_GUESSES.slice(0, 2)) {
      const guess = await fetchWithin(context, budget, record, new URL(path, home.url).toString(), ACCEPT_FEED);
      if (guess && readFeed(guess.body, guess.headers)) { feedRead = true; record.news_feed_url = guess.url; record.feed_url = guess.url; break; }
    }
  } else if (looksLikeFeed(home.body)) feedRead = readFeed(home.body, home.headers);
  if (/application\/ld\+json/i.test(homeHtml) && /"@type"\s*:\s*"(?:Event|[A-Za-z]+Event)"/.test(homeHtml)) readCalendar(home.body, home.url);

  // Website depth 2: the site's listing pages, events first.
  const listings = depth > 1 ? listingLinks(homeHtml, home.url, caps.webListingPages) : [];
  const known = new Set<string>([home.url, site, ...items.map((item) => item.source_url)]);
  const queue: DeepPage[] = [];

  if (calendarRead || feedRead) {
    // A news feed rarely carries the events calendar, so at depth 2 event listings are still read.
    let deepRead = 0;
    if (depth > 1 && !calendarRead) {
      for (const listing of listings.filter((item) => item.kind === "events")) await readListing(listing, queue, known);
      deepRead = await readDeep(queue, known);
    }
    record.requests_used = budget.used;
    record.structured_read = true;
    record.detail = `${budget.used} requests: ${calendarRead ? "calendar" : "feed"}; ${items.length} dated items kept; ${depth > 1 && !calendarRead ? `${listingsRead} event listing pages, ${deepRead} pages at depth 2` : "stopped before speculative page crawling"}`;
    return items;
  }

  // Event listings come before speculative page links, so a small budget still reaches dated events.
  for (const listing of listings.filter((item) => item.kind === "events")) await readListing(listing, queue, known);

  // 2. Recent pages from the sitemap, then story-like links from the homepage.
  const pages: Array<[string, string]> = [];
  // A section of a large site reads that section, not the whole site's sitemap.
  const sitePath = new URL(site).pathname.replace(/[^/]*$/, "");
  const inScope = (url: string) => { try { return new URL(url).pathname.startsWith(sitePath); } catch { return false; } };
  if (budgetAvailable(budget) && budget.used < PAGE_BUDGET - 2 && items.length < MAX_ITEMS) {
    const sitemaps = [...(await context.fetcher.sitemaps(home.url).catch(() => [])), ...SITEMAP_GUESSES.map((path) => new URL(path, home.url).toString())];
    const queue = [...new Set(sitemaps)];
    let reads = 0;
    while (queue.length && reads < 2 && budget.used < PAGE_BUDGET - 1 && budgetAvailable(budget)) {
      const url = queue.shift()!;
      const sitemap = await fetchWithin(context, budget, record, url, ACCEPT_XML);
      reads += 1;
      if (!sitemap) continue;
      const parsed = parseSitemap(decode(sitemap.body));
      const children = parsed.sitemaps.filter((entry) => !entry.lastmod || entry.lastmod >= since)
        .sort((a, b) => Number(/post|news|article|event|obit|stor/i.test(b.loc)) - Number(/post|news|article|event|obit|stor/i.test(a.loc)) || (b.lastmod ?? "").localeCompare(a.lastmod ?? ""));
      queue.unshift(...children.slice(0, 2).map((entry) => entry.loc));
      for (const entry of parsed.urls.filter((value) => value.lastmod && value.lastmod >= since).sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""))) {
        try { if (!SKIP_PATH.test(new URL(entry.loc).pathname) && inScope(entry.loc)) pages.push([entry.loc, "sitemap"]); } catch { /* ignore */ }
      }
      if (pages.length) break;
    }
  }
  if (pages.length < MAX_PAGES) pages.push(...storyLinks(homeHtml, home.url, MAX_PAGES * 2).map((url): [string, string] => [url, "page link"]));
  let read = 0;
  const atOnce = pLimit(PAGES_AT_ONCE);
  const reading: Array<Promise<void>> = [];
  for (const [url, how] of pages) {
    if (read >= MAX_PAGES || budget.used + reading.length >= PAGE_BUDGET || items.length >= MAX_ITEMS || !budgetAvailable(budget)) break;
    if (known.has(url)) continue;
    known.add(url);
    read += 1;
    reading.push(atOnce(() => readPage(url, how)));
  }
  await Promise.all(reading);
  // Website depth 2: the other listing pages, then everything the listings link to.
  for (const listing of listings.filter((item) => item.kind !== "events")) await readListing(listing, queue, known);
  const deepRead = depth > 1 ? await readDeep(queue, known) : 0;

  if (budget.limited) record.out_of_time = true;
  if (record.out_of_time) record.status = "partial";
  record.detail = `${budget.used} requests: ${calendarRead ? "calendar" : feedRead ? "feed" : "no feed"}, ${read} pages${depth > 1 ? `, ${listingsRead} listing pages, ${deepRead} pages at depth 2` : ""}; ${items.length} items kept, ${dropped.length} left out${siteRights === "link-only" ? "; headline and link only (site's rule)" : ""}${record.out_of_time ? "; stopped at its time budget" : ""}`;
  return items;
}

/** Collect one site and return the dropped items too (used by the orchestrator through `collect`). */
export async function collectSite(task: SourceTask, context: ConnectorContext) {
  const dropped: DroppedItem[] = [];
  const collected = await runCollector(task, context, (record) => readSite(task, context, record, dropped));
  return { ...collected, dropped };
}
webConnector.collect = collectSite;
