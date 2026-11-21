import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db } from "mongodb";
import type { Edition, Location } from "./reader-data";
import { TOPICS, topicOfFiled } from "../../../../shared/topics";
import { withSiteWriter } from "../../../../shared/restore-maintenance";

export const NEWSLETTER_TOPICS = [...TOPICS, { id: "events", label: "Events" }, { id: "alerts", label: "Safety & Weather" },
  { id: "courts", label: "Courts" }, { id: "remembrance", label: "Remembrances" }, { id: "other", label: "Other News" }];
export const SUBSCRIPTIONS = "reader_newsletter_subscriptions";
export const MAIL = "reader_newsletter_mail";
export type NewsletterConfig = { provider: "resend" | "local"; from: string; publicUrl: string; secret: string; apiKey: string };
export type Subscription = {
  _id: string; email: string; locationId: string; locationName: string; topics: string[];
  status: "pending" | "active" | "unsubscribed"; manageNonce: string; createdAt: Date; updatedAt: Date;
  requestedAt?: Date; confirmedAt?: Date; unsubscribedAt?: Date;
  pending?: { nonce: string; topics: string[]; expiresAt: Date };
  confirmedRequest?: { nonce: string; expiresAt: Date };
  dataClearPending?: boolean;
};
export type MailEnvelope = { to: string; subject: string; html: string; text: string; headers?: Record<string, string>; from?: string; subscriptionId?: string };
type MailJob = {
  _id: string; subscriptionId: string; kind: "confirmation" | "edition"; nonce?: string; editionId?: string;
  envelope?: MailEnvelope; status: "queued" | "sending" | "sent" | "failed" | "cancelled";
  attempts: number; createdAt: Date; nextAttemptAt: Date; leaseUntil?: Date; firstAttemptAt?: Date;
  sentAt?: Date; providerId?: string; error?: string;
};
export type MailTransport = (envelope: MailEnvelope, key: string) => Promise<string>;
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Delivery uses a configured canonical URL, never a request's Host header. */
export function newsletterConfig(env: NodeJS.ProcessEnv = process.env): NewsletterConfig | null {
  const provider = env.NEWSBEE_NEWSLETTER_PROVIDER ?? "resend";
  if (provider !== "resend" && !(provider === "local" && env.NEWSBEE_MODE === "local" && env.NODE_ENV !== "production")) return null;
  const secret = env.NEWSBEE_NEWSLETTER_SECRET ?? "", apiKey = env.RESEND_API_KEY ?? "";
  const from = env.NEWSBEE_NEWSLETTER_FROM ?? (provider === "local" ? "Newsbee <preview@newsbee.test>" : "");
  if (secret.length < 32 || /[\r\n]/.test(from) || !emailPattern.test(from.match(/<([^<>]+)>$/)?.[1] ?? from) || (provider === "resend" && !apiKey)) return null;
  try {
    const url = new URL(env.NEWSBEE_NEWSLETTER_PUBLIC_URL ?? "");
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(env.NEWSBEE_MODE === "local" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) return null;
    return { provider, from, secret, apiKey, publicUrl: url.href.replace(/\/$/, "") };
  } catch { return null; }
}

export function validateNewsletterSignup(value: unknown): { email: string; topics: string[]; launch: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Send your email and newsletter preferences.");
  const input = value as Record<string, unknown>;
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (email.length > 254 || !emailPattern.test(email)) throw new Error("Enter a valid email address.");
  if (input.consent !== true) throw new Error("Consent to weekly editions is required.");
  if (input.launch_notification !== undefined && typeof input.launch_notification !== "boolean") throw new Error("Choose a valid launch notification preference.");
  return { email, topics: validateNewsletterTopics(input.topics ?? []), launch: input.launch_notification === true };
}
export function validateNewsletterTopics(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > NEWSLETTER_TOPICS.length || value.some((id) => typeof id !== "string" || !NEWSLETTER_TOPICS.some((topic) => topic.id === id))) throw new Error("Choose topics from the available list.");
  return [...new Set(value as string[])];
}

