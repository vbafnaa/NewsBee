import { createHash } from "node:crypto";
import { COLLECTIONS } from "../../storage/mongo";
import { loadSourceConfig } from "../../storage/source-configs";
import { HttpStatusError } from "../../core/http";
import { FeedFormatError, MAX_FEED_BYTES } from "../common";
import { DiscoveryBlockedError } from "../fetcher";
import { sourceResult, type CollectedEvent, type CollectedSource, type Connector, type ConnectorContext, type LocationProfile, type SourceTask } from "../types";
import { chooseLinks, moreEvents, pageLinks } from "../ai-discovery";
import { blueskySearchUrl, blueskyTrendsUrl, countBlueskyMentions, parseBlueskyTrends, parseNewsFeed, parseUsgs, parseWikiDaily, parseWikiTop, publishedText, sensitive, sha256, spike, usgsQueryUrl, wikiArticleUrl, wikiDailyUrl, wikiLabel, wikiRecentDays, wikiTopUrl, wikiTopic, type NewsFacts } from "./adapters";
import { itemTier, mentions, NEARBY_KM, resolveRegion, section, validateStateSources, type Region } from "./regions";
import { trendContext, reportedDescription, type TrendContext } from "./trend-context";

const ACCEPT_JSON = "application/json";
const ACCEPT_FEED = "application/rss+xml, application/atom+xml, application/xml, text/xml";
const PAST_DAYS = 14, RADIUS_KM = NEARBY_KM, QUERY_MAGNITUDE = 2.5, MIN_MAGNITUDE = 3, MIN_FELT = 10, MAX_ITEMS = 5;
const OFFSET = /^\s*\d+(?:\.\d+)?\s*km\s+[NSEW]{1,3}\s+of\s+/i;
const formatDate = (date: Date) => date.toISOString().slice(0, 10);
const dateDelta = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
function errName(error: unknown) { return error instanceof Error ? error.constructor.name : "Error"; }
function errMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function isHttpError(error: unknown) { return error instanceof HttpStatusError; }
function emptyFailure(task: SourceTask, context: ConnectorContext, error: unknown): CollectedSource {
  const detail = `${errName(error)}: ${errMessage(error)}`;
  context.log.error("wider_source_crashed", { source_id: task.source_id, error: detail });
  return { result: sourceResult(task.source_id, task.name, "failed", detail), events: [] };
}
function makeFacts(values: NewsFacts): CollectedEvent { return values as CollectedEvent; }
function createNewsFacts(fields: NewsFacts): CollectedEvent { return makeFacts(fields); }

export const hazardsConnector: Connector = {
  type: "hazards",
  sources(location: LocationProfile, settings) {
    return settings.widerSources ? [{ source_id: "hazards:usgs", name: "USGS earthquakes nearby", type: "hazards" }] : [];
  },
  async collect(task, context) {
    try { return await collectHazards(task, context); } catch (error) { return emptyFailure(task, context, error); }
  },
};

