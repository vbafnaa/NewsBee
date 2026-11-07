/**
 * Clears explicitly selected reader-data categories. Mixed signup rows retain their email and
 * unselected registrations; a row is deleted only when no other signup intent remains.
 */
import type { Db, Document } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import { clearedTotal, LEGACY_CLEAR_DATA_TYPES, parseClearDataTypes, type ClearCounts, type ClearLocation, type ClearPreview, type ClearRecord, type ClearScope } from "./clear-scope";
import { placeMetadata } from "./usage";

const ENGAGEMENT = "reader_engagement";
const SIGNUPS = "reader_interest_signups";
/** "view" carries the story impressions; the ranker's click-through counts both "open" and "share". */
const ACTIONS = { impressions: "view", clicks: "open", shares: "share" } as const;
const NOTHING: ClearCounts = { impressions: 0, clicks: 0, shares: 0, interest_records: 0, interest_marks: 0, subscriptions: 0, legacy_signups: 0 };

type LocationScope = Pick<ClearScope, "location_id">;
const scoped = ({ location_id }: LocationScope): Document => location_id ? { location_id } : {};
/** The whole record is only interest: no subscription to keep and no ambiguous older signup. */
const interestOnly = (scope: LocationScope): Document => ({
  ...scoped(scope), interest_signup_at: { $type: "date" }, subscription_signup_at: { $exists: false }, legacy_signup: { $ne: true },
});
/** The record outlives the clear because of its subscription or older signup; only interest goes. */
const interestMark = (scope: LocationScope): Document => ({
  ...scoped(scope), interest_signup_at: { $type: "date" }, $or: [{ subscription_signup_at: { $exists: true } }, { legacy_signup: true }],
});
const legacy = (scope: LocationScope): Document => ({
  ...scoped(scope), $or: [{ legacy_signup: true }, { subscription_signup_at: { $exists: false }, interest_signup_at: { $exists: false } }],
});

export async function clearPreview(db: Db): Promise<ClearPreview> {
  type Row = { _id: unknown; count: number; name?: string };
  const count = (collection: string, filter: Document) => db.collection(collection).aggregate<Row>([
    { $match: filter }, { $group: { _id: "$location_id", count: { $sum: 1 }, name: { $last: "$location_name" } } },
  ]).toArray();
  const all: LocationScope = { location_id: null };
  const [impressions, clicks, shares, interest_records, interest_marks, subscriptions, legacy_signups] = await Promise.all([
    count(ENGAGEMENT, { action: ACTIONS.impressions }), count(ENGAGEMENT, { action: ACTIONS.clicks }), count(ENGAGEMENT, { action: ACTIONS.shares }),
    count(SIGNUPS, interestOnly(all)), count(SIGNUPS, interestMark(all)),
    count(SIGNUPS, { subscription_signup_at: { $type: "date" } }), count(SIGNUPS, legacy(all)),
  ]);
  const metrics = { impressions, clicks, shares, interest_records, interest_marks, subscriptions, legacy_signups };
  const zero = (): ClearCounts & { name?: string } => ({ ...NOTHING });
  const { name: _unnamed, ...totals } = zero();
  const byLocation = new Map<string, ReturnType<typeof zero>>();
  for (const [metric, rows] of Object.entries(metrics) as [keyof typeof metrics, Row[]][]) {
    for (const row of rows) {
      totals[metric] += row.count;
      if (typeof row._id !== "string" || !row._id) continue;
      const entry = byLocation.get(row._id) ?? zero();
      entry[metric] = row.count;
      entry.name ??= row.name;
      byLocation.set(row._id, entry);
    }
  }
  const clearable = [...byLocation].filter(([, counts]) => clearedTotal(counts) > 0);
  const { metadata } = await placeMetadata(db, clearable.map(([id]) => id));
  const locations = clearable
    .map(([id, counts]): ClearLocation => ({ ...counts, id, name: metadata.get(id)?.name ?? counts.name ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const recent = await db.collection(COLLECTIONS.readerDataClears).find({}).sort({ at: -1 }).limit(10).toArray();
  return { totals, locations, recent: recent.map(presentRecord) };
}

function presentRecord(record: Document): ClearRecord {
  return {
    id: String(record._id), by: record.by, at: record.at.toISOString(), finished_at: record.finished_at?.toISOString() ?? null, status: record.status,
    scope: record.scope, location_id: record.location_id, location_name: record.location_name,
    data_types: record.data_types ?? [...LEGACY_CLEAR_DATA_TYPES], deleted: { ...NOTHING, ...record.deleted }, error: record.error ?? null,
  };
}

/** Deletes the selected data. The log entry is written first, so a failure part-way is still on record. */
export async function clearReaderData(db: Db, scope: ClearScope, by: string): Promise<ClearRecord> {
  const data_types = parseClearDataTypes(scope.data_types);
  const log = db.collection(COLLECTIONS.readerDataClears);
  const location_name = scope.location_id ? (await placeMetadata(db, [scope.location_id])).metadata.get(scope.location_id)?.name ?? scope.location_id : null;
  const deleted = { ...NOTHING };
  const { insertedId } = await log.insertOne({
    by, at: new Date(), status: "started", scope: scope.location_id ? "location" : "all",
    location_id: scope.location_id, location_name, data_types, deleted, finished_at: null,
  });
  const finish = (status: "completed" | "failed", error?: string) => log.findOneAndUpdate(
    { _id: insertedId }, { $set: { status, deleted, finished_at: new Date(), ...(error ? { error } : {}) } }, { returnDocument: "after" },
  );
  try {
    const events = db.collection(ENGAGEMENT), signups = db.collection(SIGNUPS);
    for (const metric of ["impressions", "clicks", "shares"] as const) {
      if (data_types.includes(metric)) deleted[metric] = (await events.deleteMany({ ...scoped(scope), action: ACTIONS[metric] })).deletedCount;
    }
    if (data_types.includes("interest")) {
      deleted.interest_records = (await signups.deleteMany(interestOnly(scope))).deletedCount;
      deleted.interest_marks = (await signups.updateMany(interestMark(scope), { $unset: { interest_signup_at: "" }, $set: { launch_notification: false } })).modifiedCount;
    }
    if (data_types.includes("subscriptions")) {
      const subscription = { ...scoped(scope), subscription_signup_at: { $type: "date" } };
      deleted.subscriptions = (await signups.deleteMany({ ...subscription, interest_signup_at: { $exists: false }, legacy_signup: { $ne: true } })).deletedCount;
      deleted.subscriptions += (await signups.updateMany({
        ...subscription, $or: [{ interest_signup_at: { $exists: true } }, { legacy_signup: true }],
      }, { $unset: { subscription_signup_at: "" } })).modifiedCount;
    }
    if (data_types.includes("legacy_signups")) {
      deleted.legacy_signups = (await signups.deleteMany({
        ...scoped(scope), interest_signup_at: { $exists: false }, subscription_signup_at: { $exists: false },
      })).deletedCount;
      deleted.legacy_signups += (await signups.updateMany({
        ...scoped(scope), legacy_signup: true, $or: [{ interest_signup_at: { $exists: true } }, { subscription_signup_at: { $exists: true } }],
      }, [{ $set: { legacy_signup: false, launch_notification: { $eq: [{ $type: "$interest_signup_at" }, "date"] } } }])).modifiedCount;
    }
  } catch (error) {
    await finish("failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
  return presentRecord((await finish("completed"))!);
}
