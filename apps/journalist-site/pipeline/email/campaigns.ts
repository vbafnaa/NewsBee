import { createHash, randomUUID } from "node:crypto";
import type { AnyBulkWriteOperation, Db } from "mongodb";
import pLimit from "p-limit";
import type { PublicationReleasePayloadV1 } from "../../../../shared/publication-release";
import type { PublicationContext } from "../publications/access";
import { assertPublicationWrite, publicationScopedFilter } from "../publications/access";
import {
  loadPublicationReleaseForDistribution,
  PublicationReleaseConflict,
  PublicationReleaseNotFound,
  PublicationReleaseValidationError,
} from "../publications/releases";
import { COLLECTIONS } from "../storage/mongo";
import { ensurePublicationEmailIndexes } from "./indexes";
import type { EmailProvider, EmailProviderResult } from "./provider";
import { configuredEmailProvider } from "./provider";
import {
  personalizePublicationEmail,
  renderPublicationReleaseEmail,
  type PublicationEmailContent,
} from "./render";
import {
  publicationEmailPublicUrl,
  publicationEmailToken,
  type PublicationEmailSubscription,
} from "./subscriptions";

type CampaignMode = "release" | "test";
type CampaignState = "snapshotting" | "ready" | "sending" | "complete" | "blocked";
export type PublicationEmailCampaign = {
  _id: string;
  publication_id: string;
  release_id: string;
  release_hash: string;
  release_title: string;
  mode: CampaignMode;
  state: CampaignState;
  provider: string;
  content: PublicationEmailContent;
  recipient_count: number;
  counts: Record<string, number>;
  blocked_reason?: string;
  created_by: string;
  created_at: number;
  updated_at: number;
};

type DeliveryStatus = "pending" | "sending" | "accepted" | "retryable_failed" | "permanent_failed" | "unknown" | "suppressed" | "cancelled";
type DeliveryDocument = {
  _id: string;
  publication_id: string;
  campaign_id: string;
  release_id: string;
  recipient_id: string;
  subscription_id: string | null;
  email: string;
  email_hash: string;
  location_ids: string[];
  preferences_url: string;
  unsubscribe_url: string;
  provider: string;
  idempotency_key: string;
  status: DeliveryStatus;
  attempts_count: number;
  available_at: number;
  lease_until: number | null;
  claim_token: string | null;
  provider_message_id: string | null;
  last_attempt_id?: string | null;
  last_detail: string | null;
  created_at: number;
  updated_at: number;
};

type AttemptDocument = {
  _id: string;
  publication_id: string;
  campaign_id: string;
  delivery_id: string;
  attempt: number;
  idempotency_key: string;
  provider: string;
  result: EmailProviderResult;
  created_at: number;
  applied_at: number | null;
};

const SNAPSHOT_BATCH = 500;
const DEFAULT_DELIVERY_BATCH = 100;
const DELIVERY_CONCURRENCY = 5;

function stableKey(...values: string[]) {
  return createHash("sha256").update(values.join("\u0000")).digest("hex");
}

function readerRoot() {
  return publicationEmailPublicUrl();
}

function managementLinks(subscription: PublicationEmailSubscription) {
  const token = encodeURIComponent(publicationEmailToken(subscription));
  return {
    preferencesUrl: `${readerRoot()}/email/preferences?token=${token}`,
    unsubscribeUrl: `${readerRoot()}/email/unsubscribe?token=${token}`,
  };
}

async function insertDeliveryBatch(
  db: Db,
  campaign: PublicationEmailCampaign,
  subscriptions: PublicationEmailSubscription[],
) {
  if (!subscriptions.length) return 0;
  const suppressions = await db.collection(COLLECTIONS.publicationEmailSuppressions).find({
    publication_id: campaign.publication_id,
    email_hash: { $in: subscriptions.map((subscription) => subscription.email_hash) },
  }, { projection: { email_hash: 1 } }).toArray();
  const suppressed = new Set(suppressions.map((row) => String(row.email_hash)));
  const now = Date.now();
  const documents = subscriptions.flatMap((subscription): DeliveryDocument[] => {
    if (suppressed.has(subscription.email_hash)) return [];
    const links = managementLinks(subscription);
    return [{
      _id: randomUUID(),
      publication_id: campaign.publication_id,
      campaign_id: campaign._id,
      release_id: campaign.release_id,
      recipient_id: subscription._id,
      subscription_id: subscription._id,
      email: subscription.email,
      email_hash: subscription.email_hash,
      location_ids: [...subscription.location_ids],
      preferences_url: links.preferencesUrl,
      unsubscribe_url: links.unsubscribeUrl,
      provider: campaign.provider,
      idempotency_key: stableKey(campaign._id, subscription._id),
      status: "pending",
      attempts_count: 0,
      available_at: now,
      lease_until: null,
      claim_token: null,
      provider_message_id: null,
      last_detail: null,
      created_at: now,
      updated_at: now,
    }];
  });
  if (!documents.length) return 0;
  try {
    const result = await db.collection<DeliveryDocument>(COLLECTIONS.publicationEmailDeliveries)
      .insertMany(documents, { ordered: false });
    return result.insertedCount;
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    return db.collection<DeliveryDocument>(COLLECTIONS.publicationEmailDeliveries)
      .countDocuments({ campaign_id: campaign._id, recipient_id: { $in: documents.map((document) => document.recipient_id) } });
  }
}

