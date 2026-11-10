/**
 * Turning leads into source candidates. Discovery and retrieval stay separate: a search result,
 * an institution's website or a link from a good site is a lead, and becomes a source only after
 * it is fetched and checked for access, coverage and whether it publishes anything current. The
 * fixed readers and the mapping agent's proposals both come through here, and every step goes
 * into the decision log. Every page is opened the same way (`openPage`), and the reader that
 * opened it is kept on the source (`found_by.opened_with`).
 *
 * The checks fall into four groups (see ./checks.ts): Safety and Quality are always on here, Access
 * follows the run's Access setting, and Evidence collects locality and freshness facts, deciding
 * only clear cases. The facts are kept on each candidate and in the decision log. A page whose
 * locality is unclear goes on to the shared Model check (./gemini-check.ts), which decides it;
 * with the check switched off for a baseline test it is rejected, as before the check existed.
 *
 * The model never sets `inside_area`: only the page's own title naming the place does, because
 * that field skips the locality filter. A source can cover a place without naming it (a city's
 * police, a county assessor): it is kept with its `scope`, and each of its items still has to
 * pass the locality filter. All fetches use a Fetcher with the private-address check and a fixed
 * Accept header, so the access rules can't be sidestepped.
 */
import { blockedPlatform, DiscoveryBlockedError, Fetcher } from "../connectors/fetcher";
import { HttpStatusError } from "../core/http";
import { publicSourceTransport } from "../connectors/public-http";
import { publicApiGet } from "../connectors/public-api";
import { mentions } from "../connectors/community";
import { aggregator } from "../connectors/newssearch";
import { jinaHtml, jinaRead } from "../connectors/web/jina";
import { articleMeta, mainText, pageRights, rightsAction } from "../connectors/web/page";
import type { ConnectorContext } from "../connectors/types";
import { accessIgnored, currentOptions, runContext, type PriorityTopic } from "../core/run-options";
import { limit, regex, table } from "../playbook";
import { classify, type Classification } from "../search/classifier";
import type { SectionId } from "../sourcemap/sections";
import { hostOf, normaliseUrl, webSourceId, type DiscoveryMethod, type SourceAccess, type SourceCandidate, type SourceScope, type SourceTier } from "../sourcemap/store";
import { paidCall } from "../trace/gateway";
import { recordDecision } from "../trace/decisions";
import { areaFacts } from "./area";
import { addressFacts, freshnessFacts, localityFacts, nameFacts, otherPlace, type PageChecks } from "./checks";
import { CHECK_PAGE_CHARS, geminiCheckOn } from "./gemini-check";
import { verifiedCitySite } from "./city-site";
import { findFeed } from "./feeds";
import { datasetOf, findEndpoint, inspectPage, pageTitles, type Endpoint, RECENT_DAYS, siteLinks, sitemapLinks, type SiteKind, type SiteLink } from "./inspect";
import { addDays } from "../connectors/common";
import type { DiscoveryContext } from "./methods";
import { TOPIC_SECTIONS, type PlannedQuery } from "./topics";

