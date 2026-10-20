import { createHash } from "node:crypto";
import { FeedFormatError, addDays } from "../common";
import type { CollectedEvent, CollectedSource, Connector, GovernmentSource, LocationProfile, SourceResult, SourceTask } from "../types";
import { HttpStatusError } from "../../core/http";
import { Fetcher, DiscoveryBlockedError } from "../fetcher";
import { sourceResult } from "../types";
import type { DiscoveryResult } from "./discovery";
import { discoverGovernmentWithMethod, overrides, sourceId, USER_AGENT, PAST_DAYS, MAX_MEETINGS } from "./discovery";
import * as civicclerk from "./civicclerk";
import * as legistar from "./legistar";
import { outcome, preview, type MeetingFacts } from "./meetings";

const NO_PLATFORM = new Set(["unresolved_website", "no_platform", "blocked", "failed"]);
type PlatformData = { events: MeetingFacts[]; skipped: Record<string, number>; content: Uint8Array; url: string };
type Attempt = { result: SourceResult; events: MeetingFacts[] };
function day(value: { year: number; month: number; day: number }) {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}
function sourceName(location: LocationProfile) { return `${location.name.split(",")[0]} public meetings`; }
function bytesFetcher(fetcher: Fetcher) { return async (url: string) => (await fetcher.get(url, 4 * 1024 * 1024, "application/json"))[1]; }
function errorName(error: unknown) { return error instanceof Error ? error.name : "Error"; }
function retryable(error: HttpStatusError) { return error.status === 429 || error.status >= 500; }
type UsableGovernment = GovernmentSource & { platform: "legistar" | "civicclerk"; tenant: string; discovery_method?: "rules" | "ai" };
function usablePlatform(government: Partial<GovernmentSource> | DiscoveryResult): government is UsableGovernment {
  return (government.platform === "legistar" || government.platform === "civicclerk") && Boolean(government.tenant) && ["detected", "override"].includes(government.status ?? "");
}
function priorStatus(government: GovernmentSource) {
  const mapped: Record<string, string> = { unresolved_website: "unresolved_website", no_platform: "no_feed", blocked: "blocked", failed: "failed" };
  return mapped[government.status] ?? (NO_PLATFORM.has(government.status) ? "no_feed" : "ingested");
}
function initialResult(location: LocationProfile, government: GovernmentSource): SourceResult {
  return sourceResult(sourceId(government), sourceName(location), priorStatus(government), government.detail, {
    website: government.website,
    feed_kind: government.platform,
    pages_checked: government.pages_checked ?? [],
  });
}
function compareStart(a: { year: number; month: number; day: number; hour?: number; minute?: number }, b: { year: number; month: number; day: number; hour?: number; minute?: number }) {
  const left = `${day(a)}T${String(a.hour ?? 0).padStart(2, "0")}:${String(a.minute ?? 0).padStart(2, "0")}`;
  const right = `${day(b)}T${String(b.hour ?? 0).padStart(2, "0")}:${String(b.minute ?? 0).padStart(2, "0")}`;
  return left < right ? -1 : left > right ? 1 : 0;
}
async function collectLegistar(fetcher: Fetcher, tenant: string, place: string, today: string, window: [string, string]): Promise<PlatformData> {
  const first = addDays(today, -PAST_DAYS), last = window[1], upcomingFrom = window[0];
  const url = legistar.eventsUrl(tenant, first, last);
  const content = await bytesFetcher(fetcher)(url);
  const dated = legistar.parseEvents(content).map((event) => ({ start: legistar.start(event), event }));
  const upcoming = dated.filter(({ start }) => day(start) >= upcomingFrom && day(start) <= last).sort((a, b) => compareStart(a.start, b.start));
  const recent = dated.filter(({ start }) => day(start) >= first && day(start) < today).sort((a, b) => compareStart(b.start, a.start));
  const skipped: Record<string, number> = { outside_window: dated.length - upcoming.length - recent.length };
  const facts: MeetingFacts[] = [];
  let fetched = 0;
  for (const { start, event } of [...upcoming, ...recent]) {
    if (legistar.isCancelled(event)) { skipped.cancelled = (skipped.cancelled ?? 0) + 1; continue; }
    if (fetched >= MAX_MEETINGS) { skipped.over_limit = (skipped.over_limit ?? 0) + 1; continue; }
    fetched += 1;
    const meeting = await legistar.meeting(tenant, event, bytesFetcher(fetcher));
    const made = day(start) < today ? outcome(meeting, place) : preview(meeting, place);
    if (!made) {
      const key = day(start) < today ? "no_recorded_outcomes" : "no_substantive_agenda";
      skipped[key] = (skipped[key] ?? 0) + 1;
    } else facts.push(made);
  }
  return { events: facts, skipped: Object.fromEntries(Object.entries(skipped).filter(([, count]) => count > 0)), content, url };
}
async function collectCivicclerk(fetcher: Fetcher, tenant: string, place: string, window: [string, string]): Promise<PlatformData> {
  const first = window[0], last = window[1];
  const url = civicclerk.eventsUrl(tenant, first, addDays(last, 1));
  const content = await bytesFetcher(fetcher)(url);
  const events = civicclerk.parseEvents(content);
  const skipped: Record<string, number> = {};
  const facts: MeetingFacts[] = [];
  const inc = (key: string) => { skipped[key] = (skipped[key] ?? 0) + 1; };
  for (const event of events.sort((a, b) => compareStart(civicclerk.start(a), civicclerk.start(b)))) {
    const start = civicclerk.start(event);
    if (day(start) < first || day(start) > last) { inc("outside_window"); continue; }
    if (typeof event.eventName === "string" && /cancel/i.test(event.eventName)) { inc("cancelled"); continue; }
    if (!civicclerk.usable(event)) { inc("agenda_not_posted"); continue; }
    if (facts.length + (skipped.no_substantive_agenda ?? 0) >= MAX_MEETINGS) { inc("over_limit"); continue; }
    const made = preview(await civicclerk.meeting(tenant, event, bytesFetcher(fetcher)), place);
    if (!made) inc("no_substantive_agenda");
    else facts.push(made);
  }
  return { events: facts, skipped, content, url };
}
function sourceResultFromData(government: GovernmentSource, location: LocationProfile, data: PlatformData): SourceResult {
  const previews = data.events.filter((event) => event.kind === "meeting_preview").length;
  return sourceResult(sourceId(government), sourceName(location), "ingested", `${government.platform} API: ${previews} upcoming agendas, ${data.events.length - previews} recent outcomes`, {
    website: government.website,
    feed_kind: government.platform,
    feed_url: data.url,
    pages_checked: government.pages_checked ?? [],
    response_sha256: createHash("sha256").update(data.content).digest("hex"),
    event_count: data.events.length,
    skipped_outside_window: data.skipped.outside_window ?? 0,
    skipped_unusable: Object.fromEntries(Object.entries(data.skipped).filter(([key]) => key !== "outside_window")),
  });
}
function ordinaryFailure(government: GovernmentSource, location: LocationProfile, error: unknown): Attempt {
  const status = error instanceof DiscoveryBlockedError ? "blocked" : "failed";
  const message = error instanceof Error ? error.message : String(error);
  return { result: sourceResult(sourceId(government), sourceName(location), status, `${errorName(error)}: ${message}`, { website: government.website, feed_kind: government.platform, pages_checked: government.pages_checked ?? [] }), events: [] };
}
async function attempt(government: GovernmentSource, location: LocationProfile, fetcher: Fetcher, today: string, window: [string, string]): Promise<Attempt> {
  if (!usablePlatform(government)) return { result: initialResult(location, government), events: [] };
  try {
    const data = government.platform === "legistar"
      ? await collectLegistar(fetcher, government.tenant, location.name.split(",")[0], today, window)
      : await collectCivicclerk(fetcher, government.tenant, location.name.split(",")[0], window);
    return { result: sourceResultFromData(government, location, data), events: data.events };
  } catch (error) {
    if (error instanceof HttpStatusError && retryable(error)) throw error;
    if (error instanceof FeedFormatError || error instanceof DiscoveryBlockedError || error instanceof HttpStatusError) return ordinaryFailure(government, location, error);
    throw error;
  }
}
function tenantFromCached(entry: { kind: string; url: string }): string | null {
  if (entry.kind === "legistar") return /\/v1\/([^/]+)\/bodies(?:\?|$)/.exec(entry.url)?.[1] ?? null;
  if (entry.kind === "civicclerk") return /^https:\/\/([a-z0-9-]+)\.api\.civicclerk\.com\//i.exec(entry.url)?.[1]?.toLowerCase() ?? null;
  return null;
}
async function rediscover(context: Parameters<Connector["collect"]>[1]): Promise<DiscoveryResult> {
  const configured = (await overrides(context.settings.root, context.db))[context.location.id] ?? null;
  return discoverGovernmentWithMethod(context.transport, context.location, configured, { model: context.model, log: context.log });
}
async function cacheEntry(context: Parameters<Connector["collect"]>[1], task: SourceTask, government: GovernmentSource, method: "rules" | "ai") {
  if (!usablePlatform(government)) return;
  const url = government.platform === "legistar" ? legistar.confirmUrl(government.tenant!) : civicclerk.confirmUrl(government.tenant!);
  await context.linkCache.put({
    source_id: task.source_id,
    location_id: context.location.id,
    kind: government.platform!,
    url,
    page: government.website,
    method,
  });
}
function cacheGovernment(original: GovernmentSource, entry: { kind: string; url: string; page?: string | null }): GovernmentSource | null {
  const tenant = tenantFromCached(entry);
  if (!tenant || !["legistar", "civicclerk"].includes(entry.kind)) return null;
  return { ...original, status: "detected", platform: entry.kind, tenant, website: entry.page ?? original.website };
}
function attachMethod(attempted: Attempt, method: "cache" | "rules" | "ai") {
  attempted.result.link_discovery = { method };
  return { result: attempted.result, events: attempted.events };
}

