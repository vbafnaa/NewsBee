import type { Db } from "mongodb";
import { runs } from "./runs";

export type HealthDay = {
  day: string;
  completed_runs: number;
  failed_runs: number;
  published_items: number;
  held_items: number;
  source_ready: number;
  source_unavailable: number;
  source_failed: number;
  average_duration_seconds: number | null;
};
export type HealthHistory = { days: 7 | 30; location_id: string | null; timezone: "UTC"; series: HealthDay[] };

/** Derive history from actual completed runs; do not invent past provider/queue snapshots. */
export async function healthHistory(db: Db, days: 7 | 30, locationId: string | null = null, now = Date.now()): Promise<HealthHistory> {
  const today = new Date(now).toISOString().slice(0, 10);
  const end = Date.parse(`${today}T00:00:00Z`) + 86400000;
  const start = end - days * 86400000;
  const buckets = await runs(db).aggregate<HealthDay>([
    { $match: { status: { $in: ["published", "failed"] }, completed_at: { $gte: start / 1000, $lt: end / 1000 }, ...(locationId ? { location_id: locationId } : {}) } },
    { $group: {
      _id: { $dateToString: { format: "%Y-%m-%d", date: { $toDate: { $multiply: ["$completed_at", 1000] } }, timezone: "UTC" } },
      completed_runs: { $sum: { $cond: [{ $eq: ["$status", "published"] }, 1, 0] } },
      failed_runs: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
      published_items: { $sum: { $ifNull: ["$published.items", 0] } },
      held_items: { $sum: { $ifNull: ["$published.held", 0] } },
      source_ready: { $sum: { $size: { $filter: { input: "$sources", as: "source", cond: { $and: [
        { $eq: ["$$source.status", "completed"] }, { $in: ["$$source.result_status", ["ingested", "ok"]] },
      ] } } } } },
      source_failed: { $sum: { $size: { $filter: { input: "$sources", as: "source", cond: { $or: [
        { $eq: ["$$source.status", "failed"] }, { $eq: ["$$source.result_status", "failed"] },
      ] } } } } },
      source_unavailable: { $sum: { $size: { $filter: { input: "$sources", as: "source", cond: { $and: [
        { $eq: ["$$source.status", "completed"] }, { $not: [{ $in: ["$$source.result_status", ["ingested", "ok", "failed"]] }] },
      ] } } } } },
      average_duration_seconds: { $avg: { $cond: [
        { $and: [{ $isNumber: "$created_at" }, { $gte: ["$completed_at", "$created_at"] }] },
        { $subtract: ["$completed_at", "$created_at"] }, null,
      ] } },
    } },
    { $project: { _id: 0, day: "$_id", completed_runs: 1, failed_runs: 1, published_items: 1, held_items: 1, source_ready: 1, source_unavailable: 1, source_failed: 1, average_duration_seconds: 1 } },
  ]).toArray();
  const byDay = new Map(buckets.map((bucket) => [bucket.day, bucket]));
  return { days, location_id: locationId, timezone: "UTC", series: Array.from({ length: days }, (_, index) => {
    const day = new Date(start + index * 86400000).toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, completed_runs: 0, failed_runs: 0, published_items: 0, held_items: 0, source_ready: 0, source_unavailable: 0, source_failed: 0, average_duration_seconds: null };
  }) };
}
