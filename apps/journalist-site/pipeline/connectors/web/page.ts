/**
 * Reading one web page: usage signals (robots meta, X-Robots-Tag, AI opt-outs, mining
 * reservations, paywalls), article metadata (schema.org, Open Graph), main text, links that
 * look like stories, calendar links and sitemaps. Ported from the exploration app's crawler.
 */
import { Readability } from "@mozilla/readability";
import { decodeHTML } from "entities";
import { parseHTML } from "linkedom";
import { accessIgnored } from "../../core/run-options";
import { httpsLink, plainText } from "../common";
import { normalizeStoryImage, safeImageUrl, type StoryImage, type StoryImageMetadata } from "../../../../../shared/story-image";
import { rankedArticlePhotos, ARTICLE_PHOTO_POOL_LIMIT } from "./article-images";

export const AI_META_NAMES = ["robots", "newsbee", "claudebot", "gptbot", "ccbot", "google-extended", "anthropic-ai"];
const DIRECTIVES = new Set(["noindex", "none", "nosnippet", "noarchive", "noai", "noimageai", "noimageindex", "max-image-preview:none", "max-snippet:0"]);
export type RightsAction = "ok" | "link-only" | "skip";

export function meta(html: string, ...names: string[]): string {
  const head = html.slice(0, 200_000);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, "i").exec(head)
      ?? new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, "i").exec(head);
    if (match) return decodeHTML(match[1]).trim();
  }
  return "";
}

/** Usage signals a page or feed sends. */
export function pageRights(headers: Record<string, string>, html = ""): Set<string> {
  const raw: string[] = [];
  for (const piece of (headers["x-robots-tag"] ?? "").split(",")) {
    let value = piece.trim().toLowerCase();
    if (!value) continue;
    const colon = value.indexOf(":");
    if (colon > 0 && !/^(max-snippet|unavailable_after|max-image-preview|max-video-preview)/.test(value)) {
      const agent = value.slice(0, colon).trim();
      if (!AI_META_NAMES.includes(agent) && agent !== "*") continue;
      value = value.slice(colon + 1).trim();
    }
    raw.push(value.replace(/\s+/g, ""));
  }
  if (html) {
    for (const name of AI_META_NAMES) raw.push(...meta(html, name).toLowerCase().split(",").map((value) => value.trim().replace(/\s+/g, "")).filter(Boolean));
    if (/["']isAccessibleForFree["']\s*:\s*["']?false/i.test(html.slice(0, 300_000))) raw.push("paywalled");
    if (meta(html, "tdm-reservation") === "1") raw.push("tdm-reserved");
  }
  if ((headers["tdm-reservation"] ?? "").trim() === "1") raw.push("tdm-reserved");
  return new Set(raw.filter((value) => DIRECTIVES.has(value) || value === "paywalled" || value === "tdm-reserved"));
}

/** 'skip': don't use the page; 'link-only': headline and link, no text; 'ok'. */
export function rightsAction(flags: Set<string>): RightsAction {
  if ((flags.has("noindex") || flags.has("none") || flags.has("noai") || flags.has("tdm-reserved")) && !accessIgnored("noai", true)) return "skip";
  // Paywalled text stays link-only in every run, including relaxed ones.
  if (flags.has("paywalled")) return "link-only";
  if ((flags.has("nosnippet") || flags.has("noarchive") || flags.has("max-snippet:0")) && !accessIgnored("nosnippet", true)) return "link-only";
  return "ok";
}

export function imagesAllowed(flags: Set<string>): boolean {
  return rightsAction(flags) === "ok" && !["noimageai", "noimageindex", "max-image-preview:none"].some((flag) => flags.has(flag));
}