function token(config: NewsletterConfig, purpose: "confirm" | "manage", sub: Subscription) {
  const nonce = purpose === "confirm" ? sub.pending?.nonce ?? sub.confirmedRequest?.nonce ?? "" : sub.manageNonce;
  return createHmac("sha256", config.secret).update(`${purpose}:${sub._id}:${nonce}`).digest("hex");
}
function validToken(actual: string, expected: string) {
  return /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
export function newsletterLink(config: NewsletterConfig, sub: Subscription, purpose: "confirm" | "manage") {
  return `${config.publicUrl}/newsletter?${new URLSearchParams({ id: sub._id, token: token(config, purpose, sub), ...(purpose === "confirm" ? { confirm: "1" } : {}) })}`;
}
export async function newsletterAccess(db: Db, config: NewsletterConfig, id: string, supplied: string, purpose: "confirm" | "manage", now = new Date()) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  const sub = await db.collection<Subscription>(SUBSCRIPTIONS).findOne({ _id: id });
  if (!sub || sub.dataClearPending || !validToken(supplied, token(config, purpose, sub))) return null;
  if (purpose === "confirm") {
    const request = sub.pending ?? (sub.status === "active" ? sub.confirmedRequest : undefined);
    if (!request || request.expiresAt <= now) return null;
  }
  return sub;
}

