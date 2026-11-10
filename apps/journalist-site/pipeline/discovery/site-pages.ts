/**
 * Reading a confirmed site for its category pages, with no paid search. A home page rarely links
 * straight to agendas or police news, so the scan also reads a few hub pages ("Government",
 * "Departments", "Schools"), sorts every link into a section, and checks the best few per
 * section. Each page then goes through `evaluateLeads`, the same access, rights, locality and
 * freshness checks as any search result, so nothing here can admit a page they would refuse.
 *
 * What the site links out to comes back too: its hosted meeting portal, and the chambers, PTAs
 * and neighbourhood groups it lists, which are often the only free way to find them.
 */
import type { SectionId } from "../sourcemap/sections";
import { normaliseUrl, webSourceId, type DiscoveryMethod, type SourceCandidate, type SourceScope } from "../sourcemap/store";
import { evaluateLeads, sourceUrl, type Lead, type Rejection } from "./evaluate";
import { hubLinks, outsideLinks, siteLinks, sitemapLinks, type OutsideLink, type SiteKind, type SiteLink } from "./inspect";
import type { DiscoveryContext } from "./methods";
import { mentions } from "../connectors/community";
import { limit, ruleSet } from "../playbook";

const ACCEPT_HTML = "text/html, application/xhtml+xml";
const PAGE_BYTES = 2 * 1024 * 1024;
/** Pages kept per section of one site. Weather isn't scanned for. */
const PER_SECTION = Object.fromEntries(ruleSet("pages_per_site").map((rule) => [rule.section, rule.value])) as Partial<Record<SectionId, number>>;
const MAX_PAGES = limit("general.stop.pages_per_site");
const MAX_PLATFORMS = limit("general.stop.platforms_per_site");
const MAX_GROUPS = limit("general.stop.groups_per_job");
const LINKS_PER_PAGE = limit("general.stop.links_per_page");
const HUB_PAGES = limit("general.stop.hub_pages");
const SITEMAP_BELOW = limit("general.stop.sitemap_below");
const SECOND_STEP_LINKS = limit("general.stop.second_step_links");

export type Site = {
  url: string; name: string; kind: SiteKind; scope: SourceScope;
  /** Only these sections: a county's events aren't a neighbourhood's. */
  sections?: SectionId[];
  /** Hub pages to read for links. */
  hubs?: number; pages?: number;
  /** Keep only links this good: a school's PTA page, not every calendar. */
  bestRank?: number;
  /** Sports pages to keep, when not the section's usual share. */
  sportsPages?: number;
  /** Check the home page as a source too. `family` says how it was found, when not just as a site's home. */
  home?: { section: SectionId; topic: Lead["topic"]; family?: string };
};
export type SiteScan = { candidates: SourceCandidate[]; outside: OutsideLink[]; rejected: Rejection[]; read: Array<[string, string]> };

async function read(context: DiscoveryContext, url: string) {
  try { return await context.fetcher.getText(url, PAGE_BYTES, ACCEPT_HTML); }
  catch (error) { context.log.info("site_page_unreadable", { url, error: String(error) }); return null; }
}

/**
 * The best pages of each section, and no more than a site's share. Sections take turns, so neither
 * the page limit nor a job's deadline falls only on the sections ranked last. Sports pages are read
 * after the rest and on top of the limit, so they take no board, PTA or police page's place.
 */
export function chooseLinks(links: SiteLink[], site: Pick<Site, "sections" | "pages" | "bestRank" | "sportsPages">) {
  const sections = new Map<SectionId, SiteLink[]>();
  const sorted = [...links].sort((a, b) => a.rank - b.rank);
  const sportsPages = site.sportsPages ?? (site.sections && !site.sections.includes("sports") ? 0 : PER_SECTION.sports ?? 0);
  const sports = sorted.filter((link) => link.section === "sports").slice(0, sportsPages);
  for (const link of sorted) {
    const section = link.section as SectionId;
    if (section === "sports") continue;
    const list = sections.get(section) ?? [];
    if (site.sections && !site.sections.includes(section)) continue;
    if (site.bestRank !== undefined && link.rank > site.bestRank) continue;
    if (list.length >= (PER_SECTION[section] ?? 0)) continue;
    sections.set(section, [...list, link]);
  }
  const chosen: SiteLink[] = [];
  for (let turn = 0; [...sections.values()].some((list) => list[turn]); turn += 1) for (const list of sections.values()) if (list[turn]) chosen.push(list[turn]);
  return [...chosen.slice(0, site.pages ?? MAX_PAGES), ...sports];
}

/**
 * Pages of one site often offer the same site-wide feed. Read from each page, that feed would turn
 * agendas and police news into one source with the news page's items, so such pages stay pages.
 */
