import type { Db } from "mongodb";
import { loadSourceConfig } from "../../storage/source-configs";
import { HttpStatusError, type HttpTransport } from "../../core/http";
import { logger, type Logger } from "../../core/log";
import type { ModelRuntime } from "../../model/runtime";
import { chooseLinks, pageLinks } from "../ai-discovery";
import { DiscoveryBlockedError, Fetcher } from "../fetcher";
import { addDays, FeedFormatError, MAX_FEED_BYTES, httpsLink } from "../common";
import type { GovernmentSource, LocationProfile } from "../types";
import * as civicclerk from "./civicclerk";
import * as legistar from "./legistar";
import { lookup } from "./wikidata";

export const USER_AGENT = "Newsbee-LocalPrototype/0.1 (local government meetings evaluation)";
export const PAST_DAYS = 7;
export const MAX_MEETINGS = 25;
export const MAX_CANDIDATE_PAGES = 3;
export const SUPPORTED = ["legistar", "civicclerk"] as const;
export const TENANT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PLATFORM_LINKS: Record<string, RegExp> = {
  legistar: /\b([a-z0-9][a-z0-9-]{0,62})\.legistar\.com/i,
  civicclerk: /\b([a-z0-9][a-z0-9-]{0,62})\.(?:portal|api)\.civicclerk\.com/i,
  primegov: /\b([a-z0-9][a-z0-9-]{0,62})\.primegov\.com/i,
};
const NOT_TENANTS = new Set(["webapi", "www", "api", "portal"]);
const MEETING_LINK = /agenda|meeting|council|minutes|government|legislat/i;
const INGESTION_STATUS: Record<string, string> = { unresolved_website: "unresolved_website", no_platform: "no_feed", blocked: "blocked", failed: "failed" };
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export type DiscoveryOptions = { model?: ModelRuntime | null; log?: Logger };
export type DiscoveryResult = GovernmentSource & { discovery_method?: "rules" | "ai" };

