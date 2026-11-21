import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  publicationEmailHash,
  publicationEmailToken,
  type PublicationEmailSubscription,
} from "../../email/subscriptions";
import { COLLECTIONS } from "../../storage/mongo";

const deps = vi.hoisted(() => ({
  loadReaderPublication: vi.fn(),
  readerDatabase: vi.fn(),
  directoryTown: vi.fn(),
  saveInterestSignup: vi.fn(),
  readerMongoClient: vi.fn(),
}));
vi.mock("../../../../reader-site/src/lib/reader-data", () => deps);

import { POST as signupPost } from "../../../../reader-site/src/pages/api/publications/[publication_id]/email";
import { POST as preferencesPost } from "../../../../reader-site/src/pages/api/email/preferences";
import { POST as unsubscribePost } from "../../../../reader-site/src/pages/api/email/unsubscribe";
import { POST as interestPost } from "../../../../reader-site/src/pages/api/locations/[location_id]/interest";
import { POST as marketingPost } from "../../../../reader-site/src/pages/api/campaign-signups";

const origin = "http://127.0.0.1:4321";
const base = `${origin}/reader`;
const publicationId = "publication-routes";
let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("publication-email-routes");
});
beforeEach(async () => {
  await db.dropDatabase();
  vi.clearAllMocks();
  deps.readerDatabase.mockResolvedValue(db);
  deps.readerMongoClient.mockResolvedValue({ client, databaseName: db.databaseName });
  deps.directoryTown.mockResolvedValue({ id: "north-wa", name: "North, WA" });
  deps.loadReaderPublication.mockResolvedValue({
    release: {
      release_id: "release-1",
      publication: { id: publicationId, display_name: "Independent Weekly" },
      locations: [{ id: "north-wa", name: "North, WA" }, { id: "south-wa", name: "South, WA" }],
    },
    entry: { withdrawn: false },
  });
  vi.stubEnv("AUTH_SECRET", "publication-route-secret-with-at-least-32-characters");
  vi.stubEnv("NEWSBEE_MODE", "local");
  vi.stubEnv("NEWSBEE_EMAIL_PROVIDER", "fake");
  vi.stubEnv("NEWSBEE_READER_SITE_URL", base);
  vi.stubEnv("NEWSBEE_NEWSLETTER_PROVIDER", "local");
  vi.stubEnv("NEWSBEE_NEWSLETTER_SECRET", "community-secret-with-at-least-32-characters");
  vi.stubEnv("NEWSBEE_NEWSLETTER_PUBLIC_URL", base);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await client?.close(); await server?.stop(); });

const context = (request: Request, params: Record<string, string> = {}) => ({
  request, url: new URL(request.url), params,
});
const jsonRequest = (url: string, body: unknown, requestOrigin = origin) => new Request(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: requestOrigin },
  body: JSON.stringify(body),
});
async function historical(status: PublicationEmailSubscription["status"]) {
  const sub: PublicationEmailSubscription = {
    _id: randomUUID(), publication_id: publicationId, publication_name: "Independent Weekly",
    email: `${status}@example.test`, email_hash: publicationEmailHash(`${status}@example.test`),
    status, location_ids: ["north-wa"], consent_id: `consent-${status}`,
    consent_version: "publication-email-v1", token_version: 1, created_at: 1, updated_at: 1,
  };
  await db.collection<PublicationEmailSubscription>(COLLECTIONS.publicationEmailSubscriptions).insertOne(sub);
  await db.collection(COLLECTIONS.publicationEmailConsents).insertOne({ _id: sub.consent_id, evidence: "historical" });
  return sub;
}

