/**
 * News search: topic searches for the place, so stories from outlets not yet on the map
 * still reach the newsletter, and outlets that keep covering the place are added to the
 * map (the "publishers" discovery method reads `news_publishers`).
 *
 *   gdelt  the GDELT DOC 2.0 API (free public JSON API; one request per 5 seconds), three
 *          topic searches per place over the window. Default.
 *   llm    Gemini with Google Search grounding (built, off unless NEWSBEE_NEWS_SEARCH
 *          includes "llm").
 *
 * Google News RSS is not used: its robots.txt disallows /rss for every crawler. Results are
 * headline, link and publisher only; every item must pass the full locality check (which
 * reads the article) before ranking. A search match alone is never enough.
 */
import type { Db } from "mongodb";
import { addDays, httpsLink } from "../common";
import { publicApiGet } from "../public-api";
import { publishedText, sha256 } from "../wider/adapters";
import { runCollector } from "../parents/shared";
import { newestFirst } from "../web";
import type { CollectedEvent, Connector, ConnectorContext, DroppedItem, SourceResult, SourceTask } from "../types";
import { rangesFor } from "../../core/time";
import { WINDOWS } from "../../sourcemap/windows";
import { hostOf } from "../../sourcemap/store";
import { townName } from "../locality";
import { US_STATES } from "../../../../../shared/geography";
import { groundedSearch, jsonArray, usageRecorder } from "../../model/budget";
import type { Details } from "../../editions/details";

