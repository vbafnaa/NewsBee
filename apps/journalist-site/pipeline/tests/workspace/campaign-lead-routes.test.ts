import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as campaignRoute from "@/app/api/admin/campaigns/route";
import * as exportRoute from "@/app/api/admin/campaigns/export/route";
import { CAMPAIGN_INTERESTS, CAMPAIGN_ROLES } from "@/pipeline/campaigns/leads";
import { COLLECTIONS, useDatabase } from "@/pipeline/storage/mongo";
import { enterMaintenance, fencedDatabase } from "../../../../../shared/restore-maintenance";
import { POST as campaignSignup } from "../../../../reader-site/src/pages/api/campaign-signups";

const mocks = vi.hoisted(() => ({ operatorGuard: vi.fn(), readerDatabase: vi.fn() }));
vi.mock("@/lib/admin-session", () => ({ operatorGuard: mocks.operatorGuard }));
vi.mock("../../../../reader-site/src/lib/reader-data", () => ({ readerDatabase: mocks.readerDatabase }));

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("campaign-lead-routes");
  useDatabase(db);
});

beforeEach(async () => {
  await db.dropDatabase();
  mocks.operatorGuard.mockResolvedValue(null);
  await db.collection(COLLECTIONS.campaignSignups).insertOne({
    _id: "fixture",
    campaign: "newsroom",
    email: "lead@example.test",
    context: "City desk",
    role: CAMPAIGN_ROLES[0],
    interest: CAMPAIGN_INTERESTS[0],
    attribution: { utm_source: "community" },
    createdAt: new Date("2026-02-10T12:00:00Z"),
  });
});

afterAll(async () => {
  useDatabase(null);
  await client.close();
  await server.stop();
});

it("denies editor requests before campaign data is read", async () => {
  mocks.operatorGuard.mockResolvedValue(Response.json({ detail: "Newsbee operator access required" }, { status: 403 }));
  const response = await campaignRoute.GET(new Request("https://journalist.example/api/admin/campaigns"));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ detail: "Newsbee operator access required" });
});

it("returns private paginated data to operators and rejects invalid queries", async () => {
  const response = await campaignRoute.GET(new Request("https://journalist.example/api/admin/campaigns?campaign=newsroom"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({
    leads: [{ email: "lead@example.test", campaign: "newsroom", attribution: { utm_source: "community" } }],
    page: 1,
    pageSize: 50,
    total: 1,
    pages: 1,
  });
  const invalid = await campaignRoute.GET(new Request("https://journalist.example/api/admin/campaigns?page=0"));
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ detail: "Invalid page" });
});

it("exports private CSV and exposes no campaign mutation handlers", async () => {
  const response = await exportRoute.GET(new Request("https://journalist.example/api/admin/campaigns/export"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/csv");
  expect(response.headers.get("content-disposition")).toBe('attachment; filename="newsbee-campaign-leads.csv"');
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).toContain("lead@example.test");
  expect("POST" in campaignRoute).toBe(false);
  expect("PUT" in campaignRoute).toBe(false);
  expect("DELETE" in campaignRoute).toBe(false);
  expect("POST" in exportRoute).toBe(false);
});

it("fences direct public Reader campaign signups during maintenance", async () => {
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "owner@example.test");
  try {
    const owner = { id: "owner-id", email: "owner@example.test", role: "owner" };
    await db.collection("journalist_admins").insertOne({ principalId: owner.id, email: owner.email, enabled: true });
    mocks.readerDatabase.mockResolvedValue(await fencedDatabase(db));
    const url = new URL("https://reader.example.test/api/campaign-signups");
    const signup = () => campaignSignup({
      url, request: new Request(url, {
        method: "POST", headers: { origin: url.origin, "content-type": "application/json" },
        body: JSON.stringify({
          campaign: "newsroom", email: "new@example.test", context: "City desk",
          role: "Independent journalist", interest: "Collecting tips and story submissions",
        }),
      }),
    } as Parameters<typeof campaignSignup>[0]);
    expect((await signup()).status).toBe(200);
    await enterMaintenance(db, owner);
    expect((await signup()).status).toBe(503);
    expect(await db.collection(COLLECTIONS.campaignSignups).countDocuments({ email: "new@example.test" })).toBe(1);
  } finally { vi.unstubAllEnvs(); }
});
