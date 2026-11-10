/**
 * Google operator search, behind one interface. Results are leads, never content: each is
 * fetched and checked before it becomes a source or an item. Every query is logged in
 * `search_queries` with its topic, so the funnel shows which queries found which stories, and
 * results are cached by query so a repeat doesn't pay twice. A test-mode map run
 * (NEWSBEE_SOURCE_RUNS_ISOLATED) reuses only its own results, so every run calls its services.
 *
 *   serpapi     GET https://serpapi.com/search (engine=google)
 *   searchapi   GET https://www.searchapi.io/api/v1/search (engine=google, Bearer key)
 *   brightdata  POST https://api.brightdata.com/request (needs NEWSBEE_BRIGHTDATA_ZONE)
 *   exa         POST https://api.exa.ai/search (for coverage comparison; operators are stripped)
 *   tavily      POST https://api.tavily.com/search (free tier; site: and after: become parameters)
 *   fixture     local only: known public URLs, to exercise the flow without paying
 *
 * Code sets what a service is sent besides the query: results per search, US region and English
 * (playbook/services.yaml). An agent search also leaves out the platforms we never read, unless a
 * relaxed run may read them, and can carry a date range. Tavily can also explore one site from an
 * instruction (`exploreSite`, POST https://api.tavily.com/map), listing the pages it finds; it is
 * counted under its own hard limit of explorations a run. Exa can also find pages similar to one
 * page (`findSimilar`, POST https://api.exa.ai/findSimilar), counted against Exa's own limits.
 */
import type { Db } from "mongodb";
import { createHash } from "node:crypto";
import type { Settings } from "../core/config";
import type { HttpTransport } from "../core/http";
import { currentOptions, isDeployed, isolatedRunId, runContext, type SearchProvider } from "../core/run-options";
import { paidCall } from "../trace/gateway";
import { httpsLink } from "../connectors/common";
import { PLAYBOOK_SERVICES, table } from "../playbook";
import { adaptedRequest } from "./adapter";
import { fixtureResults } from "./fixture";

export const SEARCH_QUERIES = "search_queries";
export const SEARCH_CACHE_DAYS = 7;
export type SearchResult = { url: string; title: string; snippet: string; date: string | null; position: number };
export type QueryRecord = {
  run_id: string | null; location_id: string | null; provider: string; query: string; topic: string | null; family: string; stage: "stage1" | "stage2"; origin: "template" | "agent";
  results: SearchResult[]; result_count: number; cached: boolean; skipped: string | null; error: string | null; sources_added: number; created_at: number; key: string;
  /** What was sent when code added to the query: an agent search's exclusions and date range. */
  sent?: string | null;
};
export function searchQueries(db: Db) { return db.collection<QueryRecord>(SEARCH_QUERIES); }
export async function ensureSearchIndexes(db: Db) {
  await searchQueries(db).createIndexes([{ key: { run_id: 1, topic: 1 } }, { key: { key: 1, created_at: -1 } }]);
}

/** Which logged results a search may reuse: any recent one, or in a test-mode run only its own. */
function reuseScope() {
  const runId = isolatedRunId();
  return runId ? { run_id: runId } : {};
}

function decode(body: Uint8Array) { return new TextDecoder().decode(body); }
function day(value: unknown) { return typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1] ?? null : null; }
function clean(items: Array<Omit<SearchResult, "position">>): SearchResult[] {
  const seen = new Set<string>();
  return items.flatMap((item) => {
    const url = httpsLink(item.url?.replace(/^http:/, "https:"));
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ ...item, url, title: String(item.title ?? "").slice(0, 200), snippet: String(item.snippet ?? "").slice(0, 400) }];
  }).map((item, index) => ({ ...item, position: index + 1 }));
}

/** A Google service's fixed settings, from the playbook: results per search, region and language. */
const googleSettings = (name: string) => Object.fromEntries(Object.entries(PLAYBOOK_SERVICES[name]?.request ?? {}).map(([key, value]) => [key, String(value)]));

