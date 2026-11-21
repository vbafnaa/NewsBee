import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  publicationContentHash,
  type PublicationReleasePayloadV1,
} from "../../../../../shared/publication-release";
import type { Edition } from "../../../../reader-site/src/lib/reader-data";
import {
  dispatchNewsletters,
  newsletterLink,
  requestNewsletter,
  updateNewsletter,
  validateNewsletterSignup,
  type NewsletterConfig,
  type Subscription as ReaderNewsletterSubscription,
} from "../../../../reader-site/src/lib/newsletter";
import {
  createPublicationEmailCampaign,
  processPublicationEmailCampaign,
} from "../../email/campaigns";
import { ensurePublicationEmailIndexes } from "../../email/indexes";
import type { EmailProvider } from "../../email/provider";
import {
  confirmPublicationEmail,
  publicationEmailSubscriptionForConfirmationToken,
  recordPublicationEmailConsent,
  suppressPublicationEmail,
  unsubscribePublicationEmail,
} from "../../email/subscriptions";
import type { PublicationContext } from "../../publications/access";
import {
  loadPublicationReleaseForDistribution,
  PublicationReleaseConflict,
} from "../../publications/releases";
import { COLLECTIONS } from "../../storage/mongo";
import {
  ensureVideoProductionIndexes,
  generateReleaseVideoPackage,
  newReleaseVideoJob,
  ReleaseVideoPackageConflict,
  releaseVideoCacheIdentity,
  releaseVideoManagement,
  saveReleaseVideoPackage,
  type ReleaseVideoScope,
} from "../../video-production";
import { FakeModel } from "../support/fake-model";

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

const publicationId = "publication-distribution";
const context: PublicationContext = {
  id: publicationId,
  ownerId: "owner",
  principalId: "owner",
  role: "owner",
  publication: {
    _id: publicationId,
    owner_id: "owner",
    name: "Independent Weekly",
    selected_location_ids: ["north-wa", "south-wa"],
  },
};

function release(releaseId = "release-1"): PublicationReleasePayloadV1 {
  return {
    schema_version: 1,
    draft_id: "draft-1",
    draft_revision: 4,
    release_id: releaseId,
    title: "Independent Weekly",
    intro: "Two communities, one immutable edition.",
    window_start: "2026-11-09",
    window_end: "2026-11-15",
    locations: [
      { id: "north-wa", name: "North, WA" },
      { id: "south-wa", name: "South, WA" },
    ],
    sections: [{ id: "government", title: "Government" }],
    items: [{
      item_id: "story-1",
      story_id: "story-1",
      origin: "generated",
      source_references: [{ location_id: "north-wa", edition_id: "edition-1", story_id: "source-story" }],
      location_ids: ["north-wa", "south-wa"],
      location_names: ["North, WA", "South, WA"],
      section_id: "government",
      section_title: "Government",
      headline: "Council adopts a park plan",
      blurb: "The council adopted a park plan after public testimony.",
      byline: "",
      when_where: "Nov. 10 at City Hall",
      event_date: "2026-11-10",
      source_url: "https://civic.example.test/park",
      sources: [{ name: "Council agenda", url: "https://civic.example.test/park" }],
      rank: 1,
      kind: "local_news",
    }],
    correction: null,
    publication: {
      id: publicationId,
      profile_revision: 2,
      display_name: "Independent Weekly",
      description: "Independent reporting.",
      homepage_url: "https://weekly.example.test/",
      logo_url: null,
    },
    sponsor_placements: { revision: 1, placements: [] },
    approval: {
      draft_revision: 4,
      draft_content_hash: "a".repeat(64),
      approved_by: { id: "owner", email: "owner@example.test" },
      approved_at: 1_762_800_000,
    },
    published_by: { id: "owner", email: "owner@example.test" },
    published_at: 1_762_800_100,
  };
}

