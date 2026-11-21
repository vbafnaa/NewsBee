import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAMPAIGN_INTERESTS,
  CAMPAIGN_ROLES,
  campaignLeadCsv,
  campaignLeadSummary,
  CampaignLeadQueryError,
  listCampaignLeads,
  parseCampaignLeadFilters,
} from "../../campaigns/leads";
import { COLLECTIONS } from "../../storage/mongo";

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("campaign-leads");
});

beforeEach(async () => {
  await db.dropDatabase();
});

afterAll(async () => {
  await client.close();
  await server.stop();
});

function filters(query = "") {
  return parseCampaignLeadFilters(new URLSearchParams(query));
}

async function seed(count = 65) {
  const campaigns = ["newsroom", "college-journalism", "high-school-journalism", "branded-news"] as const;
  const base = Date.UTC(2026, 0, 20, 12);
  await db.collection(COLLECTIONS.campaignSignups).insertMany(Array.from({ length: count }, (_, index) => ({
    _id: index.toString(16).padStart(64, "0"),
    campaign: campaigns[index % campaigns.length],
    email: `lead-${index}@example.test`,
    context: index === 0 ? "=SUM(A1:A2)" : `Context ${index}`,
    role: CAMPAIGN_ROLES[index % CAMPAIGN_ROLES.length],
    interest: CAMPAIGN_INTERESTS[index % CAMPAIGN_INTERESTS.length],
    attribution: {
      utm_source: index % 2 ? "community" : "search",
      utm_medium: "social",
      utm_campaign: `launch-${index % 3}`,
      utm_content: `card-${index}`,
      utm_term: "local-news",
    },
    createdAt: new Date(base - (index * 60_000)),
  })));
}

describe("campaign lead queries", () => {
  it("creates query indexes and filters campaign, role, interest and UTM source", async () => {
    await seed();
    const campaign = await listCampaignLeads(db, filters("campaign=newsroom"));
    expect(campaign.total).toBe(17);
    expect(campaign.leads.every((lead) => lead.campaign === "newsroom")).toBe(true);

    const role = CAMPAIGN_ROLES[3];
    const byRole = await listCampaignLeads(db, filters(`role=${encodeURIComponent(role)}`));
    expect(byRole.total).toBeGreaterThan(0);
    expect(byRole.leads.every((lead) => lead.role === role)).toBe(true);

    const interest = CAMPAIGN_INTERESTS[5];
    const byInterest = await listCampaignLeads(db, filters(`interest=${encodeURIComponent(interest)}`));
    expect(byInterest.total).toBeGreaterThan(0);
    expect(byInterest.leads.every((lead) => lead.interest === interest)).toBe(true);

    const bySource = await listCampaignLeads(db, filters("utm_source=community"));
    expect(bySource.total).toBe(32);
    expect(bySource.leads.every((lead) => lead.attribution.utm_source === "community")).toBe(true);

    const indexes = await db.collection(COLLECTIONS.campaignSignups).indexes();
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "campaign_leads_newest",
      "campaign_leads_campaign",
      "campaign_leads_role",
      "campaign_leads_interest",
      "campaign_leads_utm_source",
    ]));
  });

  it("uses inclusive UTC dates, newest-first ordering, deterministic ties and exact 50-row pages", async () => {
    await seed(62);
    await db.collection(COLLECTIONS.campaignSignups).insertMany([
      {
        _id: "f".repeat(64),
        campaign: "newsroom",
        email: "day-start@example.test",
        context: "Start",
        role: CAMPAIGN_ROLES[0],
        interest: CAMPAIGN_INTERESTS[0],
        attribution: {},
        createdAt: new Date("2026-01-10T00:00:00.000Z"),
      },
      {
        _id: "e".repeat(64),
        campaign: "newsroom",
        email: "day-end@example.test",
        context: "End",
        role: CAMPAIGN_ROLES[0],
        interest: CAMPAIGN_INTERESTS[0],
        attribution: {},
        createdAt: new Date("2026-01-10T23:59:59.999Z"),
      },
    ]);
    const day = await listCampaignLeads(db, filters("from=2026-01-10&to=2026-01-10"));
    expect(day.leads.map((lead) => lead.email)).toEqual(["day-end@example.test", "day-start@example.test"]);

    await db.collection(COLLECTIONS.campaignSignups).insertMany([
      {
        _id: "a".repeat(64),
        campaign: "newsroom",
        email: "tie-a@example.test",
        context: "Tie A",
        role: CAMPAIGN_ROLES[0],
        interest: CAMPAIGN_INTERESTS[0],
        attribution: {},
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      },
      {
        _id: "b".repeat(64),
        campaign: "newsroom",
        email: "tie-b@example.test",
        context: "Tie B",
        role: CAMPAIGN_ROLES[0],
        interest: CAMPAIGN_INTERESTS[0],
        attribution: {},
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ]);
    const first = await listCampaignLeads(db, filters());
    expect(first.leads).toHaveLength(50);
    expect(first.leads.slice(0, 2).map((lead) => lead.email)).toEqual([
      "tie-b@example.test",
      "tie-a@example.test",
    ]);
    const second = await listCampaignLeads(db, filters("page=2"));
    expect(second.leads).toHaveLength(16);
    expect(second).toMatchObject({ page: 2, pageSize: 50, total: 66, pages: 2 });
  });

  it.each([
    "campaign=unknown",
    "role=unknown",
    "interest=unknown",
    "utm_source=%3Cscript%3E",
    "from=2026-02-30",
    "from=2026-02-02&to=2026-02-01",
    "page=0",
    "page=1.5",
    "campaign=newsroom&campaign=branded-news",
  ])("rejects invalid filters: %s", (query) => {
    expect(() => filters(query)).toThrow(CampaignLeadQueryError);
  });

  it("exports every matching row with spreadsheet-formula neutralization and no raw logging", async () => {
    await seed(65);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const csv = await campaignLeadCsv(db, filters());
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(66);
    expect(csv).toContain("lead-64@example.test");
    expect(csv).toContain("'=SUM(A1:A2)");
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("counts all leads and those from the inclusive trailing seven-day window", async () => {
    await db.collection(COLLECTIONS.campaignSignups).insertMany([
      { _id: "1", campaign: "newsroom", email: "recent@example.test", context: "Recent", role: CAMPAIGN_ROLES[0], interest: CAMPAIGN_INTERESTS[0], createdAt: new Date("2026-02-10T12:00:00Z") },
      { _id: "2", campaign: "newsroom", email: "boundary@example.test", context: "Boundary", role: CAMPAIGN_ROLES[0], interest: CAMPAIGN_INTERESTS[0], createdAt: new Date("2026-02-03T12:00:00Z") },
      { _id: "3", campaign: "newsroom", email: "old@example.test", context: "Old", role: CAMPAIGN_ROLES[0], interest: CAMPAIGN_INTERESTS[0], createdAt: new Date("2026-02-03T11:59:59Z") },
    ]);
    await expect(campaignLeadSummary(db, new Date("2026-02-10T12:00:00Z"))).resolves.toEqual({
      total: 3,
      recent: 2,
    });
  });
});
