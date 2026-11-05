/**
 * Looking hard at one page during discovery, for any location: which machine-readable endpoint
 * it offers, what kind of source it is, whether it publishes anything current, and which other
 * sections of the site are worth checking. Platforms are recognised by their fingerprints and
 * every endpoint is fetched and parsed before it is believed, so no site is named in code.
 */
import { decodeHTML } from "entities";
import { addDays, httpsLink, MAX_FEED_BYTES } from "../connectors/common";
import { blockedPlatform, type Fetcher } from "../connectors/fetcher";
import { advertisedFeeds } from "../connectors/feeds";
import { parseIcal } from "../connectors/library/parsers";
import { calendarLinks, mainText, parseSitemap, SKIP_PATH } from "../connectors/web/page";
import { parseNewsFeed } from "../connectors/wider/adapters";
import type { PriorityTopic } from "../core/run-values";
import { normaliseUrl } from "../sourcemap/store";

const ACCEPT_FEED = "application/rss+xml, application/atom+xml, application/xml, text/xml, text/calendar;q=0.9, */*;q=0.5";
/** An endpoint or page with nothing newer than this isn't publishing. */
export const RECENT_DAYS = 120;
const MAX_ENDPOINT_TRIES = 5;

export type Endpoint = { url: string; format: "rss" | "ical"; latest: string; items: number };
export type SourceKind = "feed" | "calendar" | "dataset" | "document_list" | "listing" | "lookup";

/** A feed or calendar counts only if it parses and has something current. */
async function verify(fetcher: Fetcher, url: string, today: string): Promise<Endpoint | null> {
  try {
    const [final, bytes] = await fetcher.get(url, MAX_FEED_BYTES, ACCEPT_FEED);
    if (new TextDecoder().decode(bytes.slice(0, 200)).trimStart().startsWith("BEGIN:VCALENDAR")) {
      const days = parseIcal(bytes).events.map((event) => event.event_date).sort();
      const latest = days.at(-1);
      return latest && latest >= addDays(today, -RECENT_DAYS) ? { url: final, format: "ical", latest, items: days.length } : null;
    }
    const items = parseNewsFeed(bytes);
    const latest = items.map((item) => item.published_day).sort().at(-1);
    return latest && latest >= addDays(today, -RECENT_DAYS) ? { url: final, format: "rss", latest, items: items.length } : null;
  } catch { return null; }
}

function withParam(pageUrl: string, name: string, value: string) {
  const url = new URL(pageUrl);
  url.hash = "";
  url.searchParams.set(name, value);
  return url.toString();
}