async function collectHazards(task: SourceTask, context: ConnectorContext): Promise<CollectedSource> {
  const place = resolveRegion(context.location, validateStateSources(await loadSourceConfig(context.db, context.settings.root, "state-sources")));
  const record = sourceResult(task.source_id, task.name, "ingested", "", { feed_kind: "usgs" });
  if (place.latitude === null || place.longitude === null || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) {
    record.status = "no_feed"; record.detail = "Location has no coordinates"; return { result: record, events: [] };
  }
  const start = dateDelta(context.today, -PAST_DAYS);
  const url = usgsQueryUrl(place.latitude, place.longitude, start, RADIUS_KM, QUERY_MAGNITUDE);
  record.feed_url = url;
  let content: Uint8Array;
  try { [, content] = await context.fetcher.get(url, MAX_FEED_BYTES, ACCEPT_JSON); }
  catch (error) {
    if (error instanceof FeedFormatError || isHttpError(error) || error instanceof DiscoveryBlockedError) { record.status = error instanceof DiscoveryBlockedError ? "blocked" : "failed"; record.detail = `${errName(error)}: ${errMessage(error)}`; return { result: record, events: [] }; }
    throw error;
  }
  let all: ReturnType<typeof parseUsgs>;
  try { all = parseUsgs(content, place.latitude, place.longitude); }
  catch (error) { record.status = "failed"; record.detail = `${errName(error)}: ${errMessage(error)}`; return { result: record, events: [] }; }
  const near = all.filter((q) => q.distance_km <= RADIUS_KM);
  const kept = near.filter((q) => q.magnitude >= MIN_MAGNITUDE || q.felt >= MIN_FELT);
  const skipped: Record<string, number> = { too_far: all.length - near.length, below_threshold: near.length - kept.length };
  kept.sort((a, b) => b.magnitude - a.magnitude || a.distance_km - b.distance_km);
  const groups = new Map<string, typeof kept>();
  for (const quake of kept) {
    const reference = quake.place.replace(OFFSET, "").trim();
    const key = reference.toLowerCase() || quake.id;
    groups.set(key, [...(groups.get(key) ?? []), quake]);
  }
  const grouped = [...groups.values()].map((group) => group.sort((a, b) => b.magnitude - a.magnitude || a.distance_km - b.distance_km || b.felt - a.felt));
  const events = grouped.slice(0, MAX_ITEMS).map((quakes) => quakes.length === 1 ? quakeFacts(quakes[0], place.town) : mergedQuakeFacts(quakes, place.town));
  const merged = kept.length - groups.size;
  if (merged) skipped.merged_same_place = merged;
  record.detail = `${all.length} earthquakes of magnitude ${QUERY_MAGNITUDE}+ within ${RADIUS_KM} km in ${PAST_DAYS} days; ${kept.length} noticeable in ${events.length} stories`;
  record.response_sha256 = sha256(content); record.event_count = events.length;
  record.skipped_unusable = Object.fromEntries(Object.entries(skipped).filter(([, count]) => count));
  context.log.info("hazards_result", { source_id: task.source_id, quakes: all.length, kept: events.length });
  return { result: record, events };
}

function reviewNote(quakes: Array<{ reviewed: boolean }>) {
  if (quakes.every((q) => q.reviewed)) return ` A USGS seismologist has reviewed the reading${quakes.length > 1 ? "s" : ""}.`;
  if (quakes.length === 1) return " The USGS reading is automatic and may be revised.";
  return " Some USGS readings are automatic and may be revised.";
}
function quakeTier(distance: number) { return distance <= 15 ? "local" : "nearby"; }
function quakeFacts(q: ReturnType<typeof parseUsgs>[number], town: string): CollectedEvent {
  const place = q.place || "near the town", day = formatDate(q.time);
  let description = `The U.S. Geological Survey recorded a magnitude ${q.magnitude} earthquake ${place}, at a depth of ${q.depth_km} km, about ${q.distance_km} km from ${town}.`;
  if (q.felt) description += ` ${q.felt} people reported feeling it to the USGS.`;
  description += reviewNote([q]);
  return createNewsFacts({ source_event_id: q.id, title: `Magnitude ${q.magnitude} earthquake ${place}`.trim(), event_date: day, schedule_text: publishedText(day), venue: place,
    source_url: q.url ?? "https://earthquake.usgs.gov/earthquakes/map/", description, kind: "earthquake", tier: quakeTier(q.distance_km), section: "Earthquakes nearby",
    signals: { magnitude: q.magnitude, distance_km: q.distance_km, felt: q.felt, depth_km: q.depth_km } });
}
function mergedQuakeFacts(quakes: ReturnType<typeof parseUsgs>, town: string): CollectedEvent {
  const strongest = quakes[0], reference = strongest.place.replace(OFFSET, "").trim() || "the same area";
  const newest = formatDate(new Date(Math.max(...quakes.map((q) => q.time.getTime()))));
  const closest = Math.min(...quakes.map((q) => q.distance_km)), felt = quakes.reduce((sum, q) => sum + q.felt, 0);
  const listed = [...quakes].sort((a, b) => a.time.getTime() - b.time.getTime()).map((q) => `magnitude ${q.magnitude} on ${publishedText(formatDate(q.time))}, ${q.place}, at a depth of ${q.depth_km} km${q.felt ? `, felt by ${q.felt} people` : ""}`).join("; ");
  let description = `The U.S. Geological Survey recorded ${quakes.length} earthquakes near ${reference}, about ${closest} km from ${town}: ${listed}.`;
  if (felt) description += ` In total, ${felt} people reported feeling them to the USGS.`;
  description += reviewNote(quakes);
  return createNewsFacts({ source_event_id: quakes.map((q) => q.id).sort().join("+"), title: `${quakes.length} earthquakes up to magnitude ${strongest.magnitude} near ${reference}`,
    event_date: newest, schedule_text: publishedText(newest), venue: reference, source_url: strongest.url ?? "https://earthquake.usgs.gov/earthquakes/map/", description,
    kind: "earthquake", tier: quakeTier(closest), section: "Earthquakes nearby", signals: { magnitude: strongest.magnitude, distance_km: closest, felt, depth_km: strongest.depth_km, count: quakes.length } });
}

