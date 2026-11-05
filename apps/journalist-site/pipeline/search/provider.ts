/**
 * Google operator search, behind one interface. Results are leads, never content: each is
 * fetched and checked before it becomes a source or an item. Every query is logged in
 * `search_queries` with its topic, so the funnel shows which queries found which stories, and
 * results are cached by query so a repeat doesn't pay twice.
 *
 *   serpapi     GET https://serpapi.com/search (engine=google)
 *   searchapi   GET https://www.searchapi.io/api/v1/search (engine=google, Bearer key)
 *   brightdata  POST https://api.brightdata.com/request (needs NEWSBEE_BRIGHTDATA_ZONE)
 *   exa         POST https://api.exa.ai/search (for coverage comparison; operators are stripped)
 *   tavily      POST https://api.tavily.com/search (free tier; site: and after: become parameters)
 *   fixture     local only: known public URLs, to exercise the flow without paying
 */
import type { Db } from "mongodb";
import { createHash } from "node:crypto";
import type { Settings } from "../core/config";
import type { HttpTransport } from "../core/http";
import { currentOptions, isDeployed, runContext, type SearchProvider } from "../core/run-options";
import { paidCall } from "../trace/gateway";
import { httpsLink } from "../connectors/common";
import { fixtureResults } from "./fixture";