export async function overrides(root: string, db: Db): Promise<Record<string, { platform: string; tenant: string }>> {
  const entries: unknown = await loadSourceConfig(db, root, "government-sources");
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("government-sources.json must map location ids to {platform, tenant}");
  for (const [key, entry] of Object.entries(entries)) {
    const value = entry as Record<string, unknown>;
    if (!value || typeof value !== "object" || !SUPPORTED.includes(value.platform as typeof SUPPORTED[number]) || typeof value.tenant !== "string" || !TENANT.test(value.tenant)) {
      throw new Error(`government-sources.json entry ${key} needs a platform (${SUPPORTED.join(", ")}) and a lowercase tenant name`);
    }
  }
  return entries as Record<string, { platform: string; tenant: string }>;
}
export function sourceId(government: Partial<GovernmentSource> | null | undefined) {
  return `meetings:${government?.platform || "none"}:${government?.tenant || "none"}`;
}
function found(status: string, detail: string, values: Partial<GovernmentSource> = {}): DiscoveryResult {
  return { status, platform: null, tenant: null, website: null, wikidata_id: null, pages_checked: [], ...values, detail };
}
export function platformLinks(html: string): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const [platform, pattern] of Object.entries(PLATFORM_LINKS)) {
    for (const match of html.matchAll(new RegExp(pattern.source, "gi"))) {
      const tenant = match[1].toLowerCase();
      if (!NOT_TENANTS.has(tenant)) result.push([platform, tenant]);
    }
  }
  return [...new Map(result.map((item) => [item.join("\u0000"), item])).values()];
}
function sameSite(url: URL, page: URL) {
  const site = page.hostname.replace(/^www\./, "");
  const host = url.hostname.replace(/^www\./, "");
  return host === site || host.endsWith(`.${site}`);
}
export function meetingPages(html: string, page: string) {
  const links: string[] = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (const match of html.matchAll(anchor)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
    if (!href) continue;
    const raw = href[1] ?? href[2] ?? href[3] ?? "";
    let url: URL;
    try { url = new URL(raw, page); } catch { continue; }
    const safe = httpsLink(url.toString());
    if (!safe || !sameSite(new URL(safe), new URL(page))) continue;
    const label = match[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    if (MEETING_LINK.test(url.pathname) || MEETING_LINK.test(label)) links.push(safe.split("#")[0]);
  }
  return [...new Set(links)].filter((url) => url.replace(/\/$/, "") !== page.replace(/\/$/, "")).slice(0, MAX_CANDIDATE_PAGES);
}
function retryable(error: HttpStatusError) { return error.status === 429 || error.status >= 500; }
async function getBytes(fetcher: Fetcher, url: string) { return (await fetcher.get(url, MAX_FEED_BYTES, "application/json"))[1]; }
async function confirm(fetcher: Fetcher, platform: string, tenant: string): Promise<boolean> {
  const url = platform === "legistar" ? legistar.confirmUrl(tenant) : civicclerk.confirmUrl(tenant);
  try {
    const content = await getBytes(fetcher, url);
    if (platform === "legistar") return legistar.parseEvents(content).length > 0;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(content));
    return Boolean(parsed && typeof parsed === "object" && Array.isArray((parsed as { value?: unknown }).value));
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 429) throw error;
    if (error instanceof FeedFormatError || error instanceof SyntaxError || error instanceof HttpStatusError) return false;
    throw error;
  }
}
async function choose(fetcher: Fetcher, candidates: Array<[string, string]>) {
  for (const [platform, tenant] of candidates) {
    if (platform === "primegov" || await confirm(fetcher, platform, tenant)) return [platform, tenant] as [string, string];
  }
  return null;
}
async function scan(fetcher: Fetcher, website: string, checked: string[]) {
  const [page, bytes] = await fetcher.get(website, MAX_PAGE_BYTES, "text/html");
  const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  checked.push(page);
  let match = await choose(fetcher, platformLinks(html));
  if (match) return match;
  for (const candidate of meetingPages(html, page)) {
    try {
      const [final, content] = await fetcher.get(candidate, MAX_PAGE_BYTES, "text/html");
      checked.push(final);
      match = await choose(fetcher, platformLinks(new TextDecoder("utf-8", { fatal: false }).decode(content)));
      if (match) return match;
    } catch (error) {
      if (error instanceof HttpStatusError && retryable(error)) throw error;
      if (error instanceof DiscoveryBlockedError || error instanceof FeedFormatError || error instanceof HttpStatusError) {
        checked.push(`${candidate} (${error.message})`);
        continue;
      }
      throw error;
    }
  }
  return null;
}
export function guesses(website: string | null, profile: LocationProfile) {
  let label = "";
  if (website) {
    try { label = new URL(website).hostname.replace(/^www\./, "").split(".")[0].toLowerCase(); } catch { /* unusable website is handled by Fetcher */ }
  }
  const city = profile.name.split(",")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  const state = profile.id.split("-").at(-1)?.toLowerCase() ?? "";
  const candidates = [label.length >= 4 ? label : "", `${city}${state}`];
  return [...new Set(candidates)].filter((slug) => slug && TENANT.test(slug));
}
async function aiScan(fetcher: Fetcher, website: string, model: ModelRuntime, log?: Logger): Promise<{ match: [string, string] | null; pages: string[] }> {
  const [page, bytes] = await fetcher.get(website, MAX_PAGE_BYTES, "text/html");
  const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const pages = [page];
  const home = pageLinks(html, page);
  const candidates = await chooseLinks(model, "the town's public meeting agendas or meeting platform", page, home, log);
  let match: [string, string] | null = null;
  for (const candidate of candidates) {
    const embedded = platformLinks(candidate);
    match = await choose(fetcher, embedded);
    if (match) return { match, pages };
    let parsed: URL;
    try { parsed = new URL(candidate); } catch { continue; }
    if (!sameSite(parsed, new URL(page))) continue;
    try {
      const [final, content] = await fetcher.get(candidate, MAX_PAGE_BYTES, "text/html");
      pages.push(final);
      const childHtml = new TextDecoder("utf-8", { fatal: false }).decode(content);
      match = await choose(fetcher, platformLinks(childHtml));
      if (match) return { match, pages };
      const childLinks = pageLinks(childHtml, final);
      const chosen = await chooseLinks(model, "the town's public meeting agendas or meeting platform", final, childLinks, log);
      match = await choose(fetcher, chosen.flatMap(platformLinks));
      if (match) return { match, pages };
    } catch (error) {
      if (error instanceof HttpStatusError && retryable(error)) throw error;
      if (error instanceof DiscoveryBlockedError || error instanceof FeedFormatError || error instanceof HttpStatusError) continue;
      throw error;
    }
  }
  return { match: null, pages };
}
async function confirmationCount(fetcher: Fetcher, candidate: [string, string]) {
  const [platform, tenant] = candidate;
  const today = new Date().toISOString().slice(0, 10);
  const first = addDays(today, 1);
  const last = addDays(today, 7);
  try {
    const url = platform === "legistar"
      ? legistar.eventsUrl(tenant, first, last)
      : civicclerk.eventsUrl(tenant, first, addDays(last, 1));
    const content = await getBytes(fetcher, url);
    return platform === "legistar" ? legistar.parseEvents(content).length : civicclerk.parseEvents(content).length;
  } catch { return 0; }
}
async function internalDiscover(transport: HttpTransport, profile: LocationProfile, override?: object | null, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  if (override) {
    const value = override as { platform: string; tenant: string };
    return found("override", "Platform from config/government-sources.json", { platform: value.platform, tenant: value.tenant });
  }
  const city = profile.name.split(",")[0];
  const system = profile.systems.find((item) => item.latitude !== null && item.latitude !== undefined);
  const latitude = system?.latitude !== undefined && system?.latitude !== null ? Number(system.latitude) : profile.latitude ?? null;
  const longitude = system?.longitude !== undefined && system?.longitude !== null ? Number(system.longitude) : profile.longitude ?? null;
  let lookupResult;
  try { lookupResult = await lookup(transport, city, latitude, longitude); }
  catch (error) {
    return found("failed", `Wikidata lookup failed: ${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const website = lookupResult.website as string | null;
  const known = { website, wikidata_id: lookupResult.wikidata_id as string | null };
  const rulesFetcher = new Fetcher(transport, USER_AGENT);
  const aiFetcher = new Fetcher(transport, USER_AGENT);
  const checked: string[] = [];
  let how = "linked from the town website";
  let rules: [string, string] | null = null;
  let ai: { match: [string, string] | null; pages: string[] } = { match: null, pages: [] };
  try {
    if (website) {
      const work: Array<Promise<unknown>> = [scan(rulesFetcher, website, checked).then((value) => { rules = value; })];
      if (options.model) work.push(aiScan(aiFetcher, website, options.model, options.log ?? logger("meetings")).then((value) => { ai = value; }));
      await Promise.all(work);
    }
    if (rules === null && website) {
      const guessed = await choose(rulesFetcher, guesses(website, profile).flatMap((slug) => SUPPORTED.map((platform) => [platform, slug] as [string, string])));
      if (guessed) { rules = guessed; how = "found under a name guessed from the town"; }
    }
    if (ai.match === null && options.model) {
      // Guessed tenants are rule-based; AI is limited to links actually present on the website.
    }
  } catch (error) {
    if (error instanceof DiscoveryBlockedError) return found("blocked", error.message, { ...known, pages_checked: checked });
    return found("failed", `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`, { ...known, pages_checked: checked });
  }
  if (!website && rules === null) {
    try {
      const guessed = await choose(rulesFetcher, guesses(null, profile).flatMap((slug) => SUPPORTED.map((platform) => [platform, slug] as [string, string])));
      if (guessed) { rules = guessed; how = "found under a name guessed from the town"; }
    } catch (error) {
      return found("failed", `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!rules && !ai.match && !website) return found("unresolved_website", `${lookupResult.detail}; no supported meeting platform under a name guessed from the town`);
  if (!rules && !ai.match) return found("no_platform", "No supported meeting platform (Legistar, CivicClerk) linked from the town website or found under its name", { ...known, pages_checked: checked });

  let selected = rules ?? ai.match!;
  let method: "rules" | "ai" = rules ? "rules" : "ai";
  if (rules && ai.match && (rules[0] !== ai.match[0] || rules[1] !== ai.match[1])) {
    const [rulesCount, aiCount] = await Promise.all([confirmationCount(rulesFetcher, rules), confirmationCount(aiFetcher, ai.match)]);
    if (aiCount > rulesCount) { selected = ai.match; method = "ai"; }
  } else if (!rules && ai.match) method = "ai";
  const [platform, tenant] = selected;
  const pages = method === "ai" ? [...new Set([...checked, ...ai.pages])] : checked;
  const values = { platform, tenant, pages_checked: pages, ...known };
  if (platform === "primegov") {
    const url = `https://${tenant}.primegov.com/api/v2/PublicPortal/ListUpcomingMeetings`;
    try {
      if (!(await rulesFetcher.allowed(url))) return found("blocked", `PrimeGov robots.txt disallows ${url}`, values);
    } catch (error) { return found("failed", `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`, values); }
    return found("no_platform", "PrimeGov is not supported yet", values);
  }
  const detail = method === "ai" ? `${platform} tenant ${tenant} found by AI-assisted meeting-page discovery` : `${platform} tenant ${tenant} ${how}`;
  return { ...found("detected", detail, values), discovery_method: method };
}
export async function discoverGovernmentWithMethod(transport: HttpTransport, profile: LocationProfile, override?: object | null, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  return internalDiscover(transport, profile, override, options);
}
export async function discoverGovernment(transport: HttpTransport, profile: LocationProfile, override?: object | null, options: DiscoveryOptions = {}): Promise<GovernmentSource> {
  const result = await internalDiscover(transport, profile, override, options);
  delete result.discovery_method;
  return result;
}
