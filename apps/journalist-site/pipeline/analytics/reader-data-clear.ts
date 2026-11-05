/**
 * Permanently clears reader impressions, clicks and launch-interest signups, for one location or
 * all of them. Clearing only touches the two collections named here; a signup record that also
 * holds a subscription, or an older record of ambiguous intent, keeps its row and loses only its
 * interest fields.
 */
import type { Db, Document } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import { clearedTotal, type ClearCounts, type ClearLocation, type ClearPreview, type ClearRecord, type ClearScope, type KeptCounts } from "./clear-scope";
import { placeMetadata } from "./usage";

const ENGAGEMENT = "reader_engagement";
const SIGNUPS = "reader_interest_signups";
/** "view" carries the story impressions; the ranker's click-through counts both "open" and "share". */
const ACTIONS = { impressions: "view", clicks: "open", shares: "share" } as const;
const NOTHING: ClearCounts = { impressions: 0, clicks: 0, shares: 0, interest_records: 0, interest_marks: 0 };

const scoped = ({ location_id }: ClearScope): Document => location_id ? { location_id } : {};
/** The whole record is only interest: no subscription to keep and no ambiguous older signup. */
const interestOnly = (scope: ClearScope): Document => ({
  ...scoped(scope), interest_signup_at: { $type: "date" }, subscription_signup_at: { $exists: false }, legacy_signup: { $ne: true },
});
/** The record outlives the clear because of its subscription or older signup; only interest goes. */
const interestMark = (scope: ClearScope): Document => ({
  ...scoped(scope), interest_signup_at: { $type: "date" }, $or: [{ subscription_signup_at: { $exists: true } }, { legacy_signup: true }],
});
const legacy = (scope: ClearScope): Document => ({
  ...scoped(scope), $or: [{ legacy_signup: true }, { subscription_signup_at: { $exists: false }, interest_signup_at: { $exists: false } }],
});

export async function clearPreview(db: Db): Promise<ClearPreview> {
  type Row = { _id: unknown; count: number; name?: string };
  const count = (collection: string, filter: Document) => db.collection(collection).aggregate<Row>([
    { $match: filter }, { $group: { _id: "$location_id", count: { $sum: 1 }, name: { $last: "$location_name" } } },
  ]).toArray();
  const all: ClearScope = { location_id: null };
  const [impressions, clicks, shares, interest_records, interest_marks, subscriptions, legacy_signups] = await Promise.all([
    count(ENGAGEMENT, { action: ACTIONS.impressions }), count(ENGAGEMENT, { action: ACTIONS.clicks }), count(ENGAGEMENT, { action: ACTIONS.shares }),
    count(SIGNUPS, interestOnly(all)), count(SIGNUPS, interestMark(all)),
    count(SIGNUPS, { subscription_signup_at: { $type: "date" } }), count(SIGNUPS, legacy(all)),
  ]);
  const metrics = { impressions, clicks, shares, interest_records, interest_marks, subscriptions, legacy_signups };
  const zero = (): ClearCounts & KeptCounts & { name?: string } => ({ ...NOTHING, subscriptions: 0, legacy_signups: 0 });
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
    scope: record.scope, location_id: record.location_id, location_name: record.location_name, deleted: record.deleted, error: record.error ?? null,
  };
}

/** Deletes the selected data. The log entry is written first, so a failure part-way is still on record. */
export async function clearReaderData(db: Db, scope: ClearScope, by: string): Promise<ClearRecord> {
  const log = db.collection(COLLECTIONS.readerDataClears);
  const location_name = scope.location_id ? (await placeMetadata(db, [scope.location_id])).metadata.get(scope.location_id)?.name ?? scope.location_id : null;
  const deleted = { ...NOTHING };
  const { insertedId } = await log.insertOne({
    by, at: new Date(), status: "started", scope: scope.location_id ? "location" : "all",
    location_id: scope.location_id, location_name, deleted, finished_at: null,
  });
  const finish = (status: "completed" | "failed", error?: string) => log.findOneAndUpdate(
    { _id: insertedId }, { $set: { status, deleted, finished_at: new Date(), ...(error ? { error } : {}) } }, { returnDocument: "after" },
  );
  try {
    const events = db.collection(ENGAGEMENT), signups = db.collection(SIGNUPS);
    for (const metric of ["impressions", "clicks", "shares"] as const) {
      deleted[metric] = (await events.deleteMany({ ...scoped(scope), action: ACTIONS[metric] })).deletedCount;
    }
    deleted.interest_records = (await signups.deleteMany(interestOnly(scope))).deletedCount;
    deleted.interest_marks = (await signups.updateMany(interestMark(scope), { $unset: { interest_signup_at: "" }, $set: { launch_notification: false } })).modifiedCount;
  } catch (error) {
    await finish("failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
  return presentRecord((await finish("completed"))!);
}