export async function createPublicationEmailCampaign(
  db: Db,
  context: PublicationContext,
  release: { payload: PublicationReleasePayloadV1; contentHash: string },
  input: { mode: CampaignMode; createdBy: string; testEmail?: string; provider?: EmailProvider },
) {
  await assertPublicationWrite(db, context, "create_email_campaign");
  await ensurePublicationEmailIndexes(db);
  const provider = input.provider ?? configuredEmailProvider(db);
  const campaigns = db.collection<PublicationEmailCampaign>(COLLECTIONS.publicationEmailCampaigns);
  let campaign: PublicationEmailCampaign | null = null;
  if (input.mode === "release") {
    const existing = await campaigns.findOne(publicationScopedFilter(context, {
      release_id: release.payload.release_id,
      mode: "release",
    }));
    if (existing) {
      if (existing.state !== "snapshotting") return existing;
      campaign = existing;
    }
  }
  const now = Date.now();
  campaign ??= {
    _id: randomUUID(),
    publication_id: context.id,
    release_id: release.payload.release_id,
    release_hash: release.contentHash,
    release_title: release.payload.title,
    mode: input.mode,
    state: "snapshotting",
    provider: provider.name,
    content: renderPublicationReleaseEmail(release.payload),
    recipient_count: 0,
    counts: {},
    created_by: input.createdBy,
    created_at: now,
    updated_at: now,
  };
  if (!await campaigns.findOne({ _id: campaign._id })) {
    try {
      await campaigns.insertOne(campaign);
    } catch (error) {
      if ((error as { code?: number }).code !== 11000 || input.mode !== "release") throw error;
      const raced = await campaigns.findOne(publicationScopedFilter(context, {
        release_id: release.payload.release_id,
        mode: "release",
      }));
      if (!raced) throw error;
      if (raced.state !== "snapshotting") return raced;
      campaign = raced;
    }
  }
  if (input.mode === "test") {
    if (!input.testEmail) throw new Error("A test recipient is required.");
    const { normalizeEmail, publicationEmailHash } = await import("./subscriptions");
    const email = normalizeEmail(input.testEmail);
    const recipientId = `test:${publicationEmailHash(email)}`;
    const delivery: DeliveryDocument = {
      _id: randomUUID(),
      publication_id: context.id,
      campaign_id: campaign._id,
      release_id: campaign.release_id,
      recipient_id: recipientId,
      subscription_id: null,
      email,
      email_hash: publicationEmailHash(email),
      location_ids: release.payload.locations.map((location) => location.id),
      preferences_url: `${readerRoot()}/publications/${encodeURIComponent(context.id)}`,
      unsubscribe_url: `${readerRoot()}/publications/${encodeURIComponent(context.id)}`,
      provider: provider.name,
      idempotency_key: stableKey(campaign._id, recipientId),
      status: "pending",
      attempts_count: 0,
      available_at: now,
      lease_until: null,
      claim_token: null,
      provider_message_id: null,
      last_detail: null,
      created_at: now,
      updated_at: now,
    };
    await db.collection<DeliveryDocument>(COLLECTIONS.publicationEmailDeliveries).insertOne(delivery);
  } else {
    const locationIds = release.payload.locations.map((location) => location.id);
    const cursor = db.collection<PublicationEmailSubscription>(COLLECTIONS.publicationEmailSubscriptions)
      .find({
        publication_id: context.id,
        status: "active",
        confirmed_at: { $gt: 0 },
        location_ids: { $in: locationIds },
      })
      .sort({ _id: 1 })
      .batchSize(SNAPSHOT_BATCH);
    let batch: PublicationEmailSubscription[] = [];
    for await (const subscription of cursor) {
      batch.push(subscription);
      if (batch.length === SNAPSHOT_BATCH) {
        await insertDeliveryBatch(db, campaign, batch);
        batch = [];
      }
    }
    await insertDeliveryBatch(db, campaign, batch);
  }
  const recipientCount = await db.collection<DeliveryDocument>(COLLECTIONS.publicationEmailDeliveries)
    .countDocuments({ campaign_id: campaign._id });
  const ready = await campaigns.findOneAndUpdate(
    { _id: campaign._id, publication_id: context.id, state: "snapshotting" },
    { $set: { state: "ready", recipient_count: recipientCount, counts: { pending: recipientCount }, updated_at: Date.now() } },
    { returnDocument: "after" },
  );
  if (!ready) throw new Error("Campaign snapshot could not be finalized.");
  return ready;
}

