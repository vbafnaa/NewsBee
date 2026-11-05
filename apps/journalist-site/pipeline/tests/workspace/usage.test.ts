import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { recordReaderSignup } from "../../../../reader-site/src/lib/signup-storage";
import { usageRange, usageSummary } from "../../analytics/usage";
import { inbox } from "../../orchestration/inbox";

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("workspace-tests");
});
beforeEach(async () => { await db.dropDatabase(); });
afterAll(async () => { await client?.close(); await server?.stop(); });

describe("accurate usage aggregation", () => {
  it("counts one read per view, not per story or unrelated action, and preserves missing geography", async () => {
    await db.collection("reader_engagement").insertMany([
      { location_id: "town-wa", action: "view", story_ids: ["a", "b", "c"], at: new Date("2026-10-01") },
      { location_id: "town-wa", action: "view", story_ids: [], at: new Date("2026-10-02") },
      { location_id: "town-wa", action: "open", at: new Date("2026-10-02") },
      { location_id: "town-wa", action: "share", at: new Date("2026-10-02") },
      { location_id: "unmapped-wa", action: "view", at: new Date("2026-10-02") },
      { location_id: "town-wa", action: "view", at: "invalid date" },
    ]);
    await db.collection<{ _id: string; name: string; latitude: number; longitude: number }>("locations").insertOne({ _id: "town-wa", name: "Town, WA", latitude: 47, longitude: -122 });
    const data = await usageSummary(db);
    expect(data.totals).toEqual({ reads: 3, subscriptions: 0, interest: 0 });
    expect(data.rows.find((row) => row.id === "town-wa")).toMatchObject({ reads: 2, latitude: 47, longitude: -122, onboarded: true });
    expect(data.rows.find((row) => row.id === "unmapped-wa")).toMatchObject({ reads: 1, latitude: null, longitude: null, onboarded: false });
    expect(data.history.first_read).toBe("2026-10-01T00:00:00.000Z");
  });

  it("records both explicit intents once, without reclassifying ambiguous historical signups", async () => {
    const town = { id: "town-wa", name: "Town, WA" };
    await db.collection("reader_interest_signups").insertOne({ location_id: town.id, email: "legacy@example.test", created_at: new Date("2025-01-01"), weekly_editions: true, launch_notification: true });
    await recordReaderSignup(db, town, "reader@example.test", true);
    const first = await db.collection("reader_interest_signups").findOne({ email: "reader@example.test" });
    await recordReaderSignup(db, town, "reader@example.test", false);
    await recordReaderSignup(db, town, "reader@example.test", true);
    const repeat = await db.collection("reader_interest_signups").findOne({ email: "reader@example.test" });
    expect(repeat?.interest_signup_at).toEqual(first?.interest_signup_at);
    expect(repeat?.subscription_signup_at).toBeInstanceOf(Date);
    expect(repeat?.legacy_signup).toBe(false);
    const summary = await usageSummary(db);
    expect(summary.totals).toEqual({ reads: 0, subscriptions: 1, interest: 1 });
    expect(summary.history.unclassified_legacy_signups).toBe(1);
    await recordReaderSignup(db, town, "legacy@example.test", false);
    const after = await usageSummary(db);
    expect(after.totals).toEqual({ reads: 0, subscriptions: 2, interest: 1 });
    expect(after.history.unclassified_legacy_signups).toBe(1);
    expect(JSON.stringify(after)).not.toContain("@example.test");
  });

  it("resolves requested communities that have not been onboarded and supports inclusive UTC date filters", async () => {
    await db.collection("reader_interest_signups").insertMany([
      { location_id: "requested-wa", interest_signup_at: new Date("2026-10-01T00:00:00Z") },
      { location_id: "requested-wa", interest_signup_at: new Date("2026-10-01T23:59:59Z") },
      { location_id: "requested-wa", interest_signup_at: new Date("2026-10-02T00:00:00Z") },
    ]);
    await db.collection<{ _id: string; label: string; latitude: number; longitude: number }>("geographic_places").insertOne({ _id: "requested-wa", label: "Requested neighbourhood, WA", latitude: 48, longitude: -123 });
    const data = await usageSummary(db, usageRange("2026-10-01", "2026-10-01"));
    expect(data.totals.interest).toBe(2);
    expect(data.rows[0]).toMatchObject({ latitude: 48, longitude: -123, onboarded: false, name: "Requested neighbourhood, WA" });
    expect((await usageSummary(db, usageRange("2020-01-01", "2020-01-01"))).rows).toEqual([]);
    expect(() => usageRange("2026-02-30", null)).toThrow("Invalid date");
    expect(() => usageRange("2026-10-02", "2026-10-01")).toThrow("Invalid date range");
  });

  it("counts concurrent repeat signups only once for each explicit intent", async () => {
    const town = { id: "town-wa", name: "Town, WA" };
    await Promise.all(Array.from({ length: 8 }, (_, index) => recordReaderSignup(db, town, "reader@example.test", index % 2 === 0)));
    expect(await db.collection("reader_interest_signups").countDocuments()).toBe(1);
    expect((await usageSummary(db)).totals).toEqual({ reads: 0, subscriptions: 1, interest: 1 });
  });
});

it("scopes every editorial inbox category to its location before applying review limits", async () => {
  for (const collection of ["reader_story_submissions", "obituary_submissions", "source_suggestions", "story_reports"]) {
    await db.collection(collection).insertMany([
      { location_id: "a-wa", status: collection === "story_reports" ? "open" : "pending", submitted_at: "2026-10-01" },
      { location_id: "b-wa", status: collection === "story_reports" ? "open" : "pending", submitted_at: "2026-10-02" },
    ]);
  }
  const result = await inbox(db, "a-wa");
  for (const rows of [result.reader_stories, result.family_notices, result.suggestions, result.reports]) {
    expect(rows).toHaveLength(1);
    expect(rows[0].location_id).toBe("a-wa");
  }
});