const ACCEPT_HTML = "text/html, application/xhtml+xml";
const THIN_PAGE = limit("general.stop.thin_page_chars");
const STALE_MIN_DATES = limit("general.stop.stale_min_dates");
const DATASET_RECENT_DAYS = limit("general.stop.dataset_recent_days");
const FOLLOWUP_LINKS_MIN = limit("general.stop.followup_links_min");
const FIRE_DATASET = regex("general.evidence.dataset_fire_words");
const PAGE_STORY_KINDS = table("general.evidence.page_story_kinds");
const TERMS_LINK = /href=["']([^"']*(?:terms|tos|legal)[^"']*)["']/i;
const TERMS_RESTRICTION = /\b(scrap(?:e|ing)|automated (?:means|access|systems)|crawl(?:er|ing)?|robots?|data mining)\b/i;
/** Stop starting new work this long into a job, so it finishes inside the function limit. */
export const JOB_DEADLINE_MS = 200_000;

function placeNames(context: DiscoveryContext) {
  const community = context.location.community;
  return community ? [community.name, ...community.coverage_terms] : [context.location.name.split(",")[0]];
}
function quoteAround(text: string, name: string) {
  const at = text.toLowerCase().indexOf(name.toLowerCase());
  return at < 0 ? null : text.slice(Math.max(0, at - 80), at + name.length + 120).replace(/\s+/g, " ").trim();
}

/** Automated part of the site terms check: look for a terms page that mentions scraping. */
async function termsCheck(fetcher: Fetcher, html: string, pageUrl: string): Promise<SourceAccess["terms"]> {
  if (accessIgnored("terms", true)) return "skipped";
  const link = TERMS_LINK.exec(html)?.[1];
  if (!link) return "not_checked";
  try {
    const [, terms] = await fetcher.getText(new URL(link, pageUrl).toString(), 1024 * 1024, ACCEPT_HTML);
    return TERMS_RESTRICTION.test(terms) ? "mentions_restrictions" : "no_restriction_found";
  } catch { return "not_checked"; }
}

/** Which reader opened a page: our fetcher, Jina Reader (free), or a paid fallback. */
export type PageReader = "fetcher" | "jina" | "scrapingbee" | "brightdata";
/** A reader that was tried before the one that opened the page, and why it wasn't enough. */
export type ReaderFallback = { reader: PageReader; why: string };
/**
 * A page as the checks read it, and how it was opened. `endpointHtml` is the markup feeds and calendars are looked for in.
 * `fallbacks` lists the readers tried first, in order, and why each wasn't enough.
 */
export type OpenedPage = { url: string; headers: Record<string, string>; html: string; endpointHtml: string; text: string; action: ReturnType<typeof rightsAction>; reader: PageReader; unblocked: boolean; fallbacks: ReaderFallback[] };
/** Statuses a site, not a rule, refused us with: under Relaxed only, Bright Data may open the page instead. */
const UNBLOCK_STATUSES = new Set([403, 429, 503]);

/** A JavaScript-rendered page through ScrapingBee. Anti-bot options stay off. */
async function scrapingBeePage(context: DiscoveryContext, url: string) {
  const key = context.settings.integrations.scrapingbeeKey;
  if (!key) return null;
  const params = new URLSearchParams({ url, render_js: "True" });
  const outcome = await paidCall("scrapingbee", async () => {
    const response = await context.transport({ url: `https://app.scrapingbee.com/api/v1?${params}`, headers: { Authorization: `Bearer ${key}` }, timeoutMs: 60_000 });
    if (response.status >= 400) throw new Error(`ScrapingBee returned HTTP ${response.status}`);
    return new TextDecoder().decode(response.body);
  }).catch(() => ({ value: null }));
  return outcome.value;
}

/** A page through Bright Data's Web Unlocker, when the run ticks it: it renders scripts, in the US. Whether it may get past a block is the caller's decision. */
async function brightDataPage(context: DiscoveryContext, url: string) {
  const key = context.settings.integrations?.brightdataKey, zone = context.settings.integrations?.brightdataUnlockerZone;
  if (!key || !zone || currentOptions().paid.brightdata_open === undefined) return null;
  const outcome = await paidCall("brightdata_open", async () => {
    const response = await context.transport({
      url: "https://api.brightdata.com/request", method: "POST", timeoutMs: 60_000,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ zone, url, format: "raw", country: "us" }),
    });
    if (response.status >= 400) throw new Error(`Bright Data returned HTTP ${response.status}`);
    return new TextDecoder().decode(response.body);
  }).catch(() => ({ value: null }));
  return outcome.value;
}

/** The paid fallback for a page built by script: ScrapingBee or Bright Data, whichever the run ticks. Agent runs never use ScrapingBee. */
async function renderedPage(context: DiscoveryContext, url: string, method: DiscoveryMethod): Promise<{ html: string; reader: PageReader } | null> {
  if (method !== "agent" && currentOptions().paid.scrapingbee !== undefined) {
    const html = await scrapingBeePage(context, url);
    if (html) return { html, reader: "scrapingbee" };
  }
  const html = await brightDataPage(context, url);
  return html ? { html, reader: "brightdata" } : null;
}

/**
 * Open a page the one way every route does: our fetcher (robots, crawl delays, private
 * addresses, the never-read list), then Jina Reader for a page built by script, then the run's
 * paid fallback. Under Relaxed only, a page whose site refused our reader is opened through
 * Bright Data; robots, logins and the never-read list are never got past this way. Throws
 * what the fetcher threw when the page can't be opened.
 */