/** Query a supplied, supported platform without rediscovering or changing the location's primary source. */
export async function collectMeetingLink(context: Parameters<Connector["collect"]>[1], government: GovernmentSource) {
  const result = await attempt(government, context.location, new Fetcher(context.transport, USER_AGENT), context.today, context.window);
  return { result: result.result, events: result.events };
}

export const meetingsConnector: Connector = {
  type: "meetings",
  sources(location: LocationProfile) {
    if (!location.government) return [];
    const government = location.government;
    return [{ source_id: sourceId(government), name: sourceName(location), type: "meetings", params: { government } }];
  },
  async collect(task: SourceTask, context): Promise<CollectedSource> {
    const original = (task.params?.government as GovernmentSource | undefined) ?? context.location.government;
    if (!original) return { result: sourceResult(task.source_id, task.name, "no_feed", "No government meeting platform configured"), events: [] };
    const fetcher = new Fetcher(context.transport, USER_AGENT);
    let government = original;
    let method: "cache" | "rules" | "ai" = "rules";
    const cached = await context.linkCache.get(context.location.id, task.source_id);
    if (cached) {
      const restored = cacheGovernment(original, cached);
      if (restored) { government = restored; method = "cache"; }
      else await context.linkCache.invalidate(context.location.id, task.source_id);
    }
    if (!usablePlatform(government) && ["no_platform", "unresolved_website", "blocked", "failed"].includes(government.status)) {
      const skipped = initialResult(context.location, government);
      context.log.info("government_meetings_result", { source_id: skipped.source_id, status: skipped.status, meetings: 0, skipped: {}, detail: skipped.detail });
      return { result: skipped, events: [] };
    }
    if (!usablePlatform(government)) {
      await context.linkCache.invalidate(context.location.id, task.source_id);
      const discovered = await rediscover(context);
      if (usablePlatform(discovered)) {
        government = discovered;
        method = discovered.discovery_method ?? "rules";
        await cacheEntry(context, task, government, method === "ai" ? "ai" : "rules");
      } else {
        const skipped = initialResult(context.location, discovered);
        skipped.source_id = sourceId(discovered);
        skipped.link_discovery = { method: discovered.discovery_method ?? "rules" };
        context.log.info("government_meetings_result", { source_id: skipped.source_id, status: skipped.status, meetings: 0, skipped: {}, detail: skipped.detail });
        return { result: skipped, events: [] };
      }
    }
    let first = await attempt(government, context.location, fetcher, context.today, context.window);
    first = attachMethod(first, method);
    if (first.events.length > 0) {
      await cacheEntry(context, task, government, method === "cache" ? (cached?.method ?? "rules") : method);
      context.log.info("government_meetings_result", { source_id: first.result.source_id, status: first.result.status, meetings: first.events.length, skipped: first.result.skipped_unusable, detail: first.result.detail });
      return { result: first.result, events: first.events as CollectedEvent[] };
    }
    await context.linkCache.invalidate(context.location.id, task.source_id);
    let discovered: DiscoveryResult;
    try { discovered = await rediscover(context); }
    catch (error) {
      context.log.warn("government_meetings_rediscovery_failed", { source_id: task.source_id, error });
      context.log.info("government_meetings_result", { source_id: first.result.source_id, status: first.result.status, meetings: 0, skipped: first.result.skipped_unusable, detail: first.result.detail });
      return { result: first.result, events: [] };
    }
    if (!usablePlatform(discovered)) {
      const result = first.result.status === "failed" || first.result.status === "blocked" ? first.result : initialResult(context.location, discovered);
      result.link_discovery = { method: discovered.discovery_method ?? "rules" };
      context.log.info("government_meetings_result", { source_id: result.source_id, status: result.status, meetings: 0, skipped: result.skipped_unusable, detail: result.detail });
      return { result, events: [] };
    }
    const retryMethod = discovered.discovery_method ?? "rules";
    await cacheEntry(context, task, discovered, retryMethod);
    const retried = attachMethod(await attempt(discovered, context.location, fetcher, context.today, context.window), retryMethod);
    if (retried.events.length === 0) await context.linkCache.invalidate(context.location.id, task.source_id);
    else await cacheEntry(context, task, discovered, retryMethod);
    context.log.info("government_meetings_result", { source_id: retried.result.source_id, status: retried.result.status, meetings: retried.events.length, skipped: retried.result.skipped_unusable, detail: retried.result.detail });
    return { result: retried.result, events: retried.events as CollectedEvent[] };
  },
};

export { discoverGovernment, overrides, sourceId } from './discovery';