async function serpApi(settings: Settings, transport: HttpTransport, query: string) {
  const params = new URLSearchParams({ engine: "google", q: query, ...googleSettings("serpapi"), api_key: settings.integrations.serpapiKey! });
  const response = await transport({ url: `https://serpapi.com/search?${params}`, headers: { Accept: "application/json" }, timeoutMs: 30_000 });
  if (response.status >= 400) throw new Error(`SerpApi returned HTTP ${response.status}`);
  const data = JSON.parse(decode(response.body)) as { organic_results?: Array<{ link?: string; title?: string; snippet?: string; date?: string }> };
  return clean((data.organic_results ?? []).map((row) => ({ url: row.link ?? "", title: row.title ?? "", snippet: row.snippet ?? "", date: day(row.date) })));
}

/** SearchApi dates read "Nov 30, 2022" or "3 days ago"; only a full date is kept. */
function longDay(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z][a-z]{2,8} \d{1,2}, \d{4}$/.test(value)) return day(value);
  const at = new Date(`${value} UTC`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}

async function searchApi(settings: Settings, transport: HttpTransport, query: string) {
  const params = new URLSearchParams({ engine: "google", q: query, ...googleSettings("searchapi") });
  const response = await transport({ url: `https://www.searchapi.io/api/v1/search?${params}`, headers: { Accept: "application/json", Authorization: `Bearer ${settings.integrations.searchapiKey}` }, timeoutMs: 30_000 });
  if (response.status >= 400) throw new Error(`SearchApi returned HTTP ${response.status}`);
  const data = JSON.parse(decode(response.body)) as { organic_results?: Array<{ link?: string; title?: string; snippet?: string; date?: string }> };
  return clean((data.organic_results ?? []).map((row) => ({ url: row.link ?? "", title: row.title ?? "", snippet: row.snippet ?? "", date: longDay(row.date) })));
}

async function brightData(settings: Settings, transport: HttpTransport, query: string) {
  const target = `https://www.google.com/search?${new URLSearchParams({ q: query, ...googleSettings("brightdata"), brd_json: "1" })}`;
  const response = await transport({
    url: "https://api.brightdata.com/request", method: "POST", timeoutMs: 45_000,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.integrations.brightdataKey}` },
    body: JSON.stringify({ zone: settings.integrations.brightdataZone, url: target, format: "raw" }),
  });
  if (response.status >= 400) throw new Error(`Bright Data returned HTTP ${response.status}`);
  const data = JSON.parse(decode(response.body)) as { organic?: Array<{ link?: string; title?: string; description?: string; date?: string }> };
  return clean((data.organic ?? []).map((row) => ({ url: row.link ?? "", title: row.title ?? "", snippet: row.description ?? "", date: day(row.date) })));
}

/** Exa drops every operator, so an agent search's exclusions and date range become its parameters. */
export function exaRequest(query: string, limits: SearchLimits = {}) {
  return { ...adaptedRequest("exa", query), ...(limits.exclude?.length ? { excludeDomains: limits.exclude } : {}), ...(limits.since ? { startPublishedDate: `${limits.since}T00:00:00.000Z` } : {}) };
}

async function exa(settings: Settings, transport: HttpTransport, query: string, limits: SearchLimits) {
  const response = await transport({
    url: "https://api.exa.ai/search", method: "POST", timeoutMs: 30_000,
    headers: { "Content-Type": "application/json", "x-api-key": settings.integrations.exaKey! },
    body: JSON.stringify(exaRequest(query, limits)),
  });
  if (response.status >= 400) throw new Error(`Exa returned HTTP ${response.status}`);
  const data = JSON.parse(decode(response.body)) as { results?: Array<{ url?: string; title?: string; publishedDate?: string; highlights?: string[] }>; costDollars?: { total?: number } };
  const results = clean((data.results ?? []).map((row) => ({ url: row.url ?? "", title: row.title ?? "", snippet: row.highlights?.[0] ?? "", date: day(row.publishedDate) })));
  // Exa reports what a search cost, which its monthly spend guard counts.
  return Object.assign(results, { cost: typeof data.costDollars?.total === "number" ? data.costDollars.total : null });
}

/** Tavily has no Google operators: site: and after: become its parameters, and the rest are stripped. */
export const tavilyRequest = (query: string) => adaptedRequest("tavily", query);

async function tavily(settings: Settings, transport: HttpTransport, query: string) {
  const response = await transport({
    url: "https://api.tavily.com/search", method: "POST", timeoutMs: 30_000,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.tavilySearchApiKey}` },
    body: JSON.stringify(tavilyRequest(query)),
  });
  if (response.status >= 400) throw new Error(`Tavily returned HTTP ${response.status}`);
  const data = JSON.parse(decode(response.body)) as { results?: Array<{ url?: string; title?: string; content?: string; published_date?: string }> };
  return clean((data.results ?? []).map((row) => ({ url: row.url ?? "", title: row.title ?? "", snippet: row.content ?? "", date: day(row.published_date) })));
}

