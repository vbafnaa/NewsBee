/**
 * Turning leads into source candidates. Discovery and retrieval stay separate: a search result,
 * an institution's website or a link from a good site is a lead, and becomes a source only after
 * it is fetched and checked for access, coverage and whether it publishes anything current. The
 * dork method and the mapping agent both come through here, and every step goes into the
 * decision log.
 *
 * The model never sets `inside_area`: only the page's own title naming the place does, because
 * that field skips the locality filter. A source can cover a place without naming it (a city's
 * police, a county assessor): it is kept with its `scope`, and each of its items still has to
 * pass the locality filter. All fetches use a Fetcher with the private-address check and a fixed
 * Accept header, so the access rules can't be sidestepped.
 */
import { blockedPlatform, DiscoveryBlockedError, Fetcher } from "../connectors/fetcher";
import { publicSourceTransport } from "../connectors/public-http";
import { publicApiGet } from "../connectors/public-api";
import { mentions } from "../connectors/community";
import { aggregator } from "../connectors/newssearch";
import { jinaHtml, jinaRead } from "../connectors/web/jina";
import { articleMeta, mainText, pageRights, rightsAction } from "../connectors/web/page";
import type { ConnectorContext } from "../connectors/types";
import { accessIgnored, currentOptions, runContext, rulesOff, type PriorityTopic } from "../core/run-options";
import { classify, type Classification } from "../search/classifier";
import { search, searchQueries, type SearchResult } from "../search/provider";
import type { SectionId } from "../sourcemap/sections";
import { hostOf, normaliseUrl, webSourceId, type SourceAccess, type SourceCandidate, type SourceScope, type SourceTier } from "../sourcemap/store";
import { paidCall } from "../trace/gateway";
import { recordDecision } from "../trace/decisions";
import { areaFacts } from "./area";
import { verifiedCitySite } from "./city-site";
import { findFeed } from "./feeds";
import { datasetOf, findEndpoint, inspectPage, siteLinks, sitemapLinks, type SiteLink } from "./inspect";
import type { DiscoveryContext } from "./methods";
import { TOPIC_SECTIONS, type PlannedQuery } from "./topics";

const ACCEPT_HTML = "text/html, application/xhtml+xml";
const THIN_PAGE = 300;
const STALE_MIN_DATES = 3;
const TERMS_LINK = /href=["']([^"']*(?:terms|tos|legal)[^"']*)["']/i;
const TERMS_RESTRICTION = /\b(scrap(?:e|ing)|automated (?:means|access|systems)|crawl(?:er|ing)?|robots?|data mining)\b/i;
/** Queries searched at once; each host is still paced by the Fetcher. */
const QUERY_BATCH = 4;
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
  if (accessIgnored("terms")) return "skipped";
  const link = TERMS_LINK.exec(html)?.[1];
  if (!link) return "not_checked";
  try {
    const [, terms] = await fetcher.getText(new URL(link, pageUrl).toString(), 1024 * 1024, ACCEPT_HTML);
    return TERMS_RESTRICTION.test(terms) ? "mentions_restrictions" : "no_restriction_found";
  } catch { return "not_checked"; }
}

