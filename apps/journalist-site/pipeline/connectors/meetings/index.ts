import { localityFor, quickEvidence, type Locality } from "../locality";
import { createHash } from "node:crypto";
import { FeedFormatError, addDays } from "../common";
import type { CollectedEvent, CollectedSource, Connector, ConnectorContext, GovernmentSource, LocationProfile, LookupWindow, SourceResult, SourceTask } from "../types";
import { rangesFor } from "../../core/time";
import { HttpStatusError } from "../../core/http";
import { Fetcher, DiscoveryBlockedError } from "../fetcher";
import { sourceResult } from "../types";
import type { DiscoveryResult } from "./discovery";
import { discoverGovernmentWithMethod, sourceId, USER_AGENT, PAST_DAYS, MAX_MEETINGS } from "./discovery";
import { MANAGED_SOURCE_DETAIL } from "../../communities/locations";
import * as civicclerk from "./civicclerk";
import * as legistar from "./legistar";
import { outcome, preview, type Meeting, type MeetingFacts } from "./meetings";
import { communityEvidence } from "../community";
import { collectCouncilDocuments } from "./documents";
import * as meetingsRanking from "../../ranking/meetings";

const NO_PLATFORM = new Set(["unresolved_website", "no_platform", "blocked", "failed"]);
type PlatformData = { events: MeetingFacts[]; skipped: Record<string, number>; content: Uint8Array; url: string };
type Attempt = { result: SourceResult; events: MeetingFacts[] };
function day(value: { year: number; month: number; day: number }) {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}
function jurisdiction(location: LocationProfile) { return location.community?.parent_name ?? location.name.split(",")[0]; }
function sourceName(location: LocationProfile) { return `${jurisdiction(location)} public meetings${location.community ? ` affecting ${location.community.name}` : ""}`; }
export function scopeMeeting(meeting: Meeting, location: LocationProfile, locality?: Locality | null): Meeting {
  if (!location.community) return meeting;
  // The meeting's venue (often City Hall) is not evidence of neighborhood impact.
  const evidenceFor = (title: string) => communityEvidence(location, [title]) ?? (locality ? quickEvidence(locality, [title]) : null);
  const items = meeting.items.filter((item) => evidenceFor(item.title));
  return { ...meeting, items, community_relevance: items.flatMap((item) => {
    const evidence = evidenceFor(item.title);
    return evidence ? [evidence] : [];
  }) };
}
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
async function collectLegistar(fetcher: Fetcher, tenant: string, location: LocationProfile, today: string, window: [string, string], pastFrom: string, locality?: Locality | null): Promise<PlatformData> {
  const first = pastFrom, last = window[1], upcomingFrom = window[0];
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
    const meeting = scopeMeeting(await legistar.meeting(tenant, event, bytesFetcher(fetcher)), location, locality);
    if (location.community && !meeting.items.length) { skipped.outside_community = (skipped.outside_community ?? 0) + 1; continue; }
    const place = jurisdiction(location);
    const made = day(start) < today ? outcome(meeting, place) : preview(meeting, place);
    if (!made) {
      const key = day(start) < today ? "no_recorded_outcomes" : "no_substantive_agenda";
      skipped[key] = (skipped[key] ?? 0) + 1;
    } else facts.push(made);
  }
  return { events: facts, skipped: Object.fromEntries(Object.entries(skipped).filter(([, count]) => count > 0)), content, url };
}
async function collectCivicclerk(fetcher: Fetcher, tenant: string, location: LocationProfile, window: [string, string], locality?: Locality | null): Promise<PlatformData> {
  const first = window[0], last = window[1];
  const url = civicclerk.eventsUrl(tenant, first, addDays(last, 1));
  const content = await bytesFetcher(fetcher)(url);
  const events = civicclerk.parseEvents(content);
  const skipped: Record<string, number> = {};
  const facts: MeetingFacts[] = [];
  const inc = (key: string) => { skipped[key] = (skipped[key] ?? 0) + 1; };
  let fetched = 0;
  for (const event of events.sort((a, b) => compareStart(civicclerk.start(a), civicclerk.start(b)))) {
    const start = civicclerk.start(event);
    if (day(start) < first || day(start) > last) { inc("outside_window"); continue; }
    if (typeof event.eventName === "string" && /cancel/i.test(event.eventName)) { inc("cancelled"); continue; }
    if (!civicclerk.usable(event)) { inc("agenda_not_posted"); continue; }
    if (fetched >= MAX_MEETINGS) { inc("over_limit"); continue; }
    fetched++;
    const meeting = scopeMeeting(await civicclerk.meeting(tenant, event, bytesFetcher(fetcher)), location, locality);
    if (location.community && !meeting.items.length) { inc("outside_community"); continue; }
    const made = preview(meeting, jurisdiction(location));
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
async function attempt(government: GovernmentSource, location: LocationProfile, fetcher: Fetcher, today: string, window: [string, string], pastFrom = addDays(today, -PAST_DAYS), locality?: Locality | null): Promise<Attempt> {
  if (!usablePlatform(government)) return { result: initialResult(location, government), events: [] };
  try {
    const data = government.platform === "legistar"
      ? await collectLegistar(fetcher, government.tenant, location, today, window, pastFrom, locality)
      : await collectCivicclerk(fetcher, government.tenant, location, window, locality);
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
  // An editor-set platform (Sources in the journalist portal) wins over discovery.
  const government = context.location.government;
  const configured = government?.detail === MANAGED_SOURCE_DETAIL && government.platform && government.tenant ? { platform: government.platform, tenant: government.tenant } : null;
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
  const result = await attempt(government, context.location, new Fetcher(context.transport, USER_AGENT), context.today, context.window, pastFrom(context), await localityFor(context, { geocodes: 0, articles: 0 }).catch(() => null));
  return { result: result.result, events: result.events };
}

/**
 * Recent outcomes since the last edition (up to 14 days), upcoming meetings for the next 7.
 * Council documents keep their own 35-day minutes lookback (DOCUMENT_PAST_DAYS) because
 * minutes are often posted weeks after a meeting; the published-story ledger stops repeats.
 */
const MEETINGS_WINDOW: LookupWindow = { back: { since: "last_edition", maxDays: 14 }, ahead: { days: 7 } };
/** First day of recent meeting outcomes for this run. */
function pastFrom(context: ConnectorContext) { return rangesFor(context, MEETINGS_WINDOW).back?.[0] ?? context.today; }

export const meetingsConnector: Connector = {
  type: "meetings",
  meta: {
    name: "Government meetings",
    formats: "Legistar and CivicClerk tenant APIs; official city council HTML/PDF agendas and minutes",
    manual: true,
    coverage: { group: "local", label: "public meetings" },
    storyKinds: ["meeting_preview", "meeting_outcome"],
  },
  window: MEETINGS_WINDOW,
  rank: meetingsRanking.rank,
  sources(location: LocationProfile) {
    const government = location.government;
    return [{ source_id: sourceId(government), name: sourceName(location), type: "meetings", params: government ? { government } : {} }];
  },
  async collect(task: SourceTask, context): Promise<CollectedSource> {
    const original = (task.params?.government as GovernmentSource | undefined) ?? context.location.government;
    const fetcher = new Fetcher(context.transport, USER_AGENT);
    let government: GovernmentSource = original ?? { status: "pending", platform: null, tenant: null, website: null, wikidata_id: null, pages_checked: [], detail: "Government source discovery pending" };
    let method: "cache" | "rules" | "ai" = "rules";
    const cached = await context.linkCache.get(context.location.id, task.source_id);
    if (!usablePlatform(government) && cached?.kind === "council_documents" && (government.website || cached.page)) {
      return collectCouncilDocuments(context, task, government.website ?? cached.page!);
    }
    if (cached) {
      const restored = cacheGovernment(government, cached);
      if (restored) { government = restored; method = "cache"; }
      else await context.linkCache.invalidate(context.location.id, task.source_id);
    }
    if (!usablePlatform(government) && ["no_platform", "unresolved_website"].includes(government.status)) {
      if (government.website) return collectCouncilDocuments(context, task, government.website);
      const skipped = initialResult(context.location, government);
      context.log.info("government_meetings_result", { source_id: skipped.source_id, status: skipped.status, meetings: 0, skipped: {}, detail: skipped.detail });
      return { result: skipped, events: [] };
    }
    if (!usablePlatform(government) && context.readOnly) {
      return { result: sourceResult(task.source_id, task.name, "needs_remap", "No saved meeting address: refresh the source map"), events: [] };
    }
    if (!usablePlatform(government)) {
      await context.linkCache.invalidate(context.location.id, task.source_id);
      const discovered = await rediscover(context);
      if (usablePlatform(discovered)) {
        government = discovered;
        method = discovered.discovery_method ?? "rules";
        await cacheEntry(context, task, government, method === "ai" ? "ai" : "rules");
      } else {
        if (discovered.website) return collectCouncilDocuments(context, task, discovered.website);
        context.log.warn("government_discovery_unavailable", { location_id: context.location.id, status: discovered.status, detail: discovered.detail });
        const skipped = initialResult(context.location, discovered);
        skipped.source_id = sourceId(discovered);
        skipped.link_discovery = { method: discovered.discovery_method ?? "rules" };
        context.log.info("government_meetings_result", { source_id: skipped.source_id, status: skipped.status, meetings: 0, skipped: {}, detail: skipped.detail });
        return { result: skipped, events: [] };
      }
    }
    let first = await attempt(government, context.location, fetcher, context.today, context.window, pastFrom(context), await localityFor(context, { geocodes: 0, articles: 0 }).catch(() => null));
    first = attachMethod(first, method);
    if (first.events.length > 0) {
      await cacheEntry(context, task, government, method === "ai" || (method === "cache" && cached?.method === "ai") ? "ai" : "rules");
      context.log.info("government_meetings_result", { source_id: first.result.source_id, status: first.result.status, meetings: first.events.length, skipped: first.result.skipped_unusable, detail: first.result.detail });
      return { result: first.result, events: first.events as CollectedEvent[] };
    }
    if (context.readOnly) {
      if (first.result.status === "failed") { first.result.status = "needs_remap"; first.result.detail = `Saved meeting address failed: refresh the source map. ${first.result.detail}`; }
      return { result: first.result, events: [] };
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
      if (discovered.website) return collectCouncilDocuments(context, task, discovered.website);
      const result = first.result.status === "failed" || first.result.status === "blocked" ? first.result : initialResult(context.location, discovered);
      result.link_discovery = { method: discovered.discovery_method ?? "rules" };
      context.log.info("government_meetings_result", { source_id: result.source_id, status: result.status, meetings: 0, skipped: result.skipped_unusable, detail: result.detail });
      return { result, events: [] };
    }
    const retryMethod = discovered.discovery_method ?? "rules";
    await cacheEntry(context, task, discovered, retryMethod);
    const retried = attachMethod(await attempt(discovered, context.location, fetcher, context.today, context.window, pastFrom(context), await localityFor(context, { geocodes: 0, articles: 0 }).catch(() => null)), retryMethod);
    if (retried.events.length === 0) await context.linkCache.invalidate(context.location.id, task.source_id);
    else await cacheEntry(context, task, discovered, retryMethod);
    context.log.info("government_meetings_result", { source_id: retried.result.source_id, status: retried.result.status, meetings: retried.events.length, skipped: retried.result.skipped_unusable, detail: retried.result.detail });
    return { result: retried.result, events: retried.events as CollectedEvent[] };
  },
};

export { discoverGovernment, sourceId } from './discovery';
