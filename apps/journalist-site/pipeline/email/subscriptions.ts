import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import { ensurePublicationEmailIndexes } from "./indexes";
import {
  configuredEmailProvider,
  type EmailProvider,
  type EmailProviderResult,
} from "./provider";

export const PUBLICATION_EMAIL_CONSENT_VERSION = "publication-email-v1";

export type EmailSuppressionReason = "unsubscribe" | "manual" | "hard_bounce" | "complaint";
const PERMANENT_SUPPRESSION_REASONS: EmailSuppressionReason[] = ["manual", "hard_bounce", "complaint"];
export type PublicationEmailSubscription = {
  _id: string;
  publication_id: string;
  publication_name: string;
  email: string;
  email_hash: string;
  status: "pending" | "active" | "unsubscribed" | "suppressed";
  location_ids: string[];
  consent_id: string;
  consent_version: typeof PUBLICATION_EMAIL_CONSENT_VERSION;
  token_version: number;
  pending_confirmation?: {
    nonce: string;
    location_ids: string[];
    source_release_id: string;
    consent_text: string;
    requested_at: number;
    expires_at: number;
  };
  confirmed_request?: { nonce: string; expires_at: number };
  requested_at?: number;
  confirmed_at?: number;
  created_at: number;
  updated_at: number;
};

type ConsentDocument = {
  _id: string;
  publication_id: string;
  subscription_id: string;
  email_hash: string;
  consent_version: typeof PUBLICATION_EMAIL_CONSENT_VERSION;
  consent_text: string;
  location_ids: string[];
  source_release_id: string;
  confirmation_nonce?: string;
  consented_at: number;
};

type SuppressionDocument = {
  _id: string;
  publication_id: string;
  email_hash: string;
  email: string;
  reason: EmailSuppressionReason;
  source: string;
  created_at: number;
  updated_at: number;
};

type EmailEventDocument = {
  _id: string;
  publication_id: string;
  email_hash: string;
  type: EmailSuppressionReason;
  source: string;
  at: number;
  provider?: string;
  provider_event_id?: string;
};

export class PublicationEmailValidationError extends Error {}
export class PublicationEmailTokenError extends Error {}

export function normalizeEmail(value: unknown) {
  if (typeof value !== "string") throw new PublicationEmailValidationError("Enter a valid email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
    throw new PublicationEmailValidationError("Enter a valid email address.");
  }
  return email;
}

export function publicationEmailHash(email: string) {
  return createHash("sha256").update(email).digest("hex");
}

function managementSecret(secret = process.env.NEWSBEE_EMAIL_MANAGEMENT_SECRET ?? process.env.AUTH_SECRET) {
  if (!secret || secret.length < 32) throw new PublicationEmailTokenError("Email management links are not configured.");
  return secret;
}

function tokenSignature(id: string, version: number, secret?: string) {
  return createHmac("sha256", managementSecret(secret))
    .update(`newsbee-publication-email-v1:${id}:${version}`)
    .digest("hex");
}

export function publicationEmailToken(subscription: Pick<PublicationEmailSubscription, "_id" | "token_version">, secret?: string) {
  return `${subscription._id}.${subscription.token_version}.${tokenSignature(subscription._id, subscription.token_version, secret)}`;
}

function confirmationSignature(id: string, version: number, nonce: string, secret?: string) {
  return createHmac("sha256", managementSecret(secret))
    .update(`newsbee-publication-email-confirm-v1:${id}:${version}:${nonce}`)
    .digest("hex");
}

export function publicationEmailConfirmationToken(
  subscription: Pick<PublicationEmailSubscription, "_id" | "token_version" | "pending_confirmation" | "confirmed_request">,
  secret?: string,
) {
  const request = subscription.pending_confirmation ?? subscription.confirmed_request;
  if (!request) throw new PublicationEmailTokenError("This email confirmation link is no longer available.");
  return `${subscription._id}.${subscription.token_version}.${request.nonce}.${confirmationSignature(subscription._id, subscription.token_version, request.nonce, secret)}`;
}

function tokenIdentity(token: string, secret?: string) {
  const match = /^([a-f0-9-]{36})\.(\d+)\.([a-f0-9]{64})$/.exec(token);
  if (!match) throw new PublicationEmailTokenError("This email management link is invalid.");
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 1) throw new PublicationEmailTokenError("This email management link is invalid.");
  const expected = Buffer.from(tokenSignature(match[1], version, secret), "hex");
  const actual = Buffer.from(match[3], "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PublicationEmailTokenError("This email management link is invalid.");
  }
  return { id: match[1], version };
}

