import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { publicationContentHash, type PublicationReleasePayloadV1 } from "../../../shared/publication-release";
import { createPublicationEmailCampaign, processPublicationEmailCampaign } from "../pipeline/email/campaigns";
import { ensurePublicationEmailIndexes } from "../pipeline/email/indexes";
import { confirmPublicationEmail, recordPublicationEmailConsent, suppressPublicationEmail } from "../pipeline/email/subscriptions";
import type { PublicationContext } from "../pipeline/publications/access";
import { COLLECTIONS } from "../pipeline/storage/mongo";
import {
  ensureVideoProductionIndexes,
  generateReleaseVideoPackage,
  releaseVideoManagement,
  type ReleaseVideoScope,
} from "../pipeline/video-production";
import { FakeModel } from "../pipeline/tests/support/fake-model";

process.env.AUTH_SECRET = "local-distribution-fixture-secret";
process.env.NEWSBEE_MODE = "local";
process.env.NEWSBEE_EMAIL_PROVIDER = "fake";
process.env.NEWSBEE_READER_SITE_URL = "http://127.0.0.1:4321/reader";

const publicationId = "local-distribution-publication";
const release: PublicationReleasePayloadV1 = {
  schema_version: 1,
  draft_id: "local-draft",
  draft_revision: 3,
  release_id: "local-release",
  title: "Local Distribution Weekly",
  intro: "A network-free distribution fixture.",
  window_start: "2026-11-09",
  window_end: "2026-11-15",
  locations: [{ id: "local-wa", name: "Local, WA" }],
  sections: [{ id: "news", title: "News" }],
  items: [{
    item_id: "local-story",
    story_id: "local-story",
    origin: "original",
    source_references: [],
    location_ids: ["local-wa"],
    location_names: ["Local, WA"],
    section_id: "news",
    section_title: "News",
    headline: "Library extends weekend hours",
    blurb: "The public library extended weekend hours after a community survey.",
    byline: "",
    when_where: "Local public library",
    event_date: "2026-11-12",
    source_url: "https://library.example.test/hours",
    sources: [{ name: "Library notice", url: "https://library.example.test/hours" }],
    rank: 1,
    kind: "local_news",
  }],
  correction: null,
  publication: {
    id: publicationId,
    profile_revision: 1,
    display_name: "Local Distribution Weekly",
    description: "Local fixture publication.",
    homepage_url: null,
    logo_url: null,
  },
  sponsor_placements: { revision: 1, placements: [] },
  approval: {
    draft_revision: 3,
    draft_content_hash: "a".repeat(64),
    approved_by: { id: "fixture", email: "fixture@example.test" },
    approved_at: 1_762_800_000,
  },
  published_by: { id: "fixture", email: "fixture@example.test" },
  published_at: 1_762_800_100,
};
const context: PublicationContext = {
  id: publicationId,
  ownerId: "fixture",
  principalId: "fixture",
  role: "owner",
  publication: { _id: publicationId, owner_id: "fixture", name: release.publication.display_name },
};

const server = await MongoMemoryServer.create();
const client = await MongoClient.connect(server.getUri());
try {
  const db = client.db("newsbee-distribution-local");
  await ensurePublicationEmailIndexes(db, true);
  await ensureVideoProductionIndexes(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Network access is disabled in the distribution local journey.");
  };
  try {
    await db.collection<Record<string, unknown> & { _id: string }>(COLLECTIONS.publicationDrafts).insertOne({
      _id: release.draft_id,
      publication_id: publicationId,
      editorial_status: "published",
      release: {
        release_id: release.release_id,
        content_hash: publicationContentHash(release),
        payload: release,
      },
    });
    for (const email of ["delivered@example.test", "suppressed@example.test"]) {
      const requested = await recordPublicationEmailConsent(db, {
        publicationId,
        publicationName: release.publication.display_name,
        releaseId: release.release_id,
        email,
        locationIds: ["local-wa"],
        allowedLocationIds: ["local-wa"],
        consent: true,
        consentText: "I agree to receive email editions from Local Distribution Weekly for the selected locations. I can unsubscribe at any time.",
      });
      await confirmPublicationEmail(db, requested.confirmationToken);
    }
    await suppressPublicationEmail(db, {
      publicationId,
      email: "suppressed@example.test",
      reason: "complaint",
      source: "local_fixture",
      provider: "fake",
      providerEventId: "local-complaint",
    });
    const campaign = await createPublicationEmailCampaign(db, context, {
      payload: release,
      contentHash: publicationContentHash(release),
    }, { mode: "release", createdBy: "fixture" });
    const delivery = await processPublicationEmailCampaign(db, context, campaign._id);
    assert.deepEqual(delivery.counts, { accepted: 1 });
    assert.equal(await db.collection(COLLECTIONS.publicationEmailOutbox).countDocuments({ campaignId: campaign._id }), 1);
    assert.equal(await db.collection(COLLECTIONS.publicationEmailSuppressions).countDocuments(), 1);

    const model = new FakeModel(() => ({
      youtubeTitle: "Library extends weekend hours",
      youtubeDescription: "The library extended weekend hours. AI-generated presenter.",
      youtubeTags: ["library", "local news"],
      tiktokCaption: "Library weekend hours expanded. AI-generated presenter.",
      spokenScript: "In Local, the public library extended its weekend hours after a community survey, giving residents more time to use collections, computers, and public services on Saturdays and Sundays throughout the community.",
      editorialDirection: "Do not imply that weekday hours also changed.",
    }));
    const scope: ReleaseVideoScope = {
      publicationId,
      releaseId: release.release_id,
      releaseHash: publicationContentHash(release),
      release,
      item: release.items[0],
    };
    const first = await generateReleaseVideoPackage(db, model, scope, undefined, { revision: 0, packageHash: "" });
    const management = await releaseVideoManagement(db, scope);
    const repeated = await generateReleaseVideoPackage(db, model, scope, undefined, {
      revision: management.packageRevision,
      packageHash: management.packageHash,
    });
    assert.deepEqual(repeated, first);
    assert.equal(model.calls.length, 1);
    assert.equal(await db.collection(COLLECTIONS.videoPackages).countDocuments({ publication_id: publicationId }), 1);

    console.log(JSON.stringify({
      campaignId: campaign._id,
      fakeOutboxMessages: 1,
      suppressedRecipients: 1,
      videoPackageCacheHits: 1,
      networkCalls: 0,
    }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  await client.close();
  await server.stop();
}