/** Where each platform publishes its feeds, recognised from the page's own markup. */
const PLATFORMS: Array<{ test: RegExp; urls(html: string, pageUrl: string): string[] }> = [
  { test: /tribe-events|tribe_events|the-events-calendar/i, urls: (_, page) => [withParam(page, "ical", "1")] },
  { test: /squarespace/i, urls: (_, page) => [withParam(page, "format", "rss")] },
  { test: /trumba\.com/i, urls: (html) => [...html.matchAll(/(?:webName\s*:\s*["']|trumba\.com\/calendars\/)([\w.-]+?)(?:["'.]|\.(?:rss|ics|json))/gi)].map((match) => `https://www.trumba.com/calendars/${match[1]}.rss`) },
  { test: /calendar\.google\.com\/calendar/i, urls: (html) => [...html.matchAll(/calendar\.google\.com\/calendar\/[^"']*?[?&;]src=([^&"';]+)/gi)].map((match) => `https://calendar.google.com/calendar/ical/${encodeURIComponent(decodeURIComponent(decodeHTML(match[1])))}/public/basic.ics`) },
  { test: /wp-content|wp-includes/i, urls: (_, page) => [`${page.split(/[?#]/)[0].replace(/\/?$/, "/")}feed/`, new URL("/feed/", page).toString()] },
];

/** RSS links from a CivicPlus site's feed directory. */
async function civicPlusFeeds(fetcher: Fetcher, pageUrl: string) {
  try {
    const [url, html] = await fetcher.getText(new URL("/rss.aspx", pageUrl).toString(), 2 * 1024 * 1024, "text/html, application/xhtml+xml");
    return [...html.matchAll(/href=["']([^"']*RSSFeed\.aspx\?[^"']+)["']/gi)].flatMap((match) => { try { return [new URL(decodeHTML(match[1]), url).toString()]; } catch { return []; } }).filter((link) => /CID=All/i.test(link)).slice(0, 3);
  } catch { return []; }
}

/** The first feed or calendar this page offers that really works. */
export async function findEndpoint(fetcher: Fetcher, html: string, pageUrl: string, today: string): Promise<Endpoint | null> {
  const candidates = [...advertisedFeeds(html, pageUrl), ...calendarLinks(html, pageUrl)];
  for (const platform of PLATFORMS) if (platform.test.test(html)) candidates.push(...platform.urls(html, pageUrl));
  if (/civicplus|civicengage|CivicAlerts/i.test(html)) candidates.push(...await civicPlusFeeds(fetcher, pageUrl));
  for (const url of [...new Set(candidates.map((value) => httpsLink(value)).filter((value): value is string => Boolean(value)))].slice(0, MAX_ENDPOINT_TRIES)) {
    const found = await verify(fetcher, url, today);
    if (found) return found;
  }
  return null;
}

/** The dataset a Socrata portal page shows, when the URL is one. */
export function datasetOf(url: string): { domain: string; dataset: string } | null {
  try {
    const parsed = new URL(url);
    const dataset = /\/([a-z0-9]{4}-[a-z0-9]{4})(?:\/|$)/.exec(parsed.pathname)?.[1];
    return dataset && /(^|[.-])data\./.test(`.${parsed.hostname}`) ? { domain: parsed.hostname, dataset } : null;
  } catch { return null; }
}

const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const LONG_DATE = new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, "gi");
const NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g;
const NO_YEAR_DATE = new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!,?\\s*\\d)`, "gi");

/** Every date a page's markup or text states, as YYYY-MM-DD. Listings often leave out the year. */
export function datesIn(html: string, today?: string) {
  const days = new Set<string>();
  for (const match of html.matchAll(/(?:datetime|datePublished|dateModified|startDate)["'=:\s]+["']?(20\d{2}-\d{2}-\d{2})/gi)) days.add(match[1]);
  // All visible text: agenda and calendar listings are usually tables, not paragraphs.
  const text = decodeHTML(html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").slice(0, 200_000);
  if (today) {
    const year = Number(today.slice(0, 4));
    for (const match of text.matchAll(NO_YEAR_DATE)) {
      const at = new Date(`${match[1].slice(0, 3)} ${match[2]}, ${year} UTC`);
      if (Number.isNaN(at.getTime())) continue;
      // The nearest such date: "Dec 28" read in January was last year.
      const day = at.toISOString().slice(0, 10);
      days.add(day > addDays(today, 180) ? `${year - 1}${day.slice(4)}` : day < addDays(today, -180) ? `${year + 1}${day.slice(4)}` : day);
    }
  }
  for (const match of text.matchAll(LONG_DATE)) {
    const at = new Date(`${match[1].slice(0, 3)} ${match[2]}, ${match[3]} UTC`);
    if (!Number.isNaN(at.getTime())) days.add(at.toISOString().slice(0, 10));
  }
  for (const match of text.matchAll(NUMERIC_DATE)) days.add(`${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`);
  return [...days].sort();
}

export type Inspection = { kind: SourceKind; fresh: boolean; latest: string | null; upcoming: string | null; dated: number };

/** What kind of source a page is, and whether it is publishing now. */
export function inspectPage(html: string, pageUrl: string, today: string, endpoint: Endpoint | null): Inspection {
  const days = datesIn(html, today);
  const past = days.filter((day) => day <= today);
  const ahead = days.filter((day) => day > today && day <= addDays(today, 365));
  const latest = [endpoint?.latest, past.at(-1)].filter((day): day is string => Boolean(day)).sort().at(-1) ?? null;
  const upcoming = ahead[0] ?? null;
  const fresh = Boolean(upcoming) || Boolean(latest && latest >= addDays(today, -RECENT_DAYS));
  const text = mainText(html) ?? "";
  const documents = (html.match(/href=["'][^"']*\.pdf\b/gi) ?? []).length + (html.match(/href=["'][^"']*(?:DocumentCenter\/View|AgendaCenter\/ViewFile)/gi) ?? []).length;
  const embedded = /<iframe[^>]+(?:tableau|powerbi|arcgis)|experience\.arcgis|public\.tableau\.com|app\.powerbi\.com/i.test(html);
  const form = /<form\b/i.test(html) && /\b(parcel|search by|look ?up|enter (?:an?|your)|account number)\b/i.test(`${pageUrl} ${text.slice(0, 3000)}`);
  const kind: SourceKind = endpoint ? (endpoint.format === "ical" ? "calendar" : "feed")
    : embedded || (form && days.length < 3) ? "lookup"
    : documents >= 3 ? "document_list" : "listing";
  return { kind, fresh, latest, upcoming, dated: days.length };
}

export type SiteLink = { url: string; title: string; topic: PriorityTopic | null; section: string };

/** What a section of a site offers, judged from its link text and address. */
const LINK_TOPICS: Array<{ topic: PriorityTopic | null; section: string; test: RegExp }> = [
  { topic: "crime", section: "safety", test: /\b(police|sheriff|blotter|crime|incidents?|public safety|fire department|911)\b/i },
  { topic: "deaths", section: "obituaries", test: /\b(obituar(?:y|ies)|memorials?|tributes|recent services)\b/i },
  { topic: "home_sales", section: "real_estate", test: /\b(permits?|land use|assessor|zoning|recorder|property sales|development notices?|public notices?)\b/i },
  { topic: "sports", section: "sports", test: /\b(athletics?|sports|teams?|standings|scores|league|game schedule)\b/i },
  { topic: "events", section: "events", test: /\b(calendar|events?|meetings?|programs|classes|recreation)\b/i },
  { topic: null, section: "civic", test: /\b(agendas?|minutes|city council|councilmember|town hall|legislation)\b/i },
  { topic: null, section: "news", test: /\b(news(?:letter|flash|room)?|press releases?|announcements?|alerts?|notices?|blog)\b/i },
  { topic: null, section: "community", test: /\b(projects?|capital improvements?|transportation|service advisor(?:y|ies)|parks?|librar(?:y|ies)|community centers?)\b/i },
];
const siteRoot = (host: string) => host.toLowerCase().replace(/^www\./, "").split(".").slice(-2).join(".");

function classifyLink(url: URL, title: string): SiteLink | null {
  const words = `${title} ${url.pathname.replace(/[/_-]+/g, " ")}`;
  const match = LINK_TOPICS.find((entry) => entry.test.test(words));
  return match ? { url: url.toString(), title: title.slice(0, 120), topic: match.topic, section: match.section } : null;
}

/** Sections of a site worth checking as sources of their own, best-matched first. */
export function siteLinks(html: string, pageUrl: string, cap = 8): SiteLink[] {
  const root = siteRoot(new URL(pageUrl).hostname);
  const seen = new Set<string>([normaliseUrl(pageUrl)]);
  const out: SiteLink[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try { url = new URL(decodeHTML(match[1]), pageUrl); } catch { continue; }
    if (url.protocol !== "https:" || siteRoot(url.hostname) !== root || blockedPlatform(url.toString()) || SKIP_PATH.test(url.pathname) || /\.(pdf|docx?|xlsx?|zip|jpe?g|png)$/i.test(url.pathname)) continue;
    // One story isn't a source: its listing is.
    if (/\/20\d{2}\/\d{1,2}\//.test(url.pathname) || (url.pathname.split("/").pop()?.match(/-/g) ?? []).length >= 6) continue;
    url.hash = "";
    // One page per address: a calendar links to itself once for every day.
    const key = normaliseUrl(`${url.origin}${url.pathname}`);
    if (seen.has(key)) continue;
    seen.add(key);
    const link = classifyLink(url, decodeHTML(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());
    if (link) out.push(link);
  }
  // Priority topics first, then a spread of the rest.
  return out.sort((a, b) => Number(Boolean(b.topic)) - Number(Boolean(a.topic))).slice(0, cap);
}

/** The same, from a site's sitemap, for sites whose links are built by script. */
export async function sitemapLinks(fetcher: Fetcher, pageUrl: string, cap = 8): Promise<SiteLink[]> {
  const listed = await fetcher.sitemaps(pageUrl).catch(() => [] as string[]);
  const sitemap = listed[0] ?? new URL("/sitemap.xml", pageUrl).toString();
  try {
    const [, xml] = await fetcher.getText(sitemap, 4 * 1024 * 1024, "application/xml, text/xml");
    const parsed = parseSitemap(xml);
    const out: SiteLink[] = [];
    for (const entry of parsed.urls) {
      let url: URL;
      try { url = new URL(entry.loc); } catch { continue; }
      if (url.protocol !== "https:" || SKIP_PATH.test(url.pathname) || url.pathname.split("/").filter(Boolean).length > 3) continue;
      const link = classifyLink(url, "");
      if (link) out.push(link);
    }
    return out.sort((a, b) => Number(Boolean(b.topic)) - Number(Boolean(a.topic))).slice(0, cap);
  } catch { return []; }
}