describe("publication email unavailable boundaries", () => {
  it("rejects signup and confirmation before DB access without changing historical consent", async () => {
    const sub = await historical("pending");
    const signupUrl = `${base}/api/publications/${publicationId}/email`;
    const body = { email: "reader@example.test", consent: true, release_id: "release-1", location_ids: ["north-wa"] };
    expect((await signupPost(context(jsonRequest(signupUrl, body, "https://other.example.test")) as never)).status).toBe(403);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await signupPost(context(jsonRequest(signupUrl, body)) as never);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ detail: expect.stringContaining("has not launched") });
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    const confirmation = await preferencesPost(context(jsonRequest(`${base}/api/email/preferences`, {
      token: "historical-confirmation-token", action: "confirm",
    })) as never);
    expect(confirmation.status).toBe(503);
    expect(deps.readerDatabase).not.toHaveBeenCalled();
    expect(deps.loadReaderPublication).not.toHaveBeenCalled();
    expect(await db.collection(COLLECTIONS.publicationEmailSubscriptions).findOne({ _id: sub._id })).toEqual(sub);
    expect(await db.collection(COLLECTIONS.publicationEmailSubscriptions).countDocuments()).toBe(1);
    expect(await db.collection(COLLECTIONS.publicationEmailConsents).countDocuments()).toBe(1);
    for (const name of [COLLECTIONS.publicationEmailLimits, COLLECTIONS.publicationEmailOutbox, COLLECTIONS.publicationEmailCampaigns]) {
      expect(await db.collection(name).countDocuments()).toBe(0);
    }
  });

  it("keeps signed preferences and unsubscribe usable without activating any historical status", async () => {
    for (const status of ["pending", "active", "unsubscribed", "suppressed"] as const) {
      const sub = await historical(status);
      const token = publicationEmailToken(sub);
      const response = await preferencesPost(context(jsonRequest(`${base}/api/email/preferences`, {
        token, action: "preferences", location_ids: ["south-wa"],
      })) as never);
      expect(response.status).toBe(200);
      expect(await db.collection(COLLECTIONS.publicationEmailSubscriptions).findOne({ _id: sub._id }))
        .toMatchObject({ status, location_ids: ["south-wa"] });
      const unsubscribe = await unsubscribePost(context(jsonRequest(`${base}/api/email/unsubscribe`, { token })) as never);
      expect(unsubscribe.status).toBe(200);
      expect(await db.collection(COLLECTIONS.publicationEmailSubscriptions).findOne({ _id: sub._id }))
        .toMatchObject({ status: "unsubscribed" });
    }
    expect(await db.collection(COLLECTIONS.publicationEmailConsents).countDocuments()).toBe(4);
    expect(await db.collection(COLLECTIONS.publicationEmailOutbox).countDocuments()).toBe(0);
  });

  it("keeps community preferences and marketing lead capture working without mail", async () => {
    const community = await interestPost(context(jsonRequest(`${base}/api/locations/north-wa/interest`, {
      email: "reader@example.test", consent: true, topics: ["events"],
    }), { location_id: "north-wa" }) as never);
    expect(community.status).toBe(200);
    expect(await community.json()).toMatchObject({ status: "saved", confirmation_required: false });
    expect(deps.saveInterestSignup).toHaveBeenCalledWith(
      { id: "north-wa", name: "North, WA" }, "reader@example.test", false,
    );
    expect(await db.collection("reader_newsletter_subscriptions").findOne({ email: "reader@example.test" }))
      .toMatchObject({ status: "pending", pending: { topics: ["events"] } });
    const marketing = await marketingPost(context(jsonRequest(`${base}/api/campaign-signups`, {
      campaign: "newsroom", email: "lead@example.test", context: "City desk",
      role: "Independent journalist", interest: "Organizing sources and drafts",
    })) as never);
    expect(marketing.status).toBe(200);
    expect(await marketing.json()).toEqual({ created: true });
    expect(await db.collection("campaign_signups").countDocuments()).toBe(1);
    expect(await db.collection(COLLECTIONS.publicationEmailSubscriptions).countDocuments()).toBe(0);
    expect(await db.collection("reader_newsletter_mail").countDocuments()).toBe(0);
    expect(await db.collection("reader_newsletter_preview_mail").countDocuments()).toBe(0);
  });
});
