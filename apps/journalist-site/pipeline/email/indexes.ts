import type { Db } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";

const pending = new WeakMap<object, Map<string, Promise<void>>>();

export async function ensurePublicationEmailIndexes(db: Db, force = false) {
  const client = db.client;
  let databases = pending.get(client);
  if (!databases) {
    databases = new Map();
    pending.set(client, databases);
  }
  if (force) databases.delete(db.databaseName);
  let promise = databases.get(db.databaseName);
  if (!promise) {
    promise = Promise.all([
      db.collection(COLLECTIONS.publicationEmailSubscriptions).createIndexes([
        { key: { publication_id: 1, email_hash: 1 }, unique: true, name: "publication_email_identity" },
        { key: { publication_id: 1, status: 1, location_ids: 1, updated_at: -1 }, name: "publication_email_active_locations" },
        { key: { publication_id: 1, status: 1, confirmed_at: 1, location_ids: 1 }, name: "publication_email_confirmed_active_locations" },
      ]),
      db.collection(COLLECTIONS.publicationEmailLimits).createIndexes([
        { key: { expires_at: 1 }, expireAfterSeconds: 0, name: "publication_email_limits_expiry" },
      ]),
      db.collection(COLLECTIONS.publicationEmailConsents).createIndexes([
        { key: { publication_id: 1, subscription_id: 1, consented_at: -1 }, name: "publication_email_consent_history" },
      ]),
      db.collection(COLLECTIONS.publicationEmailSuppressions).createIndexes([
        { key: { publication_id: 1, email_hash: 1 }, unique: true, name: "publication_email_suppression_identity" },
        { key: { publication_id: 1, reason: 1, updated_at: -1 }, name: "publication_email_suppressions_recent" },
      ]),
      db.collection(COLLECTIONS.publicationEmailEvents).createIndexes([
        { key: { provider: 1, provider_event_id: 1 }, unique: true, sparse: true, name: "publication_email_provider_event_identity" },
        { key: { publication_id: 1, email_hash: 1, at: -1 }, name: "publication_email_event_history" },
      ]),
      db.collection(COLLECTIONS.publicationEmailCampaigns).createIndexes([
        {
          key: { publication_id: 1, release_id: 1, mode: 1 },
          unique: true,
          partialFilterExpression: { mode: "release" },
          name: "publication_email_release_campaign",
        },
        { key: { publication_id: 1, created_at: -1, _id: -1 }, name: "publication_email_campaigns_recent" },
      ]),
      db.collection(COLLECTIONS.publicationEmailDeliveries).createIndexes([
        { key: { campaign_id: 1, recipient_id: 1 }, unique: true, name: "publication_email_campaign_recipient" },
        { key: { provider: 1, idempotency_key: 1 }, unique: true, name: "publication_email_delivery_idempotency" },
        { key: { campaign_id: 1, status: 1, available_at: 1, created_at: 1 }, name: "publication_email_delivery_ready" },
        { key: { status: 1, lease_until: 1 }, name: "publication_email_delivery_leases" },
      ]),
      db.collection(COLLECTIONS.publicationEmailAttempts).createIndexes([
        { key: { delivery_id: 1, attempt: 1 }, unique: true, name: "publication_email_attempt_identity" },
        { key: { campaign_id: 1, created_at: -1 }, name: "publication_email_attempts_recent" },
        { key: { campaign_id: 1, applied_at: 1, created_at: 1 }, name: "publication_email_attempts_unapplied" },
      ]),
      db.collection(COLLECTIONS.publicationEmailOutbox).createIndexes([
        { key: { idempotency_key: 1 }, unique: true, name: "publication_email_outbox_idempotency" },
        { key: { publication_id: 1, created_at: -1 }, name: "publication_email_outbox_recent" },
      ]),
    ]).then(() => undefined).catch((error: unknown) => {
      databases!.delete(db.databaseName);
      throw error;
    });
    databases.set(db.databaseName, promise);
  }
  await promise;
}
