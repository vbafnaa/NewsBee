import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { releaseVideoStatus } from "@/lib/release-video-usage";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

const mocks = vi.hoisted(() => ({
  desktopVideoCredentials: vi.fn(),
}));

vi.mock("@/pipeline/accounts/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/pipeline/accounts/runtime")>(),
  desktopVideoCredentials: mocks.desktopVideoCredentials,
}));

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("newsletter-usage");
});

afterAll(async () => {
  await client.close();
  await server.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.dropDatabase();
  mocks.desktopVideoCredentials.mockResolvedValue({
    selected: { fundingIdentity: "managed" },
    selectionUnavailable: false,
  });
});

it("summarizes release video usage without returning credential or provider internals", async () => {
  await db.collection(COLLECTIONS.videoJobs).insertMany([
    {
      _id: "desktop-job",
      publication_id: "publication",
      release_id: "release",
      story_id: "story",
      provider: "desktop",
      funding_identity: "managed",
      status: "complete",
      created_at: Date.now(),
      credential_owner_id: "private-owner",
      credential_version: 17,
      request_id: "private-provider-request",
    },
    {
      _id: "fal-job",
      publication_id: "publication",
      release_id: "release",
      story_id: "story-2",
      provider: "fal",
      funding_identity: "personal",
      status: "failed",
      created_at: 1,
    },
    {
      _id: "legacy-unscoped",
      provider: "desktop",
      status: "complete",
      created_at: Date.now(),
    },
  ]);
  await db.collection("journalist_funding_audit").insertMany([
    { role: "release-video-submitted" },
    { role: "release-video-completed" },
    { role: "writing" },
  ]);

  const result = await releaseVideoStatus({
    db,
    principal: { id: "owner", email: "owner@example.test", role: "owner" },
  } as never);

  expect(result).toEqual({
    desktop: { state: "configured", detail: null },
    total: 2,
    recent: 1,
    statuses: { complete: 1, failed: 1 },
    providers: { desktop: 1, fal: 1 },
    funding: { managed: 1, personal: 1 },
    auditEvents: 2,
  });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("private-owner");
  expect(serialized).not.toContain("credential_version");
  expect(serialized).not.toContain("private-provider-request");
});

it("reports provider configuration failures explicitly without exposing secret values", async () => {
  mocks.desktopVideoCredentials.mockRejectedValueOnce(new Error("Invalid api_key=desktop-secret"));

  const result = await releaseVideoStatus({
    db,
    principal: { id: "owner", email: "owner@example.test", role: "owner" },
  } as never);

  expect(result.desktop.state).toBe("error");
  expect(result.desktop.detail).toContain("[redacted]");
  expect(result.desktop.detail).not.toContain("desktop-secret");
});
