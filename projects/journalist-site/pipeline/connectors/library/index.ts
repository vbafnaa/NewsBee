import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";
import { HttpStatusError } from "../../core/http";
import type { Connector, CollectedEvent, CollectedSource, LocationProfile, SourceTask, SourceResult } from "../types";
import { sourceResult } from "../types";
import { checkSize, FeedFormatError, httpsLink, MAX_FEED_BYTES, type EventFacts } from "../common";
import { chooseLinks, moreEvents, pageLinks } from "../ai-discovery";
import { DiscoveryBlockedError } from "../fetcher";
import { matchBranch } from "../../communities/venues";
import * as biblio from "./bibliocommons";
import { parseIcal, parseJsonLd, parseTrumba, jsonLdBlocks, findEvents } from "./parsers";
import type { ConnectorContext, CachedLinks } from "../types";

export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_CANDIDATE_PAGES = 3;
const ACCEPT_HTML = "text/html";
const ACCEPT_FEED = "application/rss+xml, text/calendar, text/html";
const TRUMBA_SPUD = /Trumba\.addSpud\(\s*\{[\s\S]*?webName\s*:\s*["']([A-Za-z0-9_-]{1,64})["']/;
const EVENT_LINK = /event|calendar/i;
type Feed = { kind: "trumba_rss" | "ical" | "jsonld" | "bibliocommons"; url: string; page: string };
type Outcome = { status: string; detail: string; feed: Feed | null; pages_checked: string[]; events: EventFacts[]; skipped: Record<string, number>; response: Uint8Array | null; method: "rules" | "ai" | "cache" };

class LinkParser {
  links: Array<{ tag: "a" | "link"; attrs: Record<string, string>; text: string }> = [];
  private anchor: { tag: "a"; attrs: Record<string, string>; text: string } | null = null;
  parser = new Parser({
    onopentag: (tag, attrs) => {
      const normalized = Object.fromEntries(Object.entries(attrs).map(([key, value]) => [key, value ?? ""]));
      if (tag === "link") this.links.push({ tag, attrs: normalized, text: "" });
      else if (tag === "a") { this.anchor = { tag, attrs: normalized, text: "" }; this.links.push(this.anchor); }
    },
    ontext: (data) => { if (this.anchor) this.anchor.text += data; },
    onclosetag: (tag) => { if (tag === "a") this.anchor = null; },
  }, { decodeEntities: true });
  constructor(html: string) { this.parser.write(html); this.parser.end(); }
}

export function findFeed(html: string, page: string): Feed | null {
  const trumba = TRUMBA_SPUD.exec(html);
  if (trumba) return { kind: "trumba_rss", url: `https://www.trumba.com/calendars/${trumba[1]}.rss?weeks=1`, page };
  for (const { tag, attrs } of new LinkParser(html).links) {
    const href = attrs.href?.trim() ?? "";
    const calendar = (tag === "link" && (attrs.type ?? "").toLowerCase() === "text/calendar") || (tag === "a" && /\.ics(?:\?|$)/i.test(href));
    if (!href || !calendar) continue;
    let normalized = href.replace(/^webcal:\/\//i, "https://");
    try { normalized = new URL(normalized, page).toString(); } catch { continue; }
    const url = httpsLink(normalized);
    if (url) return { kind: "ical", url, page };
  }
  if (jsonLdBlocks(html).some((block) => findEvents(block).length)) return { kind: "jsonld", url: page, page };
  return null;
}

export function candidatePages(html: string, page: string): string[] {
  const site = new URL(page).hostname.replace(/^www\./i, "");
  const found: string[] = [];
  for (const { tag, attrs, text } of new LinkParser(html).links) {
    if (tag !== "a") continue;
    let url: string | null = null;
    try { url = httpsLink(new URL(attrs.href ?? "", page).toString()); } catch { /* invalid href */ }
    if (!url) continue;
    const parsed = new URL(url), host = parsed.hostname.replace(/^www\./i, "");
    const sameSite = host === site || host.endsWith(`.${site}`);
    if (sameSite && (EVENT_LINK.test(parsed.pathname) || EVENT_LINK.test(text))) found.push(url.split("#")[0]);
  }
  const unique = [...new Set(found)].sort((a, b) => Number(!EVENT_LINK.test(new URL(a).pathname)) - Number(!EVENT_LINK.test(new URL(b).pathname)));
  return unique.filter((url) => url.replace(/\/$/, "") !== page.replace(/\/$/, "")).slice(0, MAX_CANDIDATE_PAGES);
}

async function bibliocommonsFeed(context: ConnectorContext, html: string, page: string): Promise<Feed | null> {
  const slug = biblio.findSlug(html);
  if (!slug) return null;
  const url = biblio.GATEWAY.replace("{slug}", slug);
  const probe = await context.fetcher.get(`${url}/events/search?limit=1`, MAX_FEED_BYTES, "application/json");
  return biblio.eventCount(probe[1]) ? { kind: "bibliocommons", url, page } : null;
}

function retryable(error: HttpStatusError) { return error.status === 429 || error.status >= 500; }
async function rulesDiscovery(context: ConnectorContext, homepage: { url: string; html: string }): Promise<{ feed: Feed | null; checked: string[] }> {
  const checked = [homepage.url];
  let feed = findFeed(homepage.html, homepage.url);
  if (feed && feed.kind !== "jsonld") return { feed, checked };
  feed = await bibliocommonsFeed(context, homepage.html, homepage.url) ?? feed;
  if (feed) return { feed, checked };
  for (const candidate of candidatePages(homepage.html, homepage.url)) {
    try {
      const [final, bytes] = await context.fetcher.get(candidate, MAX_PAGE_BYTES, ACCEPT_HTML);
      checked.push(final);
      feed = findFeed(new TextDecoder().decode(bytes), final);
      if (feed) return { feed, checked };
    } catch (error) {
      if (error instanceof HttpStatusError && retryable(error)) throw error;
      if (error instanceof DiscoveryBlockedError || error instanceof FeedFormatError || error instanceof HttpStatusError) {
        checked.push(`${candidate} (${error.message})`); continue;
      }
      throw error;
    }
  }
  return { feed: null, checked };
}

async function aiDiscovery(context: ConnectorContext, homepage: { url: string; html: string }): Promise<{ feed: Feed | null; checked: string[] }> {
  if (!context.model) return { feed: null, checked: [] };
  const choices = await chooseLinks(context.model, "library event calendar pages", homepage.url, pageLinks(homepage.html, homepage.url), context.log);
  const checked: string[] = [];
  for (const candidate of choices) {
    try {
      const [final, bytes] = await context.fetcher.get(candidate, MAX_PAGE_BYTES, ACCEPT_HTML);
      checked.push(final);
      const feed = findFeed(new TextDecoder().decode(bytes), final);
      if (feed) return { feed, checked };
    } catch (error) {
      if (error instanceof HttpStatusError && retryable(error)) throw error;
      if (error instanceof DiscoveryBlockedError || error instanceof FeedFormatError || error instanceof HttpStatusError) { checked.push(`${candidate} (${error.message})`); continue; }
      throw error;
    }
  }
  return { feed: null, checked };
}

async function parseFeed(context: ConnectorContext, feed: Feed, system: LocationProfile["systems"][number]): Promise<{ events: EventFacts[]; skipped: Record<string, number>; response: Uint8Array; detail?: string }> {
  if (feed.kind === "bibliocommons") {
    const slug = new URL(feed.url).pathname.split("/").filter(Boolean).at(-1)!;
    const result = await biblio.fetchEvents(async (url) => (await context.fetcher.get(url, MAX_FEED_BYTES, "application/json"))[1], slug, context.window,
      (venue) => matchBranch(venue, system.branches) !== null);
    return { ...result };
  }
  const [, content] = await context.fetcher.get(feed.url, MAX_FEED_BYTES, ACCEPT_FEED);
  checkSize(content);
  const parsed = feed.kind === "ical" ? parseIcal(content) : feed.kind === "jsonld" ? parseJsonLd(content) : parseTrumba(content);
  return { ...parsed, response: content };
}

async function discoverAndParse(context: ConnectorContext, website: string, system: LocationProfile["systems"][number], method: "rules" | "ai"): Promise<Outcome> {
  const [homeUrl, homeBytes] = await context.fetcher.get(website, MAX_PAGE_BYTES, ACCEPT_HTML);
  const homepage = { url: homeUrl, html: new TextDecoder().decode(homeBytes) };
  const discovery = method === "rules" ? await rulesDiscovery(context, homepage) : await aiDiscovery(context, homepage);
  const checked = [homeUrl, ...discovery.checked.filter((url) => url !== homeUrl)];
  if (!discovery.feed) return { status: "no_feed", detail: "No supported event feed found", feed: null, pages_checked: checked, events: [], skipped: {}, response: null, method };
  try {
    const parsed = await parseFeed(context, discovery.feed, system);
    context.log.info("library_feed_parsed", { kind: discovery.feed.kind, url: discovery.feed.url, events: parsed.events.length, skipped: parsed.skipped });
    return { status: "ingested", detail: parsed.detail ?? (discovery.feed.kind === "bibliocommons" ? "bibliocommons feed" : `${discovery.feed.kind} feed`), feed: discovery.feed, pages_checked: checked,
      events: parsed.events, skipped: parsed.skipped, response: parsed.response, method };
  } catch (error) {
    if (error instanceof HttpStatusError && retryable(error)) throw error;
    if (error instanceof DiscoveryBlockedError) return { status: "blocked", detail: error.message, feed: discovery.feed, pages_checked: checked, events: [], skipped: {}, response: null, method };
    if (error instanceof FeedFormatError || error instanceof HttpStatusError) return { status: "failed", detail: `${error.name}: ${error.message}`, feed: discovery.feed, pages_checked: checked, events: [], skipped: {}, response: null, method };
    throw error;
  }
}

async function cachedRun(context: ConnectorContext, cached: CachedLinks, system: LocationProfile["systems"][number]): Promise<Outcome> {
  const feed = { kind: cached.kind as Feed["kind"], url: cached.url, page: cached.page ?? cached.url };
  if (!["trumba_rss", "ical", "jsonld", "bibliocommons"].includes(feed.kind)) throw new FeedFormatError(`Unsupported cached library feed kind: ${cached.kind}`);
  const parsed = await parseFeed(context, feed, system);
  return { status: "ingested", detail: parsed.detail ?? (feed.kind === "bibliocommons" ? "bibliocommons feed" : `${feed.kind} feed`), feed,
    pages_checked: [feed.page], events: parsed.events, skipped: parsed.skipped, response: parsed.response, method: "cache" };
}

function keptEvents(outcome: Outcome, system: LocationProfile["systems"][number], window: [string,string]) {
  const events: CollectedEvent[] = [];
  let skippedOutside = 0;
  const unmatched = new Map<string, number>();
  for (const fact of outcome.events) {
    if (fact.event_date < window[0] || fact.event_date > window[1]) { skippedOutside += 1; continue; }
    const branch = matchBranch(fact.venue, system.branches);
    if (!branch) { unmatched.set(fact.venue, (unmatched.get(fact.venue) ?? 0) + 1); continue; }
    events.push({ ...fact, branch });
  }
  return { events, skippedOutside, unmatched };
}
function mostCommon(unmatched: Map<string, number>) {
  return Object.fromEntries([...unmatched.entries()].sort((a,b) => b[1]-a[1]).slice(0,10));
}
function toCollected(system: LocationProfile["systems"][number], outcome: Outcome, context: ConnectorContext): CollectedSource {
  const kept = keptEvents(outcome, system, context.window);
  const unmatchedCount = [...kept.unmatched.values()].reduce((sum, count) => sum + count, 0);
  if (unmatchedCount) context.log.info("library_events_skipped_other_venues", { fscskey: system.fscskey, venues: mostCommon(kept.unmatched) });
  const sourceId = `library:${system.fscskey}`;
  const result: SourceResult = sourceResult(sourceId, system.name, outcome.status, outcome.detail, {
    website: system.website ?? null,
    feed_kind: outcome.feed?.kind ?? null,
    feed_url: outcome.feed?.url ?? null,
    pages_checked: outcome.pages_checked,
    response_sha256: outcome.response?.byteLength ? createHash("sha256").update(outcome.response).digest("hex") : null,
    event_count: kept.events.length,
    skipped_other_venues: unmatchedCount,
    skipped_outside_window: kept.skippedOutside,
    skipped_unusable: outcome.skipped,
    unmatched_venues: mostCommon(kept.unmatched),
    link_discovery: { method: outcome.method },
  });
  context.log.info("library_system_result", { source_id: sourceId, status: outcome.status, events: kept.events.length,
    skipped_other_venues: unmatchedCount, skipped_outside_window: kept.skippedOutside, detail: outcome.detail });
  return { result, events: kept.events };
}

async function runSystem(system: LocationProfile["systems"][number], context: ConnectorContext): Promise<CollectedSource> {
  if (!system.website) return toCollected(system, { status: "unresolved_website", detail: "No official website recorded at onboarding", feed: null, pages_checked: [], events: [], skipped: {}, response: null, method: "rules" }, context);
  const sourceId = `library:${system.fscskey}`;
  const cache = await context.linkCache.get(context.location.id, sourceId);
  if (cache) {
    try {
      const cached = await cachedRun(context, cache, system);
      const collected = toCollected(system, cached, context);
      if (collected.events.length) return collected;
    } catch (error) {
      if (error instanceof HttpStatusError && retryable(error)) throw error;
      if (!(error instanceof Error)) throw error;
    }
    await context.linkCache.invalidate(context.location.id, sourceId);
  }
  try {
    const rules = await discoverAndParse(context, system.website, system, "rules");
    let selected = toCollected(system, rules, context);
    if (rules.status === "ingested" && rules.feed) await context.linkCache.put({ location_id: context.location.id, source_id: sourceId, kind: rules.feed.kind, url: rules.feed.url, page: rules.feed.page, method: "rules" });
    if (context.model) {
      const ai = await discoverAndParse(context, system.website, system, "ai");
      const aiCollected = toCollected(system, ai, context);
      selected = moreEvents(selected, aiCollected);
      if (selected.result.link_discovery?.method === "ai" && ai.feed) await context.linkCache.put({ location_id: context.location.id, source_id: sourceId, kind: ai.feed.kind, url: ai.feed.url, page: ai.feed.page, method: "ai" });
    }
    if (selected.result.status === "ingested" && !selected.events.length) await context.linkCache.invalidate(context.location.id, sourceId);
    return selected;
  } catch (error) {
    if (error instanceof DiscoveryBlockedError) return toCollected(system, { status: "blocked", detail: error.message, feed: null, pages_checked: [], events: [], skipped: {}, response: null, method: "rules" }, context);
    if (error instanceof HttpStatusError && retryable(error)) throw error;
    if (error instanceof FeedFormatError || error instanceof HttpStatusError) return toCollected(system, { status: "failed", detail: `${error.name}: ${error.message}`, feed: null, pages_checked: [], events: [], skipped: {}, response: null, method: "rules" }, context);
    throw error;
  }
}

export const libraryConnector: Connector = {
  type: "library",
  sources(location: LocationProfile): SourceTask[] {
    return location.systems.map((system) => ({ source_id: `library:${system.fscskey}`, name: system.name, type: "library", params: { fscskey: system.fscskey } }));
  },
  async collect(task: SourceTask, context: ConnectorContext) {
    const key = task.params?.fscskey ?? task.source_id.slice("library:".length);
    const system = context.location.systems.find((candidate) => candidate.fscskey === key);
    if (!system) return { result: sourceResult(task.source_id, task.name, "failed", `Library system not found: ${key}`), events: [] };
    return runSystem(system, context);
  },
};