/** A JavaScript-rendered page, through ScrapingBee when the run allows it. Anti-bot options stay off. */
async function renderedPage(context: DiscoveryContext, url: string) {
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

/** The page itself is the source. A single dated story isn't: its listing is. */
export function sourceUrl(url: string) {
  const parsed = new URL(url);
  parsed.hash = "";
  const dated = /^(.*?)\/20\d{2}\/\d{1,2}\/.*$/.exec(parsed.pathname);
  if (dated) { parsed.pathname = dated[1] || "/"; parsed.search = ""; }
  return parsed.toString();
}

function propertyCandidate(result: { url: string; title: string; snippet: string }, query: PlannedQuery, tier: SourceTier, access: SourceAccess): SourceCandidate {
  return {
    source_id: `property:${webSourceId(result.url).slice(4)}`, name: result.title || hostOf(result.url), url: result.url, feed_url: null, reader: "property",
    params: { backend: "csv", url: result.url }, section: "real_estate", found_by: { method: "dork", detail: `Sales data file found by search (${query.family})`, query: query.query },
    inside_area: false, status: "proposed", source_tier: tier, access, topics: ["home_sales"], why: "A county sales data file", evidence: [{ url: result.url, quote: result.snippet || null, kind: "search", at: Date.now() / 1000 }],
  };
}

const siteRoot = (host: string) => host.split(".").slice(-2).join(".");

export type EvaluatedSource = { candidate: SourceCandidate; excerpt: string };
/** Something worth checking, wherever it came from. `scope` is set when its coverage is already known. */
export type Lead = { url: string; title: string; snippet: string; topic: PriorityTopic | null; family: string; query?: string | null; section?: SectionId; scope?: SourceScope };
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

type Options = { method: "dork" | "agent"; seen: Set<string>; fetchesPerQuery?: number; origin?: "template" | "agent"; deadline?: number };

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
    evidence: { query: lead.query ?? null, family: lead.family, tier, rules_tier: scoreOf.rules_tier, jev: scoreOf.jev, ...extra }, would_have_blocked: blocked,
  });
  const section: SectionId = lead.section ?? (lead.topic ? TOPIC_SECTIONS[lead.topic] : "community");
  const topics = lead.topic ? [lead.topic] : [];
  const checkedAt = Date.now() / 1000;
  const foundBy = (detail: string) => ({ method: options.method, detail: `${detail}${lead.topic ? ` (${lead.topic})` : ""}`, query: lead.query ?? null });
  // A platform we never read, or an aggregator: a public agency's account is still worth a link.
  if (blockedPlatform(lead.url) || aggregator(lead.url)) {
    await note("link_only_lead", "platform or aggregator we never read: kept as a link-only lead", "blocked_site");
    if (names.some((name) => mentions(`${lead.title} ${lead.snippet}`, name))) out.candidates.push({
      source_id: webSourceId(lead.url), name: (lead.title || host).slice(0, 120), url: lead.url, feed_url: null, reader: "web", params: { url: lead.url, section, inside_area: false }, section, found_by: foundBy(`${lead.family}: platform we don't read, kept as a link`), inside_area: false, link_only: true, status: "proposed", source_tier: tier, topics, why: "On a platform we don't read: an editor can check it", source_kind: "lookup",
      access: { robots: "blocked", rights: "unknown", terms: "not_checked", checked_at: checkedAt, fresh: false }, evidence: lead.snippet ? [{ url: lead.url, quote: lead.snippet, kind: "search", at: checkedAt }] : [],
    });
    return;
  }
  if (tier === "repost" && !rulesOff("quality")) { await note("skipped", "reposts other sources", "source_tier"); reject(lead.url, "reposts other sources"); return; }
  out.counts.fetched += 1;
  if (/\.csv(\?|$)/i.test(lead.url)) {
    out.candidates.push(propertyCandidate(lead, { ...query }, tier, { robots: "allowed", rights: "ok", terms: "not_checked", checked_at: checkedAt, fresh: true }));
    await note("fetch", "sales data file: the property reader checks it at collection");
    return;
  }
  // An open-data dataset is read through its own API, by the open-data reader.
  const dataset = datasetOf(lead.url);
  const datasetTopic = lead.topic === "crime" ? (/fire|911|ems/i.test(`${lead.title} ${lead.snippet}`) ? "fire" : "police") : lead.topic === "home_sales" ? "permits" : null;
  if (dataset && datasetTopic) {
    try {
      const view = JSON.parse(new TextDecoder().decode(await publicApiGet(context.transport, `https://${dataset.domain}/api/views/${dataset.dataset}.json`, "application/json", 2 * 1024 * 1024, 20_000))) as { name?: string; attribution?: string; rowsUpdatedAt?: number };
      const updated = Number(view.rowsUpdatedAt ?? 0) * 1000;
      if (updated && Date.now() - updated > 120 * 86400_000) { await note("fetch", "dataset hasn't been updated recently", "stale", { outcome: "stale" }); reject(lead.url, "dataset hasn't been updated recently"); return; }
      out.candidates.push({
        source_id: `opendata:${dataset.domain}:${dataset.dataset}`, name: `${view.name ?? lead.title} (${view.attribution ?? dataset.domain})`.slice(0, 120), url: `https://${dataset.domain}/d/${dataset.dataset}`, reader: "opendata",
        params: { domain: dataset.domain, dataset: dataset.dataset, topic: datasetTopic, filter: "radius", agency: view.attribution ?? dataset.domain, license: null }, section, found_by: foundBy(`${lead.family}: open-data dataset`), inside_area: false, status: "proposed", source_tier: "official", topics, source_kind: "dataset", scope: lead.scope ?? "city", why: "An open dataset: each row is filtered to the place by location",
        access: { robots: "allowed", rights: "ok", terms: "not_checked", checked_at: checkedAt, fresh: true }, evidence: [{ url: lead.url, quote: view.name ?? null, kind: "search", at: checkedAt }],
      });
      await note("fetch", "kept: open-data dataset", null, { outcome: "kept" });
      return;
    } catch { /* not a dataset we can read: treat it as a page */ }
  }
  let page;
  try { page = await fetcher.getResponse(lead.url, 2 * 1024 * 1024, ACCEPT_HTML); }
  catch (error) {
    const blocked = error instanceof DiscoveryBlockedError;
    const reason = error instanceof Error ? error.message : String(error);
    await note("fetch", blocked ? `blocked: ${reason}` : `failed: ${reason}`, blocked ? "access" : null, { outcome: blocked ? "blocked" : "failed" });
    reject(lead.url, blocked ? `blocked: ${reason}` : `failed: ${reason}`);
    if (blocked) out.candidates.push({
      source_id: webSourceId(lead.url), name: lead.title || host, url: lead.url, feed_url: null, reader: "web", params: { url: lead.url, section, inside_area: false }, section,
      found_by: foundBy(`${lead.family}: blocked, kept as a link`), inside_area: false, link_only: true, status: "proposed", source_tier: tier, topics, why: "Blocked from reading, kept as a link-only lead",
      access: { robots: "blocked", rights: "unknown", terms: "not_checked", checked_at: checkedAt, fresh: false }, evidence: [{ url: lead.url, quote: lead.snippet || null, kind: "search", at: checkedAt }],
    });
    return;
  }
  let html = new TextDecoder().decode(page.body);
  const skippedBefore = new Set(runContext()?.overrides ?? []);
  const action = rightsAction(pageRights(page.headers, html));
  const overrides = [...(runContext()?.overrides ?? [])].filter((rule) => !skippedBefore.has(rule));
  if (action === "skip") { await note("fetch", "page opts out of reuse", "rights", { outcome: "opted_out" }); reject(lead.url, "page opts out of reuse"); return; }
  let text = action === "ok" ? mainText(html) ?? "" : "";
  // A page built by script: the free reader first, then ScrapingBee if the run allows it.
  let endpointHtml = html;
  if (action === "ok" && text.length < THIN_PAGE) {
    const read = await jinaRead(context.transport, context.settings.integrations?.jinaKey, page.url);
    const rendered = read || currentOptions().paid.scrapingbee === undefined ? null : await renderedPage(context, page.url);
    if (read) html = jinaHtml(read);
    if (rendered) { html = rendered; endpointHtml = rendered; }
    if (read || rendered) text = mainText(html) ?? text;
  }
  // Coverage: the place itself, its city or its county. A county source must be first-party, and
  // naming only the state isn't enough.
  const haystack = `${lead.title} ${articleMeta(html)?.title ?? ""} ${text.slice(0, 6000)}`;
  const named = names.find((name) => mentions(haystack, name));
  const parent = context.location.community?.parent_name;
  const inParent = parent && mentions(haystack, parent) ? parent : null;
  const facts = await areaFacts(context as unknown as ConnectorContext).catch(() => null);
  const firstParty = ["official", "organisation"].includes(tier);
  // A public body named for the city, such as its school district, covers the city.
  const parentSlug = parent?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  const namedForCity = firstParty && parentSlug.length >= 4 && siteRoot(host).includes(parentSlug);
  const inCounty = firstParty && facts?.county && mentions(haystack, facts.county) ? facts.county : null;
  const scope: SourceScope | null = lead.scope ?? (named ? "place" : onCitySite ? (parent ? "city" : "place") : inParent || namedForCity ? "city" : inCounty ? "county" : null);
  const covered = Boolean(scope);
  if (!covered && !rulesOff("quality")) { await note("fetch", `no evidence it concerns ${place}`, "locality", { outcome: "no_locality_evidence" }); reject(lead.url, `no evidence it concerns ${place}`); return; }
  // What it is and whether it is publishing. A source must have something current to offer.
  const endpoint = await findEndpoint(fetcher, endpointHtml, page.url, context.today) ?? (new URL(page.url).pathname.length <= 1 ? await findFeed(fetcher, new URL(page.url).origin, context.today).then((feed) => feed ? { url: feed.feed, format: "rss" as const, latest: feed.latest, items: feed.items } : null).catch(() => null) : null);
  const inspection = inspectPage(html, page.url, context.today, endpoint);
  // No dates at all usually means the page builds its list by script, so keep the link. A few old
  // dates can be a footer. Only a page with plenty of dates, all old, has stopped publishing.
  const asReference = inspection.kind === "lookup" || (!inspection.fresh && inspection.dated < STALE_MIN_DATES);
  if (!inspection.fresh && !asReference && !rulesOff("quality")) {
    const reason = inspection.latest ? `nothing newer than ${inspection.latest}` : "no dated items";
    await note("fetch", reason, "stale", { outcome: "stale", kind: inspection.kind });
    reject(lead.url, reason);
    return;
  }
  const terms = await termsCheck(fetcher, html, page.url);
  const url = sourceUrl(page.url);
  const pageTitle = articleMeta(html)?.title ?? lead.title;
  const blocked = covered ? [] : ["locality"];
  const evidenceName = named ?? inParent ?? inCounty;
  const why = asReference ? (inspection.kind === "lookup" ? "A lookup or dashboard: kept as a link for checking facts" : "No current dated items found, possibly built by script: kept as a link for an editor")
    : named ? `Names ${named}` : inParent ? `Covers ${inParent}` : inCounty ? `Covers ${inCounty}` : lead.scope ? `${lead.title} serves this place` : "Flagged: no local evidence";
  const candidate: SourceCandidate = {
    source_id: webSourceId(endpoint?.url ?? url), name: (lead.title || pageTitle || host).slice(0, 120), url, feed_url: endpoint?.url ?? null, reader: "web",
    params: { url, feed_url: endpoint?.url ?? null, kind: lead.topic === "deaths" ? "obituary" : lead.topic === "sports" ? "school_sports" : "local_news", section, inside_area: false }, section,
    found_by: foundBy(lead.family),
    inside_area: Boolean(named && mentions(pageTitle, named)), status: "proposed", source_tier: tier, topics, agent_run_id: runContext()?.runId ?? null, access_overrides: overrides, why,
    link_only: action === "link-only" || asReference, scope: scope ?? undefined, source_kind: inspection.kind, latest_day: inspection.latest,
    access: { robots: overrides.includes("robots") ? "ignored" : "allowed", rights: action, terms, checked_at: checkedAt, fresh: inspection.fresh },
    evidence: [{ url: page.url, quote: evidenceName ? quoteAround(haystack, evidenceName) : lead.snippet || null, kind: "locality", at: checkedAt }, ...(inspection.latest ? [{ url: page.url, quote: `Latest dated item: ${inspection.latest}`, kind: "date" as const, at: checkedAt }] : [])],
  };
  out.candidates.push(candidate);
  out.checked.push({ candidate, excerpt: text.slice(0, 500) });
  await note("fetch", `kept: ${why}; ${inspection.kind}${endpoint ? `, verified ${endpoint.format}` : ""}`, null, { outcome: "kept", terms, rights: action, feed: endpoint?.url ?? null, kind: inspection.kind, latest: inspection.latest, scope }, blocked);
  // A first-party site's other sections may be sources of their own.
  if (firstParty || tier === "business") {
    const found: SiteLink[] = siteLinks(html, page.url);
    const links = found.length >= 2 ? found : [...found, ...await sitemapLinks(fetcher, page.url)];
    for (const link of links) out.links.push({ url: link.url, title: link.title || `${candidate.name}: ${link.section}`, snippet: "", topic: link.topic, family: "site_section", section: link.section as SectionId, scope: scope ?? undefined });
  }
}