export async function openPage(context: DiscoveryContext, fetcher: Fetcher, url: string, method: DiscoveryMethod): Promise<OpenedPage> {
  let page: { url: string; body: Uint8Array; headers: Record<string, string> };
  let reader: PageReader = "fetcher", unblocked = false;
  const fallbacks: ReaderFallback[] = [];
  try { page = await fetcher.getResponse(url, 2 * 1024 * 1024, ACCEPT_HTML); }
  catch (error) {
    const status = error instanceof HttpStatusError || error instanceof DiscoveryBlockedError ? error.status : null;
    const html = status && UNBLOCK_STATUSES.has(status) && accessIgnored("blocks") ? await brightDataPage(context, url) : null;
    if (!html) throw error;
    accessIgnored("blocks", true);
    page = { url, body: new TextEncoder().encode(html), headers: {} };
    reader = "brightdata";
    unblocked = true;
    fallbacks.push({ reader: "fetcher", why: `the site refused our reader (HTTP ${status})` });
  }
  let html = new TextDecoder().decode(page.body);
  const action = rightsAction(pageRights(page.headers, html));
  let text = action === "ok" ? mainText(html) ?? "" : "";
  let endpointHtml = html;
  if (action === "ok" && text.length < THIN_PAGE && reader === "fetcher") {
    fallbacks.push({ reader: "fetcher", why: `${text.length} characters of text, under ${THIN_PAGE}: probably built by script` });
    const read = await jinaRead(context.transport, context.settings.integrations?.jinaKey, page.url);
    const rendered = read ? null : await renderedPage(context, page.url, method);
    if (read) { html = jinaHtml(read); reader = "jina"; }
    else fallbacks.push({ reader: "jina", why: "Jina Reader returned no usable text" });
    if (rendered) { html = rendered.html; endpointHtml = rendered.html; reader = rendered.reader; }
    if (read || rendered) text = mainText(html) ?? text;
  }
  return { url: page.url, headers: page.headers, html, endpointHtml, text, action, reader, unblocked, fallbacks };
}

/** The page itself is the source. A single dated story isn't: its listing is. */
export function sourceUrl(url: string) {
  const parsed = new URL(url);
  parsed.hash = "";
  const dated = /^(.*?)\/20\d{2}\/\d{1,2}\/.*$/.exec(parsed.pathname);
  if (dated) { parsed.pathname = dated[1] || "/"; parsed.search = ""; }
  return parsed.toString();
}

function propertyCandidate(result: { url: string; title: string; snippet: string }, query: PlannedQuery, method: DiscoveryMethod, tier: SourceTier, access: SourceAccess): SourceCandidate {
  return {
    source_id: `property:${webSourceId(result.url).slice(4)}`, name: result.title || hostOf(result.url), url: result.url, feed_url: null, reader: "property",
    params: { backend: "csv", url: result.url }, section: "real_estate", found_by: { method, detail: `Sales data file found by search (${query.family})`, query: query.query },
    inside_area: false, status: "proposed", source_tier: tier, access, topics: ["home_sales"], why: "A county sales data file", evidence: [{ url: result.url, quote: result.snippet || null, kind: "search", at: Date.now() / 1000 }],
  };
}

const siteRoot = (host: string) => host.split(".").slice(-2).join(".");

export type EvaluatedSource = { candidate: SourceCandidate; excerpt: string };
/**
 * Something worth checking, wherever it came from. `scope` is set when its coverage is already known, and `lastmod` when a sitemap dated it.
 * A fixed reader can say what the page's stories are (`kind`) and which feeds it already knows of (`feeds`, tried first and still verified).
 */
export type Lead = { url: string; title: string; snippet: string; topic: PriorityTopic | null; family: string; query?: string | null; section?: SectionId; scope?: SourceScope; lastmod?: string | null; kind?: string; feeds?: string[] };
export type Rejection = { url: string; reason: string };

export type EvaluationResult = {
  candidates: SourceCandidate[];
  checked: EvaluatedSource[];
  /** Other sections of the sites that passed, to check next. */
  links: Lead[];
  rejected: Rejection[];
  /** Leads not reached before the deadline. */
  leftover: Lead[];
  hosts: string[];
  counts: { queries: number; results: number; fetched: number; skipped: number; failed: number; not_run: number };
};
function emptyResult(): EvaluationResult { return { candidates: [], checked: [], links: [], rejected: [], leftover: [], hosts: [], counts: { queries: 0, results: 0, fetched: 0, skipped: 0, failed: 0, not_run: 0 } }; }