async function consent(email: string, locationIds = ["north-wa"]) {
  const requested = await recordPublicationEmailConsent(db, {
    publicationId,
    publicationName: "Independent Weekly",
    releaseId: "release-1",
    email,
    locationIds,
    allowedLocationIds: ["north-wa", "south-wa"],
    consent: true,
    consentText: "I agree to receive email editions from Independent Weekly for the selected locations. I can unsubscribe at any time.",
  });
  const confirmed = await confirmPublicationEmail(db, requested.confirmationToken);
  return { ...requested, subscription: confirmed.subscription, token: confirmed.token };
}

async function persistRelease(payload = release()) {
  await db.collection(COLLECTIONS.publicationDrafts).replaceOne(
    { _id: payload.draft_id },
    {
      _id: payload.draft_id,
      publication_id: publicationId,
      editorial_status: "published",
      release: {
        release_id: payload.release_id,
        content_hash: publicationContentHash(payload),
        payload,
      },
    },
    { upsert: true },
  );
  return payload;
}

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("publication-distribution");
});

beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", "distribution-test-secret-with-enough-entropy");
  vi.stubEnv("NEWSBEE_MODE", "local");
  vi.stubEnv("NEWSBEE_EMAIL_PROVIDER", "fake");
  vi.stubEnv("NEWSBEE_READER_SITE_URL", "https://reader.example.test/reader");
  await db.dropDatabase();
  await db.collection(COLLECTIONS.outputChannels).insertOne(context.publication);
  await ensurePublicationEmailIndexes(db, true);
  await ensureVideoProductionIndexes(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

describe("publication email distribution", () => {
  it("preserves legacy subscription history while excluding unconfirmed addresses from delivery", async () => {
    await db.collection(COLLECTIONS.publicationEmailSubscriptions).insertOne({
      _id: "legacy-unconfirmed",
      publication_id: publicationId,
      publication_name: "Independent Weekly",
      email: "legacy@example.test",
      email_hash: "legacy-hash",
      status: "active",
      location_ids: ["north-wa"],
      consent_id: "legacy-consent",
      consent_version: "publication-email-v1",
      token_version: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    await ensurePublicationEmailIndexes(db, true);
    expect(await db.collection(COLLECTIONS.publicationEmailSubscriptions)
      .findOne({ _id: "legacy-unconfirmed" })).toMatchObject({ status: "active", location_ids: ["north-wa"] });
    const payload = release();
    const campaign = await createPublicationEmailCampaign(db, context, {
      payload,
      contentHash: publicationContentHash(payload),
    }, { mode: "release", createdBy: "owner" });
    expect(campaign.recipient_count).toBe(0);
  });

  it("keeps publication delivery pending until the signed confirmation is applied", async () => {
    const requested = await recordPublicationEmailConsent(db, {
      publicationId,
      publicationName: "Independent Weekly",
      releaseId: "release-1",
      email: "pending@example.test",
      locationIds: ["north-wa"],
      allowedLocationIds: ["north-wa", "south-wa"],
      consent: true,
      consentText: "I agree to receive publication email.",
    });
    expect(requested.subscription).toMatchObject({
      status: "pending",
      location_ids: [],
      pending_confirmation: { location_ids: ["north-wa"], source_release_id: "release-1" },
    });
    expect(requested.confirmationSent).toBe(true);
    expect(await db.collection(COLLECTIONS.publicationEmailConsents).countDocuments()).toBe(0);
    await expect(publicationEmailSubscriptionForConfirmationToken(db, `${requested.confirmationToken}0`))
      .rejects.toThrow(/invalid/i);

    const confirmed = await confirmPublicationEmail(db, requested.confirmationToken);
    expect(confirmed.subscription).toMatchObject({
      status: "active",
      location_ids: ["north-wa"],
      confirmed_at: expect.any(Number),
    });
    expect(confirmed.subscription.pending_confirmation).toBeUndefined();
    expect(await db.collection(COLLECTIONS.publicationEmailConsents).countDocuments()).toBe(1);
    await expect(confirmPublicationEmail(db, requested.confirmationToken)).resolves.toMatchObject({
      subscription: { status: "active", location_ids: ["north-wa"] },
    });
  });

  it("does not let an unauthenticated repeat request replace active publication preferences", async () => {
    const active = await consent("preferences@example.test", ["north-wa"]);
    const requested = await recordPublicationEmailConsent(db, {
      publicationId,
      publicationName: "Independent Weekly",
      releaseId: "release-1",
      email: "preferences@example.test",
      locationIds: ["south-wa"],
      allowedLocationIds: ["north-wa", "south-wa"],
      consent: true,
      consentText: "I agree to receive publication email.",
    }, { now: Date.now() + 61_000 });
    expect(requested.subscription).toMatchObject({
      status: "active",
      location_ids: ["north-wa"],
      pending_confirmation: { location_ids: ["south-wa"] },
    });
    expect(active.subscription.location_ids).toEqual(["north-wa"]);
    const confirmed = await confirmPublicationEmail(db, requested.confirmationToken, Date.now() + 62_000);
    expect(confirmed.subscription.location_ids).toEqual(["south-wa"]);
  });

  it("revokes a pending confirmation when the publication subscription is unsubscribed", async () => {
    const active = await consent("pending-unsubscribe@example.test", ["north-wa"]);
    const requested = await recordPublicationEmailConsent(db, {
      publicationId,
      publicationName: "Independent Weekly",
      releaseId: "release-1",
      email: "pending-unsubscribe@example.test",
      locationIds: ["south-wa"],
      allowedLocationIds: ["north-wa", "south-wa"],
      consent: true,
      consentText: "I agree to receive publication email.",
    }, { now: Date.now() + 61_000 });
    await unsubscribePublicationEmail(db, active.token);
    await expect(confirmPublicationEmail(db, requested.confirmationToken, Date.now() + 62_000))
      .rejects.toThrow(/no longer available|invalid/i);
    expect(await db.collection(COLLECTIONS.publicationEmailSubscriptions)
      .findOne({ _id: active.subscription._id })).toMatchObject({
      status: "unsubscribed",
      location_ids: ["north-wa"],
    });
  });

  it("keeps explicit publication consent separate from existing reader interest signups", async () => {
    await db.collection("reader_interest_signups").insertOne({
      location_id: "north-wa",
      email: "reader@example.test",
      weekly_editions: true,
      consent_version: "weekly-editions-v2",
    });
    const saved = await consent("Reader@Example.test", ["north-wa", "south-wa"]);
    expect(saved.subscription).toMatchObject({
      publication_id: publicationId,
      email: "reader@example.test",
      location_ids: ["north-wa", "south-wa"],
      consent_version: "publication-email-v1",
    });
    expect(await db.collection("reader_interest_signups").countDocuments()).toBe(1);
    expect(await db.collection(COLLECTIONS.publicationEmailConsents).countDocuments()).toBe(1);
  });

  it("keeps community and publication artifacts disjoint for the same confirmed address", async () => {
    const email = "both-audiences@example.test";
    const communityConfig: NewsletterConfig = {
      provider: "local",
      from: "Newsbee <preview@newsbee.test>",
      publicUrl: "http://127.0.0.1:4321/reader",
      secret: "community-newsletter-secret-at-least-32-characters",
      apiKey: "",
    };
    const location = { id: "north-wa", name: "North, WA" };
    const communityRequest = await requestNewsletter(
      db,
      location,
      validateNewsletterSignup({ email, consent: true, topics: [] }),
      null,
    );
    const communityPending = (await db.collection<ReaderNewsletterSubscription>("reader_newsletter_subscriptions")
      .findOne({ _id: communityRequest.id }))!;
    const communityToken = new URL(newsletterLink(communityConfig, communityPending, "confirm")).searchParams.get("token")!;
    await updateNewsletter(db, communityConfig, communityPending._id, communityToken, "confirm");
    await consent(email, ["north-wa"]);

    const sentCommunity: string[] = [];
    const legacyEdition: Edition = {
      id: "community-edition",
      location_id: "north-wa",
      location_name: "North, WA",
      published_at: Date.now() / 1000 - 20,
      headline: "North community edition",
      intro: "",
      window_start: "2026-11-09",
      window_end: "2026-11-15",
      items: [{
        story_id: "community-story",
        headline: "Community council update",
        blurb: "A legacy community edition story.",
        source_url: "https://community.example.test/story",
      }],
    };
    const publicationShapedEdition: Edition = {
      ...legacyEdition,
      id: "publication-release-as-edition",
      publication_release: true,
      published_at: Date.now() / 1000 - 10,
      headline: "Must not enter the community queue",
    };
    await dispatchNewsletters(
      db,
      communityConfig,
      { locations: [location], editions: [legacyEdition, publicationShapedEdition] },
      new Date(),
      async (envelope) => {
        sentCommunity.push(envelope.subject);
        return "community-receipt";
      },
    );

    const payload = await persistRelease();
    const campaign = await createPublicationEmailCampaign(db, context, {
      payload,
      contentHash: publicationContentHash(payload),
    }, { mode: "release", createdBy: "owner" });
    await processPublicationEmailCampaign(db, context, campaign._id);

    expect(sentCommunity).toEqual(["North, WA this week | Newsbee"]);
    expect(await db.collection("reader_newsletter_mail").countDocuments({
      editionId: "publication-release-as-edition",
    })).toBe(0);
    expect(await db.collection(COLLECTIONS.publicationEmailDeliveries).countDocuments({
      campaign_id: campaign._id,
      email,
    })).toBe(1);
    expect(await db.collection(COLLECTIONS.publicationEmailOutbox).countDocuments({
      campaignId: campaign._id,
      to: email,
    })).toBe(1);
  });

  it("isolates unsubscribe state across community and publication audiences", async () => {
    const email = "isolated@example.test";
    const communityConfig: NewsletterConfig = {
      provider: "local",
      from: "Newsbee <preview@newsbee.test>",
      publicUrl: "http://127.0.0.1:4321/reader",
      secret: "community-newsletter-secret-at-least-32-characters",
      apiKey: "",
    };
    const location = { id: "north-wa", name: "North, WA" };
    const communityRequest = await requestNewsletter(
      db,
      location,
      validateNewsletterSignup({ email, consent: true, topics: [] }),
      null,
    );
    const communityPending = (await db.collection<ReaderNewsletterSubscription>("reader_newsletter_subscriptions")
      .findOne({ _id: communityRequest.id }))!;
    await updateNewsletter(
      db,
      communityConfig,
      communityPending._id,
      new URL(newsletterLink(communityConfig, communityPending, "confirm")).searchParams.get("token")!,
      "confirm",
    );
    const first = await consent(email);
    const secondRequest = await recordPublicationEmailConsent(db, {
      publicationId: "other-publication",
      publicationName: "Other Publication",
      releaseId: "other-release",
      email,
      locationIds: ["north-wa"],
      allowedLocationIds: ["north-wa"],
      consent: true,
      consentText: "I agree to receive Other Publication by email.",
    });
    const second = await confirmPublicationEmail(db, secondRequest.confirmationToken);

    await unsubscribePublicationEmail(db, first.token);

    expect(await db.collection<ReaderNewsletterSubscription>("reader_newsletter_subscriptions")
      .findOne({ _id: communityPending._id })).toMatchObject({ status: "active" });
    expect(await db.collection(COLLECTIONS.publicationEmailSubscriptions)
      .findOne({ _id: first.subscription._id })).toMatchObject({ status: "unsubscribed" });
    expect(await db.collection(COLLECTIONS.publicationEmailSubscriptions)
      .findOne({ _id: second.subscription._id })).toMatchObject({ status: "active", publication_id: "other-publication" });
  });

  it("freezes recipient preferences and rendered content when a campaign snapshot is created", async () => {
    const saved = await consent("snapshot@example.test", ["north-wa"]);
    const payload = release();
    const campaign = await createPublicationEmailCampaign(db, context, {
      payload,
      contentHash: publicationContentHash(payload),
    }, { mode: "release", createdBy: "owner" });
    await db.collection(COLLECTIONS.publicationEmailSubscriptions).updateOne(
      { _id: saved.subscription._id },
      { $set: { location_ids: ["south-wa"], email: "changed@example.test" } },
    );
    const delivery = await db.collection(COLLECTIONS.publicationEmailDeliveries).findOne({ campaign_id: campaign._id });
    expect(delivery).toMatchObject({
      email: "snapshot@example.test",
      location_ids: ["north-wa"],
    });
    expect(campaign.content.subject).toBe("Independent Weekly");
    expect(campaign.release_hash).toBe(publicationContentHash(payload));
  });

  it("excludes suppressed recipients before snapshotting and records fake-provider delivery idempotently", async () => {
    await consent("included@example.test");
    await consent("suppressed@example.test");
    await suppressPublicationEmail(db, {
      publicationId,
      email: "suppressed@example.test",
      reason: "complaint",
      source: "test",
      provider: "fake",
      providerEventId: "complaint-1",
    });
    const payload = await persistRelease();
    const campaign = await createPublicationEmailCampaign(db, context, {
      payload,
      contentHash: publicationContentHash(payload),
    }, { mode: "release", createdBy: "owner" });
    expect(campaign.recipient_count).toBe(1);
    const first = await processPublicationEmailCampaign(db, context, campaign._id);
    expect(first.counts).toEqual({ accepted: 1 });
    const second = await processPublicationEmailCampaign(db, context, campaign._id);
    expect(second.counts).toEqual({ accepted: 1 });
    expect(await db.collection(COLLECTIONS.publicationEmailOutbox).countDocuments({ campaignId: campaign._id })).toBe(1);
    expect(await db.collection(COLLECTIONS.publicationEmailAttempts).countDocuments()).toBe(1);
  });

  it("does not normally retry unknown outcomes and explicitly reuses their original idempotency key", async () => {
    await consent("accepted@example.test");
    await consent("unknown@example.test");
    const calls: Array<{ to: string; key: string }> = [];
    const attempts = new Map<string, number>();
    const provider: EmailProvider = {
      name: "scripted",
      async send(message) {
        calls.push({ to: message.to, key: message.idempotencyKey });
        const count = (attempts.get(message.to) ?? 0) + 1;
        attempts.set(message.to, count);
        if (message.to === "unknown@example.test" && count === 1) {
          return { status: "unknown", detail: "ambiguous timeout" };
        }
        return { status: "accepted", providerMessageId: `${message.to}:${count}` };
      },
    };
    const payload = await persistRelease();
    const campaign = await createPublicationEmailCampaign(db, context, {
      payload,
      contentHash: publicationContentHash(payload),
    }, { mode: "release", createdBy: "owner", provider });
    const partial = await processPublicationEmailCampaign(db, context, campaign._id, { provider });
    expect(partial.counts).toEqual({ accepted: 1, unknown: 1 });
    const beforeNormalRetry = calls.length;
    await processPublicationEmailCampaign(db, context, campaign._id, { provider });
    expect(calls).toHaveLength(beforeNormalRetry);
    const unknownFirst = calls.find((call) => call.to === "unknown@example.test")!;
    const retried = await processPublicationEmailCampaign(db, context, campaign._id, { provider, includeUnknown: true });
    expect(retried.counts).toEqual({ accepted: 2 });
    const unknownCalls = calls.filter((call) => call.to === "unknown@example.test");
    expect(unknownCalls).toHaveLength(2);
    expect(unknownCalls[1].key).toBe(unknownFirst.key);
  });

  it("suppresses queued recipients when consent changes after snapshotting", async () => {
    await consent("late-suppression@example.test");
    const rechecked = await consent("rechecked-suppression@example.test");
    const payload = await persistRelease();
    const calls: string[] = [];
    const provider: EmailProvider = {
      name: "late-suppression",
      async send(message) {
        calls.push(message.to);
        return { status: "accepted" };
      },
    };
    const campaign = await createPublicationEmailCampaign(db, context, {
      payload,
      contentHash: publicationContentHash(payload),
    }, { mode: "release", createdBy: "owner", provider });
    await suppressPublicationEmail(db, {
      publicationId,
      email: "late-suppression@example.test",
      reason: "unsubscribe",
      source: "reader",
    });
    await db.collection(COLLECTIONS.publicationEmailSuppressions).insertOne({
      _id: "direct-suppression",
      publication_id: publicationId,
      email_hash: rechecked.subscription.email_hash,
      email: rechecked.subscription.email,
      reason: "manual",
      source: "operator",
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const result = await processPublicationEmailCampaign(db, context, campaign._id, { provider });
    expect(result.counts).toEqual({ suppressed: 2 });
    expect(calls).toEqual([]);
  });

  it("blocks an existing campaign when its release is withdrawn after snapshotting", async () => {
    await consent("withdrawn@example.test");
    const payload = await persistRelease();
    const campaign = await createPublicationEmailCampaign(db, context, {
      payload,
      contentHash: publicationContentHash(payload),
    }, { mode: "release", createdBy: "owner" });
    await db.collection(COLLECTIONS.publicationReleaseActions).insertOne({
      _id: "campaign-withdrawal",
      publication_id: publicationId,
      release_id: payload.release_id,
      action: "withdraw",
      reason: "Correction required",
      at: Date.now(),
      by: { id: "owner", email: "owner@example.test" },
    });
    await expect(processPublicationEmailCampaign(db, context, campaign._id))
      .rejects.toBeInstanceOf(PublicationReleaseConflict);
    expect(await db.collection(COLLECTIONS.publicationEmailCampaigns).findOne({ _id: campaign._id }))
      .toMatchObject({ state: "blocked", counts: { cancelled: 1 } });
  });

  it("blocks an existing campaign when a source story is withdrawn after snapshotting", async () => {
    await consent("source-withdrawn@example.test");
    const payload = await persistRelease();
    const campaign = await createPublicationEmailCampaign(db, context, {
      payload,
      contentHash: publicationContentHash(payload),
    }, { mode: "release", createdBy: "owner" });
    await db.collection(COLLECTIONS.publicationReleaseActions).insertOne({
      _id: "campaign-source-withdrawal",
      publication_id: publicationId,
      release_id: payload.release_id,
      action: "source_withdrawal",
      reason: "Source story removed",
      source: { location_id: "north-wa", story_id: "source-story" },
      at: Date.now(),
      by: { id: "owner", email: "owner@example.test" },
    });
    await expect(processPublicationEmailCampaign(db, context, campaign._id))
      .rejects.toBeInstanceOf(PublicationReleaseConflict);
    expect(await db.collection(COLLECTIONS.publicationEmailCampaigns).findOne({ _id: campaign._id }))
      .toMatchObject({ state: "blocked", counts: { cancelled: 1 } });
  });

  it("never downgrades or clears permanent suppression through unsubscribe or later consent", async () => {
    await consent("permanent@example.test");
    await suppressPublicationEmail(db, {
      publicationId,
      email: "permanent@example.test",
      reason: "complaint",
      source: "provider",
      provider: "fake",
      providerEventId: "complaint-permanent",
    });
    await suppressPublicationEmail(db, {
      publicationId,
      email: "permanent@example.test",
      reason: "unsubscribe",
      source: "reader",
    });
    const renewed = await consent("permanent@example.test");
    expect(await db.collection(COLLECTIONS.publicationEmailSuppressions).findOne({
      publication_id: publicationId,
      email: "permanent@example.test",
    })).toMatchObject({ reason: "complaint", source: "provider" });
    expect(renewed.subscription.status).toBe("suppressed");
    expect(await db.collection(COLLECTIONS.publicationEmailEvents).countDocuments({
      publication_id: publicationId,
      email_hash: renewed.subscription.email_hash,
    })).toBe(2);
  });

  it("recovers unapplied attempt evidence before claiming another delivery attempt", async () => {
    await consent("attempt-recovery@example.test");
    const payload = await persistRelease();
    const calls: string[] = [];
    const provider: EmailProvider = {
      name: "attempt-recovery",
      async send(message) {
        calls.push(message.to);
        return { status: "accepted" };
      },
    };
    const campaign = await createPublicationEmailCampaign(db, context, {
      payload,
      contentHash: publicationContentHash(payload),
    }, { mode: "release", createdBy: "owner", provider });
    const delivery = await db.collection(COLLECTIONS.publicationEmailDeliveries)
      .findOne({ campaign_id: campaign._id });
    await db.collection(COLLECTIONS.publicationEmailDeliveries).updateOne(
      { _id: delivery!._id },
      {
        $set: {
          status: "sending",
          attempts_count: 1,
          claim_token: "interrupted",
          lease_until: Date.now() + 60_000,
        },
      },
    );
    await db.collection(COLLECTIONS.publicationEmailAttempts).insertOne({
      _id: "attempt-recovery-evidence",
      publication_id: publicationId,
      campaign_id: campaign._id,
      delivery_id: delivery!._id,
      attempt: 1,
      idempotency_key: delivery!.idempotency_key,
      provider: provider.name,
      result: { status: "accepted", providerMessageId: "accepted-before-crash" },
      created_at: Date.now(),
      applied_at: null,
    });
    await db.collection(COLLECTIONS.publicationEmailCampaigns).updateOne(
      { _id: campaign._id },
      { $set: { state: "blocked", blocked_reason: "Release withdrawn during attempt persistence." } },
    );
    await expect(processPublicationEmailCampaign(db, context, campaign._id, { provider }))
      .rejects.toBeInstanceOf(PublicationReleaseConflict);
    expect(calls).toEqual([]);
    expect(await db.collection(COLLECTIONS.publicationEmailDeliveries).findOne({ _id: delivery!._id }))
      .toMatchObject({ status: "accepted", last_attempt_id: "attempt-recovery-evidence" });
    expect(await db.collection(COLLECTIONS.publicationEmailAttempts).findOne({ _id: "attempt-recovery-evidence" }))
      .toMatchObject({ applied_at: expect.any(Number) });
  });
});

describe("immutable release distribution boundaries", () => {
  it("loads only intact active releases and blocks withdrawals and source withdrawals", async () => {
    const payload = await persistRelease();
    expect((await loadPublicationReleaseForDistribution(db, context, payload.release_id)).payload.title).toBe(payload.title);
    await db.collection(COLLECTIONS.publicationReleaseActions).insertOne({
      _id: "withdraw",
      publication_id: publicationId,
      release_id: payload.release_id,
      action: "withdraw",
      reason: "Correction required",
      at: 1,
      by: { id: "owner", email: "owner@example.test" },
    });
    await expect(loadPublicationReleaseForDistribution(db, context, payload.release_id))
      .rejects.toBeInstanceOf(PublicationReleaseConflict);
    await db.collection(COLLECTIONS.publicationReleaseActions).insertMany([{
      _id: "restore",
      publication_id: publicationId,
      release_id: payload.release_id,
      action: "restore",
      reason: "Restored",
      at: 2,
      by: { id: "owner", email: "owner@example.test" },
    }, {
      _id: "source-withdrawal",
      publication_id: publicationId,
      release_id: payload.release_id,
      action: "source_withdrawal",
      reason: "Source removed",
      at: 3,
      by: { id: "owner", email: "owner@example.test" },
      source: { location_id: "north-wa", story_id: "source-story" },
    }]);
    await expect(loadPublicationReleaseForDistribution(db, context, payload.release_id))
      .rejects.toBeInstanceOf(PublicationReleaseConflict);
  });
});

describe("release-scoped video packages", () => {
  it("reuses the exact release/story/template cache and warns when edited packages stale prior output", async () => {
    const payload = release();
    const scope: ReleaseVideoScope = {
      publicationId,
      releaseId: payload.release_id,
      releaseHash: publicationContentHash(payload),
      release: payload,
      item: payload.items[0],
    };
    const generated = {
      youtubeTitle: "Council adopts a park plan",
      youtubeDescription: "Council adopted a park plan. AI-generated presenter.",
      youtubeTags: ["local news"],
      tiktokCaption: "Council adopts a park plan. AI-generated presenter.",
      spokenScript: "In North and South, council members adopted a new park plan after public testimony on November tenth, setting priorities for future improvements while preserving the approved public record for both communities.",
      editorialDirection: "Do not imply that planned improvements are already complete.",
    };
    const model = new FakeModel(() => generated);
    const first = await generateReleaseVideoPackage(db, model, scope, undefined, { revision: 0, packageHash: "" });
    let management = await releaseVideoManagement(db, scope);
    const second = await generateReleaseVideoPackage(db, model, scope, undefined, {
      revision: management.packageRevision,
      packageHash: management.packageHash,
    });
    expect(second).toEqual(first);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].prompt).toContain(`/publications/${publicationId}/releases/${payload.release_id}?story=story-1`);
    const job = { ...newReleaseVideoJob(scope, first), status: "complete" as const };
    await db.collection(COLLECTIONS.videoJobs).insertOne(job);
    const staleExpected = { revision: management.packageRevision, packageHash: management.packageHash };
    await saveReleaseVideoPackage(db, scope, {
      ...first,
      spokenScript: `${first.spokenScript} Updated.`,
    }, undefined, staleExpected);
    await expect(saveReleaseVideoPackage(db, scope, {
      ...first,
      spokenScript: `${first.spokenScript} Conflicting update.`,
    }, undefined, staleExpected)).rejects.toBeInstanceOf(ReleaseVideoPackageConflict);
    management = await releaseVideoManagement(db, scope);
    expect(management.videos[0].stale).toBe(true);
    const concurrent = await Promise.allSettled([
      generateReleaseVideoPackage(db, model, scope, "{{dialogue}}\n{{editorialDirection}}", { revision: 0, packageHash: "" }),
      generateReleaseVideoPackage(db, model, scope, "{{dialogue}}\n{{editorialDirection}}", { revision: 0, packageHash: "" }),
    ]);
    expect(concurrent.some((result) => result.status === "fulfilled")).toBe(true);
    expect(model.calls).toHaveLength(2);
    expect(await db.collection(COLLECTIONS.videoPackages).countDocuments({ publication_id: publicationId })).toBe(2);
  });

  it("takes over an expired package generation lease without duplicating an active claim", async () => {
    const payload = release();
    const scope: ReleaseVideoScope = {
      publicationId,
      releaseId: payload.release_id,
      releaseHash: publicationContentHash(payload),
      release: payload,
      item: payload.items[0],
    };
    const template = "{{dialogue}}\n{{editorialDirection}}\nexpired-lease";
    const identity = releaseVideoCacheIdentity(scope, template);
    await db.collection(COLLECTIONS.videoPackages).insertOne({
      _id: identity.id,
      publication_id: publicationId,
      release_id: payload.release_id,
      release_hash: scope.releaseHash,
      location_id: "north-wa",
      story_id: "story-1",
      story_hash: identity.storyHash,
      template_hash: identity.templateHash,
      cache_hash: identity.cacheHash,
      package_revision: 0,
      package_hash: "",
      generation_claim: {
        token: "interrupted",
        at: Date.now() - 10 * 60_000,
        expires_at: Date.now() - 4 * 60_000,
      },
      updated_at: Date.now() - 10 * 60_000,
    });
    const model = new FakeModel(() => ({
      youtubeTitle: "Recovered package",
      youtubeDescription: "Recovered after an interrupted generation lease.",
      youtubeTags: ["local news"],
      tiktokCaption: "Recovered package",
      spokenScript: "The interrupted package generation lease expired safely, allowing Newsbee to recover this immutable release story without duplicating active work, changing approved facts, or creating a second cached package for journalists.",
      editorialDirection: "Remain factual.",
    }));
    const content = await generateReleaseVideoPackage(db, model, scope, template, { revision: 0, packageHash: "" });
    expect(content.youtubeTitle).toBe("Recovered package");
    expect(model.calls).toHaveLength(1);
    const stored = await db.collection(COLLECTIONS.videoPackages).findOne({ _id: identity.id });
    expect(stored).toMatchObject({ package_revision: 1 });
    expect(stored).not.toHaveProperty("generation_claim");
  });
});