export const GDELT = "https://api.gdeltproject.org/api/v2/doc/doc";
export const GDELT_PAUSE_MS = 5500;
export const NEWS_PUBLISHERS = "news_publishers";
export const AGGREGATORS = ["news.google.com", "yahoo.com", "msn.com", "aol.com", "newsbreak.com", "apple.news", "flipboard.com", "ground.news", "nytimes.com", "washingtonpost.com", "cnn.com", "foxnews.com", "apnews.com", "usatoday.com", "nbcnews.com", "cbsnews.com", "abcnews.go.com", "reuters.com", "bloomberg.com", "wsj.com", "theguardian.com", "npr.org", "bbc.com", "bbc.co.uk", "youtube.com", "facebook.com", "x.com", "twitter.com", "reddit.com", "nextdoor.com", "legacy.com", "yelp.com", "patch.com/national"];
const TOPICS = [
  { name: "news", terms: "" },
  { name: "safety and civic", terms: "(police OR fire OR crash OR council OR school OR arrested OR rescue OR permit)" },
  { name: "business and community", terms: "(restaurant OR opening OR closing OR obituary OR festival OR market OR development OR neighbors)" },
];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function aggregator(url: string) {
  const host = hostOf(url);
  return AGGREGATORS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function placeQuery(context: Pick<ConnectorContext, "location">) {
  const place = context.location.community?.name ?? townName(context.location);
  const parent = context.location.community ? townName(context.location) : US_STATES[context.location.state] ?? context.location.state;
  return parent && parent.toLowerCase() !== place.toLowerCase() ? `"${place}" "${parent}"` : `"${place}"`;
}

export const newsSearchConnector: Connector = {
  type: "newssearch",
  meta: {
    name: "News search",
    formats: "GDELT news search for the place (Gemini grounded search optional); headlines and links, each checked against the article before use",
    manual: false,
    coverage: { group: "local", label: "news coverage of the place" },
    storyKinds: ["news_report"],
  },
  window: WINDOWS.news,
  rank: newestFirst,
  sources(location, settings) {
    return settings.newsSearch.map((backend) => ({ source_id: `newssearch:${backend}`, name: backend === "gdelt" ? "News search (GDELT)" : "News search (Gemini)", type: "newssearch" as const, params: { backend } }));
  },
  async collect(task, context) {
    const dropped: DroppedItem[] = [];
    const collected = await runCollector(task, context, (record) => search(task, context, record, dropped));
    return { ...collected, dropped };
  },
};

type Hit = { title: string; url: string; day: string; domain: string; image: string | null };

async function gdelt(context: ConnectorContext, query: string, days: number): Promise<Hit[]> {
  const params = new URLSearchParams({ query: `${query} sourcelang:english`, mode: "ArtList", format: "json", maxrecords: "75", timespan: `${Math.max(1, Math.min(days, 90))}d`, sort: "DateDesc" });
  const body = await publicApiGet(context.transport, `${GDELT}?${params.toString()}`, "application/json", 2 * 1024 * 1024, 30_000);
  const text = new TextDecoder().decode(body).trim();
  if (!text.startsWith("{")) return [];
  const data = JSON.parse(text) as { articles?: Array<{ url?: string; title?: string; seendate?: string; domain?: string; socialimage?: string }> };
  return (data.articles ?? []).flatMap((article) => {
    const url = httpsLink(article.url ?? null);
    const seen = /^(\d{4})(\d{2})(\d{2})/.exec(article.seendate ?? "");
    if (!url || !article.title || !seen) return [];
    return [{ title: article.title.replace(/\s+-\s+[^-]{2,60}$/, "").trim(), url, day: `${seen[1]}-${seen[2]}-${seen[3]}`, domain: article.domain ?? hostOf(url), image: httpsLink(article.socialimage ?? null) }];
  });
}

async function llmNews(context: ConnectorContext, query: string, since: string): Promise<Hit[]> {
  const prompt = `Find local news articles published since ${since} about ${query.replace(/"/g, "")}. Prefer local newsrooms, community blogs, city and school announcements. Reply with ONLY a JSON array of objects {"title": str, "url": str, "date": "YYYY-MM-DD", "publisher": str}. Include only articles you found in search results.`;
  const result = await groundedSearch(context.settings, prompt, context.transport, usageRecorder(context.db, context.settings, "discovery"));
  if (!result) return [];
  const grounded = new Set(result.sources.map((source) => source.uri));
  return jsonArray(result.text).flatMap((value) => {
    const item = value as { title?: unknown; url?: unknown; date?: unknown; publisher?: unknown };
    const url = httpsLink(typeof item.url === "string" ? item.url : null);
    const day = typeof item.date === "string" ? /^\d{4}-\d{2}-\d{2}/.exec(item.date)?.[0] : null;
    if (!url || typeof item.title !== "string" || !day) return [];
    // Grounding redirect links hide the real URL; accept only answers that point at a real site.
    if (grounded.size && hostOf(url).includes("vertexaisearch")) return [];
    return [{ title: item.title, url, day, domain: typeof item.publisher === "string" ? item.publisher : hostOf(url), image: null }];
  });
}

async function search(task: SourceTask, context: ConnectorContext, record: SourceResult, dropped: DroppedItem[]): Promise<CollectedEvent[]> {
  const backend = String(task.params?.backend ?? "gdelt");
  const since = rangesFor(context, WINDOWS.news).back?.[0] ?? addDays(context.today, -7);
  const days = Math.round((Date.parse(`${context.today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86400_000) + 1;
  const query = placeQuery(context);
  record.feed_kind = backend;
  const hits: Hit[] = [];
  if (backend === "llm") hits.push(...await llmNews(context, query, since));
  else {
    for (const [index, topic] of TOPICS.entries()) {
      if (index) await sleep(GDELT_PAUSE_MS);
      try { hits.push(...await gdelt(context, `${query} ${topic.terms}`.trim(), days)); }
      catch (error) { record.pages_checked.push(`${topic.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  const events: CollectedEvent[] = [];
  const seen = new Set<string>();
  const publishers = new Map<string, { hits: number; url: string; name: string }>();
  for (const hit of hits) {
    const id = sha256(hit.url).slice(0, 16);
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    if (aggregator(hit.url)) { dropped.push({ source_event_id: id, title: hit.title, url: hit.url, reason: "aggregator or national outlet", event_date: hit.day }); continue; }
    if (hit.day < since || hit.day > context.today) { dropped.push({ source_event_id: id, title: hit.title, url: hit.url, reason: "outside_window", event_date: hit.day }); continue; }
    const host = hostOf(hit.url);
    const entry = publishers.get(host) ?? { hits: 0, url: new URL(hit.url).origin, name: hit.domain };
    entry.hits += 1;
    publishers.set(host, entry);
    events.push({
      source_event_id: id, title: hit.title, event_date: hit.day, schedule_text: publishedText(hit.day), venue: hit.domain, room: null, source_url: hit.url,
      description: null, kind: "news_report", source_name: hit.domain, needs_locality: true, found_by: "news search", section_hint: null,
      details: { image: hit.image, links: [hit.url] } as Partial<Details>,
    } as CollectedEvent);
  }
  await recordPublishers(context.db, context.location.id, publishers);
  record.detail = `${backend}: ${hits.length} results for ${query}; ${events.length} to check against the article, ${dropped.length} left out`;
  return events;
}

type PublisherDoc = { _id: string; location_id: string; host: string; url: string; name: string; hits: number; last_seen: string };
export function newsPublishers(db: Db) { return db.collection<PublisherDoc>(NEWS_PUBLISHERS); }
async function recordPublishers(db: Db, locationId: string, publishers: Map<string, { hits: number; url: string; name: string }>) {
  for (const [host, entry] of publishers) {
    await newsPublishers(db).updateOne({ _id: `${locationId}:${host}` }, {
      $set: { location_id: locationId, host, url: entry.url, name: entry.name, last_seen: new Date().toISOString() }, $inc: { hits: entry.hits },
    }, { upsert: true });
  }
}
