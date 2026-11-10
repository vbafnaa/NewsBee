import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { PHOTO_CATALOG_SOURCES, PHOTO_SUPPLY_INVITES, PHOTO_SUPPLY_SUBMISSIONS, type PhotoCatalogRecord, type PhotoCatalogSource } from "../../../../shared/photo-catalog";
import { PHOTO_SUPPLY_GRANT_TEXT, PHOTO_SUPPLY_MAX_BATCHES, PHOTO_SUPPLY_MAX_PHOTOS, publicPhotoUrl, validatePhotoSupply, type PhotoSupplyInput, type PublicPhotoInvite } from "../../../../shared/photo-supply";
import type { StoryImage } from "../../../../shared/story-image";
import { importPhotoCatalog, parsePhotoCatalog, photoGrantFingerprint } from "./catalog";
import { COLLECTIONS } from "../storage/mongo";

type Supplied = Extract<PhotoCatalogSource, { kind: "supplied" }>;
type Invite = { _id: string; id: string; location_id: string; location_name: string; source: Supplied; status: "active" | "revoked";
  contact_email: string; requested_photos: Partial<StoryImage>[]; request_ids: string[]; created_at: string; created_by: string; expires_at: Date };
type Submission = Omit<PhotoSupplyInput, "request_id"> & { _id: string; invite_id: string; location_id: string; submitted_at: string;
  status: "pending" | "approved" | "rejected" | "revoked"; decided_at?: string; decided_by?: string; reason?: string;
  approved_source?: Supplied; grant_fingerprint?: string };
function invalid(message: string): never { throw Error(`Invalid photo supply: ${message}`); }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid("expected an object");
const id = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value) ? value : invalid("invalid record identity");

export async function createPhotoInvite(db: Db, locationId: string, locationName: string, value: unknown, by: string, today = new Date()) {
  const raw = record(value), day = today.toISOString().slice(0, 10);
  const until = new Date(today.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const source = parsePhotoCatalog({ version: 1, location_id: locationId, sources: [{ ...record(raw.source), kind: "supplied", status: "pending",
    reviewed_on: day, expires_on: raw.expires_on ?? until, permission: { editorial: false, archive: false, crop: false }, photos: [] }] }, locationId, today)[0];
  if (source.kind !== "supplied" || source.expires_on < day || Date.parse(source.expires_on) - Date.parse(day) > 90 * 86400000) invalid("choose a grant expiry within 90 days");
  source.scope.source_urls.forEach(publicPhotoUrl);
  if (source.scope.identity_url) publicPhotoUrl(source.scope.identity_url);
  const contact = typeof raw.contact_email === "string" ? raw.contact_email.trim().toLowerCase() : "";
  if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) invalid("invalid contact email");
  const requested: Partial<StoryImage>[] = Array.isArray(raw.requested_photos) ? raw.requested_photos.slice(0, PHOTO_SUPPLY_MAX_PHOTOS).map((item: unknown) => {
    const photo = record(item);
    return { image: publicPhotoUrl(photo.image), image_source_url: publicPhotoUrl(photo.image_source_url),
      image_credit: typeof photo.image_credit === "string" ? photo.image_credit.slice(0, 240) : "",
      image_caption: typeof photo.image_caption === "string" ? photo.image_caption.slice(0, 500) : "",
      image_date: typeof photo.image_date === "string" ? photo.image_date.slice(0, 10) : "" };
  }) : [];
  const token = randomBytes(32).toString("hex"), publicId = randomUUID();
  const invite: Invite = { _id: digest(token), id: publicId, location_id: locationId, location_name: locationName, source,
    contact_email: contact, status: "active", requested_photos: requested, request_ids: [], created_at: today.toISOString(), created_by: by,
    expires_at: new Date(Math.min(today.getTime() + 14 * 86400000, Date.parse(source.expires_on) + 86400000)) };
  await db.collection<Invite>(PHOTO_SUPPLY_INVITES).createIndex({ location_id: 1, created_at: -1 });
  await db.collection<Invite>(PHOTO_SUPPLY_INVITES).insertOne(invite);
  return { id: publicId, token, expires_at: invite.expires_at.toISOString(), source, contact_email: contact };
}

async function activeInvite(db: Db, token: string, today: Date) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const invite = await db.collection<Invite>(PHOTO_SUPPLY_INVITES).findOne({ _id: digest(token), status: "active", expires_at: { $gt: today } });
  if (!invite) return null;
  const location = await db.collection(COLLECTIONS.locations).findOne({ _id: invite.location_id as never });
  return location && !location.removal ? invite : null;
}

export async function publicPhotoInvite(db: Db, token: string, today = new Date()): Promise<PublicPhotoInvite | null> {
  const invite = await activeInvite(db, token, today);
  return invite ? { name: invite.source.name, location_name: invite.location_name, scope: invite.source.scope,
    expires_on: invite.source.expires_on, grant_text: PHOTO_SUPPLY_GRANT_TEXT, requested_photos: invite.requested_photos } : null;
}

