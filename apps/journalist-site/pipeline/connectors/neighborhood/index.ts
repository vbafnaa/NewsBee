/**
 * Neighborhood sites found automatically: collects every feed and calendar that source
 * discovery found for the location (communities/source-discovery.ts), rediscovering when the
 * stored list is older than a week. An organization's own feed counts as local; a shared
 * city-wide calendar keeps only events that name the area or a place inside it.
 */
import { createHash } from "node:crypto";
import { currentDiscovery, type DiscoveredSource } from "../../communities/source-discovery";
import { addDays, httpsLink, MAX_FEED_BYTES } from "../common";
import { parseIcal, parseJsonLd, parseTrumba } from "../library/parsers";
import { parseNewsFeed, publishedText, sensitive, sponsoredItem } from "../wider/adapters";
import { compareKeys, type Story } from "../../editions/stories";
import { isUpcoming } from "../../../../../shared/newsletter-layout";
import { sourceResult, type CollectedEvent, type CollectedSource, type Connector, type ConnectorContext } from "../types";
import { logDiscoveredFeeds } from "../../orchestration/source-log";

export const NEWS_LOOKBACK_DAYS = 14;
const ACCEPT_FEED = "application/rss+xml,application/atom+xml,application/xml,text/xml,text/calendar,*/*;q=0.5";
const CONCURRENCY = 6;

export type FeedOutcome = { source: DiscoveredSource; status: "ok" | "failed"; items: number; detail: string };

function mentions(text: string, terms: string[]) {
  const haystack = text.toLowerCase();
  return terms.some((term) => term.length >= 3 && haystack.includes(term.toLowerCase()));
}

function evidence(source: DiscoveredSource) {
  return { method: "source_location", matches: [source.name], detail: `Published by ${source.name}, found inside the area` };
}

/** News items from the last two weeks; the organization is in the area, so every item is local. */
export function newsFacts(source: DiscoveredSource, bytes: Uint8Array, today: string): CollectedEvent[] {
  const since = addDays(today, -NEWS_LOOKBACK_DAYS);
  return parseNewsFeed(bytes).flatMap((item) => {
    const link = httpsLink(item.link);
    if (!link || item.published_day < since || item.published_day > today) return [];
    if (sensitive(item.title, item.summary) || sponsoredItem(item)) return [];
    return [{
      source_event_id: createHash("sha256").update(`${source.feed_url}\u0000${item.id}`).digest("hex").slice(0, 16),
      title: item.title, event_date: item.published_day, schedule_text: publishedText(item.published_day), venue: source.name,
      source_url: link, description: item.summary, kind: "state_news", tier: "local", section: source.category,
      signals: { publisher: source.name, discovered: true }, community_relevance: evidence(source),
    } as CollectedEvent];
  });
}

/** Calendar events in the edition window; shared calendars keep only events naming the area. */
export function calendarFacts(source: DiscoveredSource, bytes: Uint8Array, window: [string, string], areaTerms: string[]): CollectedEvent[] {
  const parsed = source.feed_kind === "trumba" ? parseTrumba(bytes) : source.feed_kind === "jsonld" ? parseJsonLd(bytes) : parseIcal(bytes, { venue: source.name, link: source.site });
  return parsed.events.flatMap((event) => {
    if (event.event_date < window[0] || event.event_date > window[1]) return [];
    if (source.scope === "shared" && !mentions(`${event.venue} ${event.title}`, areaTerms)) return [];
    if (sensitive(event.title, event.description)) return [];
    const link = httpsLink(event.source_url) ?? httpsLink(source.site);
    if (!link) return [];
    return [{
      ...event, source_event_id: `${source.id}:${event.source_event_id}`, source_url: link, kind: "event", tier: "local",
      section: source.category, signals: { publisher: source.name, discovered: true }, community_relevance: evidence(source),
    } as CollectedEvent];
  });
}

async function collectFeed(context: ConnectorContext, source: DiscoveredSource, areaTerms: string[]): Promise<{ outcome: FeedOutcome; facts: CollectedEvent[] }> {
  try {
    const [, bytes] = await context.fetcher.get(source.feed_url, MAX_FEED_BYTES, source.feed_kind === "jsonld" ? "text/html,application/xhtml+xml" : ACCEPT_FEED);
    const facts = source.feed_kind === "rss" ? newsFacts(source, bytes, context.today) : calendarFacts(source, bytes, context.window, areaTerms);
    return { outcome: { source, status: "ok", items: facts.length, detail: "" }, facts };
  } catch (error) {
    return { outcome: { source, status: "failed", items: 0, detail: error instanceof Error ? error.message : String(error) }, facts: [] };
  }
}

export async function collectNeighborhood(context: ConnectorContext, taskId: string, taskName: string): Promise<CollectedSource> {
  const discovery = await currentDiscovery(context.db, context.transport, context.location);
  const queue = [...discovery.sources];
  const outcomes: FeedOutcome[] = [];
  const facts: CollectedEvent[] = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const result = await collectFeed(context, queue.shift()!, discovery.area_terms);
      outcomes.push(result.outcome);
      facts.push(...result.facts);
    }
  }));
  logDiscoveredFeeds(context.location.name, discovery, outcomes);
  const ok = outcomes.filter((outcome) => outcome.status === "ok").length;
  const status = !discovery.sources.length ? "no_feed" : ok ? "ingested" : "failed";
  const detail = discovery.sources.length
    ? `${ok} of ${discovery.sources.length} automatically found feeds read from ${discovery.places.length} places; ${facts.length} items`
    : `No readable feeds found among ${discovery.places.length} places${discovery.gaps.length ? `: ${discovery.gaps.join("; ")}` : ""}`;
  return {
    result: sourceResult(taskId, taskName, status, detail, {
      feed_kind: "discovered",
      pages_checked: discovery.sources.map((source) => source.feed_url),
      event_count: facts.length,
      skipped_unusable: { feeds_failed: outcomes.length - ok },
    }),
    events: facts,
  };
}

/** Upcoming events soonest first, then news newest first. */
export function rank(stories: Story[]) {
  const upcoming = stories.filter((story) => isUpcoming(story.kind)).sort((a, b) => compareKeys([a.first.event_date, a.title], [b.first.event_date, b.title]));
  const news = stories.filter((story) => !isUpcoming(story.kind)).sort((a, b) => compareKeys([b.first.event_date, a.title], [a.first.event_date, b.title]));
  return [...upcoming, ...news];
}

export const neighborhoodConnector: Connector = {
  type: "neighborhood",
  sources() {
    return [{ source_id: "neighborhood:discovered", name: "Neighborhood sites found automatically", type: "neighborhood" }];
  },
  async collect(task, context) {
    return collectNeighborhood(context, task.source_id, task.name);
  },
};