/** Check leads that didn't come from a search: institutions' websites, and links from good sites. */
export async function evaluateLeads(context: DiscoveryContext, leads: Lead[], options: Options): Promise<EvaluationResult> {
  const out = emptyResult();
  const fetcher = new Fetcher(publicSourceTransport(context.transport, 15_000));
  for (const [index, lead] of leads.entries()) {
    if (options.deadline && Date.now() >= options.deadline) { out.leftover = leads.slice(index); break; }
    const key = normaliseUrl(sourceUrl(lead.url));
    if (options.seen.has(key)) continue;
    options.seen.add(key);
    await checkLead(context, fetcher, lead, null, options, out);
  }
  return out;
}

/** Run planned queries and return the candidates that passed. Pages in `seen` are skipped. */
export async function evaluateQueries(context: DiscoveryContext, queries: PlannedQuery[], options: Options): Promise<EvaluationResult> {
  const out = emptyResult();
  const place = placeNames(context)[0];
  // Search results are untrusted URLs: no private addresses, on any hop.
  const fetcher = new Fetcher(publicSourceTransport(context.transport, 15_000));
  const runOne = async (query: PlannedQuery) => {
    const outcome = await search({ db: context.db, settings: context.settings, transport: context.transport, query: query.query, topic: query.topic, family: query.family, stage: query.stage, origin: options.origin ?? "template" });
    out.counts.queries += 1;
    await recordDecision({ stage: "query", actor: options.method === "agent" ? "agent" : "rule", subject: query.query, decision: outcome.skipped ? "skipped" : outcome.error ? "failed" : "ran", reason: outcome.skipped ?? outcome.error ?? `${outcome.results.length} results from ${outcome.provider}`, topic: query.topic, evidence: { family: query.family, stage: query.stage, provider: outcome.provider } });
    if (outcome.skipped) { out.counts.skipped += 1; return; }
    if (outcome.error) { out.counts.failed += 1; out.rejected.push({ url: query.query, reason: outcome.error }); return; }
    out.counts.results += outcome.results.length;
    out.hosts.push(...outcome.results.map((result) => hostOf(result.url)));
    const scored = await Promise.all(outcome.results.map(async (result: SearchResult) => ({ result, verdict: await classify(context.settings, context.transport, { url: result.url, title: result.title, snippet: result.snippet, query: query.query, topic: query.topic, place }) })));
    // A score sets the fetch order. It doesn't delete anything.
    scored.sort((a, b) => b.verdict.fetch - a.verdict.fetch || a.result.position - b.result.position);
    let fetched = 0;
    const addedBefore = out.candidates.length;
    for (const { result, verdict } of scored) {
      const key = normaliseUrl(sourceUrl(result.url));
      if (options.seen.has(key)) {
        await recordDecision({ stage: "result", actor: "rule", subject: result.url, decision: "skipped", reason: "already considered this run", rule: "duplicate", topic: query.topic, evidence: { query: query.query, position: result.position } });
        continue;
      }
      if (fetched >= (options.fetchesPerQuery ?? 3) || (options.deadline && Date.now() >= options.deadline)) {
        await recordDecision({ stage: "result", actor: "rule", subject: result.url, decision: "not_fetched", reason: `past the ${options.fetchesPerQuery ?? 3} fetches for this query`, rule: "fetch_budget", topic: query.topic, evidence: { query: query.query, position: result.position } });
        continue;
      }
      options.seen.add(key);
      fetched += 1;
      await checkLead(context, fetcher, { url: result.url, title: result.title, snippet: result.snippet, topic: query.topic, family: query.family, query: query.query, section: query.section }, verdict, options, out);
    }
    const added = out.candidates.length - addedBefore;
    if (added && outcome.id) await searchQueries(context.db).updateOne({ _id: outcome.id as never }, { $set: { sources_added: added } });
  };
  for (let index = 0; index < queries.length; index += QUERY_BATCH) {
    if (options.deadline && Date.now() >= options.deadline) {
      out.counts.not_run = queries.length - index;
      for (const query of queries.slice(index)) await recordDecision({ stage: "query", actor: options.method === "agent" ? "agent" : "rule", subject: query.query, decision: "not_run", reason: "this job's time ran out", rule: "time_limit", topic: query.topic, evidence: { family: query.family } });
      break;
    }
    await Promise.all(queries.slice(index, index + QUERY_BATCH).map(runOne));
  }
  return out;
}