function resultUpdate(result: EmailProviderResult, now: number) {
  if (result.status === "accepted") {
    return {
      status: "accepted" as const,
      available_at: now,
      provider_message_id: result.providerMessageId,
      last_detail: null,
    };
  }
  if (result.status === "retryable_failed") {
    return {
      status: "retryable_failed" as const,
      available_at: now + Math.max(1, result.retryAfterSeconds ?? 60) * 1000,
      provider_message_id: null,
      last_detail: result.detail,
    };
  }
  return {
    status: result.status,
    available_at: now,
    provider_message_id: null,
    last_detail: result.detail,
  };
}

function attemptId(deliveryId: string, attempt: number) {
  return stableKey("publication-email-attempt-v1", deliveryId, String(attempt));
}

async function persistAttemptResults(
  db: Db,
  campaign: PublicationEmailCampaign,
  values: Array<{ delivery: DeliveryDocument; result: EmailProviderResult }>,
) {
  if (!values.length) return;
  const attempts = db.collection<AttemptDocument>(COLLECTIONS.publicationEmailAttempts);
  const attemptDocuments: AttemptDocument[] = values.map(({ delivery, result }) => ({
    _id: attemptId(delivery._id, delivery.attempts_count),
    publication_id: campaign.publication_id,
    campaign_id: campaign._id,
    delivery_id: delivery._id,
    attempt: delivery.attempts_count,
    idempotency_key: delivery.idempotency_key,
    provider: campaign.provider,
    result,
    created_at: Date.now(),
    applied_at: null,
  }));
  const attemptWrites: AnyBulkWriteOperation<AttemptDocument>[] = attemptDocuments.map((attempt) => ({
    updateOne: {
      filter: { _id: attempt._id },
      update: { $setOnInsert: attempt },
      upsert: true,
    },
  }));
  await attempts.bulkWrite(attemptWrites, { ordered: false });

  const deliveries = db.collection<DeliveryDocument>(COLLECTIONS.publicationEmailDeliveries);
  const appliedAt = Date.now();
  const deliveryWrites: AnyBulkWriteOperation<DeliveryDocument>[] = values.map(({ delivery, result }) => ({
    updateOne: {
      filter: {
        _id: delivery._id,
        campaign_id: campaign._id,
        status: "sending",
        attempts_count: delivery.attempts_count,
      },
      update: {
        $set: {
          ...resultUpdate(result, appliedAt),
          last_attempt_id: attemptId(delivery._id, delivery.attempts_count),
          claim_token: null,
          lease_until: null,
          updated_at: appliedAt,
        },
      },
    },
  }));
  await deliveries.bulkWrite(deliveryWrites, { ordered: false });
  await attempts.updateMany(
    { _id: { $in: attemptDocuments.map((attempt) => attempt._id) }, applied_at: null },
    { $set: { applied_at: appliedAt } },
  );
}

async function reconcileUnappliedAttempts(db: Db, campaign: PublicationEmailCampaign) {
  const attempts = db.collection<AttemptDocument>(COLLECTIONS.publicationEmailAttempts);
  const pending = await attempts.find({
    campaign_id: campaign._id,
    applied_at: null,
  }).sort({ created_at: 1, _id: 1 }).limit(500).toArray();
  if (!pending.length) return;
  const deliveries = db.collection<DeliveryDocument>(COLLECTIONS.publicationEmailDeliveries);
  const appliedAt = Date.now();
  const writes: AnyBulkWriteOperation<DeliveryDocument>[] = pending.map((attempt) => ({
    updateOne: {
      filter: {
        _id: attempt.delivery_id,
        campaign_id: campaign._id,
        status: "sending",
        attempts_count: attempt.attempt,
      },
      update: {
        $set: {
          ...resultUpdate(attempt.result, attempt.created_at),
          last_attempt_id: attempt._id,
          claim_token: null,
          lease_until: null,
          updated_at: appliedAt,
        },
      },
    },
  }));
  await deliveries.bulkWrite(writes, { ordered: false });
  await attempts.updateMany(
    { _id: { $in: pending.map((attempt) => attempt._id) }, applied_at: null },
    { $set: { applied_at: appliedAt } },
  );
}