type JsonObject = Record<string, unknown>;
export function jsonLdNodes(html: string): JsonObject[] {
  const nodes: JsonObject[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    const node = value as JsonObject;
    nodes.push(node);
    if (Array.isArray(node["@graph"])) walk(node["@graph"]);
  };
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(match[1].trim())); } catch { /* malformed JSON-LD is ignored */ }
  }
  return nodes;
}
function types(node: JsonObject) {
  const value = node["@type"];
  return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string");
}
const ARTICLE_TYPES = new Set(["NewsArticle", "Article", "BlogPosting", "Report", "LiveBlogPosting", "AnalysisNewsArticle", "ReportageNewsArticle", "LocalNewsArticle"]);
function names(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.flatMap((item) => typeof item === "string" ? [item] : item && typeof item === "object" && typeof (item as JsonObject).name === "string" ? [String((item as JsonObject).name)] : [])
    .map((name) => name.trim()).filter((name) => name && name.length < 80);
}
function imageOf(value: unknown, pageUrl?: string): StoryImage | null {
  if (Array.isArray(value)) return value.map((item) => imageOf(item, pageUrl)).find(Boolean) ?? null;
  const node = value && typeof value === "object" ? value as JsonObject : {};
  const image = safeImageUrl(typeof value === "string" ? value : node.contentUrl ?? node.url, pageUrl);
  return image ? normalizeStoryImage({ image, image_source_url: pageUrl, image_credit: node.creditText ?? node.copyrightNotice,
    image_alt: node.caption ?? node.description, image_width: node.width, image_height: node.height }) : null;
}

export type PageArticle = StoryImageMetadata & { title: string; date: string | null; description: string | null; authors: string[]; image: string | null;
  image_candidates?: StoryImage[]; section: string | null; keywords: string[] };

/** Extract bounded editorial candidates without collecting unrelated page images. */
export function articleImageCandidates(html: string, pageUrl?: string, headline?: string): StoryImage[] {
  const images = new Map<string, StoryImage>();
  const add = (image: StoryImage | null) => { if (image && !images.has(image.image) && images.size < ARTICLE_PHOTO_POOL_LIMIT) images.set(image.image, image); };
  for (const article of jsonLdNodes(html).filter(node => types(node).some(type => ARTICLE_TYPES.has(type) || type === "Event"))) {
    for (const value of Array.isArray(article.image) ? article.image : [article.image]) add(imageOf(value, pageUrl));
  }
  for (const name of ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]) {
    const image = safeImageUrl(meta(html, name), pageUrl);
    if (image) add(normalizeStoryImage({ image, image_source_url: pageUrl,
      image_alt: meta(html, name.startsWith("og:") ? "og:image:alt" : "twitter:image:alt"),
      image_width: name.startsWith("og:") ? meta(html, "og:image:width") : undefined,
      image_height: name.startsWith("og:") ? meta(html, "og:image:height") : undefined }));
  }
  return rankedArticlePhotos(html, pageUrl, [...images.values()], headline);
}

/** Title, date, description, authors and image from schema.org, then Open Graph and HTML. */
export function articleMeta(html: string, pageUrl?: string): PageArticle | null {
  const article = jsonLdNodes(html).find((node) => types(node).some((type) => ARTICLE_TYPES.has(type)));
  const title = (typeof article?.headline === "string" ? article.headline : "") || meta(html, "og:title", "twitter:title")
    || plainText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "", 220) || "";
  if (!title.trim()) return null;
  const rawDate = (typeof article?.datePublished === "string" ? article.datePublished : "") || meta(html, "article:published_time", "og:published_time", "date", "pubdate", "dc.date");
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(rawDate)?.[1] ?? (Number.isFinite(Date.parse(rawDate)) ? new Date(Date.parse(rawDate)).toISOString().slice(0, 10) : null);
  const description = (typeof article?.description === "string" ? article.description : "") || meta(html, "og:description", "description", "twitter:description");
  const keywords = typeof article?.keywords === "string" ? article.keywords.split(",") : Array.isArray(article?.keywords) ? article.keywords.map(String) : meta(html, "keywords", "news_keywords").split(",");
  const candidates = articleImageCandidates(html, pageUrl, title);
  const image = candidates[0];
  return {
    title: plainText(title, 220)?.replace(/\.$/, "") ?? title,
    // A bare 1 January is what a year mention in a title produces; don't trust it.
    date: day && !day.endsWith("-01-01") ? day : null,
    description: plainText(description, 600),
    authors: names(article?.author),
    ...(image ?? { image: null }),
    ...(candidates.length > 1 ? { image_candidates: candidates } : {}),
    section: (typeof article?.articleSection === "string" ? article.articleSection : "") || meta(html, "article:section") || null,
    keywords: keywords.map((value) => value.trim()).filter(Boolean).slice(0, 12),
  };
}