export function withoutSharedFeeds(candidates: SourceCandidate[], taken: Set<string> = new Set()) {
  const uses = new Map<string, number>();
  for (const candidate of candidates) if (candidate.feed_url) uses.set(candidate.feed_url, (uses.get(candidate.feed_url) ?? 0) + 1);
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const shared = candidate.feed_url && ((uses.get(candidate.feed_url) ?? 0) > 1 || taken.has(candidate.feed_url));
    const page = shared && candidate.url ? { ...candidate, feed_url: null, source_id: webSourceId(candidate.url), source_kind: "listing", params: { ...candidate.params, feed_url: null } } : candidate;
    if (seen.has(page.source_id)) return [];
    seen.add(page.source_id);
    return [page];
  });
}

const leadFor = (site: Site, link: SiteLink): Lead => ({ url: link.url, title: `${site.name}: ${link.title || link.section}`, snippet: "", topic: link.topic, family: "site_section", section: link.section as SectionId, scope: site.scope });

/** The category pages of one confirmed site. `seen` is shared, so no page is checked twice in a job. */
export async function scanSite(context: DiscoveryContext, site: Site, method: DiscoveryMethod, seen: Set<string>, deadline: number, feeds: Set<string> = new Set()): Promise<SiteScan> {
  const home = await read(context, site.url);
  if (!home) return { candidates: [], outside: [], rejected: [{ url: site.url, reason: "the site could not be read" }], read: [] };
  const pages: Array<[string, string]> = [home];
  for (const hub of hubLinks(home[1], home[0], site.hubs ?? HUB_PAGES)) {
    if (Date.now() >= deadline) break;
    const page = await read(context, hub);
    if (page) pages.push(page);
  }
  const found = new Map<string, SiteLink>();
  for (const [url, html] of pages) for (const link of siteLinks(html, url, LINKS_PER_PAGE, site.kind)) if (!found.has(normaliseUrl(link.url))) found.set(normaliseUrl(link.url), link);
  // Links built by script don't show in the page: the sitemap still lists them.
  if (found.size < SITEMAP_BELOW) for (const link of await sitemapLinks(context.fetcher, home[0], LINKS_PER_PAGE, site.kind)) if (!found.has(normaliseUrl(link.url))) found.set(normaliseUrl(link.url), link);
  const outside = pages.flatMap(([url, html]) => outsideLinks(html, url, site.kind)).filter((link, index, all) => all.findIndex((other) => other.url === link.url) === index);
  const leads: Lead[] = [
    ...(site.home ? [{ url: home[0], title: site.name, snippet: "", topic: site.home.topic, family: site.home.family ?? "site_home", section: site.home.section, scope: site.scope }] : []),
    ...chooseLinks([...found.values()], site).map((link) => leadFor(site, link)),
    ...outside.filter((link) => link.kind === "platform").slice(0, MAX_PLATFORMS).map((link): Lead => ({ url: link.url, title: `${site.name}: meetings`, snippet: "", topic: link.topic, family: "meeting_platform", section: link.section as SectionId, scope: site.scope })),
  ];
  const first = await evaluateLeads(context, leads, { method, seen, deadline, fixed: true, siteKind: site.kind });
  // A council's page often holds the link to its agendas: one step further for sections with nothing to read yet.
  const readable = new Set(first.candidates.filter((candidate) => !candidate.link_only).map((candidate) => candidate.section));
  const next = first.links.filter((link) => link.section && PER_SECTION[link.section] && !readable.has(link.section) && link.section !== "sports" && (!site.sections || site.sections.includes(link.section)) && site.bestRank === undefined).slice(0, SECOND_STEP_LINKS);
  const second = await evaluateLeads(context, next.map((link) => ({ ...link, title: `${site.name}: ${link.title}` })), { method, seen, deadline, fixed: true, siteKind: site.kind });
  return { candidates: withoutSharedFeeds([...first.candidates, ...second.candidates], feeds), outside, rejected: [...first.rejected, ...second.rejected], read: pages };
}

/**
 * Groups a site links to, for the sections asked for. They are not the site's own, so they get no
 * scope: each must pass the full locality check. A neighbourhood wants its own groups, not the city's.
 */
export async function checkGroups(context: DiscoveryContext, links: OutsideLink[], sections: SectionId[], method: DiscoveryMethod, seen: Set<string>, deadline: number) {
  const community = context.location.community;
  const leads = links.filter((link) => link.kind === "group" && sections.includes(link.section as SectionId))
    .filter((link) => link.section !== "community" || !community || mentions(link.title, community.name))
    .slice(0, MAX_GROUPS).map((link): Lead => ({ url: link.url, title: link.title, snippet: "", topic: link.topic, family: "linked_group", section: link.section as SectionId }));
  return evaluateLeads(context, leads, { method, seen, deadline, fixed: true });
}

/** The address a check will key this page under, to skip what a job already has. */
export const pageKey = (url: string) => normaliseUrl(sourceUrl(url));