const MAX_PER_NEWSROOM = 25;
const NEWS_LOOKBACK_DAYS = 14;
export const stateNewsConnector: Connector = {
  type: "statenews",
  sources(_location, settings) { return settings.widerSources ? [{ source_id: "statenews", name: "State newsrooms", type: "statenews" }] : []; },
  async collect(task, context) {
    try { return await collectStateNews(task, context); } catch (error) { return emptyFailure(task, context, error); }
  },
};

async function collectStateNews(task: SourceTask, context: ConnectorContext): Promise<CollectedSource> {
  const states = validateStateSources(await loadSourceConfig(context.db, context.settings.root, "state-sources"));
  const place = resolveRegion(context.location, states);
  const manualFeed = task.params?.manual_feed;
  if (typeof manualFeed === "string") place.newsrooms = [{ name: task.name, feed: manualFeed }];
  const record = sourceResult(task.source_id, task.name, "ingested", "", { feed_kind: "rss" });
  if (!place.configured || place.newsrooms.length === 0) { record.status = "no_feed"; record.detail = `No reviewed newsrooms for ${place.state_code}`; return { result: record, events: [] }; }
  const run = async (newsrooms: Array<{ name: string; feed: string }>) => {
    const facts: CollectedEvent[] = [], skipped: Record<string, number> = {}, failures: Record<string, number> = {};
    const digest = createHash("sha256"); let success = 0;
    for (const newsroom of newsrooms) {
      let content: Uint8Array;
      let items: ReturnType<typeof parseNewsFeed>;
      try { [, content] = await context.fetcher.get(newsroom.feed, MAX_FEED_BYTES, ACCEPT_FEED); items = parseNewsFeed(content); }
      catch (error) {
        const kind = errName(error) === "DiscoveryBlockedError" ? "blocked" : "failed";
        failures[kind] = (failures[kind] ?? 0) + 1;
        record.pages_checked.push(`${newsroom.feed} (${kind === "blocked" ? errMessage(error) : errName(error)})`);
        continue;
      }
      success++; record.pages_checked.push(newsroom.feed); digest.update(content);
      let kept = 0;
      for (const item of items!) {
        const day = item.published_day;
        if (day < dateDelta(context.today, -NEWS_LOOKBACK_DAYS) || day > context.today) {
          skipped.outside_news_window = (skipped.outside_news_window ?? 0) + 1; continue;
        }
        if (sensitive(item.title, item.summary)) { skipped.sensitive_topic = (skipped.sensitive_topic ?? 0) + 1; continue; }
        const tier = itemTier(place, item.title, item.summary, true);
        if (!tier) { skipped.not_near_town = (skipped.not_near_town ?? 0) + 1; continue; }
        if (kept >= MAX_PER_NEWSROOM) { skipped.over_limit = (skipped.over_limit ?? 0) + 1; continue; }
        kept++;
        facts.push(createNewsFacts({ source_event_id: sha256(item.id).slice(0, 16), title: item.title, event_date: day, schedule_text: publishedText(day), venue: newsroom.name,
          source_url: item.link, description: item.summary, kind: "state_news", tier, section: section(place, tier), signals: { publisher: newsroom.name } }));
      }
    }
    const ok = newsrooms.length - Object.values(failures).reduce((a, b) => a + b, 0);
    const status = ok === 0 ? (failures.blocked && !failures.failed ? "blocked" : "failed") : "ingested";
    const tiers = { local: 0, region: 0, nearby: 0 };
    for (const fact of facts) tiers[fact.tier as keyof typeof tiers]++;
    record.status = status;
    record.detail = `${ok}/${newsrooms.length} newsrooms read; ${facts.length} items near ${place.town} (${tiers.local} name the town, ${tiers.region} the county, ${tiers.nearby} a nearby place)`;
    record.response_sha256 = ok ? digest.digest("hex") : null; record.event_count = facts.length;
    record.skipped_unusable = skipped;
    context.log.info("state_news_result", { source_id: task.source_id, status, items: facts.length, tiers, skipped });
    return { result: { ...record, pages_checked: [...record.pages_checked] }, events: facts } as CollectedSource;
  };
  const rules = await run(place.newsrooms);
  if (typeof manualFeed === "string" || !context.model || !context.settings.aiLinkDiscovery) return rules;
  const cached = await context.linkCache.get(context.location.id, task.source_id);
  if (cached) {
    record.pages_checked = [];
    const cachedRun = await run([{ name: cached.kind, feed: cached.url }]);
    if (cachedRun.events.length > 0) {
      const best = moreEvents(rules, cachedRun);
      if (best.events.length > rules.events.length) best.result.link_discovery = { method: "cache" };
      return best;
    }
    await context.linkCache.invalidate(context.location.id, task.source_id);
    record.pages_checked = [];
  }
  const pages = place.newsrooms.flatMap((room) => [room.page, room.website].filter((url): url is string => typeof url === "string" && url.startsWith("https://")).map((url) => ({ room, url })));
  if (!context.model || !context.settings.aiLinkDiscovery || pages.length === 0) return rules;
  const selected: Array<{ name: string; feed: string }> = [];
  for (const { room, url } of pages) {
    try {
      const [, html] = await context.fetcher.getText(url, MAX_FEED_BYTES, "text/html,application/xhtml+xml");
      const links = pageLinks(html, url);
      const linksChosen = await chooseLinks(context.model, "official state newsroom RSS or Atom feeds", url, links, context.log);
      selected.push(...linksChosen.map((feed) => ({ name: room.name, feed })));
    } catch (error) { context.log.warn("state_news_ai_page_failed", { page: url, error }); }
  }
  if (selected.length === 0) return rules;
  record.pages_checked = [];
  const ai = await run(selected);
  if (ai.events.length > 0) await context.linkCache.put({ source_id: task.source_id, location_id: context.location.id, kind: selected[0].name, url: selected[0].feed, page: pages[0]?.url ?? null, method: "ai" });
  return moreEvents(rules, ai);
}