function confirmationIdentity(token: string, secret?: string) {
  const match = /^([a-f0-9-]{36})\.(\d+)\.([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(token);
  if (!match) throw new PublicationEmailTokenError("This email confirmation link is invalid.");
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 1) throw new PublicationEmailTokenError("This email confirmation link is invalid.");
  const expected = Buffer.from(confirmationSignature(match[1], version, match[3], secret), "hex");
  const actual = Buffer.from(match[4], "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PublicationEmailTokenError("This email confirmation link is invalid.");
  }
  return { id: match[1], version, nonce: match[3] };
}

export function publicationEmailPublicUrl(env: NodeJS.ProcessEnv = process.env) {
  let url: URL;
  try {
    url = new URL(env.NEWSBEE_READER_SITE_URL ?? "");
  } catch {
    throw new PublicationEmailTokenError("NEWSBEE_READER_SITE_URL must be an absolute URL, without surrounding quotes or placeholders.");
  }
  if (url.username || url.password) {
    throw new PublicationEmailTokenError("NEWSBEE_READER_SITE_URL must not contain a username or password.");
  }
  if (url.search || url.hash) {
    throw new PublicationEmailTokenError("NEWSBEE_READER_SITE_URL must not contain a query string or fragment.");
  }
  const local = env.NEWSBEE_MODE === "local" && url.protocol === "http:"
    && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new PublicationEmailTokenError("NEWSBEE_READER_SITE_URL requires HTTPS. HTTP localhost or 127.0.0.1 is allowed only with NEWSBEE_MODE=local.");
  }
  return url.href.replace(/\/$/, "");
}

function normalizeLocations(values: unknown, allowed: ReadonlySet<string>) {
  if (!Array.isArray(values) || !values.length || values.length > 100) {
    throw new PublicationEmailValidationError("Choose at least one covered location.");
  }
  const locations = values.map((value) => typeof value === "string" ? value : "");
  if (locations.some((value) => !value || !allowed.has(value)) || new Set(locations).size !== locations.length) {
    throw new PublicationEmailValidationError("Choose only locations covered by this publication release.");
  }
  return locations.sort();
}

