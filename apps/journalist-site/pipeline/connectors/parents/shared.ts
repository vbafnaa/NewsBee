/**
 * Shared plumbing for the parent-and-homeowner connectors (civiccalendar, homesafety, housing,
 * development, athletics): robots-checked fetches, status mapping and location relevance.
 */
import { HttpStatusError } from "../../core/http";
import { loadSourceConfig } from "../../storage/source-configs";
import { FeedFormatError, MAX_FEED_BYTES, plainText } from "../common";
import { DiscoveryBlockedError } from "../fetcher";
import { sourceResult, type CollectedEvent, type CollectedSource, type ConnectorContext, type SourceResult, type SourceTask } from "../types";
import { distanceKm, LOCAL_KM, NEARBY_KM, resolveRegion, validateStateSources, type Region } from "../wider/regions";

export type Tier = "local" | "region" | "nearby";
export const ACCEPT_JSON = "application/json";

/** An ordinary, non-retryable source problem, reported on the Health page instead of thrown. */
export class SourceUnavailable extends Error {
  constructor(readonly status: "failed" | "blocked" | "no_feed", message: string) { super(message); }
}
function errorText(error: unknown) { return error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error); }
export function transient(error: unknown) { return error instanceof HttpStatusError && (error.status === 429 || error.status >= 500); }

/** Robots-checked GET. 429/5xx are rethrown so the job queue retries; other failures become a status. */
export async function fetchBytes(context: ConnectorContext, url: string, accept: string, maxBytes = MAX_FEED_BYTES): Promise<Uint8Array> {
  try { const [, body] = await context.fetcher.get(url, maxBytes, accept); return body; }
  catch (error) {
    if (transient(error)) throw error;
    if (error instanceof DiscoveryBlockedError) throw new SourceUnavailable("blocked", errorText(error));
    if (error instanceof HttpStatusError || error instanceof FeedFormatError) throw new SourceUnavailable("failed", errorText(error));
    throw error;
  }
}
export function decode(body: Uint8Array) { return new TextDecoder().decode(body); }
export async function fetchJson<T>(context: ConnectorContext, url: string): Promise<T> {
  const body = await fetchBytes(context, url, ACCEPT_JSON);
  try { return JSON.parse(decode(body)) as T; }
  catch (error) { throw new SourceUnavailable("failed", `Expected JSON from ${url}: ${errorText(error)}`); }
}

/** Runs a collector body, turning SourceUnavailable and unexpected errors into a SourceResult. */
export async function runCollector(task: SourceTask, context: ConnectorContext, body: (record: SourceResult) => Promise<CollectedEvent[]>): Promise<CollectedSource> {
  const record = sourceResult(task.source_id, task.name, "ingested", "");
  try {
    const events = await body(record);
    record.event_count = events.length;
    return { result: record, events };
  } catch (error) {
    if (transient(error)) throw error;
    if (error instanceof SourceUnavailable) { record.status = error.status; record.detail = error.message; return { result: record, events: [] }; }
    record.status = "failed"; record.detail = errorText(error);
    context.log.error("parent_source_crashed", { source_id: task.source_id, error: record.detail });
    return { result: record, events: [] };
  }
}
export function skip(record: SourceResult, reason: string, count = 1) {
  if (count > 0) record.skipped_unusable[reason] = (record.skipped_unusable[reason] ?? 0) + count;
}

export async function locationRegion(context: ConnectorContext): Promise<Region> {
  return resolveRegion(context.location, validateStateSources(await loadSourceConfig(context.db, context.settings.root, "state-sources")));
}
export function hasPoint(region: Region): region is Region & { latitude: number; longitude: number } {
  return typeof region.latitude === "number" && typeof region.longitude === "number" && Number.isFinite(region.latitude) && Number.isFinite(region.longitude);
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Tier for a record's own place name: the town (or a neighbourhood's coverage terms) is local, configured places within 50 km are nearby. */
export function placeTier(region: Region, place: string | null | undefined): Tier | null {
  if (!place?.trim()) return null;
  const name = norm(place);
  if ([region.town, ...region.aliases, ...(region.community_terms ?? [])].some((term) => norm(term) === name)) return "local";
  return region.nearby.some((term) => norm(term) === name) ? "nearby" : null;
}
/** Tier for a record's coordinates: within `localKm` is local, within NEARBY_KM is nearby. */
export function pointTier(region: Region, latitude: number, longitude: number, localKm = LOCAL_KM, nearbyKm = NEARBY_KM): { tier: Tier; distance_km: number } | null {
  if (!hasPoint(region) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const distance = Math.round(distanceKm(region.latitude, region.longitude, latitude, longitude) * 10) / 10;
  if (distance <= localKm) return { tier: "local", distance_km: distance };
  return distance <= nearbyKm ? { tier: "nearby", distance_km: distance } : null;
}
export function sectionFor(region: Region, tier: Tier, topic: string) { return tier === "local" ? `${topic} in ${region.town}` : `${topic} near ${region.town}`; }
export function isoDay(value: unknown): string | null {
  const match = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(value.trim()) : null;
  return match ? match[1] : null;
}

/** Plain text for a name or address: plainText without the sentence period it adds. */
export function label(value: unknown, limit = 120): string | null { return plainText(value, limit)?.replace(/(?<!\.)\.$/, "") || null; }
