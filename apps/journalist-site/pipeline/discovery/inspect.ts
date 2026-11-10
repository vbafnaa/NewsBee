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
import { limit, regex, ruleSet } from "../playbook";
import { normaliseUrl } from "../sourcemap/store";

const ACCEPT_FEED = "application/rss+xml, application/atom+xml, application/xml, text/xml, text/calendar;q=0.9, */*;q=0.5";
/** An endpoint or page with nothing newer than this isn't publishing. */
export const RECENT_DAYS = limit("general.stop.recent_days");
const MAX_ENDPOINT_TRIES = limit("general.stop.endpoint_tries");
const ENDPOINT_TITLES = limit("general.stop.gemini_check_titles");
const DOCUMENT_LIST_MIN = limit("general.stop.document_list_min");
const LOOKUP_MAX_DATES = limit("general.stop.lookup_max_dates");
const LOOKUP_EMBED = regex("general.page.lookup_embed");
const LOOKUP_FORM = regex("general.page.lookup_form");

/** `titles` are its newest items' titles and `recent` how many it dated in the last RECENT_DAYS, for the model check. */
export type Endpoint = { url: string; format: "rss" | "ical"; latest: string; items: number; titles?: string[]; recent?: number };
export type SourceKind = "feed" | "calendar" | "dataset" | "document_list" | "listing" | "lookup";