const TOP_DAYS = 3, TOP_LOOKBACK = 6, MAX_MOST_READ = 8, MAX_SOCIAL_LOOKUPS = 3, MIN_RATIO = 2, MIN_RATIO_MOST_READ = 1.5, MIN_VIEWS = 1000, MIN_POSTS = 100, SOCIAL_DAYS = 3;
const EXCLUDED_CATEGORIES = new Set(["politics"]), EXCLUDED_PREFIXES = ["List_of", "Lists_of", "Deaths_in", "Timeline_of", "Index_of"];
const WIKI_MAX_ITEMS = 5;
type WikiTopic = { article: string; about: string | null; origin: "watchlist" | "most_read"; recent_daily_views: number; baseline_daily_views: number; ratio: number; latest_day: string | null; best_rank?: number; social_mentions?: number | null };
type WikiData = { topics: WikiTopic[]; top_days: string[]; errors: string[]; failed: boolean };
type BlueskyCache = { trends?: ReturnType<typeof parseBlueskyTrends>; failed?: boolean; status?: string; error?: string };
async function cacheState<T>(context: ConnectorContext, kind: string, state: string, day: string, build: () => Promise<T & { failed?: boolean }>): Promise<T & { failed?: boolean }> {
  const key = `${kind}:${state}:${day}`;
  const collection = context.db.collection(COLLECTIONS.wideCache);
  await collection.createIndex({ key: 1 }, { unique: true });
  const cached = await collection.findOne<{ key: string; value: T & { failed?: boolean } }>({ key });
  if (cached) return cached.value;
  const value = await build();
  if (!value.failed) {
    try { await collection.replaceOne({ key }, { key, value }, { upsert: true }); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code: number }).code === 11000)) throw error;
      const winner = await collection.findOne<{ key: string; value: T & { failed?: boolean } }>({ key });
      if (winner) return winner.value;
      throw error;
    }
  }
  return value;
}
async function getJson(context: ConnectorContext, url: string) { return (await context.fetcher.get(url, MAX_FEED_BYTES, ACCEPT_JSON))[1]; }
function wikiAllowed(article: string) { return wikiTopic(article) && !EXCLUDED_PREFIXES.some((prefix) => article.startsWith(prefix)) && !sensitive(wikiLabel(article)); }
function stateTied(article: string, place: Region) {
  const title = wikiLabel(article);
  return Boolean(place.place_suffix && title.includes(place.place_suffix)) || place.aliases.some((alias) => mentions(title, alias));
}
async function daily(context: ConnectorContext, article: string, today: string) {
  const [first, last] = wikiRecentDays(today);
  return spike(parseWikiDaily(await getJson(context, wikiDailyUrl(article, first, last))));
}
async function socialCount(context: ConnectorContext, query: string, today: string, days = SOCIAL_DAYS): Promise<number | null> {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - days * 86400000);
  try { return countBlueskyMentions(await getJson(context, blueskySearchUrl(query, since)), since); }
  catch (error) { context.log.info("bluesky_mention_count_unavailable", { query, error: `${errName(error)}: ${errMessage(error)}` }); return null; }
}
function qualifies(topic: WikiTopic) {
  return wikiAllowed(topic.article) && topic.ratio >= (topic.origin === "watchlist" ? MIN_RATIO : MIN_RATIO_MOST_READ) && topic.recent_daily_views >= MIN_VIEWS;
}
function topicTier(topic: WikiTopic, place: Region): "local" | "region" | "nearby" | null {
  const tier = itemTier(place, wikiLabel(topic.article), topic.about, true);
  if (tier === null && place.nearby_topics.some((entry) => entry.article === topic.article)) return "nearby";
  return tier;
}
async function verifiedTrend(context: ConnectorContext, topic: string, wikipediaUrl?: string) {
  const cached = await cacheState<{ report: TrendContext | null }>(context, "trend-context-v1", sha256(topic).slice(0, 16), context.today, async () => {
    const report = await trendContext(context, topic, wikipediaUrl);
    return { report, failed: report === null };
  });
  return cached.report;
}
function topicFacts(topic: WikiTopic, place: Region, report: TrendContext): CollectedEvent {
  const name = wikiLabel(topic.article), views = topic.recent_daily_views, ratio = topic.ratio;
  const reading = `Wikipedia readers viewed the ${name} article about ${views.toLocaleString("en-US")} times a day over the latest three days, ${ratio} times its usual daily readership.`;
  let description = `${reportedDescription(report)} Attention signal (not evidence of cause): ${reading}`;
  if (topic.social_mentions) description += ` Bluesky users mentioned it in ${topic.social_mentions} or more recent posts.`;
  const tier = topicTier(topic, place)!;
  const sectionName = tier === "local" ? "Trending locally" : tier === "region" ? `Trending around ${place.county}` : `Trending near ${place.town}`;
  const day = topic.latest_day ? `${topic.latest_day.slice(0, 4)}-${topic.latest_day.slice(4, 6)}-${topic.latest_day.slice(6, 8)}` : "";
  return createNewsFacts({ source_event_id: sha256(topic.article).slice(0, 16), title: name, event_date: day, schedule_text: publishedText(day), venue: "Wikipedia page views",
    source_url: report.url, description, kind: "trending_topic", tier, section: sectionName,
    trend_context: report, attention_source_url: wikiArticleUrl(topic.article),
    signals: { ratio, recent_daily_views: views, baseline_daily_views: topic.baseline_daily_views, origin: topic.origin, ...(topic.best_rank === undefined ? {} : { best_rank: topic.best_rank }) },
    social_mentions: topic.social_mentions });
}
async function wikiStatewide(context: ConnectorContext, place: Region, today: string): Promise<WikiData> {
  const topics: WikiTopic[] = [], errors: string[] = [], top_days: string[] = [];
  for (const entry of place.watchlist) {
    try { topics.push({ ...await daily(context, entry.article, today), article: entry.article, about: entry.about, origin: "watchlist" }); }
    catch (error) { errors.push(`${entry.article}: ${errName(error)}`); }
  }
  const watched = new Set(place.watchlist.map((entry) => entry.article));
  const mostRead = new Map<string, number>();
  for (let offset = 1; offset <= TOP_LOOKBACK && top_days.length < TOP_DAYS; offset++) {
    const day = dateDelta(today, -offset);
    try {
      for (const item of parseWikiTop(await getJson(context, wikiTopUrl(day)))) {
        if (watched.has(item.article) || !stateTied(item.article, place)) continue;
        mostRead.set(item.article, Math.min(mostRead.get(item.article) ?? item.rank, item.rank));
      }
      top_days.push(day);
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 404) continue;
      errors.push(`top ${day}: ${errName(error)}`);
    }
  }
  const ranked = [...mostRead.entries()].sort((a, b) => a[1] - b[1]).slice(0, MAX_MOST_READ);
  for (const [article, rank] of ranked) {
    try { topics.push({ ...await daily(context, article, today), article, about: null, origin: "most_read", best_rank: rank }); }
    catch (error) { errors.push(`${article}: ${errName(error)}`); }
  }
  const trending = topics.filter(qualifies).sort((a, b) => b.ratio - a.ratio);
  for (const topic of trending.slice(0, MAX_SOCIAL_LOOKUPS)) topic.social_mentions = await socialCount(context, `"${wikiLabel(topic.article)}"`, today);
  const attempted = place.watchlist.length + ranked.length;
  return { topics, top_days, errors, failed: attempted > 0 && errors.length >= attempted };
}

