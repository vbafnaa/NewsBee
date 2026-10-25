/**
 * School athletics from reviewed state athletic-association feeds (config/state-sources.json
 * `athletics`, added only after robots.txt and terms review). Team-level only: an item is
 * kept when its headline is about a sport and names the location (local) or a configured
 * place within 50 km (nearby). Headlines about individual students are dropped, and feed
 * summaries are never republished, so no student is named.
 */
import type { CollectedEvent, Connector, ConnectorContext, SourceResult, SourceTask } from "../types";
import { parseNewsFeed, publishedText, sensitive, type FeedItem } from "../wider/adapters";
import { mentions, validateStateSources, type Region } from "../wider/regions";
import { loadSourceConfig } from "../../storage/source-configs";
import { fetchBytes, locationRegion, reportingSince, runCollector, skip, SourceUnavailable, type Tier } from "../parents/shared";
import { CHAMPIONSHIP } from "../../ranking/parents";

const ACCEPT_FEED = "application/rss+xml, application/atom+xml, application/xml, text/xml";
const SPORTS: Array<[string, RegExp]> = [
  ["Football", /\bfootball\b/i], ["Basketball", /\bbasketball\b/i], ["Soccer", /\bsoccer\b/i], ["Volleyball", /\bvolleyball\b/i],
  ["Baseball", /\bbaseball\b/i], ["Softball", /\bsoftball\b/i], ["Track and field", /\btrack\b/i], ["Cross country", /\bcross[- ]country\b/i],
  ["Swimming and diving", /\bswim\w*|\bdiving\b/i], ["Wrestling", /\bwrestl\w*/i], ["Tennis", /\btennis\b/i], ["Golf", /\bgolf\b/i],
  ["Gymnastics", /\bgymnastics\b/i], ["Bowling", /\bbowling\b/i], ["Lacrosse", /\blacrosse\b/i], ["Water polo", /\bwater polo\b/i],
  ["Cheer and dance", /\bcheer\w*|\bdance\b/i],
];
/** Headlines centred on one student (awards, signings, commitments, records) are never used. */
export const INDIVIDUAL = /\b(athletes?|players?|students?|seniors?|juniors?|signs?|signed|signing|commits?|committed|commitment|scholarship|named|award\w*|honou?r\w*|mvp|all[- ](?:state|league|american|conference)|record[- ]breaking|sets? .*record|of the (?:week|month|year)|selected|executive board|appointed|hired|coach)\b/i;
const ADMIN = /\b(tickets?|handbook|polic(?:y|ies)|brand guide|welcome|test article|amendments?|rules?|eligibility|meeting|minutes|survey|webinar|job|employment)\b/i;

export type AthleticsFeed = { name: string; feed: string };

export const athleticsConnector: Connector = {
  type: "athletics",
  sources(location) {
    return location.state ? [{ source_id: `athletics:${location.state.toLowerCase()}`, name: "School athletics (state association)", type: "athletics" }] : [];
  },
  collect(task, context) { return runCollector(task, context, (record) => collectAthletics(task, context, record)); },
};

export function sportOf(title: string) { return SPORTS.find(([, pattern]) => pattern.test(title))?.[0] ?? null; }
/** Team-level sports headline, or the reason it is not. */
export function headlineProblem(title: string): string | null {
  if (INDIVIDUAL.test(title)) return "individual_student";
  if (ADMIN.test(title)) return "administrative";
  if (sensitive(title)) return "sensitive";
  return sportOf(title) ? null : "not_sports";
}
/** Only the headline decides relevance: summaries can name students and are never read. */
export function headlineTier(region: Region, title: string): Tier | null {
  const local = [region.town, ...region.aliases, ...(region.community_terms ?? [])];
  if (local.some((name) => mentions(title, name))) return "local";
  return region.community_terms ? null : region.nearby.some((name) => mentions(title, name)) ? "nearby" : null;
}

async function stateFeeds(context: ConnectorContext, state: string): Promise<AthleticsFeed[]> {
  const states = validateStateSources(await loadSourceConfig(context.db, context.settings.root, "state-sources"));
  return states[state]?.athletics ?? [];
}

async function collectAthletics(task: SourceTask, context: ConnectorContext, record: SourceResult): Promise<CollectedEvent[]> {
  const region = await locationRegion(context);
  const feeds = await stateFeeds(context, region.state_code);
  if (!feeds.length) throw new SourceUnavailable("no_feed", `No reviewed athletics feed for ${region.state_code}; add one to state-sources.json after a robots.txt and terms review`);
  const since = reportingSince(context);
  const events: CollectedEvent[] = [];
  const checked: string[] = [];
  for (const feed of feeds) {
    record.feed_url ??= feed.feed;
    checked.push(feed.feed);
    let items: FeedItem[];
    try { items = parseNewsFeed(await fetchBytes(context, feed.feed, ACCEPT_FEED)); }
    catch (error) {
      if (feeds.length > 1 && error instanceof SourceUnavailable) { skip(record, `feed_${error.status}`); continue; }
      throw error;
    }
    for (const item of items) {
      if (item.published_day < since || item.published_day > context.today) { record.skipped_outside_window += 1; continue; }
      const problem = headlineProblem(item.title);
      if (problem) { skip(record, problem); continue; }
      const tier = headlineTier(region, item.title);
      if (!tier) { skip(record, "outside_area"); continue; }
      events.push(athleticsFacts(item, feed, tier, region.town));
    }
  }
  record.feed_kind = "athletics_rss"; record.pages_checked = checked; record.website = checked[0] ? new URL(checked[0]).origin : null;
  events.sort((a, b) => Number(a.tier !== "local") - Number(b.tier !== "local") || String(b.event_date).localeCompare(String(a.event_date)));
  const kept = events;
  record.detail = `${feeds.length} reviewed feed${feeds.length === 1 ? "" : "s"}; ${kept.length} team headlines naming ${region.town} or a place within 50 km since ${since}`;
  return kept;
}

export function athleticsFacts(item: FeedItem, feed: AthleticsFeed, tier: Tier, town: string): CollectedEvent {
  const sport = sportOf(item.title) ?? "School sports";
  return {
    source_event_id: item.id, title: item.title, event_date: item.published_day, schedule_text: publishedText(item.published_day),
    venue: feed.name, room: null, source_url: item.link,
    description: `${feed.name} published this update on ${publishedText(item.published_day)}.`,
    kind: "school_sports", tier, section: sport,
    signals: { championship: CHAMPIONSHIP.test(item.title) ? 1 : 0, nearby: tier === "local" ? 0 : 1 },
    area: town,
  };
}