/** `fixed`: a method of the current flow, whose checked pages are active sources rather than proposals. */
type Options = { method: DiscoveryMethod; seen: Set<string>; origin?: "template" | "agent"; deadline?: number; fixed?: boolean; siteKind?: SiteKind };

/** Check one lead. Returns whether it became a source. */
async function checkLead(context: DiscoveryContext, fetcher: Fetcher, lead: Lead, verdict: Classification | null, options: Options, out: EvaluationResult) {
  const scoreOf = verdict ?? await classify(context.settings, context.transport, { url: lead.url, title: lead.title, snippet: lead.snippet, query: lead.query ?? undefined, topic: lead.topic, place: placeNames(context)[0] });
  const names = placeNames(context);
  const place = names[0];
  const host = hostOf(lead.url);
  // Anything on the city's checked website is the city's own, whatever its address looks like.
  const citySite = await verifiedCitySite(context as never).catch(() => null);
  const onCitySite = Boolean(citySite && siteRoot(host) === siteRoot(citySite.host));
  const tier: SourceTier = onCitySite ? "official" : scoreOf.tier;
  const query = { topic: lead.topic, family: lead.family, query: lead.query ?? lead.url, stage: "stage1" as const };
  const reject = (url: string, reason: string) => { out.rejected.push({ url, reason }); };
  const note = (decision: string, reason: string, rule: string | null = null, extra: Record<string, unknown> = {}, blocked: string[] = []) => recordDecision({
    stage: decision === "fetch" ? "fetch" : "result", actor: scoreOf.decided_by === "jev" ? "classifier" : "rule", subject: lead.url, decision, reason, rule, topic: lead.topic, model: scoreOf.model,
    evidence: { query: lead.query ?? null, family: lead.family, method: options.method, tier, rules_tier: scoreOf.rules_tier, jev: scoreOf.jev, ...opened, ...extra }, would_have_blocked: blocked,
  });
  // Once the page is open, every note says which reader opened it and which were tried first.
  let opened: { reader?: PageReader; fallbacks?: ReaderFallback[] } = {};
  const section: SectionId = lead.section ?? (lead.topic ? TOPIC_SECTIONS[lead.topic] : "community");
  const topics = lead.topic ? [lead.topic] : [];
  const checkedAt = Date.now() / 1000;
  const standing = options.fixed ? { status: "active" as const, section_page: true } : { status: "proposed" as const };
  const foundBy = (detail: string, opened?: PageReader) => ({ method: options.method, detail: `${detail}${lead.topic ? ` (${lead.topic})` : ""}`, query: lead.query ?? null, ...(opened ? { opened_with: opened } : {}) });
  // Access rules this lead's checks skip, from here on, for the candidate's record.
  const skippedBefore = new Set(runContext()?.overrides ?? []);
  // A platform on the never-read list (Access: a relaxed run may read it), or an aggregator (Quality:
  // always on). A public agency's account is still worth a link.
  const neverRead = blockedPlatform(lead.url);
  if ((neverRead && !accessIgnored("never_read", true)) || (!neverRead && aggregator(lead.url))) {
    const keep = names.some((name) => mentions(`${lead.title} ${lead.snippet}`, name));
    // Kept only when what was shown names the place; the log says which, for the Source runs code check.
    await note("link_only_lead", keep ? "platform or aggregator we never read: kept as a link-only lead" : neverRead ? "a platform we never read, and nothing shown names the place" : "an aggregator that reposts others, and nothing shown names the place",
      neverRead ? "access:never_read" : "quality:aggregator", { outcome: keep ? "link_only" : "dropped" });
    if (keep) out.candidates.push({
      source_id: webSourceId(lead.url), name: (lead.title || host).slice(0, 120), url: lead.url, feed_url: null, reader: "web", params: { url: lead.url, section, inside_area: false }, section, found_by: foundBy(`${lead.family}: platform we don't read, kept as a link`), inside_area: false, link_only: true, ...standing, source_tier: tier, topics, why: "On a platform we don't read: an editor can check it", source_kind: "lookup",
      access: { robots: "blocked", rights: "unknown", terms: "not_checked", checked_at: checkedAt, fresh: false }, evidence: lead.snippet ? [{ url: lead.url, quote: lead.snippet, kind: "search", at: checkedAt }] : [],
    });
    else reject(lead.url, neverRead ? "a platform we never read, and nothing shown names the place" : "an aggregator that reposts others, and nothing shown names the place");
    return;
  }
  // Quality is always on in discovery, whatever the run's guardrails. The never-read platforms are
  // also on the aggregator list; past this point a relaxed run has chosen to read them, so Access decides.
  if (tier === "repost" && !neverRead) { await note("skipped", "reposts other sources", "quality:repost"); reject(lead.url, "reposts other sources"); return; }
  out.counts.fetched += 1;
  if (/\.csv(\?|$)/i.test(lead.url)) {
    const property = propertyCandidate(lead, { ...query }, options.method, tier, { robots: "allowed", rights: "ok", terms: "not_checked", checked_at: checkedAt, fresh: true });
    out.candidates.push(property);
    await note("fetch", "sales data file: the property reader checks it at collection", null, { outcome: "kept", source_id: property.source_id, source_url: property.url, section: property.section, structured: true });
    return;
  }
  // An open-data dataset is read through its own API, by the open-data reader.
  const dataset = datasetOf(lead.url);
  const datasetTopic = lead.topic === "crime" ? (FIRE_DATASET.test(`${lead.title} ${lead.snippet}`) ? "fire" : "police") : lead.topic === "home_sales" ? "permits" : null;
  if (dataset && datasetTopic) {
    try {
      const view = JSON.parse(new TextDecoder().decode(await publicApiGet(context.transport, `https://${dataset.domain}/api/views/${dataset.dataset}.json`, "application/json", 2 * 1024 * 1024, 20_000))) as { name?: string; attribution?: string; rowsUpdatedAt?: number };
      const updated = Number(view.rowsUpdatedAt ?? 0) * 1000;
      if (updated && Date.now() - updated > DATASET_RECENT_DAYS * 86400_000) { await note("fetch", "dataset hasn't been updated recently", "stale", { outcome: "stale" }); reject(lead.url, "dataset hasn't been updated recently"); return; }
      out.candidates.push({
        source_id: `opendata:${dataset.domain}:${dataset.dataset}`, name: `${view.name ?? lead.title} (${view.attribution ?? dataset.domain})`.slice(0, 120), url: `https://${dataset.domain}/d/${dataset.dataset}`, reader: "opendata",
        params: { domain: dataset.domain, dataset: dataset.dataset, topic: datasetTopic, filter: "radius", agency: view.attribution ?? dataset.domain, license: null }, section, found_by: foundBy(`${lead.family}: open-data dataset`), inside_area: false, status: "proposed", source_tier: "official", topics, source_kind: "dataset", scope: lead.scope ?? "city", why: "An open dataset: each row is filtered to the place by location",
        ...(updated ? { latest_day: new Date(updated).toISOString().slice(0, 10) } : {}),
        access: { robots: "allowed", rights: "ok", terms: "not_checked", checked_at: checkedAt, fresh: true }, evidence: [{ url: lead.url, quote: view.name ?? null, kind: "search", at: checkedAt }],
      });
      await note("fetch", "kept: open-data dataset", null, { outcome: "kept", source_id: `opendata:${dataset.domain}:${dataset.dataset}`, source_url: `https://${dataset.domain}/d/${dataset.dataset}`, section, structured: true });
      return;
    } catch { /* not a dataset we can read: treat it as a page */ }
  }
  let page: OpenedPage;
  try { page = await openPage(context, fetcher, lead.url, options.method); }
  catch (error) {
    const blocked = error instanceof DiscoveryBlockedError;
    const reason = error instanceof Error ? error.message : String(error);
    await note("fetch", blocked ? `blocked: ${reason}` : `failed: ${reason}`, blocked ? "access" : null, { outcome: blocked ? "blocked" : "failed" });
    reject(lead.url, blocked ? `blocked: ${reason}` : `failed: ${reason}`);
    if (blocked) out.candidates.push({
      source_id: webSourceId(lead.url), name: lead.title || host, url: lead.url, feed_url: null, reader: "web", params: { url: lead.url, section, inside_area: false }, section,
      found_by: foundBy(`${lead.family}: blocked, kept as a link`), inside_area: false, link_only: true, ...standing, source_tier: tier, topics, why: "Blocked from reading, kept as a link-only lead",
      access: { robots: "blocked", rights: "unknown", terms: "not_checked", checked_at: checkedAt, fresh: false }, evidence: [{ url: lead.url, quote: lead.snippet || null, kind: "search", at: checkedAt }],
    });
    return;
  }
  const { html, endpointHtml, text, action } = page;
  opened = { reader: page.reader, fallbacks: page.fallbacks };
  if (action === "skip") { await note("fetch", "page opts out of reuse", "rights", { outcome: "opted_out" }); reject(lead.url, "page opts out of reuse"); return; }
  // Coverage: the place itself, its city or its county. A county source must be first-party, and
  // naming only the state isn't enough.
  const title = `${lead.title} ${articleMeta(html)?.title ?? ""}`;
  const body = text.slice(0, 6000);
  const haystack = `${title} ${body}`;
  const named = names.find((name) => mentions(haystack, name));
  const parent = context.location.community?.parent_name;
  const inParent = parent && mentions(haystack, parent) ? parent : null;
  const facts = await areaFacts(context as unknown as ConnectorContext).catch(() => null);
  const firstParty = ["official", "organisation"].includes(tier);
  // A public body named for the city, such as its school district, covers the city.
  const parentSlug = parent?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  const namedForCity = firstParty && parentSlug.length >= 4 && siteRoot(host).includes(parentSlug);
  const inCounty = firstParty && facts?.county && mentions(haystack, facts.county) ? facts.county : null;
  let scope: SourceScope | null = lead.scope ?? (named ? "place" : onCitySite ? (parent ? "city" : "place") : inParent || namedForCity ? "city" : inCounty ? "county" : null);
  // Evidence: a page that names nothing may still list an address inside the area, or be clearly about another place.
  const addresses = scope ? [] : await addressFacts(context.location, fetcher, context.db, body).catch(() => []);
  if (!scope && addresses.some((item) => item.inside)) scope = "place";
  const locality = localityFacts({
    scope, place, officialSite: onCitySite, foundByLocation: lead.family.startsWith("institution"), addresses,
    names: nameFacts([...names.map((name) => ({ name, level: "place" as const })), ...(parent ? [{ name: parent, level: "city" as const }] : []), ...(facts?.county ? [{ name: facts.county, level: "county" as const }] : [])], title, body),
    otherPlace: scope ? null : otherPlace(title, [...names, parent ?? "", facts?.county ?? ""], Object.keys(facts?.places ?? {})),
  });
  // Clearly about another place fails Quality. Unclear goes on to the model check, which decides it; with the check off it is rejected.
  const unclear = locality.outcome === "unclear" && geminiCheckOn();
  if (locality.outcome !== "pass" && !unclear) {
    await note("fetch", locality.reason, locality.outcome === "fail" ? "quality:other_place" : "locality", { outcome: locality.outcome === "fail" ? "other_place" : "no_locality_evidence", checks: { locality } });
    reject(lead.url, locality.reason);
    return;
  }
  // What it is and whether it is publishing. A source must have something current to offer.
  const endpoint = await findEndpoint(fetcher, endpointHtml, page.url, context.today, lead.feeds) ?? (new URL(page.url).pathname.length <= 1 ? await findFeed(fetcher, new URL(page.url).origin, context.today).then((feed): Endpoint | null => feed ? { url: feed.feed, format: "rss", latest: feed.latest, items: feed.items } : null).catch(() => null) : null);
  const inspection = inspectPage(html, page.url, context.today, endpoint);
  // No dates at all usually means the page builds its list by script, so keep the link. A few old
  // dates can be a footer. Only a page with plenty of dates, all old, has stopped publishing.
  const freshness = freshnessFacts(inspection, endpoint, page.headers, lead.lastmod, STALE_MIN_DATES);
  const checks: PageChecks = { locality, freshness };
  const asReference = inspection.kind === "lookup" || freshness.outcome === "unclear";
  if (freshness.outcome === "fail") {
    await note("fetch", freshness.reason, "stale", { outcome: "stale", kind: inspection.kind, checks });
    reject(lead.url, freshness.reason);
    return;
  }
  const terms = await termsCheck(fetcher, html, page.url);
  const overrides = [...(runContext()?.overrides ?? [])].filter((rule) => !skippedBefore.has(rule));
  const url = sourceUrl(page.url);
  const pageTitle = articleMeta(html)?.title ?? lead.title;
  const blocked = [...overrides];
  const evidenceName = named ?? inParent ?? inCounty;
  const why = asReference ? (inspection.kind === "lookup" ? "A lookup or dashboard: kept as a link for checking facts" : "No current dated items found, possibly built by script: kept as a link for an editor")
    : named ? `Names ${named}` : inParent ? `Covers ${inParent}` : inCounty ? `Covers ${inCounty}` : lead.scope ? `${lead.title} serves this place` : unclear ? `Locality unclear (${locality.reason}): for the model check to decide` : `Locality: ${locality.reason}`;
  const titles = endpoint?.titles?.length ? endpoint.titles : pageTitles(html);
  const since = addDays(context.today, -RECENT_DAYS);
  const recent = endpoint?.recent ?? [...new Set([...inspection.dates.markup, ...inspection.dates.text])].filter((day) => day >= since && day <= context.today).length;
  const candidate: SourceCandidate = {
    source_id: webSourceId(endpoint?.url ?? url), name: (lead.title || pageTitle || host).slice(0, 120), url, feed_url: endpoint?.url ?? null, reader: "web",
    params: { url, feed_url: endpoint?.url ?? null, kind: lead.kind ?? PAGE_STORY_KINDS[lead.topic ?? ""] ?? PAGE_STORY_KINDS.default, section, inside_area: false }, section,
    found_by: foundBy(lead.family, page.reader),
    inside_area: Boolean(named && mentions(pageTitle, named)), ...standing, source_tier: tier, topics, agent_run_id: runContext()?.runId ?? null, access_overrides: overrides, why,
    link_only: action === "link-only" || asReference, scope: scope ?? undefined, source_kind: inspection.kind, latest_day: inspection.latest,
    access: { robots: overrides.includes("robots") ? "ignored" : "allowed", rights: action, terms, checked_at: checkedAt, fresh: inspection.fresh }, checks,
    ...(titles.length ? { recent_titles: titles } : {}), judge_input: { text: text.slice(0, CHECK_PAGE_CHARS), titles, recent },
    evidence: [{ url: page.url, quote: evidenceName ? quoteAround(haystack, evidenceName) : lead.snippet || null, kind: "locality", at: checkedAt }, ...(inspection.latest ? [{ url: page.url, quote: `Latest dated item: ${inspection.latest}`, kind: "date" as const, at: checkedAt }] : [])],
  };
  out.candidates.push(candidate);
  out.checked.push({ candidate, excerpt: text.slice(0, 500) });
  await note("fetch", `kept: ${why}; ${inspection.kind}${endpoint ? `, verified ${endpoint.format}` : ""}`, null, { outcome: "kept", link_only: candidate.link_only, source_id: candidate.source_id, source_url: url, section, terms, rights: action, feed: endpoint?.url ?? null, kind: inspection.kind, latest: inspection.latest, scope, checks }, blocked);
  // A first-party site's other sections may be sources of their own. A page not yet shown to be local isn't followed.
  if ((firstParty || tier === "business") && !unclear) {
    const found: SiteLink[] = siteLinks(html, page.url, undefined, options.siteKind);
    const links = found.length >= FOLLOWUP_LINKS_MIN ? found : [...found, ...await sitemapLinks(fetcher, page.url, undefined, options.siteKind)];
    for (const link of links) out.links.push({ url: link.url, title: link.title || `${candidate.name}: ${link.section}`, snippet: "", topic: link.topic, family: "site_section", section: link.section as SectionId, scope: scope ?? undefined, lastmod: link.lastmod ?? null });
  }
}

/** Check leads that didn't come from a search: institutions' websites, and links from good sites. */
export async function evaluateLeads(context: DiscoveryContext, leads: Lead[], options: Options): Promise<EvaluationResult> {
  const out = emptyResult();
  const fetcher = new Fetcher(publicSourceTransport(context.transport, 15_000));
  // A site's crawl delay never holds a page past the job's time: it becomes a link-only lead.
  fetcher.deadline = options.deadline ?? null;
  for (const [index, lead] of leads.entries()) {
    if (options.deadline && Date.now() >= options.deadline) { out.leftover = leads.slice(index); break; }
    const key = normaliseUrl(sourceUrl(lead.url));
    if (options.seen.has(key)) continue;
    options.seen.add(key);
    await checkLead(context, fetcher, lead, null, options, out);
  }
  return out;
}
