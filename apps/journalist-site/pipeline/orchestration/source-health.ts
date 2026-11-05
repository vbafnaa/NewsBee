/**
 * Per-location source health, ported from the exploration pipeline's source scoring: each
 * collection updates a streak so editors can see a source that keeps failing or keeps
 * returning nothing, instead of reading each run's detail line.
 */
import type { Db } from "mongodb";

export const SOURCE_HEALTH = "source_health";
export const FAILING_AFTER = 3;
export const QUIET_AFTER = 4;
/** Outcomes that say nothing about the source itself: it ran out of time, or needs a map run. */
export const NEUTRAL_OUTCOMES = ["partial", "needs_remap"];
const DURATIONS_KEPT = 5;

export type SourceHealth = {
  _id: string;
  location_id: string;
  source_id: string;
  last_status: string;
  last_day: string;
  last_success_day: string | null;
  last_items_day: string | null;
  consecutive_failures: number;
  consecutive_empty: number;
  flag: "healthy" | "failing" | "quiet";
  /** How long this source's recent collections took, to put the quick ones first. */
  recent_seconds?: number[];
  median_seconds?: number;
};

export function healthFlag(failures: number, empty: number): SourceHealth["flag"] {
  if (failures >= FAILING_AFTER) return "failing";
  if (empty >= QUIET_AFTER) return "quiet";
  return "healthy";
}

/** Records one collection outcome; returns the updated health entry. */
export async function recordSourceHealth(db: Db, locationId: string, sourceId: string, status: string, events: number, day: string, seconds?: number): Promise<SourceHealth> {
  const collection = db.collection<SourceHealth>(SOURCE_HEALTH);
  const _id = `${locationId}:${sourceId}`;
  const previous = await collection.findOne({ _id });
  const neutral = NEUTRAL_OUTCOMES.includes(status);
  const ok = status === "ingested" || (neutral && events > 0);
  const consecutive_failures = ok || status === "no_feed" ? 0 : neutral ? previous?.consecutive_failures ?? 0 : (previous?.consecutive_failures ?? 0) + 1;
  const consecutive_empty = status === "ingested" && events === 0 ? (previous?.consecutive_empty ?? 0) + 1 : ok ? 0 : previous?.consecutive_empty ?? 0;
  const recent_seconds = [...(previous?.recent_seconds ?? []), ...(typeof seconds === "number" ? [Math.round(seconds)] : [])].slice(-DURATIONS_KEPT);
  const health: SourceHealth = {
    _id, location_id: locationId, source_id: sourceId, last_status: status, last_day: day,
    last_success_day: ok ? day : previous?.last_success_day ?? null,
    last_items_day: ok && events > 0 ? day : previous?.last_items_day ?? null,
    consecutive_failures, consecutive_empty, flag: healthFlag(consecutive_failures, consecutive_empty), recent_seconds,
    ...(recent_seconds.length ? { median_seconds: [...recent_seconds].sort((a, b) => a - b)[Math.floor(recent_seconds.length / 2)] } : {}),
  };
  await collection.replaceOne({ _id }, health, { upsert: true });
  return health;
}

export async function locationHealth(db: Db, locationId?: string) {
  return db.collection<SourceHealth>(SOURCE_HEALTH).find(locationId ? { location_id: locationId } : {}).sort({ flag: 1, source_id: 1 }).toArray();
}