async function collectWikipedia(task: SourceTask, context: ConnectorContext): Promise<CollectedSource> {
  const place = resolveRegion(context.location, validateStateSources(await loadSourceConfig(context.db, context.settings.root, "state-sources")));
  const record = sourceResult(task.source_id, task.name, "ingested", "", { feed_kind: "wikimedia_pageviews", website: "https://wikimedia.org/api/rest_v1/" });
  if (!place.configured) { record.status = "no_feed"; record.detail = `No reviewed watchlist for ${place.state_code}`; return { result: record, events: [] }; }
  const data = await cacheState(context, "wikipedia", place.state_code, context.today, () => wikiStatewide(context, place, context.today));
  const attention: Record<string, number | null> = {};
  for (const [label, article] of [["town", `${place.town}${place.place_suffix ?? ""}`], ["county", place.county ? `${place.county}${place.place_suffix ?? ""}` : null]] as const) {
    if (!article) continue;
    try { attention[label] = (await daily(context, article.replaceAll(" ", "_"), context.today)).ratio; } catch { attention[label] = null; }
  }
  if (data.failed) { record.status = "failed"; record.detail = data.errors.slice(0, 5).join("; "); return { result: record, events: [] }; }
  const trending = data.topics.filter(qualifies).sort((a, b) => b.ratio - a.ratio);
  const near = trending.filter((topic) => topicTier(topic, place));
  const events: CollectedEvent[] = [];
  let noContext = 0;
  for (const topic of near.slice(0, WIKI_MAX_ITEMS)) {
    const report = await verifiedTrend(context, wikiLabel(topic.article), wikiArticleUrl(topic.article));
    if (report) events.push(topicFacts(topic, place, report));
    else noContext++;
  }
  record.detail = `${data.topics.length} topics measured, ${trending.length} trending, ${near.length} near ${place.town}; ${noContext} omitted without sourced story/attention context; top lists ${data.top_days.join(", ") || "unavailable"}; attention vs usual: town ${attention.town ?? "None"}x, county ${attention.county ?? "None"}x`;
  if (noContext && !events.length) record.status = "no_context";
  record.event_count = events.length;
  record.skipped_unusable = Object.fromEntries(Object.entries({ not_trending: data.topics.length - trending.length, not_near_town: trending.length - near.length, no_story_context: noContext }).filter(([, count]) => count));
  record.pages_checked = data.errors.slice(0, 10);
  context.log.info("wikipedia_trending_result", { source_id: task.source_id, topics: data.topics.length, trending: events.length, attention });
  return { result: record, events };
}

