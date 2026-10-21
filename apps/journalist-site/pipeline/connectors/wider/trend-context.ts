import { Parser } from "htmlparser2";
import { httpsLink, MAX_FEED_BYTES } from "../common";
import { Fetcher } from "../fetcher";
import type { ConnectorContext } from "../types";
import { pageLinks } from "../ai-discovery";
import { blueskySearchUrl, parseNewsFeed, sensitive, sponsoredItem } from "./adapters";
import { publicSourceTransport } from "../public-http";
import { trendTier, type Region } from "./regions";
import { quoteSearch, reportingQualifier, type ReportingSearch } from "./trend-discovery";
export { assertPublicReportingUrl } from "../public-http";

const MAX_REPORTS = 3;
const MAX_AGE_DAYS = 7;
const ATTENTION = /\b(?:trending|viral|attention|public interest|search interest|searches|page views|readership)\b/i;
const EXCLUDED_HOST = /(?:^|\.)(?:wikipedia\.org|wikimedia\.org|bsky\.app|twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com)$/i;

export type TrendContext = { url: string; publisher: string; published_at: string; headline: string; excerpt: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function topicMention(text: string, topic: string) {
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return normalize(text).includes(normalize(topic));
}

/** Social posts discover reporting URLs; their text and authors are never retained as evidence. */
export function reportingLinks(bytes: Uint8Array, since: Date) {
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!record(data) || !Array.isArray(data.posts)) throw new Error("Invalid trend reporting-link response");
  const urls = new Set<string>();
  for (const post of data.posts) {
    if (!record(post) || !record(post.record) || typeof post.record.createdAt !== "string") continue;
    const date = Date.parse(post.record.createdAt);
    if (!Number.isFinite(date) || date < since.getTime()) continue;
    const embed = record(post.embed) && record(post.embed.external) ? post.embed.external : null;
    if (typeof embed?.uri === "string") urls.add(embed.uri);
    const facets = post.record.facets;
    if (!Array.isArray(facets)) continue;
    for (const facet of facets) {
      if (!record(facet) || !Array.isArray(facet.features)) continue;
      for (const feature of facet.features) {
        if (record(feature) && feature.$type === "app.bsky.richtext.facet#link" && typeof feature.uri === "string") urls.add(feature.uri);
      }
    }
  }
  return [...urls];
}

/** Require an actual recent local development; attention is discovery metadata, not reporting. */
export function parseTrendReport(html: string, url: string, topic: string, today: string, place: Region): TrendContext | null {
  let title = "", publisher = "", published = "", paragraph = "", script = "", scriptType = "";
  const sections: string[] = [];
  let hidden = 0, inParagraph = false, inTitle = false;
  const paragraphs: string[] = [];
  const structured: unknown[] = [];
  const parser = new Parser({
    onopentag(name, attributes) {
      if (["script", "style", "nav", "aside", "header", "footer", "form", "noscript"].includes(name)) hidden++;
      if (name === "script") { scriptType = attributes.type ?? ""; script = ""; }
      if (name === "title") inTitle = true;
      if (name === "meta") {
        const key = attributes.property ?? attributes.name;
        if (key === "og:title") title = attributes.content ?? title;
        if (key === "og:site_name") publisher = attributes.content ?? publisher;
        if (key === "article:published_time") published = attributes.content ?? published;
        if (key === "article:section" && attributes.content) sections.push(attributes.content);
      }
      if (name === "p" && hidden === 0) { paragraph = ""; inParagraph = true; }
    },
    ontext(text) {
      if (scriptType === "application/ld+json") script += text;
      if (inTitle && !title) title = text;
      if (inParagraph && hidden === 0) paragraph += text;
    },
    onclosetag(name) {
      if (name === "p" && inParagraph) { paragraphs.push(paragraph.replace(/\s+/g, " ").trim()); inParagraph = false; }
      if (name === "title") inTitle = false;
      if (name === "script") {
        if (scriptType === "application/ld+json") {
          try { structured.push(JSON.parse(script)); }
          catch { /* A malformed optional metadata block is not reporting evidence. */ }
        }
        scriptType = "";
      }
      if (["script", "style", "nav", "aside", "header", "footer", "form", "noscript"].includes(name)) hidden = Math.max(0, hidden - 1);
    },
  }, { decodeEntities: true });
  parser.end(html);
  function articleMetadata(value: unknown) {
    if (Array.isArray(value)) { value.forEach(articleMetadata); return; }
    if (!record(value)) return;
    if (Array.isArray(value["@graph"])) value["@graph"].forEach(articleMetadata);
    const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    if (!types.some((type) => type === "NewsArticle" || type === "Article" || type === "ReportageNewsArticle")) return;
    if (typeof value.datePublished === "string") published ||= value.datePublished;
    if (typeof value.headline === "string") title ||= value.headline;
    if (record(value.publisher) && typeof value.publisher.name === "string") publisher ||= value.publisher.name;
    if (typeof value.articleBody === "string" && !paragraphs.length) paragraphs.push(value.articleBody.replace(/\s+/g, " ").trim());
  }
  structured.forEach(articleMetadata);
  const age = Date.parse(`${today}T23:59:59Z`) - Date.parse(published);
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_DAYS * 86400000 || !publisher.trim()) return null;
  if (sponsoredItem({ title, link: url, summary: paragraphs.join(" "), categories: sections })) return null;
  const relevant = paragraphs.filter((text) => (!topic || topicMention(`${title} ${text}`, topic))
    && trendTier(place, title, text) && !sensitive(title, text) && text.length >= 80 && text.length <= 2000);
  // Do not let a sidebar's town name or a popularity-only paragraph establish relevance.
  const evidence = relevant.filter((text) => !ATTENTION.test(text) && !/\b(?:pageviews|daily views|post count)\b/i.test(text));
  if (!title.trim() || ATTENTION.test(title) || !evidence.length) return null;
  return { url, publisher: publisher.trim(), published_at: published, headline: title.trim(),
    excerpt: evidence.slice(0, 2).join(" ").slice(0, 4000) };
}