/** The page's main text: <article>, else <main>, else the body without navigation, at most `limit` characters. */
export function mainText(html: string, limit = 12000): string | null {
  const cleaned = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(cleaned)?.[1];
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(cleaned)?.[1];
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(cleaned)?.[1] ?? cleaned;
  const paragraphs = [...(article ?? main ?? body).matchAll(/<(?:p|li|dt|dd)\b[^>]*>([\s\S]*?)<\/(?:p|li|dt|dd)>/gi)].map((match) => plainText(match[1], limit) ?? "").filter(Boolean);
  const text = paragraphs.length >= 2 ? paragraphs.join("\n") : plainText(article ?? main ?? body, limit) ?? "";
  const structured = jsonLdNodes(html).find((node) => types(node).some((type) => ARTICLE_TYPES.has(type)) && typeof node.articleBody === "string");
  const articleBody = structured ? plainText(String(structured.articleBody), limit) ?? "" : "";
  const fullest = articleBody.length > text.length ? articleBody : text;
  return fullest ? fullest.slice(0, limit) : null;
}

const MAX_READABLE_CHARS = 1_500_000;
/** Dates marked up as the page's own. A list of dated items has several, so more than a few says nothing. */
const STAMP = "article time[datetime], main time[datetime], time[itemprop='datePublished'], time.published, time.entry-date";
const MAX_STAMPS = 3;

/** The page read by a parser instead of a model, in milliseconds: its main text, and its date when it has one. */
export function readablePage(html: string): { title: string | null; text: string | null; date: string | null } | null {
  if (html.length > MAX_READABLE_CHARS) return null;
  try {
    const { document } = parseHTML(html);
    const stamps = document.querySelector("article + article") ? [] : [...document.querySelectorAll(STAMP)];
    const stamped = stamps.length && stamps.length <= MAX_STAMPS ? stamps[0].getAttribute("datetime") : null;
    const parsed = new Readability(document as unknown as Document).parse();
    const raw = parsed?.publishedTime ?? stamped ?? "";
    const when = /^\d{4}-\d{2}-\d{2}/.exec(raw)?.[0] ?? (Number.isFinite(Date.parse(raw)) ? new Date(Date.parse(raw)).toISOString().slice(0, 10) : null);
    return { title: parsed?.title?.trim() || null, text: parsed?.textContent?.replace(/\s+/g, " ").trim() || null, date: when };
  } catch { return null; }
}

/** Follow only explicitly useful same-origin documents, never a general link crawl. */
export function supportingLinks(html: string, pageUrl: string) {
  const links: string[] = [];
  const scope = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html;
  const cleaned = scope.replace(/<(nav|header|footer|aside|script|style)\b[\s\S]*?<\/\1>/gi, "");
  for (const match of cleaned.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!/\b(agenda|staff report|official notice|project details|application details|registration details)\b/i.test(plainText(match[2], 200) ?? "")) continue;
    try {
      const url = new URL(decodeHTML(match[1]), pageUrl); url.hash = "";
      if (url.origin !== new URL(pageUrl).origin || !httpsLink(url.toString()) || /\.(docx?|xlsx?|zip)$/i.test(url.pathname) || url.toString() === pageUrl) continue;
      if (!links.includes(url.toString())) links.push(url.toString());
    } catch { /* malformed source link */ }
    if (links.length === 1) break;
  }
  return links;
}

const ARTICLE_HINT = /\/20\d{2}\/|\/news\/|\/events?\/|\/stor(y|ies)\/|\/articles?\/|\/blog\/|\/obituar|\/posts?\/|\/calendar\/|\/announcements?\//i;
export const SKIP_PATH = /\/(tag|tags|category|categories|author|page|wp-content|wp-json|feed|login|search|privacy|terms|contact|about|donate|subscribe|cart|account|shop)(\/|$)/i;

