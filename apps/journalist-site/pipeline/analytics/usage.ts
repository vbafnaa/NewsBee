import type { Db, Document } from "mongodb";
import { point } from "../../../../shared/geography";

export type UsageRow = {
  id: string; name: string; latitude: number | null; longitude: number | null; onboarded: boolean;
  reads: number; subscriptions: number; interest: number;
};
export type UsageSummary = {
  rows: UsageRow[]; totals: { reads: number; subscriptions: number; interest: number };
  history: { first_read: string | null; first_subscription: string | null; first_interest: string | null; unclassified_legacy_signups: number };
};
export type UsageRange = { from?: Date; to?: Date };

export function usageRange(from: string | null, to: string | null): UsageRange {
  function date(value: string | null) {
    if (!value) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid date: use YYYY-MM-DD.");
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error("Invalid date.");
    return parsed;
  }
  const start = date(from), end = date(to);
  if (start && end && start > end) throw new Error("Invalid date range: start must not follow end.");
  return { from: start, to: end ? new Date(end.getTime() + 86400000) : undefined };
}

/** Names and coordinates for location IDs, preferring onboarded locations over directory places. */
export async function placeMetadata(db: Db, ids: string[]) {
  const [locations, geographic, census] = await Promise.all([
    db.collection<{ _id: string; name: string; latitude?: number; longitude?: number }>("locations").find({ _id: { $in: ids } }, { projection: { name: 1, latitude: 1, longitude: 1 } }).toArray(),
    db.collection<{ _id: string; label: string; latitude?: number; longitude?: number }>("geographic_places").find({ _id: { $in: ids } }, { projection: { label: 1, latitude: 1, longitude: 1 } }).toArray(),
    db.collection<{ _id: string; name: string; state: string; latitude?: number; longitude?: number }>("census_places").find({ _id: { $in: ids } }, { projection: { name: 1, state: 1, latitude: 1, longitude: 1 } }).toArray(),
  ]);
  const metadata = new Map<string, { name: string; latitude?: number; longitude?: number }>([
    ...census.map((place) => [place._id, { ...place, name: `${place.name}, ${place.state}` }] as const),
    ...geographic.map((place) => [place._id, { ...place, name: place.label }] as const),
    ...locations.map((place) => [place._id, place] as const),
  ]);
  return { metadata, onboarded: new Set(locations.map((location) => location._id)) };
}

export async function usageSummary(db: Db, range: UsageRange = {}): Promise<UsageSummary> {
  const match = (field: string): Document => ({
    [field]: { $type: "date", ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lt: range.to } : {}) },
    location_id: { $type: "string", $ne: "" },
  });
  type Count = { _id: string; count: number; name?: string };
  const count = (collection: string, field: string, extra: Document = {}) => db.collection(collection).aggregate<Count>([
    { $match: { ...match(field), ...extra } },
    { $group: { _id: "$location_id", count: { $sum: 1 }, name: { $last: "$location_name" } } },
  ]).toArray();
  const first = async (collection: string, field: string, extra: Document = {}) => {
    const data = await db.collection(collection).findOne({ [field]: { $type: "date" }, ...extra }, { sort: { [field]: 1 }, projection: { [field]: 1 } });
    return data?.[field] instanceof Date ? data[field].toISOString() : null;
  };
  const [reads, subscriptions, interest, firstRead, firstSubscription, firstInterest, legacy] = await Promise.all([
    count("reader_engagement", "at", { action: "view" }),
    count("reader_interest_signups", "subscription_signup_at"),
    count("reader_interest_signups", "interest_signup_at"),
    first("reader_engagement", "at", { action: "view" }),
    first("reader_interest_signups", "subscription_signup_at"),
    first("reader_interest_signups", "interest_signup_at"),
    db.collection("reader_interest_signups").countDocuments({ $or: [
      { legacy_signup: true }, { subscription_signup_at: { $exists: false }, interest_signup_at: { $exists: false } },
    ] }),
  ]);
  const ids = [...new Set([...reads, ...subscriptions, ...interest].map((row) => row._id))];
  const { metadata, onboarded } = await placeMetadata(db, ids);
  const byMetric = [reads, subscriptions, interest].map((rows) => new Map(rows.map((row) => [row._id, row])));
  const rows = ids.map((id): UsageRow => {
    const place = metadata.get(id);
    const located = point([place?.longitude, place?.latitude]);
    return {
      id, name: place?.name ?? byMetric[1].get(id)?.name ?? byMetric[2].get(id)?.name ?? id,
      latitude: located ? place!.latitude! : null, longitude: located ? place!.longitude! : null, onboarded: onboarded.has(id),
      reads: byMetric[0].get(id)?.count ?? 0, subscriptions: byMetric[1].get(id)?.count ?? 0, interest: byMetric[2].get(id)?.count ?? 0,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return {
    rows,
    totals: rows.reduce((totals, row) => ({ reads: totals.reads + row.reads, subscriptions: totals.subscriptions + row.subscriptions, interest: totals.interest + row.interest }), { reads: 0, subscriptions: 0, interest: 0 }),
    history: { first_read: firstRead, first_subscription: firstSubscription, first_interest: firstInterest, unclassified_legacy_signups: legacy },
  };
}
