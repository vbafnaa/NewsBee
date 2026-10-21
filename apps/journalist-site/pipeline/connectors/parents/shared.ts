/**
 * Shared plumbing for the parent-and-homeowner connectors (civiccalendar, homesafety, housing,
 * development, athletics): robots-checked fetches, status mapping and location relevance.
 */
import { HttpStatusError } from "../../core/http";
import { WINDOW_DAYS } from "../../core/time";
import { COLLECTIONS } from "../../storage/mongo";
import { loadSourceConfig } from "../../storage/source-configs";
import { addDays, FeedFormatError, MAX_FEED_BYTES, plainText } from "../common";
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
  return (await fetchResponse(context, url, accept, maxBytes)).body;
}
/** fetchBytes plus the response headers (for example Last-Modified, used as a release date). */
export async function fetchResponse(context: ConnectorContext, url: string, accept: string, maxBytes = MAX_FEED_BYTES): Promise<{ body: Uint8Array; headers: Record<string, string> }> {
  try { const { body, headers } = await context.fetcher.getResponse(url, maxBytes, accept); return { body, headers }; }
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

/** How many recent published editions are checked for items that already ran. */
export const PUBLISHED_EDITIONS_CHECKED = 52;
type PublishedEdition = { id: string; today?: string; published_at?: number };
type PublishedEntry = { result?: { story?: { occurrences?: Array<{ source_id?: string; source_event_id?: string }> } } };

async function publishedEditions(context: ConnectorContext): Promise<PublishedEdition[]> {
  return context.db.collection<PublishedEdition>(COLLECTIONS.editions)
    .find({ location_id: context.location.id, status: "published" }, { projection: { id: 1, today: 1, published_at: 1 } })
    .sort({ published_at: -1 }).limit(PUBLISHED_EDITIONS_CHECKED).toArray();
}

/**
 * First day of the period this edition reports on: the previous published edition's day, or one
 * edition window (WINDOW_DAYS) back if that's later or there is none. The boundary day overlaps
 * the previous edition on purpose, so nothing published after its run is missed; items it
 * already ran are removed by publishedKeys.
 */
export async function reportingSince(context: ConnectorContext): Promise<string> {
  const floor = addDays(context.today, -WINDOW_DAYS);
  const last = (await publishedEditions(context)).map((edition) => edition.today).filter((day): day is string => typeof day === "string" && day <= context.today).sort().at(-1);
  return last && last > floor ? last : floor;
}

/** source_event_ids from this source that already ran in a published edition for the location. */
export async function publishedKeys(context: ConnectorContext, sourceId: string): Promise<Set<string>> {
  const ids = (await publishedEditions(context)).map((edition) => edition.id);
  const keys = new Set<string>();
  if (!ids.length) return keys;
  const entries = context.db.collection<PublishedEntry & { edition_id: string; disposition: string }>(COLLECTIONS.editionEntries)
    .find({ edition_id: { $in: ids }, disposition: { $ne: "held" } }, { projection: { "result.story.occurrences": 1 } });
  for await (const entry of entries) {
    for (const item of entry.result?.story?.occurrences ?? []) if (item.source_id === sourceId && item.source_event_id) keys.add(item.source_event_id);
  }
  return keys;
}