async function recoverExpiredDeliveryLeases(db: Db, campaign: PublicationEmailCampaign) {
  const expired = await db.collection<DeliveryDocument>(COLLECTIONS.publicationEmailDeliveries).find({
    campaign_id: campaign._id,
    status: "sending",
    lease_until: { $lte: Date.now() },
  }).sort({ lease_until: 1, _id: 1 }).limit(500).toArray();
  await persistAttemptResults(db, campaign, expired.map((delivery) => ({
    delivery,
    result: {
      status: "unknown",
      detail: "The prior delivery lease expired with an unknown provider outcome.",
    },
  })));
}

async function refreshCampaignCounts(db: Db, campaign: PublicationEmailCampaign) {
  const rows = await db.collection<DeliveryDocument>(COLLECTIONS.publicationEmailDeliveries).aggregate<{ _id: string; count: number }>([
    { $match: { campaign_id: campaign._id } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]).toArray();
  const counts = Object.fromEntries(rows.map((row) => [row._id, row.count]));
  const unsettled = (counts.pending ?? 0) + (counts.sending ?? 0) + (counts.retryable_failed ?? 0);
  const state: CampaignState = unsettled ? "sending" : "complete";
  await db.collection<PublicationEmailCampaign>(COLLECTIONS.publicationEmailCampaigns).updateOne(
    { _id: campaign._id, publication_id: campaign.publication_id },
    { $set: { counts, state, updated_at: Date.now() } },
  );
  return { counts, state };
}

async function blockCampaign(
  db: Db,
  campaign: PublicationEmailCampaign,
  reason: string,
  claimedToken?: string,
) {
  const now = Date.now();
  await db.collection<DeliveryDocument>(COLLECTIONS.publicationEmailDeliveries).updateMany(
    {
      campaign_id: campaign._id,
      $or: [
        { status: { $in: ["pending", "retryable_failed", "unknown"] } },
        ...(claimedToken ? [{ status: "sending" as const, claim_token: claimedToken }] : []),
      ],
    },
    {
      $set: {
        status: "cancelled",
        last_detail: reason,
        claim_token: null,
        lease_until: null,
        updated_at: now,
      },
    },
  );
  const rows = await db.collection<DeliveryDocument>(COLLECTIONS.publicationEmailDeliveries).aggregate<{ _id: string; count: number }>([
    { $match: { campaign_id: campaign._id } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]).toArray();
  const counts = Object.fromEntries(rows.map((row) => [row._id, row.count]));
  await db.collection<PublicationEmailCampaign>(COLLECTIONS.publicationEmailCampaigns).updateOne(
    { _id: campaign._id, publication_id: campaign.publication_id },
    { $set: { state: "blocked", blocked_reason: reason, counts, updated_at: now } },
  );
}

async function assertCampaignReleaseActive(
  db: Db,
  context: PublicationContext,
  campaign: PublicationEmailCampaign,
  claimedToken?: string,
) {
  try {
    const release = await loadPublicationReleaseForDistribution(db, context, campaign.release_id);
    if (release.contentHash !== campaign.release_hash) {
      throw new PublicationReleaseValidationError("The campaign release hash no longer matches its immutable release.");
    }
  } catch (error) {
    if (error instanceof PublicationReleaseConflict
      || error instanceof PublicationReleaseNotFound
      || error instanceof PublicationReleaseValidationError
    ) {
      await blockCampaign(db, campaign, error.message || "The immutable release is no longer eligible for distribution.", claimedToken);
    }
    throw error;
  }
}

export async function processPublicationEmailCampaign(
  db: Db,
  context: PublicationContext,
  campaignId: string,
  options: {
    provider?: EmailProvider;
    includeUnknown?: boolean;
    limit?: number;
  } = {},
) {
  await assertPublicationWrite(db, context, "process_email_campaign");
  await ensurePublicationEmailIndexes(db);
  const campaign = await db.collection<PublicationEmailCampaign>(COLLECTIONS.publicationEmailCampaigns)
    .findOne(publicationScopedFilter(context, { _id: campaignId }));
  if (!campaign || campaign.state === "snapshotting") throw new Error("Campaign is not ready.");
  await reconcileUnappliedAttempts(db, campaign);
  await recoverExpiredDeliveryLeases(db, campaign);
  if (campaign.state === "blocked") {
    const reason = campaign.blocked_reason ?? "This campaign is blocked.";
    await blockCampaign(db, campaign, reason);
    throw new PublicationReleaseConflict(reason);
  }
  await assertCampaignReleaseActive(db, context, campaign);
  const provider = options.provider ?? configuredEmailProvider(db);
  if (provider.name !== campaign.provider) throw new Error("Campaign provider cannot change after recipient snapshotting.");
  const deliveries = db.collection<DeliveryDocument>(COLLECTIONS.publicationEmailDeliveries);
  const now = Date.now();
  const statuses: DeliveryStatus[] = ["pending", "retryable_failed"];
  if (options.includeUnknown) statuses.push("unknown");
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_DELIVERY_BATCH, 500));
  const candidates = await deliveries.find({
    campaign_id: campaign._id,
    status: { $in: statuses },
    available_at: { $lte: now },
  }, { projection: { _id: 1 } }).sort({ created_at: 1, _id: 1 }).limit(limit).toArray();
  if (!candidates.length) return refreshCampaignCounts(db, campaign);
  const claimToken = randomUUID();
  await deliveries.updateMany(
    {
      campaign_id: campaign._id,
      _id: { $in: candidates.map((candidate) => candidate._id) },
      status: { $in: statuses },
      available_at: { $lte: now },
    },
    {
      $set: { status: "sending", claim_token: claimToken, lease_until: now + 5 * 60_000, updated_at: now },
      $inc: { attempts_count: 1 },
    },
  );
  const claimed = await deliveries.find({ campaign_id: campaign._id, claim_token: claimToken }).toArray();
  await assertCampaignReleaseActive(db, context, campaign, claimToken);
  const suppressions = claimed.length ? await db.collection(COLLECTIONS.publicationEmailSuppressions).find({
    publication_id: campaign.publication_id,
    email_hash: { $in: claimed.map((delivery) => delivery.email_hash) },
  }, { projection: { email_hash: 1, reason: 1 } }).toArray() : [];
  const suppressionByEmail = new Map(suppressions.map((suppression) => [
    String(suppression.email_hash),
    String(suppression.reason),
  ]));
  const suppressedDeliveries = claimed.filter((delivery) => suppressionByEmail.has(delivery.email_hash));
  if (suppressedDeliveries.length) {
    const suppressedAt = Date.now();
    const writes: AnyBulkWriteOperation<DeliveryDocument>[] = suppressedDeliveries.map((delivery) => ({
      updateOne: {
        filter: { _id: delivery._id, campaign_id: campaign._id, claim_token: claimToken, status: "sending" },
        update: {
          $set: {
            status: "suppressed",
            last_detail: `Delivery suppressed: ${suppressionByEmail.get(delivery.email_hash)}.`,
            claim_token: null,
            lease_until: null,
            updated_at: suppressedAt,
          },
        },
      },
    }));
    await deliveries.bulkWrite(writes, { ordered: false });
  }
  const sendable = claimed.filter((delivery) => !suppressionByEmail.has(delivery.email_hash));
  const concurrency = pLimit(DELIVERY_CONCURRENCY);
  const results = await Promise.all(sendable.map((delivery) => concurrency(async () => {
    const personalized = personalizePublicationEmail(campaign.content, {
      preferencesUrl: delivery.preferences_url,
      unsubscribeUrl: delivery.unsubscribe_url,
    });
    let result: EmailProviderResult;
    try {
      result = await provider.send({
        publicationId: campaign.publication_id,
        campaignId: campaign._id,
        deliveryId: delivery._id,
        idempotencyKey: delivery.idempotency_key,
        to: delivery.email,
        ...personalized,
      });
    } catch (error) {
      result = {
        status: "unknown",
        detail: error instanceof Error ? error.message : "The provider result is unknown.",
      };
    }
    return { delivery, result };
  })));
  await persistAttemptResults(db, campaign, results);
  return refreshCampaignCounts(db, campaign);
}

export async function listPublicationEmailCampaigns(db: Db, context: PublicationContext) {
  await ensurePublicationEmailIndexes(db);
  return db.collection<PublicationEmailCampaign>(COLLECTIONS.publicationEmailCampaigns)
    .find(publicationScopedFilter(context))
    .sort({ created_at: -1, _id: -1 })
    .limit(50)
    .toArray();
}