/** A feed or calendar counts only if it parses and has something current. */
async function verify(fetcher: Fetcher, url: string, today: string): Promise<Endpoint | null> {
  try {
    const [final, bytes] = await fetcher.get(url, MAX_FEED_BYTES, ACCEPT_FEED);
    const since = addDays(today, -RECENT_DAYS);
    const newest = (items: Array<{ title: string; day: string }>) => [...items].sort((a, b) => b.day.localeCompare(a.day)).map((item) => item.title).filter(Boolean).slice(0, ENDPOINT_TITLES);
    if (new TextDecoder().decode(bytes.slice(0, 200)).trimStart().startsWith("BEGIN:VCALENDAR")) {
      const events = parseIcal(bytes).events;
      const days = events.map((event) => event.event_date).sort();
      const latest = days.at(-1);
      return latest && latest >= since ? { url: final, format: "ical", latest, items: days.length, titles: newest(events.map((event) => ({ title: event.title, day: event.event_date }))), recent: days.filter((day) => day >= since).length } : null;
    }
    const items = parseNewsFeed(bytes);
    const latest = items.map((item) => item.published_day).sort().at(-1);
    return latest && latest >= since ? { url: final, format: "rss", latest, items: items.length, titles: newest(items.map((item) => ({ title: item.title, day: item.published_day }))), recent: items.filter((item) => item.published_day >= since && item.published_day <= today).length } : null;
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

/** The first feed or calendar this page offers that really works. `known` feeds, from a reader that already listed them, are tried first. */
export async function findEndpoint(fetcher: Fetcher, html: string, pageUrl: string, today: string, known: string[] = []): Promise<Endpoint | null> {
  const candidates = [...known, ...advertisedFeeds(html, pageUrl), ...calendarLinks(html, pageUrl)];
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

/** Every date a page states, as YYYY-MM-DD, by where it was found: the markup or the visible text. */
export function datesBySource(html: string, today?: string) {
  const markup = new Set<string>(), days = new Set<string>();
  for (const match of html.matchAll(/(?:datetime|datePublished|dateModified|startDate)["'=:\s]+["']?(20\d{2}-\d{2}-\d{2})/gi)) markup.add(match[1]);
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
  return { markup: [...markup].sort(), text: [...days].sort() };
}

/** Every date a page's markup or text states, as YYYY-MM-DD. Listings often leave out the year. */
export function datesIn(html: string, today?: string) {
  const found = datesBySource(html, today);
  return [...new Set([...found.markup, ...found.text])].sort();
}

export type Inspection = { kind: SourceKind; fresh: boolean; latest: string | null; upcoming: string | null; dated: number; dates: { markup: string[]; text: string[] } };

/** A page's item headings, in page order: what the model check and the final review read as its recent titles. */
export function pageTitles(html: string, count = ENDPOINT_TITLES) {
  const out: string[] = [];
  for (const match of html.matchAll(/<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/gi)) {
    const title = decodeHTML(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (title.length >= 12 && title.length <= 160 && !out.includes(title)) out.push(title);
    if (out.length >= count) break;
  }
  return out;
}

/** What kind of source a page is, and whether it is publishing now. */
export function inspectPage(html: string, pageUrl: string, today: string, endpoint: Endpoint | null): Inspection {
  const dates = datesBySource(html, today);
  const days = [...new Set([...dates.markup, ...dates.text])].sort();
  const past = days.filter((day) => day <= today);
  const ahead = days.filter((day) => day > today && day <= addDays(today, 365));
  const latest = [endpoint?.latest, past.at(-1)].filter((day): day is string => Boolean(day)).sort().at(-1) ?? null;
  const upcoming = ahead[0] ?? null;
  const fresh = Boolean(upcoming) || Boolean(latest && latest >= addDays(today, -RECENT_DAYS));
  const text = mainText(html) ?? "";
  const documents = (html.match(/href=["'][^"']*\.pdf\b/gi) ?? []).length + (html.match(/href=["'][^"']*(?:DocumentCenter\/View|AgendaCenter\/ViewFile)/gi) ?? []).length;
  const embedded = LOOKUP_EMBED.test(html);
  const form = /<form\b/i.test(html) && LOOKUP_FORM.test(`${pageUrl} ${text.slice(0, 3000)}`);
  const kind: SourceKind = endpoint ? (endpoint.format === "ical" ? "calendar" : "feed")
    : embedded || (form && days.length < LOOKUP_MAX_DATES) ? "lookup"
    : documents >= DOCUMENT_LIST_MIN ? "document_list" : "listing";
  return { kind, fresh, latest, upcoming, dated: days.length, dates };
}

/** `lastmod` is the sitemap's last-modified day, when the link came from one. */
export type SiteLink = { url: string; title: string; topic: PriorityTopic | null; section: string; rank: number; lastmod?: string | null };
/** Whose site it is: the same words mean different things on a council's site and a school's. */
export type SiteKind = "government" | "school" | "organisation";
type LinkRule = { topic: PriorityTopic | null; section: string; test: RegExp };

const linkRules = (set: string) => ruleSet(set).map((rule): LinkRule => ({ topic: rule.topic as PriorityTopic | null, section: rule.section, test: rule.test }));
/** What a section of a site offers, judged from its link text and address. First match wins, and earlier rules are the better pages. */
const LINK_TOPICS = linkRules("site_links");
/** On a school or district site, meetings, calendars and news are all the school's. */
const SCHOOL_LINK_TOPICS = linkRules("school_site_links");
/** Pages that link on to the sections, worth reading for their links. */
const HUB = regex("general.page.hub");
/** One meeting, alert or event, not its listing. */
const ONE_ITEM = regex("general.page.one_item");
/** Hosted meeting portals a public body links out to. Most build their pages by script. */
const MEETING_PLATFORM = regex("civic.page.meeting_platforms");
/** Local groups a public body links out to, judged from the link text and the host. */
const GROUP_LINKS = linkRules("group_links");
const HUB_TITLE_MAX = limit("general.stop.hub_title_max");
const GROUP_TITLE_MAX = limit("general.stop.group_title_max");
const STORY_SLUG_HYPHENS = limit("general.stop.story_slug_hyphens");
const LINK_CANDIDATES = limit("general.stop.link_candidates_default");
const siteRoot = (host: string) => host.toLowerCase().replace(/^www\./, "").split(".").slice(-2).join(".");

function classifyLink(url: URL, title: string, kind: SiteKind): SiteLink | null {
  const words = `${title} ${url.pathname.replace(/[/_-]+/g, " ")}`;
  const rules = kind === "school" ? SCHOOL_LINK_TOPICS : LINK_TOPICS;
  const rank = rules.findIndex((entry) => entry.test.test(words));
  return rank < 0 ? null : { url: url.toString(), title: title.slice(0, 120), topic: rules[rank].topic, section: rules[rank].section, rank };
}

/** The best links, taking each section in turn so one busy section can't fill the list. */
function spread(links: SiteLink[], cap: number) {
  const sorted = [...links].sort((a, b) => a.rank - b.rank);
  const sections = [...new Set(sorted.map((link) => link.section))].map((section) => sorted.filter((link) => link.section === section));
  const out: SiteLink[] = [];
  for (let turn = 0; out.length < cap && sections.some((list) => list[turn]); turn += 1) for (const list of sections) if (list[turn] && out.length < cap) out.push(list[turn]);
  return out;
}

function anchors(html: string, pageUrl: string) {
  return [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)].flatMap((match) => {
    try { return [{ url: new URL(decodeHTML(match[1]), pageUrl), title: decodeHTML(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() }]; }
    catch { return []; }
  });
}

/** Pages of the same site whose links are worth reading: a home page often stops at "Government". */
export function hubLinks(html: string, pageUrl: string, cap = limit("general.stop.hub_pages")) {
  const root = siteRoot(new URL(pageUrl).hostname);
  const seen = new Set<string>([normaliseUrl(pageUrl)]);
  const out: string[] = [];
  for (const { url, title } of anchors(html, pageUrl)) {
    if (url.protocol !== "https:" || siteRoot(url.hostname) !== root || title.length > HUB_TITLE_MAX || !HUB.test(title) || ONE_ITEM.test(url.search) || /\.(pdf|docx?|xlsx?|zip|jpe?g|png)$/i.test(url.pathname)) continue;
    const key = normaliseUrl(`${url.origin}${url.pathname}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url.toString());
  }
  return out.slice(0, cap);
}

export type OutsideLink = { url: string; title: string; kind: "platform" | "group"; topic: PriorityTopic | null; section: string };

/** Links leaving a public body's site that are sources themselves: its meeting portal, and the groups it lists. */
export function outsideLinks(html: string, pageUrl: string, site: SiteKind): OutsideLink[] {
  const root = siteRoot(new URL(pageUrl).hostname);
  const seen = new Set<string>();
  const out: OutsideLink[] = [];
  for (const { url, title } of anchors(html, pageUrl)) {
    if (!/^https?:$/.test(url.protocol) || siteRoot(url.hostname) === root || blockedPlatform(url.toString())) continue;
    url.protocol = "https:";
    url.hash = "";
    const key = normaliseUrl(url.toString());
    if (seen.has(key)) continue;
    seen.add(key);
    if (MEETING_PLATFORM.test(url.hostname)) { out.push({ url: url.toString(), title: title.slice(0, 120), kind: "platform", topic: site === "school" ? "schools" : "government", section: site === "school" ? "schools" : "civic" }); continue; }
    const rule = GROUP_LINKS.find((entry) => entry.test.test(`${title} ${url.hostname.replace(/[.-]/g, " ")}`));
    if (rule && title.length <= GROUP_TITLE_MAX) out.push({ url: url.toString(), title: title.slice(0, 120), kind: "group", topic: rule.topic, section: rule.section });
  }
  return out;
}

/** Sections of a site worth checking as sources of their own, best-matched first. */
export function siteLinks(html: string, pageUrl: string, cap = LINK_CANDIDATES, kind: SiteKind = "government"): SiteLink[] {
  const root = siteRoot(new URL(pageUrl).hostname);
  const seen = new Set<string>([normaliseUrl(pageUrl)]);
  const out: SiteLink[] = [];
  for (const { url, title } of anchors(html, pageUrl)) {
    if (url.protocol !== "https:" || siteRoot(url.hostname) !== root || blockedPlatform(url.toString()) || SKIP_PATH.test(url.pathname) || ONE_ITEM.test(url.search) || /\.(pdf|docx?|xlsx?|zip|jpe?g|png)$/i.test(url.pathname)) continue;
    // One story isn't a source: its listing is.
    if (/\/20\d{2}\/\d{1,2}\//.test(url.pathname) || (url.pathname.split("/").pop()?.match(/-/g) ?? []).length >= STORY_SLUG_HYPHENS) continue;
    url.hash = "";
    // One page per address: a calendar links to itself once for every day.
    const key = normaliseUrl(`${url.origin}${url.pathname}`);
    if (seen.has(key)) continue;
    seen.add(key);
    const link = classifyLink(url, title, kind);
    if (link) out.push(link);
  }
  return spread(out, cap);
}

/** The same, from a site's sitemap, for sites whose links are built by script. */
export async function sitemapLinks(fetcher: Fetcher, pageUrl: string, cap = LINK_CANDIDATES, kind: SiteKind = "government"): Promise<SiteLink[]> {
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
      const link = classifyLink(url, "", kind);
      if (link) out.push({ ...link, lastmod: entry.lastmod });
    }
    return spread(out, cap);
  } catch { return []; }
}