async function indexes(db: Db) {
  await db.collection<Subscription>(SUBSCRIPTIONS).createIndex({ locationId: 1, email: 1 }, { unique: true });
  await db.collection<MailJob>(MAIL).createIndex({ status: 1, nextAttemptAt: 1 });
  await db.collection("reader_newsletter_limits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}
async function queue(db: Db, job: Pick<MailJob, "_id" | "subscriptionId" | "kind" | "nonce" | "editionId" | "envelope">, now: Date) {
  await db.collection<MailJob>(MAIL).updateOne({ _id: job._id }, { $setOnInsert: { ...job, status: "queued", attempts: 0, createdAt: now, nextAttemptAt: now } }, { upsert: true });
}
function confirmation(config: NewsletterConfig, sub: Subscription): MailEnvelope {
  const link = newsletterLink(config, sub, "confirm");
  return { subscriptionId: sub._id, from: config.from, to: sub.email, subject: `Confirm your ${sub.locationName} Newsbee newsletter`,
    text: `Confirm your weekly Newsbee newsletter for ${sub.locationName}: ${link}\nThis link expires in 48 hours. If you did not request this, ignore this email.`,
    html: `<h1>Confirm your local Newsbee</h1><p>Weekly news for ${escape(sub.locationName)}, with the topics you choose.</p><p><a href="${escape(link)}">Confirm newsletter preferences</a></p><p>This link expires in 48 hours. If you did not request this, ignore this email.</p>` };
}

/** Repeated public requests never change an active subscriber's preferences or status. */
export async function requestNewsletter(db: Db, location: Location, input: ReturnType<typeof validateNewsletterSignup>, config: NewsletterConfig | null, now = new Date()) {
  await indexes(db);
  const bucket = `${Math.floor(now.getTime() / 3600_000)}`;
  for (const [key, maximum] of [[`global:${bucket}`, 100], [`email:${hash(input.email)}:${bucket}`, 5]] as const) {
    const limit = await db.collection<{ _id: string; requests: number; expiresAt: Date }>("reader_newsletter_limits").findOneAndUpdate({ _id: key },
      { $inc: { requests: 1 }, $setOnInsert: { expiresAt: new Date(now.getTime() + 2 * 3600_000) } }, { upsert: true, returnDocument: "after" });
    if ((limit?.requests ?? 0) > maximum) throw new Error("Too many newsletter requests. Please try again later.");
  }
  const subscriptions = db.collection<Subscription>(SUBSCRIPTIONS);
  const existing = await subscriptions.findOne({ locationId: location.id, email: input.email });
  if (existing?.dataClearPending) throw new Error("Newsletter preferences are being cleared. Please try again later.");
  if (existing?.requestedAt && now.getTime() - existing.requestedAt.getTime() < 60_000) return { id: existing._id, queued: Boolean(config) };
  const id = existing?._id ?? randomUUID();
  const pending = { nonce: randomUUID(), topics: input.topics, expiresAt: new Date(now.getTime() + 48 * 3600_000) };
  try {
    const result = await subscriptions.updateOne({ locationId: location.id, email: input.email,
      $or: [{ requestedAt: { $lte: new Date(now.getTime() - 60_000) } }, { requestedAt: { $exists: false } }] }, {
      $setOnInsert: { _id: id, email: input.email, locationId: location.id, topics: [], status: "pending", manageNonce: randomUUID(), createdAt: now },
      $set: { locationName: location.name, pending, requestedAt: now, updatedAt: now },
    }, { upsert: !existing });
    if (!result.modifiedCount && !result.upsertedCount) return { id, queued: Boolean(config) };
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return { id, queued: Boolean(config) };
    throw error;
  }
  if (config) {
    const sub = (await subscriptions.findOne({ _id: id }))!;
    const jobId = `confirm-${hash(`${id}:${pending.nonce}`)}`;
    await queue(db, { _id: jobId, subscriptionId: id, kind: "confirmation", nonce: pending.nonce, envelope: confirmation(config, sub) }, now);
    // The durable job remains available for retry if immediate delivery fails.
    await deliverNewsletterJob(db, config, jobId, now).catch(() => undefined);
  }
  return { id, queued: Boolean(config) };
}

export async function updateNewsletter(db: Db, config: NewsletterConfig, id: string, supplied: string, action: string, topics?: unknown, now = new Date()) {
  const purpose = action === "confirm" ? "confirm" : "manage";
  const sub = await newsletterAccess(db, config, id, supplied, purpose, now);
  if (!sub) throw new Error("This link is invalid or expired. Request a new link from the signup form.");
  if (!["confirm", "preferences", "unsubscribe"].includes(action)) throw new Error("Choose a valid newsletter action.");
  if (action === "confirm" && !sub.pending) return { sub, manageUrl: newsletterLink(config, sub, "manage") };
  const selected = action === "confirm" ? sub.pending!.topics : action === "preferences" ? validateNewsletterTopics(topics) : sub.topics;
  const filter = { _id: id, ...(action === "confirm" ? { "pending.nonce": sub.pending!.nonce } : {}) };
  const result = await db.collection<Subscription>(SUBSCRIPTIONS).updateOne(filter, {
    $set: { topics: selected, updatedAt: now, ...(action === "confirm" ? { confirmedRequest: { nonce: sub.pending!.nonce, expiresAt: sub.pending!.expiresAt } } : {}),
      ...(action === "unsubscribe" ? { status: "unsubscribed", unsubscribedAt: now } : action === "confirm" ? { status: "active", confirmedAt: sub.confirmedAt ?? now } : {}) },
    ...(action === "preferences" ? {} : { $unset: { pending: "" } }),
  });
  if (!result.matchedCount) throw new Error("Your preferences changed. Open the newest confirmation link.");
  await db.collection<MailJob>(MAIL).updateMany({ subscriptionId: id, status: "queued" }, { $set: { status: "cancelled" }, $unset: { envelope: "" } });
  const updated = (await db.collection<Subscription>(SUBSCRIPTIONS).findOne({ _id: id }))!;
  return { sub: updated, manageUrl: newsletterLink(config, updated, "manage") };
}

export function newsletterItems(edition: Edition, topics: string[]) {
  return edition.items.map((item, index) => ({ item, index })).filter(({ item }) => {
    const topic = ["event", "meeting_preview"].includes(item.kind ?? "") ? "events"
      : ["safety_notice", "safety_incident", "weather_alert", "earthquake"].includes(item.kind ?? "") ? "alerts"
      : item.kind === "court_case" ? "courts" : item.kind === "obituary" ? "remembrance"
      : topicOfFiled({ kind: item.kind, title: item.headline, description: item.blurb, section_id: item.section_id }) ?? "other";
    return !topics.length || topics.includes(topic);
  }).slice(0, 20);
}
export function editionEmail(config: NewsletterConfig, sub: Subscription, edition: Edition): MailEnvelope {
  const page = `${config.publicUrl}?${new URLSearchParams({ location: edition.location_id, edition: edition.id })}`;
  const manage = newsletterLink(config, sub, "manage");
  const unsubscribe = new URL(`${config.publicUrl}/api/newsletter/unsubscribe`);
  unsubscribe.search = new URLSearchParams({ id: sub._id, token: token(config, "manage", sub) }).toString();
  const stories = newsletterItems(edition, sub.topics).map(({ item, index }) => ({ ...item,
    href: `${page}&${new URLSearchParams({ story: item.story_id || `item:${index + 1}` })}` }));
  const summary = (text: string) => text.length > 500 ? `${text.slice(0, 497)}...` : text;
  return { subscriptionId: sub._id, from: config.from, to: sub.email, subject: `${sub.locationName} this week | Newsbee`,
    headers: { "List-Unsubscribe": `<${unsubscribe.href}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    text: `${sub.locationName} | ${edition.window_start} – ${edition.window_end}\n\n${stories.map((story) => `${story.headline}\n${summary(story.blurb)}\n${story.href}`).join("\n\n")}\n\nRead this edition: ${page}\nPreferences or unsubscribe: ${manage}`,
    html: `<div style="max-width:640px;margin:auto;font-family:Arial,sans-serif;color:#0a0a0a"><h1>Newsbee</h1><h2>${escape(sub.locationName)}</h2><p>${escape(edition.window_start)} – ${escape(edition.window_end)}</p>${stories.map((story) => `<article style="border-bottom:1px solid #e5e5e5;padding:16px 0"><h3><a href="${escape(story.href)}">${escape(story.headline)}</a></h3><p>${escape(summary(story.blurb))}</p></article>`).join("")}<p><a href="${escape(page)}">Read this edition</a></p><p><a href="${escape(manage)}">Preferences or unsubscribe</a></p></div>` };
}

export function newsletterTransport(db: Db, config: NewsletterConfig): MailTransport {
  return async (envelope, key) => {
    if (config.provider === "local") {
      if (envelope.subscriptionId) {
        const current = await db.collection<Subscription>(SUBSCRIPTIONS).findOne({ _id: envelope.subscriptionId });
        if (!current || current.dataClearPending) throw new Error("This delivery was revoked.");
      }
      await db.collection("reader_newsletter_preview_mail").updateOne({ _id: key as never }, { $setOnInsert: { key, ...envelope, at: new Date() } }, { upsert: true });
      return `local-${key}`;
    }
    const response = await fetch("https://api.resend.com/emails", { method: "POST", signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ from: envelope.from ?? config.from, to: [envelope.to], subject: envelope.subject, html: envelope.html, text: envelope.text, headers: envelope.headers }) });
    if (!response.ok) throw new Error(`Mail provider returned HTTP ${response.status}.`);
    const body = await response.json() as { id?: unknown };
    if (typeof body.id !== "string" || !body.id) throw new Error("Mail provider did not return a delivery receipt.");
    return body.id;
  };
}

/** A durable receipt plus the provider idempotency key protects overlapping workers and retries. */
export function deliverNewsletterJob(...args: Parameters<typeof deliverNewsletterJobAdmitted>) {
  return withSiteWriter(args[0], () => deliverNewsletterJobAdmitted(...args));
}

async function deliverNewsletterJobAdmitted(db: Db, config: NewsletterConfig, id: string, now = new Date(), transport = newsletterTransport(db, config)) {
  const mail = db.collection<MailJob>(MAIL);
  const job = await mail.findOneAndUpdate({ _id: id, attempts: { $lt: 5 }, nextAttemptAt: { $lte: now },
    $or: [{ status: "queued" }, { status: "sending", leaseUntil: { $lte: now } }] },
  { $set: { status: "sending", leaseUntil: new Date(now.getTime() + 120_000) }, $inc: { attempts: 1 } }, { returnDocument: "after" });
  if (!job) return false;
  const sub = await db.collection<Subscription>(SUBSCRIPTIONS).findOne({ _id: job.subscriptionId });
  if (!sub || sub.dataClearPending || (job.kind === "edition" && sub.status !== "active") || (job.kind === "confirmation" && (!sub.pending || sub.pending.nonce !== job.nonce || sub.pending.expiresAt <= now))) {
    await mail.updateOne({ _id: id }, { $set: { status: "cancelled" }, $unset: { envelope: "", leaseUntil: "" } });
    return false;
  }
  if (job.firstAttemptAt && now.getTime() - job.firstAttemptAt.getTime() > 23 * 3600_000) {
    await mail.updateOne({ _id: id }, { $set: { status: "failed", error: "The safe provider retry window expired; review this delivery before resending." }, $unset: { leaseUntil: "" } });
    return false;
  }
  await mail.updateOne({ _id: id, firstAttemptAt: { $exists: false } }, { $set: { firstAttemptAt: now } });
  try {
    if (!job.envelope) throw new Error("This delivery has no email content.");
    const providerId = await transport(job.envelope, job._id);
    await mail.updateOne({ _id: id }, { $set: { status: "sent", sentAt: now, providerId }, $unset: { envelope: "", leaseUntil: "", error: "" } });
    return true;
  } catch (error) {
    await mail.updateOne({ _id: id }, { $set: { status: job.attempts >= 5 ? "failed" : "queued", error: error instanceof Error ? error.message.slice(0, 200) : "Email delivery failed.",
      nextAttemptAt: new Date(now.getTime() + Math.min(3600_000, 60_000 * 2 ** job.attempts)) }, $unset: { leaseUntil: "" } });
    return false;
  }
}

/** Only the public reader-folder editions are eligible for email delivery. */
export function dispatchNewsletters(...args: Parameters<typeof dispatchNewslettersAdmitted>) {
  return withSiteWriter(args[0], () => dispatchNewslettersAdmitted(...args));
}

async function dispatchNewslettersAdmitted(db: Db, config: NewsletterConfig, catalog: { locations: Location[]; editions: Edition[] }, now = new Date(), transport = newsletterTransport(db, config)) {
  await indexes(db);
  const latest = new Map<string, Edition>();
  const allowed = new Set(catalog.locations.map((location) => location.id));
  for (const edition of catalog.editions) if (!edition.publication_release && allowed.has(edition.location_id) && Number.isFinite(edition.published_at) && edition.published_at > 0 && edition.published_at <= now.getTime() / 1000 && (!latest.has(edition.location_id) || latest.get(edition.location_id)!.published_at < edition.published_at)) latest.set(edition.location_id, edition);
  const subscriptions = db.collection<Subscription>(SUBSCRIPTIONS);
  // A bounded scan resumes from a persisted cursor, so larger lists aren't starved.
  const cursor = await db.collection("reader_newsletter_state").findOne({ _id: "scan" as never });
  const rows = await subscriptions.find({ dataClearPending: { $ne: true }, ...(cursor?.after ? { _id: { $gt: String(cursor.after) } } : {}), $or: [{ status: "active" }, { pending: { $exists: true } }] }).sort({ _id: 1 }).limit(100).toArray();
  for (const sub of rows) {
    if (sub.pending && sub.pending.expiresAt > now) await queue(db, { _id: `confirm-${hash(`${sub._id}:${sub.pending.nonce}`)}`, subscriptionId: sub._id, kind: "confirmation", nonce: sub.pending.nonce, envelope: confirmation(config, sub) }, now);
    const edition = latest.get(sub.locationId);
    if (sub.status === "active" && edition && newsletterItems(edition, sub.topics).length) await queue(db, { _id: `edition-${hash(`${sub._id}:${edition.id}`)}`, subscriptionId: sub._id, kind: "edition", editionId: edition.id, envelope: editionEmail(config, sub, edition) }, now);
  }
  await db.collection("reader_newsletter_state").updateOne({ _id: "scan" as never }, { $set: { after: rows.length === 100 ? rows.at(-1)!._id : null, at: now } }, { upsert: true });
  const jobs = await db.collection<MailJob>(MAIL).find({ nextAttemptAt: { $lte: now }, attempts: { $lt: 5 }, $or: [{ status: "queued" }, { status: "sending", leaseUntil: { $lte: now } }] }).sort({ nextAttemptAt: 1 }).limit(20).toArray();
  let sent = 0;
  const deadline = Date.now() + 40_000;
  for (const job of jobs) {
    if (Date.now() > deadline - 9000) break;
    if (job.kind === "edition") {
      const subscriber = await subscriptions.findOne({ _id: job.subscriptionId });
      if (!subscriber || latest.get(subscriber.locationId)?.id !== job.editionId) {
        await db.collection<MailJob>(MAIL).updateOne({ _id: job._id, status: { $in: ["queued", "sending"] } }, { $set: { status: "cancelled" }, $unset: { envelope: "", leaseUntil: "" } });
        continue;
      }
    }
    if (await deliverNewsletterJob(db, config, job._id, now, transport)) sent++;
    if (config.provider === "resend") await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return { scanned: rows.length, sent, pending: await db.collection<MailJob>(MAIL).countDocuments({ status: { $in: ["queued", "sending"] } }) };
}

export async function newsletterStatus(db: Db) {
  const count = (collection: string, status: string) => db.collection(collection).countDocuments({ status });
  const [active, pending, unsubscribed, queued, sending, sent, failed, failures] = await Promise.all([
    count(SUBSCRIPTIONS, "active"), count(SUBSCRIPTIONS, "pending"), count(SUBSCRIPTIONS, "unsubscribed"),
    count(MAIL, "queued"), count(MAIL, "sending"), count(MAIL, "sent"), count(MAIL, "failed"),
    db.collection<MailJob>(MAIL).find({ status: "failed" }, { projection: { _id: 1, kind: 1, error: 1, attempts: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(20).toArray(),
  ]);
  return { configured: false, provider: null, active, pending, unsubscribed, queued: queued + sending, sent, failed,
    failures: failures.map((job) => ({ id: job._id, kind: job.kind, error: job.error ?? "Delivery failed", attempts: job.attempts })),
    previews: [] };
}
