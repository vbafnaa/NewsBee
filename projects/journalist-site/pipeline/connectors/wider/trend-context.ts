import { Parser } from "htmlparser2";
import { httpsLink, MAX_FEED_BYTES } from "../common";
import { Fetcher } from "../fetcher";
import type { ConnectorContext } from "../types";
import { pageLinks } from "../ai-discovery";
import { blueskySearchUrl } from "./adapters";
import { publicSourceTransport } from "../public-http";
export { assertPublicReportingUrl } from "../public-http";

const MAX_REPORTS = 3;
const MAX_AGE_DAYS = 7;
const ATTENTION = /\b(?:trending|viral|attention|public interest|search interest|searches|page views|readership)\b/i;
const CAUSE = /\b(?:because|after|following|due to|driven by|sparked by|prompted by|as a result of)\b/i;
const EXCLUDED_HOST = /(?:^|\.)(?:wikipedia\.org|wikimedia\.org|bsky\.app|twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com)$/i;

export type TrendContext = { url: string; publisher: string; published_at: string; excerpt: string; reason: string };

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

/** Require recent reporting that explicitly connects attention to a development, not mere correlation. */
export function parseTrendReport(html: string, url: string, topic: string, today: string): TrendContext | null {
  let title = "", publisher = "", published = "", paragraph = "", script = "", scriptType = "";
  let hidden = 0, inParagraph = false, inTitle = false;
  const paragraphs: string[] = [];
  const structured: unknown[] = [];
  const parser = new Parser({
    onopentag(name, attributes) {
      if (["script", "style", "nav", "header", "footer", "form", "noscript"].includes(name)) hidden++;
      if (name === "script") { scriptType = attributes.type ?? ""; script = ""; }
      if (name === "title") inTitle = true;
      if (name === "meta") {
        const key = attributes.property ?? attributes.name;
        if (key === "og:title") title = attributes.content ?? title;
        if (key === "og:site_name") publisher = attributes.content ?? publisher;
        if (key === "article:published_time") published = attributes.content ?? published;
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
      if (["script", "style", "nav", "header", "footer", "form", "noscript"].includes(name)) hidden = Math.max(0, hidden - 1);
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
  const relevant = paragraphs.filter((text) => topicMention(text, topic));
  const explanation = relevant.find((text) => ATTENTION.test(text) && CAUSE.test(text) && text.length <= 1500);
  if (!explanation || !topicMention(`${title} ${relevant.join(" ")}`, topic)) return null;
  const excerpt = relevant.filter((text) => text !== explanation).slice(0, 2).join(" ");
  return { url, publisher: publisher.trim(), published_at: published, excerpt: excerpt.length <= 2000 ? excerpt : "", reason: explanation };
}

export async function trendContext(context: ConnectorContext, topic: string, wikipediaUrl?: string): Promise<TrendContext | null> {
  const since = new Date(Date.parse(`${context.today}T00:00:00Z`) - MAX_AGE_DAYS * 86400000);
  const urls: string[] = [];
  const fetcher = new Fetcher(publicSourceTransport(context.transport));
  try {
    const [, bytes] = await context.fetcher.get(blueskySearchUrl(`"${topic}"`, since), MAX_FEED_BYTES, "application/json");
    urls.push(...reportingLinks(bytes, since));
  } catch (error) { context.log.warn("trend_reporting_discovery_failed", { topic, error: String(error) }); }
  if (!urls.length && wikipediaUrl) {
    try {
      const [, html] = await context.fetcher.getText(wikipediaUrl, MAX_FEED_BYTES, "text/html");
      urls.push(...pageLinks(html, wikipediaUrl, 1000).map((link) => link.url));
    } catch (error) { context.log.warn("trend_reference_discovery_failed", { topic, error: String(error) }); }
  }
  const candidates = [...new Set(urls)].filter((url) => httpsLink(url) && !EXCLUDED_HOST.test(new URL(url).hostname)).slice(0, MAX_REPORTS);
  for (const url of candidates) {
    try {
      const [finalUrl, html] = await fetcher.getText(url, MAX_FEED_BYTES, "text/html");
      const report = parseTrendReport(html, finalUrl, topic, context.today);
      if (report) {
        context.log.info("trend_context_verified", { topic, url: finalUrl, publisher: report.publisher });
        return report;
      }
    } catch (error) { context.log.warn("trend_reporting_fetch_failed", { topic, url, error: String(error) }); }
  }
  context.log.info("trend_context_missing", { topic, reports_checked: candidates.length });
  return null;
}

export function reportedDescription(report: TrendContext) {
  return `Reporting by ${report.publisher}, published ${report.published_at.slice(0, 10)}. ${report.excerpt} Source-reported explanation of attention: ${report.reason}`;
}