export const trendingConnector: Connector = {
  type: "trending",
  sources(_location, settings) { return settings.widerSources ? [
    { source_id: "trending:wikipedia", name: "Trending on Wikipedia", type: "trending" },
    { source_id: "trending:bluesky", name: "Trending on Bluesky", type: "trending" },
  ] : []; },
  async collect(task, context) {
    try { return task.source_id.endsWith(":bluesky") ? await collectBluesky(task, context) : await collectWikipedia(task, context); }
    catch (error) { return emptyFailure(task, context, error); }
  },
};

const TREND_MAX_ITEMS = 5;
function trendTier(trend: { name: string; description: string | null }, place: Region): "local" | "region" | "nearby" | null {
  const tier = itemTier(place, trend.name, trend.description);
  if (!tier && place.nearby_topics.some((entry) => mentions(trend.name, entry.article.replaceAll("_", " ")))) return "nearby";
  return tier;
}
async function collectBluesky(task: SourceTask, context: ConnectorContext): Promise<CollectedSource> {
  const place = resolveRegion(context.location, validateStateSources(await loadSourceConfig(context.db, context.settings.root, "state-sources")));
  const trendUrl = blueskyTrendsUrl();
  const record = sourceResult(task.source_id, task.name, "ingested", "", { feed_kind: "bluesky_trends", website: "https://bsky.app/", feed_url: trendUrl });
  if (!place.configured) { record.status = "no_feed"; record.detail = `No reviewed aliases for ${place.state_code}`; return { result: record, events: [] }; }
  const data = await cacheState<BlueskyCache>(context, "bluesky", place.state_code, context.today, async () => {
    try { return { trends: parseBlueskyTrends(await getJson(context, trendUrl)) }; }
    catch (error) { return { failed: true, status: errName(error) === "DiscoveryBlockedError" ? "blocked" : "failed", error: errName(error) }; }
  });
  const townPosts = await socialCount(context, `"${place.town}" "${place.state_name}"`, context.today, 7);
  if (data.failed) { record.status = String(data.status ?? "failed"); record.detail = String(data.error ?? "Error"); return { result: record, events: [] }; }
  const trends = data.trends ?? [];
  const skipped = { not_near_town: 0, excluded_topic: 0, too_few_posts: 0, no_story_context: 0 };
  const facts: CollectedEvent[] = [];
  let contextLookups = 0;
  for (const trend of trends) {
    const text = `${trend.name} ${trend.description ?? ""}`;
    if (!trendTier(trend, place)) skipped.not_near_town++;
    else if (EXCLUDED_CATEGORIES.has(trend.category) || sensitive(text)) skipped.excluded_topic++;
    else if (trend.post_count < MIN_POSTS) skipped.too_few_posts++;
    else {
      if (contextLookups >= TREND_MAX_ITEMS) continue;
      contextLookups++;
      const report = await verifiedTrend(context, trend.name);
      if (!report) { skipped.no_story_context++; continue; }
      const tier = trendTier(trend, place)!;
      const description = `${reportedDescription(report)} Attention signal (not evidence of cause): Bluesky lists ${trend.name} as a trending topic, with about ${trend.post_count.toLocaleString("en-US")} posts.`;
      facts.push(createNewsFacts({ source_event_id: sha256(trend.topic).slice(0, 16), title: trend.name, event_date: context.today, schedule_text: publishedText(context.today),
        venue: report.publisher, source_url: report.url, description, kind: "social_trend", tier, section: "Trending on social media",
        trend_context: report, attention_source_url: trend.url ?? "https://bsky.app/",
        signals: { post_count: trend.post_count, category: trend.category, status: trend.status }, social_mentions: trend.post_count }));
    }
  }
  const events = facts.slice(0, TREND_MAX_ITEMS);
  record.detail = `${trends.length} national trending topics, ${events.length} sourced stories about ${place.town} or nearby; ${skipped.no_story_context} omitted without sourced story/attention context; ${townPosts ?? "unknown"} posts naming ${place.town} in 7 days (counted, not stored)`;
  if (skipped.no_story_context && !events.length) record.status = "no_context";
  record.event_count = events.length;
  record.skipped_unusable = Object.fromEntries(Object.entries(skipped).filter(([, count]) => count));
  context.log.info("bluesky_trending_result", { source_id: task.source_id, trends: trends.length, kept: events.length, town_posts: townPosts });
  return { result: record, events };
}