export async function trendReports(context: ConnectorContext, topic: string, place: Region, wikipediaUrl?: string): Promise<TrendContext[]> {
  return (await discoverReports(context, place, [{ topic, query: `${quoteSearch(topic)} ${quoteSearch(reportingQualifier(place))}` }], [], wikipediaUrl)).reports;
}

export async function discoverReports(context: ConnectorContext, place: Region, searches: ReportingSearch[], feeds: string[] = [], wikipediaUrl?: string) {
  const since = new Date(Date.parse(`${context.today}T00:00:00Z`) - MAX_AGE_DAYS * 86400000);
  const groups: Array<Array<{ url: string; topic: string }>> = [];
  const errors: string[] = [];
  let discovered = false;
  const eligible = (url: string) => httpsLink(url) !== null && !EXCLUDED_HOST.test(new URL(url).hostname);
  const fetcher = new Fetcher(publicSourceTransport(context.transport));
  const failed = (source: string, error: unknown) => {
    errors.push(`${source}: ${String(error)}`);
    context.log.warn("trend_reporting_discovery_failed", { source, error: String(error) });
  };
  for (const { topic, query } of searches.slice(0, 6)) {
    try {
      const [, bytes] = await context.fetcher.get(blueskySearchUrl(query, since), MAX_FEED_BYTES, "application/json");
      groups.push(reportingLinks(bytes, since).filter(eligible).slice(0, MAX_REPORTS).map((url) => ({ url, topic })));
      discovered = true;
    } catch (error) { failed(query, error); }
  }
  for (const feed of [...new Set(feeds)].slice(0, 3)) {
    try {
      const [, bytes] = await fetcher.get(feed, MAX_FEED_BYTES, "application/rss+xml, application/atom+xml, application/xml");
      const items = parseNewsFeed(bytes).filter((item) => item.published >= since
        && item.published.getTime() <= Date.parse(`${context.today}T23:59:59Z`) && !sponsoredItem(item));
      groups.push(items.filter((item) => eligible(item.link)).slice(0, MAX_REPORTS).map((item) => ({ url: item.link, topic: "" })));
      discovered = true;
    } catch (error) { failed(feed, error); }
  }
  if (wikipediaUrl) {
    try {
      const [, html] = await context.fetcher.getText(wikipediaUrl, MAX_FEED_BYTES, "text/html");
      groups.push(pageLinks(html, wikipediaUrl, 1000).map((link) => link.url).filter(eligible).slice(0, MAX_REPORTS)
        .map((url) => ({ url, topic: searches[0]?.topic ?? "" })));
      discovered = true;
    } catch (error) { failed(wikipediaUrl, error); }
  }
  if (!discovered) throw new Error(`Local reporting discovery unavailable: ${errors.join("; ")}`);
  // Round-robin candidates prevent the first identity or publisher from taking the entire budget.
  const candidates = Array.from({ length: MAX_REPORTS }, (_, index) => groups.flatMap((group) => group[index] ? [group[index]] : [])).flat();
  const topicsByUrl = new Map<string, Set<string>>();
  for (const { url, topic } of candidates) {
    if (!topicsByUrl.has(url)) topicsByUrl.set(url, new Set());
    topicsByUrl.get(url)!.add(topic);
  }
  const reportsByUrl = new Map<string, TrendContext>();
  const reports: TrendContext[] = [];
  let fetched = 0;
  for (const [url, topics] of [...topicsByUrl].slice(0, 12)) {
    try {
      const [finalUrl, html] = await fetcher.getText(url, MAX_FEED_BYTES, "text/html");
      fetched++;
      const report = [...topics].map((topic) => parseTrendReport(html, finalUrl, topic, context.today, place)).find((report) => report !== null);
      if (report) {
        context.log.info("trend_context_verified", { url: finalUrl, publisher: report.publisher });
        reportsByUrl.set(finalUrl, report);
      }
    } catch (error) { failed(url, error); }
  }
  if (candidates.length && !fetched) throw new Error("All linked reporting unavailable");
  reports.push(...reportsByUrl.values());
  if (!reports.length) context.log.info("trend_context_missing", { reports_checked: Math.min(topicsByUrl.size, 12), location_id: place.location_id });
  return { reports, errors };
}

export async function trendContext(context: ConnectorContext, topic: string, place: Region, wikipediaUrl?: string): Promise<TrendContext | null> {
  return (await trendReports(context, topic, place, wikipediaUrl))[0] ?? null;
}

export function reportedDescription(report: TrendContext) {
  return `Reporting by ${report.publisher}, published ${report.published_at.slice(0, 10)}. ${report.excerpt}`;
}