/** Why a search service can't run without a key, or null when it can. */
export function missingKey(provider: SearchProvider, settings: Settings) {
  if (provider === "serpapi" && !settings.integrations.serpapiKey) return "NEWSBEE_SERPAPI_API_KEY is not set";
  if (provider === "searchapi" && !settings.integrations.searchapiKey) return "NEWSBEE_SEARCHAPI_API_KEY is not set";
  if (provider === "brightdata" && !(settings.integrations.brightdataKey && settings.integrations.brightdataZone)) return "NEWSBEE_BRIGHTDATA_API_KEY and NEWSBEE_BRIGHTDATA_ZONE are not set";
  if (provider === "exa" && !settings.integrations.exaKey) return "NEWSBEE_EXA_API_KEY is not set";
  if (provider === "tavily" && !settings.tavilySearchApiKey) return "NEWSBEE_TAVILY_API_KEY is not set";
  if (provider === "fixture" && isDeployed()) return "The fixture provider is local only";
  return null;
}

/** What code adds to an agent's search: sites to leave out, and the earliest date a result may have. */
export type SearchLimits = { exclude?: string[]; since?: string | null };
export type SearchInput = { db: Db; settings: Settings; transport: HttpTransport; query: string; topic: string | null; family: string; stage: "stage1" | "stage2"; origin?: "template" | "agent"; provider?: SearchProvider; limits?: SearchLimits };

/** A Google-operator query with the limits written in as operators; Tavily's adapter turns them into its parameters. */
export function limitedQuery(query: string, limits: SearchLimits = {}) {
  const present = new Set([...query.matchAll(/(?:^|\s)-site:(\S+)/gi)].map(([, site]) => site.toLowerCase()));
  const extra = [...(limits.exclude ?? []).filter((site) => !present.has(site)).map((site) => `-site:${site}`), ...(limits.since && !/(?:^|\s)after:/i.test(query) ? [`after:${limits.since}`] : [])];
  return [query, ...extra].join(" ").trim();
}