/** Same-site links that look like individual stories, events or obituaries. */
export function storyLinks(html: string, pageUrl: string, cap: number): string[] {
  const out: string[] = [];
  const host = new URL(pageUrl).hostname.replace(/^www\./, "");
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    let url: URL;
    try { url = new URL(decodeHTML(match[1]), pageUrl); } catch { continue; }
    if (url.protocol !== "https:" || url.hostname.replace(/^www\./, "") !== host || SKIP_PATH.test(url.pathname) || /ical/i.test(url.search)) continue;
    url.hash = "";
    const link = url.toString();
    if (link.replace(/\/$/, "") === pageUrl.replace(/\/$/, "") || out.includes(link)) continue;
    const slug = url.pathname.replace(/\/$/, "").split("/").pop() ?? "";
    if (ARTICLE_HINT.test(url.pathname) || (slug.match(/-/g) ?? []).length >= 3) {
      out.push(link);
      if (out.length >= cap) break;
    }
  }
  return out;
}

export function calendarLinks(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/href=["']([^"']*(?:\.ics\b|[?&]ical=1|\/ical\/?|\/ics\/?|webcal:)[^"']*)["']/gi)) {
    try {
      const url = new URL(decodeHTML(match[1]).replace(/^webcal:/i, "https:"), pageUrl).toString();
      if (httpsLink(url) && !out.includes(url)) out.push(url);
    } catch { /* ignore bad hrefs */ }
  }
  return out.slice(0, 2);
}

export type SitemapEntry = { loc: string; lastmod: string | null };
/** A sitemap or sitemap index: child sitemaps and page URLs with their last-modified day. */
export function parseSitemap(xml: string): { sitemaps: SitemapEntry[]; urls: SitemapEntry[] } {
  const entry = (block: string): SitemapEntry | null => {
    const loc = /<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(block)?.[1];
    if (!loc) return null;
    const mod = /<(?:news:publication_date|lastmod)>\s*([\s\S]*?)\s*<\//i.exec(block)?.[1] ?? null;
    const day = mod ? /^(\d{4}-\d{2}-\d{2})/.exec(mod)?.[1] ?? null : null;
    return { loc: decodeHTML(loc.replace(/^<!\[CDATA\[|\]\]>$/g, "")), lastmod: day };
  };
  const sitemaps = [...xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/gi)].map((match) => entry(match[1])).filter((value): value is SitemapEntry => Boolean(value));
  const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)].map((match) => entry(match[1])).filter((value): value is SitemapEntry => Boolean(value));
  return { sitemaps, urls };
}

/** Feed paths sites commonly use. */
export const FEED_GUESSES = ["/feed", "/rss", "/rss.xml", "/news/feed", "/events/feed", "/?feed=rss2", "/feeds/posts/default"];
export const SITEMAP_GUESSES = ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml", "/news-sitemap.xml"];

/** Read only explicitly embedded Trumba configurations; retain the branch filter. */
export function trumbaFeeds(html: string): string[] {
  const feeds = new Set<string>();
  for (const match of html.matchAll(/\bTrumba\.addSpud\s*\(\s*([\s\S]{0,4000}?)\)\s*;/g)) {
    const name = /\bwebName\s*:\s*["']([a-zA-Z0-9_-]+)["']/.exec(match[1])?.[1];
    if (!name) continue;
    const filter = /\bfilterview\s*:\s*["']([^"']+)["']/.exec(match[1])?.[1];
    const url = new URL(`https://www.trumba.com/calendars/${name}.rss`);
    url.searchParams.set("weeks", "4");
    if (filter) url.searchParams.set("filterview", filter);
    feeds.add(url.toString());
  }
  return [...feeds];
}

/** Coordinates explicitly published by the venue page (not inferred from its name). */
export function venuePoint(html: string): [number, number] | null {
  const { document } = parseHTML(html);
  const marker = document.querySelector("[data-map-markerlat][data-map-markerlng]");
  if (!marker) return null;
  const lat = Number(marker.getAttribute("data-map-markerlat")), lon = Number(marker.getAttribute("data-map-markerlng"));
  return Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180 ? [lon, lat] : null;
}