export const SEARCH_QUERIES = "search_queries";
export const SEARCH_CACHE_DAYS = 7;
export type SearchResult = { url: string; title: string; snippet: string; date: string | null; position: number };
export type QueryRecord = {
  run_id: string | null; location_id: string | null; provider: string; query: string; topic: string | null; family: string; stage: "stage1" | "stage2"; origin: "template" | "agent";
  results: SearchResult[]; result_count: number; cached: boolean; skipped: string | null; error: string | null; sources_added: number; created_at: number; key: string;
};
export function searchQueries(db: Db) { return db.collection<QueryRecord>(SEARCH_QUERIES); }
export async function ensureSearchIndexes(db: Db) {
  await searchQueries(db).createIndexes([{ key: { run_id: 1, topic: 1 } }, { key: { key: 1, created_at: -1 } }]);
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

async function serpApi(settings: Settings, transport: HttpTransport, query: string) {
  const params = new URLSearchParams({ engine: "google", q: query, api_key: settings.integrations.serpapiKey! });
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
  const params = new URLSearchParams({ engine: "google", q: query });
  const response = await transport({ url: `https://www.searchapi.io/api/v1/search?${params}`, headers: { Accept: "application/json", Authorization: `Bearer ${settings.integrations.searchapiKey}` }, timeoutMs: 30_000 });
  if (response.status >= 400) throw new Error(`SearchApi returned HTTP ${response.status}`);
  const data = JSON.parse(decode(response.body)) as { organic_results?: Array<{ link?: string; title?: string; snippet?: string; date?: string }> };
  return clean((data.organic_results ?? []).map((row) => ({ url: row.link ?? "", title: row.title ?? "", snippet: row.snippet ?? "", date: longDay(row.date) })));
}

async function brightData(settings: Settings, transport: HttpTransport, query: string) {
  const target = `https://www.google.com/search?${new URLSearchParams({ q: query, brd_json: "1" })}`;
  const response = await transport({
    url: "https://api.brightdata.com/request", method: "POST", timeoutMs: 45_000,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.integrations.brightdataKey}` },
    body: JSON.stringify({ zone: settings.integrations.brightdataZone, url: target, format: "raw" }),
  });
  if (response.status >= 400) throw new Error(`Bright Data returned HTTP ${response.status}`);
  const data = JSON.parse(decode(response.body)) as { organic?: Array<{ link?: string; title?: string; description?: string; date?: string }> };
  return clean((data.organic ?? []).map((row) => ({ url: row.link ?? "", title: row.title ?? "", snippet: row.description ?? "", date: day(row.date) })));
}

async function exa(settings: Settings, transport: HttpTransport, query: string) {
  const plain = query.replace(/-?\b(site|inurl|intitle|filetype|after|before):\S+/g, " ").replace(/\s+/g, " ").trim();
  const response = await transport({
    url: "https://api.exa.ai/search", method: "POST", timeoutMs: 30_000,
    headers: { "Content-Type": "application/json", "x-api-key": settings.integrations.exaKey! },
    body: JSON.stringify({ query: plain, type: "auto", numResults: 10, contents: { highlights: true } }),
  });
  if (response.status >= 400) throw new Error(`Exa returned HTTP ${response.status}`);
  const data = JSON.parse(decode(response.body)) as { results?: Array<{ url?: string; title?: string; publishedDate?: string; highlights?: string[] }> };
  return clean((data.results ?? []).map((row) => ({ url: row.url ?? "", title: row.title ?? "", snippet: row.highlights?.[0] ?? "", date: day(row.publishedDate) })));
}

/** Tavily has no Google operators: site: and after: become its parameters, and the rest are stripped. */
export function tavilyRequest(query: string) {
  const domains = (pattern: RegExp) => [...query.matchAll(pattern)].map((match) => match[1].toLowerCase()).filter((domain) => !domain.startsWith("."));
  const after = /(?:^|\s)after:(\d{4}-\d{2}-\d{2})/.exec(query)?.[1];
  const include = domains(/(?:^|\s)site:(\S+)/gi), exclude = domains(/(?:^|\s)-site:(\S+)/gi);
  return {
    query: query.replace(/(^|\s)-?\b(site|inurl|intitle|filetype|after|before):\S+/gi, " ").replace(/\s+/g, " ").trim(), max_results: 10, search_depth: "basic",
    ...(include.length ? { include_domains: include } : {}), ...(exclude.length ? { exclude_domains: exclude } : {}), ...(after ? { start_date: after } : {}),
  };
}

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

function missingKey(provider: SearchProvider, settings: Settings) {
  if (provider === "serpapi" && !settings.integrations.serpapiKey) return "NEWSBEE_SERPAPI_API_KEY is not set";
  if (provider === "searchapi" && !settings.integrations.searchapiKey) return "NEWSBEE_SEARCHAPI_API_KEY is not set";
  if (provider === "brightdata" && !(settings.integrations.brightdataKey && settings.integrations.brightdataZone)) return "NEWSBEE_BRIGHTDATA_API_KEY and NEWSBEE_BRIGHTDATA_ZONE are not set";
  if (provider === "exa" && !settings.integrations.exaKey) return "NEWSBEE_EXA_API_KEY is not set";
  if (provider === "tavily" && !settings.tavilySearchApiKey) return "NEWSBEE_TAVILY_API_KEY is not set";
  if (provider === "fixture" && isDeployed()) return "The fixture provider is local only";
  return null;
}

export type SearchInput = { db: Db; settings: Settings; transport: HttpTransport; query: string; topic: string | null; family: string; stage: "stage1" | "stage2"; origin?: "template" | "agent"; provider?: SearchProvider };

/** Run one query and log it. A refused or failed query returns no results, with the reason. */
export async function search(input: SearchInput): Promise<{ id: unknown; results: SearchResult[]; skipped: string | null; error: string | null; provider: string }> {
  const provider = input.provider ?? currentOptions().search_provider;
  const context = runContext();
  const key = createHash("sha256").update(`${provider}:${input.query}`).digest("hex");
  let results: SearchResult[] = [], skipped: string | null = missingKey(provider, input.settings), error: string | null = null, cached = false;
  if (!skipped) {
    const fresh = await searchQueries(input.db).findOne({ key, skipped: null, error: null, created_at: { $gte: Date.now() / 1000 - SEARCH_CACHE_DAYS * 86400 } }, { sort: { created_at: -1 } });
    if (fresh) { results = fresh.results; cached = true; }
    else if (provider === "fixture") results = await fixtureResults(input.db, input.query, input.topic);
    else {
      try {
        const call = () => provider === "serpapi" ? serpApi(input.settings, input.transport, input.query) : provider === "searchapi" ? searchApi(input.settings, input.transport, input.query) : provider === "brightdata" ? brightData(input.settings, input.transport, input.query) : provider === "tavily" ? tavily(input.settings, input.transport, input.query) : exa(input.settings, input.transport, input.query);
        const outcome = await paidCall(provider, call);
        skipped = outcome.refused;
        results = outcome.value ?? [];
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    }
  }
  const record: QueryRecord = {
    run_id: context?.runId ?? null, location_id: context?.locationId ?? null, provider, query: input.query, topic: input.topic, family: input.family, stage: input.stage, origin: input.origin ?? "template",
    results, result_count: results.length, cached, skipped, error, sources_added: 0, created_at: Date.now() / 1000, key,
  };
  const inserted = await searchQueries(input.db).insertOne(record);
  return { id: inserted.insertedId, results, skipped, error, provider };
}