/** Run one query and log it. A refused or failed query returns no results, with the reason. */
export async function search(input: SearchInput): Promise<{ id: unknown; results: SearchResult[]; skipped: string | null; error: string | null; provider: string }> {
  const provider = input.provider ?? currentOptions().search_provider;
  const context = runContext();
  // Exa can't read operators, so its limits go in as parameters instead.
  const sent = provider === "exa" ? input.query : limitedQuery(input.query, input.limits);
  const limits = input.limits ?? {};
  const key = createHash("sha256").update(`${provider}:${sent}${provider === "exa" && (limits.exclude?.length || limits.since) ? `:${JSON.stringify(limits)}` : ""}`).digest("hex");
  let results: SearchResult[] = [], skipped: string | null = missingKey(provider, input.settings), error: string | null = null, cached = false;
  if (!skipped) {
    const fresh = await searchQueries(input.db).findOne({ key, skipped: null, error: null, created_at: { $gte: Date.now() / 1000 - SEARCH_CACHE_DAYS * 86400 }, ...reuseScope() }, { sort: { created_at: -1 } });
    if (fresh) { results = fresh.results; cached = true; }
    else if (provider === "fixture") results = await fixtureResults(input.db, input.query, input.topic);
    else {
      try {
        const call = () => provider === "serpapi" ? serpApi(input.settings, input.transport, sent) : provider === "searchapi" ? searchApi(input.settings, input.transport, sent) : provider === "brightdata" ? brightData(input.settings, input.transport, sent) : provider === "tavily" ? tavily(input.settings, input.transport, sent) : exa(input.settings, input.transport, sent, limits);
        // Tavily counts credits: a basic search costs one, an advanced one two.
        const units = provider === "tavily" && (tavilyRequest(sent) as { search_depth?: string }).search_depth === "advanced" ? 2 : 1;
        const outcome = await paidCall(provider, call, (found: SearchResult[] & { cost?: number | null }) => found.cost ?? null, { units });
        skipped = outcome.refused;
        results = outcome.value ?? [];
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    }
  }
  const record: QueryRecord = {
    run_id: context?.runId ?? null, location_id: context?.locationId ?? null, provider, query: input.query, topic: input.topic, family: input.family, stage: input.stage, origin: input.origin ?? "template",
    results, result_count: results.length, cached, skipped, error, sources_added: 0, created_at: Date.now() / 1000, key, ...(sent !== input.query ? { sent } : {}),
  };
  const inserted = await searchQueries(input.db).insertOne(record);
  return { id: inserted.insertedId, results, skipped, error, provider };
}

/** What Exa is sent to find pages like one: its results per search, the page's own site left out, and an agent search's limits. */
export function similarRequest(url: string, limits: SearchLimits = {}) {
  const request = PLAYBOOK_SERVICES.exa?.request ?? {};
  return {
    url, excludeSourceDomain: true, ...(request.numResults ? { numResults: request.numResults } : {}), ...(request.contents ? { contents: request.contents } : {}),
    ...(limits.exclude?.length ? { excludeDomains: limits.exclude } : {}), ...(limits.since ? { startPublishedDate: `${limits.since}T00:00:00.000Z` } : {}),
  };
}

/**
 * Pages like one page, from Exa's find-similar: the agent's "more like this" angle, built on a
 * source accepted in this run. Logged like a search under the provider `exa`, and counted against
 * Exa's limits and spend like one. A local fixture run answers from the fixture.
 */
export async function findSimilar(input: { db: Db; settings: Settings; transport: HttpTransport; url: string; topic: string | null; family: string; provider?: SearchProvider; limits?: SearchLimits }): Promise<{ id: unknown; results: SearchResult[]; skipped: string | null; error: string | null; provider: string }> {
  const context = runContext();
  const provider = input.provider === "fixture" ? "fixture" : "exa";
  const query = `similar to ${input.url}`;
  const limits = input.limits ?? {};
  const key = createHash("sha256").update(`${provider}:similar:${input.url}:${JSON.stringify(limits)}`).digest("hex");
  let results: SearchResult[] = [], skipped: string | null = missingKey(provider, input.settings), error: string | null = null, cached = false;
  if (!skipped) {
    const fresh = await searchQueries(input.db).findOne({ key, skipped: null, error: null, created_at: { $gte: Date.now() / 1000 - SEARCH_CACHE_DAYS * 86400 }, ...reuseScope() }, { sort: { created_at: -1 } });
    if (fresh) { results = fresh.results; cached = true; }
    else if (provider === "fixture") results = await fixtureResults(input.db, query, input.topic);
    else {
      try {
        const outcome = await paidCall("exa", async () => {
          const response = await input.transport({
            url: "https://api.exa.ai/findSimilar", method: "POST", timeoutMs: 30_000,
            headers: { "Content-Type": "application/json", "x-api-key": input.settings.integrations.exaKey! },
            body: JSON.stringify(similarRequest(input.url, limits)),
          });
          if (response.status >= 400) throw new Error(`Exa returned HTTP ${response.status}`);
          const data = JSON.parse(decode(response.body)) as { results?: Array<{ url?: string; title?: string; publishedDate?: string; highlights?: string[] }>; costDollars?: { total?: number } };
          const found = clean((data.results ?? []).map((row) => ({ url: row.url ?? "", title: row.title ?? "", snippet: row.highlights?.[0] ?? "", date: day(row.publishedDate) })));
          return Object.assign(found, { cost: typeof data.costDollars?.total === "number" ? data.costDollars.total : null });
        }, (found: SearchResult[] & { cost?: number | null }) => found.cost ?? null);
        skipped = outcome.refused;
        results = outcome.value ?? [];
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    }
  }
  const record: QueryRecord = {
    run_id: context?.runId ?? null, location_id: context?.locationId ?? null, provider, query, topic: input.topic, family: input.family, stage: "stage1", origin: "agent",
    results, result_count: results.length, cached, skipped, error, sources_added: 0, created_at: Date.now() / 1000, key,
  };
  const inserted = await searchQueries(input.db).insertOne(record);
  return { id: inserted.insertedId, results, skipped, error, provider };
}

const EXPLORE_REQUEST = table("general.search.tavily_explore_request") as Record<string, unknown>;

/** What Tavily is sent to explore one site from an instruction. */
export function exploreRequest(url: string, instruction: string, exclude: string[] = []) {
  return { url, instructions: instruction, ...EXPLORE_REQUEST, ...(exclude.length ? { exclude_domains: exclude } : {}) };
}

/**
 * Explore one site with Tavily: it follows the site's links as the instruction says and lists the
 * pages it found. They are leads, opened and checked like any search result. Logged like a search,
 * under the provider `tavily_explore`, and counted under Tavily's explorations a run.
 */
export async function exploreSite(input: { db: Db; settings: Settings; transport: HttpTransport; url: string; instruction: string; topic: string | null; family: string; exclude?: string[] }): Promise<{ id: unknown; results: SearchResult[]; skipped: string | null; error: string | null; provider: string }> {
  const context = runContext();
  const provider = "tavily_explore";
  const query = `${input.url} :: ${input.instruction}`;
  const key = createHash("sha256").update(`${provider}:${query}`).digest("hex");
  let results: SearchResult[] = [], skipped: string | null = missingKey("tavily", input.settings), error: string | null = null, cached = false;
  if (!skipped) {
    const fresh = await searchQueries(input.db).findOne({ key, skipped: null, error: null, created_at: { $gte: Date.now() / 1000 - SEARCH_CACHE_DAYS * 86400 }, ...reuseScope() }, { sort: { created_at: -1 } });
    if (fresh) { results = fresh.results; cached = true; }
    else {
      try {
        const outcome = await paidCall("tavily", async () => {
          const response = await input.transport({
            url: "https://api.tavily.com/map", method: "POST", timeoutMs: 60_000,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.settings.tavilySearchApiKey}` },
            body: JSON.stringify(exploreRequest(input.url, input.instruction, input.exclude)),
          });
          if (response.status >= 400) throw new Error(`Tavily returned HTTP ${response.status}`);
          const data = JSON.parse(decode(response.body)) as { results?: Array<string | { url?: string }> };
          return clean((data.results ?? []).map((row) => ({ url: typeof row === "string" ? row : row.url ?? "", title: "", snippet: "", date: null })));
        }, undefined, { limits: "tavily_explore" });
        skipped = outcome.refused;
        results = outcome.value ?? [];
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    }
  }
  const record: QueryRecord = {
    run_id: context?.runId ?? null, location_id: context?.locationId ?? null, provider, query, topic: input.topic, family: input.family, stage: "stage1", origin: "agent",
    results, result_count: results.length, cached, skipped, error, sources_added: 0, created_at: Date.now() / 1000, key,
  };
  const inserted = await searchQueries(input.db).insertOne(record);
  return { id: inserted.insertedId, results, skipped, error, provider };
}
