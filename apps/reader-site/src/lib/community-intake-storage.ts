import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { COMMUNITY_INTAKE_COLLECTION, INTAKE_STATUSES, CommunityIntakeError, type CommunityIntake, type CommunityIntakeInput, type IntakeKind, type IntakeStatus } from "../../../../shared/community-intake";

const RATE_COLLECTION = "community_intake_limits";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function indexes(db: Db) {
  await Promise.all([
    db.collection<CommunityIntake>(COMMUNITY_INTAKE_COLLECTION).createIndexes([
      { key: { dedupe_key: 1 }, unique: true, name: "intake_duplicate" },
      { key: { status: 1, kind: 1, submitted_at: -1 }, name: "intake_review" },
    ]),
    db.collection(RATE_COLLECTION).createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: "intake_limit_expiry" }),
  ]);
}

/** Email-based rate buckets expire automatically; submissions remain until editorial review. */
export async function saveCommunityIntake(db: Db, input: CommunityIntakeInput, now = new Date()) {
  await indexes(db);
  const collection = db.collection<CommunityIntake>(COMMUNITY_INTAKE_COLLECTION);
  const dedupe_key = hash(JSON.stringify(input)) + ":" + now.toISOString().slice(0, 10);
  const existing = await collection.findOne({ dedupe_key }, { projection: { _id: 1 } });
  if (existing) return existing._id;
  const rateId = hash(input.submitter_email) + ":" + now.toISOString().slice(0, 13);
  try {
    await db.collection<{ _id: string; count: number; expires_at: Date }>(RATE_COLLECTION).findOneAndUpdate(
      { _id: rateId, count: { $lt: 5 } },
      { $inc: { count: 1 }, $setOnInsert: { expires_at: new Date(now.getTime() + 2 * 3600_000) } },
      { upsert: true },
    );
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new CommunityIntakeError("You have sent several inquiries recently. Please try again in an hour.", 429);
    throw error;
  }
  const record: CommunityIntake = { ...input, _id: randomUUID(), dedupe_key, status: "pending", submitted_at: now.toISOString(), consented_at: now.toISOString(), consent_version: "community-intake-v1" };
  try { await collection.insertOne(record); }
  catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const duplicate = await collection.findOne({ dedupe_key }, { projection: { _id: 1 } });
    if (!duplicate) throw error;
    return duplicate._id;
  }
  return record._id;
}

export async function listCommunityIntake(db: Db, filter: { kind?: IntakeKind; status?: IntakeStatus; page: number }) {
  const query = { ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.status ? { status: filter.status } : {}) };
  const collection = db.collection<CommunityIntake>(COMMUNITY_INTAKE_COLLECTION), pageSize = 25;
  const total = await collection.countDocuments(query), pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(filter.page) || 1), pages);
  const items = await collection.find(query, { projection: { dedupe_key: 0 } }).sort({ submitted_at: -1, _id: 1 })
    .skip((page - 1) * pageSize).limit(pageSize).toArray();
  return { items, total, page, pages };
}

/** Only records editorial progress. It never edits users, communities or publishing settings. */
export async function reviewCommunityIntake(db: Db, id: string, status: IntakeStatus, note: string, editor: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new CommunityIntakeError("Choose a valid inquiry.");
  if (!INTAKE_STATUSES.includes(status)) throw new CommunityIntakeError("Choose a valid review status.");
  if (note.length > 1000) throw new CommunityIntakeError("Keep the review note within 1,000 characters.");
  const at = new Date().toISOString(), trimmedNote = note.trim();
  const result = await db.collection<CommunityIntake>(COMMUNITY_INTAKE_COLLECTION).findOneAndUpdate({ _id: id }, {
    $set: { status, review_note: trimmedNote, reviewed_at: at, reviewed_by: editor },
    $push: { review_history: { $each: [{ status, note: trimmedNote, at, by: editor }], $slice: -50 } },
  }, { returnDocument: "after", projection: { dedupe_key: 0 } });
  if (!result) throw new CommunityIntakeError("This inquiry could not be found.", 404);
  return result;
}
