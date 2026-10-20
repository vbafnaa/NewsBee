import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { FeedFormatError, checkCount, checkSize, plainText, rejectUnsafeXml, httpsLink, scheduleText, type EventFacts } from "../common";

export type Tier = "local" | "region" | "nearby";
export type NewsKind = "earthquake" | "state_news" | "trending_topic" | "social_trend";
export type NewsFacts = EventFacts & { kind: NewsKind; tier: Tier; section: string; signals: Record<string, number | string>; social_mentions?: number | null };

const SENSITIVE = /\b(murder\w*|homicide|kill(?:ed|ing|ings|er)|shooting|stabb\w*|massacre|serial|rape\w*|sexual|assault\w*|abus(?:e|ed|ive)|suicide|overdos\w*|fatal\w*|dead|death\w*|died|obituar\w*|funeral|sentenc\w*|convict\w*|guilty|indict\w*|arrest\w*|charged|kidnap\w*|missing person|manhunt|porn\w*|nude|terror\w*|hostage)\b/i;
export function sensitive(...texts: Array<string | null | undefined>) { return texts.some((text) => Boolean(text && SENSITIVE.test(text))); }
export function publishedText(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return scheduleText({ year, month, day });
}
function textOf(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value).trim() || null;
  if (value && typeof value === "object" && "#text" in value) return textOf((value as Record<string, unknown>)["#text"]);
  return null;
}
function itemArray<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }

export type FeedItem = { id: string; title: string; link: string; published: Date; published_day: string; summary: string | null };
export function parseNewsFeed(bytes: Uint8Array): FeedItem[] {
  checkSize(bytes); rejectUnsafeXml(bytes);
  const xml = new TextDecoder().decode(bytes);
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new FeedFormatError(`Feed is not well-formed XML: ${typeof valid === "object" ? valid.err.msg : "invalid XML"}`);
  let root: Record<string, unknown>;
  try { root = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", processEntities: true, trimValues: true, parseTagValue: false, parseAttributeValue: false }).parse(xml) as Record<string, unknown>; }
  catch (error) { throw new FeedFormatError(`Feed is not well-formed XML: ${error instanceof Error ? error.message : String(error)}`); }
  const rss = root.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  const atom = root.feed as Record<string, unknown> | undefined;
  const nodes = itemArray((channel?.item ?? atom?.entry) as Record<string, unknown> | Record<string, unknown>[] | undefined);
  checkCount(nodes.length);
  const seen = new Set<string>();
  const items: FeedItem[] = [];
  for (const node of nodes) {
    const title = plainText(textOf(node.title), 200)?.replace(/\.+$/, "") ?? null;
    const rawLink = node.link;
    const linkEntries: Array<Record<string, unknown> | string> = rawLink === undefined ? [] : Array.isArray(rawLink) ? rawLink as Array<Record<string, unknown> | string> : [rawLink as Record<string, unknown> | string];
    let raw: string | null = null;
    for (const entry of linkEntries) {
      const maybe = typeof entry === "string" ? entry : textOf(entry["@_href"]) ?? textOf(entry);
      const rel = typeof entry === "object" && entry ? textOf(entry["@_rel"]) : null;
      if (maybe && (!rel || rel === "alternate")) { raw = maybe; break; }
    }
    const link = httpsLink(raw);
    const dateValue = textOf(node.pubDate) ?? textOf(node.published) ?? textOf(node.updated) ?? textOf(node.date);
    const millis = dateValue ? Date.parse(dateValue) : NaN;
    const isoDay = dateValue?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    const rfcDate = dateValue?.match(/^(?:\w{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const publishedDay = isoDay ?? (rfcDate ? [rfcDate[3], String(months.indexOf(rfcDate[2]) + 1).padStart(2, "0"), String(Number(rfcDate[1])).padStart(2, "0")].join("-") : Number.isFinite(millis) ? new Date(millis).toISOString().slice(0, 10) : "");
    if (!title || !link || !Number.isFinite(millis) || seen.has(link)) continue;
    seen.add(link);
    const id = textOf(node.guid) ?? textOf(node.id) ?? link;
    const summary = textOf(node.description) ?? textOf(node.summary) ?? textOf(node.content);
    items.push({ id, title, link, published: new Date(millis), published_day: publishedDay, summary: plainText(summary) });
  }
  return items.sort((a, b) => b.published.getTime() - a.published.getTime());
}

function roundPython(value: number, digits = 0) { const factor = 10 ** digits, scaled = value * factor, lower = Math.floor(scaled), fraction = scaled - lower; return (fraction === 0.5 ? (lower % 2 === 0 ? lower : lower + 1) : Math.round(scaled)) / factor; }

export const USGS_ENDPOINT = "https://earthquake.usgs.gov/fdsnws/event/1/query";
export function usgsQueryUrl(latitude: number, longitude: number, start: string, radiusKm: number, minimum: number) {
  const params = new URLSearchParams({ format: "geojson", latitude: latitude.toFixed(4), longitude: longitude.toFixed(4), maxradiuskm: String(radiusKm), starttime: start, minmagnitude: String(minimum), eventtype: "earthquake", orderby: "time", limit: "100" });
  return `${USGS_ENDPOINT}?${params.toString()}`;
}
export function parseUsgs(bytes: Uint8Array, latitude: number, longitude: number) {
  checkSize(bytes);
  let features: unknown;
  try { features = (JSON.parse(new TextDecoder().decode(bytes)) as { features: unknown }).features; }
  catch (error) { throw new FeedFormatError(`USGS response is not GeoJSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(features)) throw new FeedFormatError("USGS response is not GeoJSON: missing features");
  checkCount(features.length);
  const result: Array<{ id: string; magnitude: number; place: string; time: Date; depth_km: number; felt: number; alert: unknown; tsunami: boolean; reviewed: boolean; url: string | null; distance_km: number }> = [];
  for (const raw of features) {
    if (!raw || typeof raw !== "object") continue;
    const feature = raw as Record<string, unknown>;
    const props = feature.properties as Record<string, unknown> | undefined;
    const coordinates = (feature.geometry as { coordinates?: unknown } | undefined)?.coordinates;
    if (!props || !Array.isArray(coordinates) || coordinates.length < 3) continue;
    const [lon, lat, depth] = coordinates.map(Number);
    const magnitude = Number(props.mag);
    const millis = Number(props.time);
    if (!Number.isFinite(magnitude) || !Number.isFinite(millis) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (props.type !== undefined && props.type !== "earthquake") continue;
    const a = Math.sin(((lat - latitude) * Math.PI / 180) / 2) ** 2 + Math.cos(latitude * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.sin(((lon - longitude) * Math.PI / 180) / 2) ** 2;
    const distance = 6371 * 2 * Math.asin(Math.sqrt(a));
    result.push({ id: String(feature.id ?? props.code), magnitude: roundPython(magnitude, 1),
      place: String(props.place ?? "").trim(), time: new Date(millis), depth_km: roundPython(Number(depth) || 0, 1),
      felt: Math.trunc(Number(props.felt) || 0), alert: props.alert, tsunami: Boolean(props.tsunami), reviewed: props.status === "reviewed",
      url: httpsLink(typeof props.url === "string" ? props.url : null), distance_km: roundPython(distance) });
  }
  return result;
}

const WIKI_BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews";
export const WIKI_PROJECT = "en.wikipedia";
const NAMESPACES = ["Special:", "Wikipedia:", "File:", "Portal:", "Help:", "Category:", "Talk:", "Template:", "User:", "Draft:", "Module:"];
const enc = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
export function wikiTopUrl(day: string) { return `${WIKI_BASE}/top/${WIKI_PROJECT}/all-access/${day.replaceAll("-", "/")}`; }
export function wikiDailyUrl(article: string, first: string, last: string) { return `${WIKI_BASE}/per-article/${WIKI_PROJECT}/all-access/user/${enc(article.replaceAll(" ", "_"))}/daily/${first.replaceAll("-", "")}00/${last.replaceAll("-", "")}00`; }
export function wikiArticleUrl(article: string) { const title = encodeURIComponent(article.replaceAll(" ", "_")).replace(/[!'*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).replaceAll("%28", "(").replaceAll("%29", ")").replaceAll("%2C", ","); return `https://en.wikipedia.org/wiki/${title}`; }
export function wikiLabel(article: string) { return article.replaceAll("_", " "); }
export function wikiTopic(article: string) { return article !== "Main_Page" && !NAMESPACES.some((prefix) => article.startsWith(prefix)); }
function wikiItems(bytes: Uint8Array) {
  checkSize(bytes);
  try { const items = (JSON.parse(new TextDecoder().decode(bytes)) as { items: unknown }).items; if (!Array.isArray(items)) throw new Error("missing items"); return items as Array<Record<string, unknown>>; }
  catch (error) { throw new FeedFormatError(`Pageviews response is not the expected JSON: ${error instanceof Error ? error.message : String(error)}`); }
}
export function parseWikiTop(bytes: Uint8Array) {
  const top = wikiItems(bytes)[0]?.articles;
  if (!Array.isArray(top)) return [];
  return top.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && "article" in item && wikiTopic(String(item.article))))
    .map((item) => ({ article: String(item.article), views: Number.parseInt(String(item.views), 10), rank: Number.parseInt(String(item.rank), 10) }));
}
export function parseWikiDaily(bytes: Uint8Array) { return Object.fromEntries(wikiItems(bytes).map((item) => [String(item.timestamp).slice(0, 8), Number.parseInt(String(item.views), 10)])); }
export function spike(daily: Record<string, number>) {
  const days = Object.keys(daily).sort(); const recent = days.slice(-3), baseline = days.slice(0, -3);
  const avg = (list: string[]) => list.length ? list.reduce((sum, day) => sum + daily[day], 0) / list.length : 0;
  const recentMean = avg(recent), baselineMean = avg(baseline);
  return { recent_daily_views: roundPython(recentMean), baseline_daily_views: roundPython(baselineMean), ratio: roundPython(recentMean / Math.max(baselineMean, 1), 2), latest_day: days.at(-1) ?? null };
}
export function wikiRecentDays(today: string, lag = 1, span = 17): [string, string] {
  const add = (iso: string, delta: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
  const last = add(today, -lag); return [add(last, -(span - 1)), last];
}

const BSKY_BASE = "https://api.bsky.app/xrpc";
export function blueskyTrendsUrl(limit = 25) { return `${BSKY_BASE}/app.bsky.unspecced.getTrends?limit=${limit}`; }
export function blueskySearchUrl(query: string, since: Date) {
  const params = new URLSearchParams({ q: query, since: since.toISOString().replace(/\.\d{3}Z$/, "Z"), limit: "100", sort: "latest", lang: "en" });
  return `${BSKY_BASE}/app.bsky.feed.searchPosts?${params.toString()}`;
}
function blueskyJson(bytes: Uint8Array) { checkSize(bytes); let data: unknown; try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch (error) { throw new FeedFormatError(`Bluesky response is not JSON: ${error instanceof Error ? error.message : String(error)}`); } if (!data || typeof data !== "object" || Array.isArray(data)) throw new FeedFormatError("Bluesky response is not a JSON object"); return data as Record<string, unknown>; }
export function countBlueskyMentions(bytes: Uint8Array, since: Date) {
  const posts = blueskyJson(bytes).posts; let count = 0;
  if (!Array.isArray(posts)) return count;
  for (const post of posts) {
    const record = (post as { record?: { createdAt?: unknown } }).record;
    const created = record?.createdAt ?? (post as { indexedAt?: unknown }).indexedAt;
    const time = typeof created === "string" ? Date.parse(created) : NaN;
    if (Number.isFinite(time) && time >= since.getTime()) count++;
  }
  return count;
}
export function parseBlueskyTrends(bytes: Uint8Array) {
  const trends = blueskyJson(bytes).trends;
  if (!Array.isArray(trends)) return [];
  return trends.filter((trend): trend is Record<string, unknown> => Boolean(trend && typeof trend === "object" && (trend as Record<string, unknown>).displayName))
    .map((trend) => { const link = String(trend.link ?? ""); return { topic: String(trend.topic ?? trend.displayName), name: String(trend.displayName).trim(), description: String(trend.description ?? "").trim() || null,
      category: String(trend.category ?? "other"), status: String(trend.status ?? ""), post_count: Number.parseInt(String(trend.postCount ?? 0), 10) || 0,
      started_at: String(trend.startedAt ?? ""), url: link.startsWith("/") ? httpsLink(`https://bsky.app${link}`) : null }; });
}
export function sha256(bytes: Uint8Array | string) { return createHash("sha256").update(bytes).digest("hex"); }