async function enforceSignupLimits(db: Db, publicationId: string, emailHash: string, now: number) {
  const bucket = Math.floor(now / 3600_000);
  for (const [key, maximum] of [
    [`global:${bucket}`, 100],
    [`publication:${publicationId}:${emailHash}:${bucket}`, 5],
  ] as const) {
    const limit = await db.collection<{ _id: string; requests: number; expires_at: Date }>(
      COLLECTIONS.publicationEmailLimits,
    ).findOneAndUpdate(
      { _id: key },
      {
        $inc: { requests: 1 },
        $setOnInsert: { expires_at: new Date(now + 2 * 3600_000) },
      },
      { upsert: true, returnDocument: "after" },
    );
    if ((limit?.requests ?? 0) > maximum) {
      throw new PublicationEmailValidationError("Too many publication email requests. Please try again later.");
    }
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function confirmationLink(subscription: PublicationEmailSubscription) {
  const token = encodeURIComponent(publicationEmailConfirmationToken(subscription));
  return `${publicationEmailPublicUrl()}/email/preferences?token=${token}&confirm=1`;
}

async function sendPublicationEmailConfirmation(
  db: Db,
  subscription: PublicationEmailSubscription,
  provider: EmailProvider,
): Promise<EmailProviderResult> {
  const pending = subscription.pending_confirmation;
  if (!pending) throw new PublicationEmailTokenError("This email confirmation request is no longer available.");
  const link = confirmationLink(subscription);
  const deliveryId = `confirmation:${subscription._id}:${pending.nonce}`;
  return provider.send({
    publicationId: subscription.publication_id,
    campaignId: `confirmation:${subscription.publication_id}`,
    deliveryId,
    idempotencyKey: createHash("sha256").update(deliveryId).digest("hex"),
    to: subscription.email,
    subject: `Confirm ${subscription.publication_name} by email`,
    text: `Confirm email editions from ${subscription.publication_name}: ${link}\nThis link expires in 48 hours. If you did not request this, ignore this email.`,
    html: `<h1>Confirm ${escapeHtml(subscription.publication_name)} by email</h1><p><a href="${escapeHtml(link)}">Confirm publication email preferences</a></p><p>This link expires in 48 hours. If you did not request this, ignore this email.</p>`,
  });
}

export async function recordPublicationEmailConsent(
  db: Db,
  input: {
    publicationId: string;
    publicationName: string;
    releaseId: string;
    email: unknown;
    locationIds: unknown;
    allowedLocationIds: readonly string[];
    consent: unknown;
    consentText: string;
  },
  options: { now?: number; provider?: EmailProvider } = {},
) {
  if (input.consent !== true) throw new PublicationEmailValidationError("Explicit email consent is required.");
  managementSecret();
  publicationEmailPublicUrl();
  await ensurePublicationEmailIndexes(db);
  const email = normalizeEmail(input.email);
  const emailHash = publicationEmailHash(email);
  const locationIds = normalizeLocations(input.locationIds, new Set(input.allowedLocationIds));
  const now = options.now ?? Date.now();
  await enforceSignupLimits(db, input.publicationId, emailHash, now);
  const subscriptions = db.collection<PublicationEmailSubscription>(COLLECTIONS.publicationEmailSubscriptions);
  let subscription = await subscriptions.findOne({ publication_id: input.publicationId, email_hash: emailHash });
  let pending = subscription?.pending_confirmation;
  const recentRequest = pending && subscription?.requested_at && now - subscription.requested_at < 60_000;
  if (!recentRequest) {
    pending = {
      nonce: randomUUID(),
      location_ids: locationIds,
      source_release_id: input.releaseId,
      consent_text: input.consentText,
      requested_at: now,
      expires_at: now + 48 * 3600_000,
    };
  }
  if (!subscription) {
    const candidate: PublicationEmailSubscription = {
      _id: randomUUID(),
      publication_id: input.publicationId,
      publication_name: input.publicationName,
      email,
      email_hash: emailHash,
      status: "pending",
      location_ids: [],
      consent_id: "",
      consent_version: PUBLICATION_EMAIL_CONSENT_VERSION,
      token_version: 1,
      pending_confirmation: pending,
      requested_at: now,
      created_at: now,
      updated_at: now,
    };
    try {
      await subscriptions.insertOne(candidate);
      subscription = candidate;
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      subscription = await subscriptions.findOne({ publication_id: input.publicationId, email_hash: emailHash });
    }
  }
  if (!subscription) throw new Error("Subscription could not be created.");
  if (!recentRequest) {
    subscription = await subscriptions.findOneAndUpdate(
      { _id: subscription._id, publication_id: input.publicationId },
      {
        $set: {
          publication_name: input.publicationName,
          email,
          pending_confirmation: pending,
          requested_at: now,
          updated_at: now,
        },
      },
      { returnDocument: "after" },
    );
  }
  if (!subscription?.pending_confirmation) throw new Error("Subscription confirmation could not be created.");
  try {
    const provider = options.provider ?? configuredEmailProvider(db);
    const result = await sendPublicationEmailConfirmation(db, subscription, provider);
    return {
      subscription,
      token: publicationEmailToken(subscription),
      confirmationToken: publicationEmailConfirmationToken(subscription),
      confirmationSent: result.status === "accepted",
      confirmationResult: result,
    };
  } catch (error) {
    return {
      subscription,
      token: publicationEmailToken(subscription),
      confirmationToken: publicationEmailConfirmationToken(subscription),
      confirmationSent: false,
      confirmationError: error instanceof Error ? error.message : "Confirmation email is unavailable.",
    };
  }
}

export async function publicationEmailSubscriptionForToken(db: Db, token: string) {
  await ensurePublicationEmailIndexes(db);
  const identity = tokenIdentity(token);
  const subscription = await db.collection<PublicationEmailSubscription>(COLLECTIONS.publicationEmailSubscriptions)
    .findOne({ _id: identity.id, token_version: identity.version });
  if (!subscription) throw new PublicationEmailTokenError("This email management link is no longer available.");
  return subscription;
}

export async function publicationEmailSubscriptionForConfirmationToken(
  db: Db,
  token: string,
  now = Date.now(),
) {
  await ensurePublicationEmailIndexes(db);
  const identity = confirmationIdentity(token);
  const subscription = await db.collection<PublicationEmailSubscription>(COLLECTIONS.publicationEmailSubscriptions)
    .findOne({ _id: identity.id, token_version: identity.version });
  if (!subscription) throw new PublicationEmailTokenError("This email confirmation link is no longer available.");
  const request = subscription.pending_confirmation?.nonce === identity.nonce
    ? subscription.pending_confirmation
    : subscription.status === "active" && subscription.confirmed_request?.nonce === identity.nonce
      ? subscription.confirmed_request
      : null;
  if (!request || request.expires_at <= now) {
    throw new PublicationEmailTokenError("This email confirmation link is invalid or expired.");
  }
  return subscription;
}

async function reconcileConfirmedSuppression(
  db: Db,
  subscription: PublicationEmailSubscription,
  now: number,
) {
  const suppressions = db.collection<SuppressionDocument>(COLLECTIONS.publicationEmailSuppressions);
  await suppressions.deleteOne({
    publication_id: subscription.publication_id,
    email_hash: subscription.email_hash,
    reason: "unsubscribe",
  });
  const effective = await suppressions.findOne({
    publication_id: subscription.publication_id,
    email_hash: subscription.email_hash,
  });
  return db.collection<PublicationEmailSubscription>(COLLECTIONS.publicationEmailSubscriptions)
    .findOneAndUpdate(
      { _id: subscription._id, token_version: subscription.token_version },
      {
        $set: {
          status: effective ? "suppressed" : "active",
          updated_at: now,
        },
      },
      { returnDocument: "after" },
    );
}

export async function confirmPublicationEmail(db: Db, token: string, now = Date.now()) {
  const subscription = await publicationEmailSubscriptionForConfirmationToken(db, token, now);
  const pending = subscription.pending_confirmation;
  if (!pending) {
    const reconciled = await reconcileConfirmedSuppression(db, subscription, now);
    if (!reconciled) throw new PublicationEmailTokenError("This email confirmation link is no longer available.");
    return { subscription: reconciled, token: publicationEmailToken(reconciled) };
  }
  const consentId = createHash("sha256")
    .update(`publication-email-consent:${subscription._id}:${pending.nonce}`)
    .digest("hex");
  const consent: ConsentDocument = {
    _id: consentId,
    publication_id: subscription.publication_id,
    subscription_id: subscription._id,
    email_hash: subscription.email_hash,
    consent_version: PUBLICATION_EMAIL_CONSENT_VERSION,
    consent_text: pending.consent_text,
    location_ids: pending.location_ids,
    source_release_id: pending.source_release_id,
    confirmation_nonce: pending.nonce,
    consented_at: now,
  };
  try {
    await db.collection<ConsentDocument>(COLLECTIONS.publicationEmailConsents).insertOne(consent);
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  const effectiveSuppression = await db.collection<SuppressionDocument>(COLLECTIONS.publicationEmailSuppressions).findOne({
    publication_id: subscription.publication_id,
    email_hash: subscription.email_hash,
  });
  const updated = await db.collection<PublicationEmailSubscription>(COLLECTIONS.publicationEmailSubscriptions)
    .findOneAndUpdate(
      {
        _id: subscription._id,
        token_version: subscription.token_version,
        "pending_confirmation.nonce": pending.nonce,
      },
      {
        $set: {
          publication_name: subscription.publication_name,
          location_ids: pending.location_ids,
          consent_id: consentId,
          consent_version: PUBLICATION_EMAIL_CONSENT_VERSION,
          status: effectiveSuppression
            ? effectiveSuppression.reason === "unsubscribe" ? "unsubscribed" : "suppressed"
            : "active",
          confirmed_request: { nonce: pending.nonce, expires_at: pending.expires_at },
          confirmed_at: subscription.confirmed_at ?? now,
          updated_at: now,
        },
        $unset: { pending_confirmation: "" },
      },
      { returnDocument: "after" },
    );
  if (!updated) {
    const current = await db.collection<PublicationEmailSubscription>(COLLECTIONS.publicationEmailSubscriptions)
      .findOne({ _id: subscription._id, token_version: subscription.token_version });
    if (!current || current.confirmed_request?.nonce !== pending.nonce) {
      await db.collection<ConsentDocument>(COLLECTIONS.publicationEmailConsents).deleteOne({ _id: consentId });
      throw new PublicationEmailTokenError("A newer email confirmation request is available.");
    }
    const reconciled = await reconcileConfirmedSuppression(db, current, now);
    if (!reconciled) throw new PublicationEmailTokenError("This email confirmation link is no longer available.");
    return { subscription: reconciled, token: publicationEmailToken(reconciled) };
  }
  const reconciled = await reconcileConfirmedSuppression(db, updated, now);
  if (!reconciled) throw new PublicationEmailTokenError("This email confirmation link is no longer available.");
  return { subscription: reconciled, token: publicationEmailToken(reconciled) };
}

export async function updatePublicationEmailPreferences(
  db: Db,
  token: string,
  locationIds: unknown,
  allowedLocationIds: readonly string[],
) {
  const subscription = await publicationEmailSubscriptionForToken(db, token);
  const normalized = normalizeLocations(locationIds, new Set(allowedLocationIds));
  const updated = await db.collection<PublicationEmailSubscription>(COLLECTIONS.publicationEmailSubscriptions)
    .findOneAndUpdate(
      { _id: subscription._id, token_version: subscription.token_version },
      { $set: { location_ids: normalized, updated_at: Date.now() } },
      { returnDocument: "after" },
    );
  if (!updated) throw new PublicationEmailTokenError("This email management link is no longer available.");
  return updated;
}

export async function suppressPublicationEmail(
  db: Db,
  input: {
    publicationId: string;
    email: string;
    reason: EmailSuppressionReason;
    source: string;
    provider?: string;
    providerEventId?: string;
  },
) {
  await ensurePublicationEmailIndexes(db);
  const email = normalizeEmail(input.email);
  const emailHash = publicationEmailHash(email);
  const events = db.collection<EmailEventDocument>(COLLECTIONS.publicationEmailEvents);
  const now = Date.now();
  const event: EmailEventDocument = {
    _id: randomUUID(),
    publication_id: input.publicationId,
    email_hash: emailHash,
    type: input.reason,
    source: input.source,
    at: now,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.providerEventId ? { provider_event_id: input.providerEventId } : {}),
  };
  let duplicate = false;
  try {
    await events.insertOne(event);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) duplicate = true;
    else throw error;
  }
  const permanentReasons = PERMANENT_SUPPRESSION_REASONS;
  await db.collection<SuppressionDocument>(COLLECTIONS.publicationEmailSuppressions).updateOne(
    { publication_id: input.publicationId, email_hash: emailHash },
    [{
      $set: {
        _id: { $ifNull: ["$_id", randomUUID()] },
        publication_id: input.publicationId,
        email_hash: emailHash,
        email,
        reason: {
          $cond: [
            { $in: ["$reason", permanentReasons] },
            "$reason",
            input.reason,
          ],
        },
        source: {
          $cond: [
            { $in: ["$reason", permanentReasons] },
            "$source",
            input.source,
          ],
        },
        created_at: { $ifNull: ["$created_at", now] },
        updated_at: {
          $cond: [
            { $in: ["$reason", permanentReasons] },
            "$updated_at",
            now,
          ],
        },
      },
    }],
    { upsert: true },
  );
  const effective = await db.collection<SuppressionDocument>(COLLECTIONS.publicationEmailSuppressions)
    .findOne({ publication_id: input.publicationId, email_hash: emailHash });
  if (!effective) throw new Error("Email suppression could not be recorded.");
  await db.collection<PublicationEmailSubscription>(COLLECTIONS.publicationEmailSubscriptions).updateOne(
    { publication_id: input.publicationId, email_hash: emailHash },
    {
      $set: {
        status: effective.reason === "unsubscribe" ? "unsubscribed" : "suppressed",
        updated_at: now,
      },
      $unset: { pending_confirmation: "" },
    },
  );
  await db.collection(COLLECTIONS.publicationEmailDeliveries).updateMany(
    {
      publication_id: input.publicationId,
      email_hash: emailHash,
      status: { $in: ["pending", "retryable_failed", "unknown"] },
    },
    {
      $set: {
        status: "suppressed",
        last_detail: `Delivery suppressed: ${effective.reason}.`,
        claim_token: null,
        lease_until: null,
        updated_at: now,
      },
    },
  );
  return { duplicate, reason: effective.reason };
}

export async function unsubscribePublicationEmail(db: Db, token: string) {
  const subscription = await publicationEmailSubscriptionForToken(db, token);
  await suppressPublicationEmail(db, {
    publicationId: subscription.publication_id,
    email: subscription.email,
    reason: "unsubscribe",
    source: "reader_unsubscribe",
  });
  return subscription;
}