export async function submitPhotoSupply(db: Db, token: string, value: unknown, today = new Date()) {
  const invite = await activeInvite(db, token, today);
  if (!invite) invalid("this invitation has expired or is unavailable");
  const input = validatePhotoSupply(value, invite.source.scope, today);
  const claimed = await db.collection<Invite>(PHOTO_SUPPLY_INVITES).updateOne({ _id: invite._id, status: "active", expires_at: { $gt: today },
    $or: [{ request_ids: input.request_id }, { [`request_ids.${PHOTO_SUPPLY_MAX_BATCHES - 1}`]: { $exists: false } }] }, { $addToSet: { request_ids: input.request_id } });
  if (!claimed.matchedCount) invalid("this invitation cannot accept more photo batches");
  const { request_id, ...details } = input;
  try {
    await db.collection<Submission>(PHOTO_SUPPLY_SUBMISSIONS).updateOne({ _id: request_id }, { $setOnInsert: {
      _id: request_id, ...details, invite_id: invite.id, location_id: invite.location_id, status: "pending", submitted_at: today.toISOString(),
    } }, { upsert: true });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
  }
  const submitted = await db.collection<Submission>(PHOTO_SUPPLY_SUBMISSIONS).findOne({ _id: request_id });
  if (submitted?.invite_id !== invite.id) invalid("submission identity belongs to another invitation");
  return { id: request_id, status: submitted.status };
}

export async function photoSupplyInbox(db: Db, locationId: string) {
  const [invites, submissions] = await Promise.all([
    db.collection<Invite>(PHOTO_SUPPLY_INVITES).find({ location_id: locationId }, { projection: { _id: 0, request_ids: 0 } }).sort({ created_at: -1 }).limit(50).toArray(),
    db.collection<Submission>(PHOTO_SUPPLY_SUBMISSIONS).find({ location_id: locationId }).sort({ submitted_at: -1 }).limit(50).toArray(),
  ]);
  return { invites, submissions };
}

export async function approvePhotoSupply(db: Db, locationId: string, submissionId: string, by: string, today = new Date()) {
  const submissions = db.collection<Submission>(PHOTO_SUPPLY_SUBMISSIONS);
  const submission = await submissions.findOne({ _id: id(submissionId), location_id: locationId });
  if (!submission || !["pending", "approved"].includes(submission.status)) invalid("submission is not awaiting approval");
  if (submission.status === "approved" && submission.approved_source) {
    const existing = await db.collection<PhotoCatalogRecord>(PHOTO_CATALOG_SOURCES).findOne({ location_id: locationId, id: submission.approved_source.id });
    if (existing) return { status: existing.status, source_id: existing.id };
  }
  const invite = await db.collection<Invite>(PHOTO_SUPPLY_INVITES).findOne({ id: submission.invite_id, location_id: locationId, status: "active" });
  const day = today.toISOString().slice(0, 10);
  if (!invite || invite.source.expires_on < day) invalid("the source invitation or grant is no longer available");
  const source = parsePhotoCatalog({ version: 1, location_id: locationId, sources: [{ ...invite.source,
    id: `${invite.source.id.slice(0, 60)}-${submission._id.slice(0, 8)}`, permission_record_id: submission._id,
    status: "active", reviewed_on: day, permission: submission.permission, photos: submission.photos }] }, locationId, today)[0] as Supplied;
  const fingerprint = photoGrantFingerprint(source);
  const result = await submissions.updateOne({ _id: submission._id, location_id: locationId, status: { $in: ["pending", "approved"] } },
    { $set: { status: "approved", approved_source: source, grant_fingerprint: fingerprint, decided_at: today.toISOString(), decided_by: by } });
  if (!result.matchedCount) invalid("submission changed during review");
  try { await importPhotoCatalog(db, { version: 1, location_id: locationId, sources: [source] }, locationId, true, today); }
  catch (error) {
    await submissions.updateOne({ _id: submission._id, status: "approved", grant_fingerprint: fingerprint }, { $set: { status: "pending" }, $unset: { approved_source: "", grant_fingerprint: "" } });
    throw error;
  }
  return { status: "active", source_id: source.id };
}

export async function rejectPhotoSupply(db: Db, locationId: string, submissionId: string, reason: string, by: string, today = new Date()) {
  const changed = await db.collection<Submission>(PHOTO_SUPPLY_SUBMISSIONS).updateOne({ _id: id(submissionId), location_id: locationId, status: "pending" },
    { $set: { status: "rejected", reason: reason.trim().slice(0, 600) || "Photo details or permission could not be confirmed.", decided_by: by, decided_at: today.toISOString() } });
  if (!changed.matchedCount) invalid("submission is not awaiting review");
  return { status: "rejected" };
}

export async function revokePhotoInvite(db: Db, locationId: string, inviteId: string) {
  const changed = await db.collection<Invite>(PHOTO_SUPPLY_INVITES).updateOne({ id: id(inviteId), location_id: locationId }, { $set: { status: "revoked" } });
  if (!changed.matchedCount) invalid("unknown invitation");
  return { status: "revoked" };
}

export async function revokePhotoSource(db: Db, locationId: string, sourceId: string, by: string, today = new Date()) {
  const source = await db.collection<PhotoCatalogRecord>(PHOTO_CATALOG_SOURCES).findOne({ location_id: locationId, id: sourceId });
  if (!source) invalid("unknown photo source");
  if (source.permission_record_id) await db.collection<Submission>(PHOTO_SUPPLY_SUBMISSIONS).updateOne({ _id: source.permission_record_id, location_id: locationId },
    { $set: { status: "revoked", decided_by: by, decided_at: today.toISOString() } });
  await importPhotoCatalog(db, { version: 1, location_id: locationId, sources: [{ ...source, status: "revoked" }] }, locationId, true, today);
  return { status: "revoked" };
}
