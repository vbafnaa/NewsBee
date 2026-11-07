import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("@/lib/admin-session", () => ({ adminGuard: vi.fn(), ownerGuard: vi.fn(), currentAdmin: vi.fn(), currentPrincipal: async () => ({ id: "fixture-owner", email: "editor@example.test", role: "owner" }) }));
vi.mock("@/lib/pipeline", () => ({ pipelineDeps: vi.fn() }));

import { adminGuard, ownerGuard, currentAdmin } from "@/lib/admin-session";
import { pipelineDeps } from "@/lib/pipeline";
import { GET, POST } from "@/app/api/admin/usage-map/clear/route";
import { recordReaderSignup } from "../../../../reader-site/src/lib/signup-storage";
import { ALL_LOCATIONS_CONFIRMATION, CLEAR_DATA_TYPES, DEFAULT_CLEAR_DATA_TYPES, LEGACY_CLEAR_DATA_TYPES, parseClearRequest, type ClearDataType } from "../../analytics/clear-scope";
import { clearPreview, clearReaderData } from "../../analytics/reader-data-clear";
import { usageSummary } from "../../analytics/usage";
import { engagementEvidence } from "../../ranking/edition-ranker";
import { COLLECTIONS } from "../../storage/mongo";

const at = new Date("2026-10-01T00:00:00Z");
const ALL = { location_id: null, data_types: [...LEGACY_CLEAR_DATA_TYPES] };
const TOWN = { location_id: "town-wa", data_types: [...LEGACY_CLEAR_DATA_TYPES] };
const SIGNUPS = "reader_interest_signups";
const ENGAGEMENT = "reader_engagement";
const url = "https://portal.example/api/admin/usage-map/clear";
const post = (body: unknown) => new Request(url, { method: "POST", body: JSON.stringify(body) });

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("reader-data-clear-tests");
});
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  await db.dropDatabase();
  vi.mocked(adminGuard).mockResolvedValue(null);
  vi.mocked(ownerGuard).mockResolvedValue(null);
  vi.mocked(currentAdmin).mockResolvedValue("editor@example.test");
  vi.mocked(pipelineDeps).mockResolvedValue({ db } as never);
  await seed("town-wa");
  await seed("other-wa");
});

async function seed(location_id: string) {
  const event = { location_id, edition_id: `${location_id}-edition`, at };
  await db.collection(ENGAGEMENT).insertMany([
    { ...event, action: "view", story_ids: ["a", "b"] }, { ...event, action: "view", story_ids: ["a"] },
    { ...event, action: "open", story_ids: ["a"] }, { ...event, action: "share", story_ids: ["a"] },
  ]);
  const signup = { location_id, location_name: location_id, created_at: at, weekly_editions: true };
  await db.collection(SIGNUPS).insertMany([
    { ...signup, email: "interest@example.test", interest_signup_at: at, legacy_signup: false, launch_notification: true },
    { ...signup, email: "subscriber@example.test", subscription_signup_at: at, legacy_signup: false, launch_notification: false },
    { ...signup, email: "both@example.test", interest_signup_at: at, subscription_signup_at: at, legacy_signup: false, launch_notification: true },
    { ...signup, email: "legacy@example.test", legacy_signup: true, launch_notification: true },
    { ...signup, email: "legacy-interest@example.test", legacy_signup: true, interest_signup_at: at, launch_notification: true },
    { ...signup, email: "unmarked@example.test", launch_notification: true },
  ]);
}
const emails = async (location_id: string) => (await db.collection(SIGNUPS).find({ location_id }).toArray()).map((row) => row.email).sort();
const snapshot = async (except: string[]) => {
  const names = (await db.listCollections().toArray()).map((item) => item.name).filter((name) => !except.includes(name)).sort();
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await db.collection(name).find({}).sort({ _id: 1 }).toArray()])));
};

describe("clearing reader data", () => {
  it("denies nonowner preview and deletion before accessing pipeline data", async () => {
    vi.mocked(pipelineDeps).mockClear();
    vi.mocked(ownerGuard).mockResolvedValue(Response.json({ detail: "Owner access required" }, { status: 403 }));
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await POST(post({ location_id: "town-wa" }))).status).toBe(403);
    expect(pipelineDeps).not.toHaveBeenCalled();
  });
  it("previews what will go and what will stay, per location and in total, without emails", async () => {
    await db.collection<{ _id: string; name: string }>("locations").insertOne({ _id: "town-wa", name: "Town, WA" });
    const preview = await clearPreview(db);
    const expected = { impressions: 2, clicks: 1, shares: 1, interest_records: 1, interest_marks: 2, subscriptions: 2, legacy_signups: 3 };
    expect(preview.locations.find((row) => row.id === "town-wa")).toEqual({ id: "town-wa", name: "Town, WA", ...expected });
    expect(preview.locations.find((row) => row.id === "other-wa")?.name).toBe("other-wa");
    expect(preview.totals).toEqual(Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value * 2])));
    expect(JSON.stringify(preview)).not.toContain("@example.test");
    expect(await db.collection(ENGAGEMENT).countDocuments()).toBe(8);
  });

  it("deletes interest-only records, but keeps subscribers and ambiguous older signups", async () => {
    const before = await db.collection(SIGNUPS).findOne({ location_id: "town-wa", email: "subscriber@example.test" });
    const record = await clearReaderData(db, ALL, "editor@example.test");
    expect(record.deleted).toEqual({ impressions: 4, clicks: 2, shares: 2, interest_records: 2, interest_marks: 4, subscriptions: 0, legacy_signups: 0 });
    expect(await db.collection(ENGAGEMENT).countDocuments()).toBe(0);
    expect(await emails("town-wa")).toEqual(["both@example.test", "legacy-interest@example.test", "legacy@example.test", "subscriber@example.test", "unmarked@example.test"]);
    expect(await db.collection(SIGNUPS).findOne({ location_id: "town-wa", email: "subscriber@example.test" })).toEqual(before);
    const both = await db.collection(SIGNUPS).findOne({ location_id: "town-wa", email: "both@example.test" });
    expect(both).toMatchObject({ subscription_signup_at: at, launch_notification: false, weekly_editions: true });
    expect(both).not.toHaveProperty("interest_signup_at");
    expect(await db.collection(SIGNUPS).findOne({ location_id: "town-wa", email: "legacy@example.test" })).toMatchObject({ legacy_signup: true, launch_notification: true });
    expect(await db.collection(SIGNUPS).findOne({ location_id: "town-wa", email: "legacy-interest@example.test" })).not.toHaveProperty("interest_signup_at");
  });

  it("clears one location without touching another", async () => {
    const other = async () => [await db.collection(ENGAGEMENT).find({ location_id: "other-wa" }).toArray(), await db.collection(SIGNUPS).find({ location_id: "other-wa" }).toArray()];
    const before = await other();
    const record = await clearReaderData(db, TOWN, "editor@example.test");
    expect(record.deleted).toEqual({ impressions: 2, clicks: 1, shares: 1, interest_records: 1, interest_marks: 2, subscriptions: 0, legacy_signups: 0 });
    expect(await other()).toEqual(before);
    expect(await db.collection(ENGAGEMENT).countDocuments({ location_id: "town-wa" })).toBe(0);
  });

  it("leaves every other collection exactly as it was, including rows for the cleared location", async () => {
    const other = [
      ...Object.values(COLLECTIONS).filter((name) => name !== COLLECTIONS.readerDataClears),
      "source_map", "edition_maps", "discovery_state", "discovered_sources", "collected_items", "item_texts", "story_details", "story_text",
      "news_publishers", "source_suggestions", "story_reports", "reader_reports", "reader_story_submissions", "obituary_submissions",
      "neighbour_stories", "remembrance_notices", "journalist_admins", "geographic_places", "geographic_search_cache",
      "internal_access_attempts",
    ];
    for (const name of other) {
      await db.collection(name).insertMany([
        { location_id: "town-wa", edition_id: "town-wa-edition", action: "view", email: "subscriber@example.test", interest_signup_at: at },
        { location_id: "other-wa", marker: name },
      ]);
    }
    const untouched = [ENGAGEMENT, SIGNUPS, COLLECTIONS.readerDataClears];
    const before = await snapshot(untouched);
    expect(Object.keys(before).sort()).toEqual([...new Set(other)].sort());
    await clearReaderData(db, ALL, "editor@example.test");
    await clearReaderData(db, TOWN, "editor@example.test");
    expect(await snapshot(untouched)).toEqual(before);
  });

  it("records who cleared what and when", async () => {
    await db.collection<{ _id: string; name: string }>("locations").insertOne({ _id: "town-wa", name: "Town, WA" });
    await clearReaderData(db, TOWN, "editor@example.test");
    const stored = await db.collection(COLLECTIONS.readerDataClears).findOne({});
    expect(stored).toMatchObject({
      by: "editor@example.test", scope: "location", location_id: "town-wa", location_name: "Town, WA", status: "completed",
      deleted: { impressions: 2, clicks: 1, shares: 1, interest_records: 1, interest_marks: 2 },
    });
    expect(stored?.at).toBeInstanceOf(Date);
    expect(stored?.finished_at).toBeInstanceOf(Date);
    expect(JSON.stringify(stored)).not.toContain("interest@example.test");
    const { recent } = await clearPreview(db);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ by: "editor@example.test", status: "completed" });
  });

  it("keeps a record of a clear that fails part-way", async () => {
    const failing = new Proxy(db, {
      get(target, property) {
        if (property !== "collection") return Reflect.get(target, property);
        return (name: string) => {
          const collection = target.collection(name);
          return name === SIGNUPS ? Object.assign(Object.create(collection), { deleteMany: () => Promise.reject(new Error("write denied")) }) : collection;
        };
      },
    });
    await expect(clearReaderData(failing, ALL, "editor@example.test")).rejects.toThrow("write denied");
    expect(await db.collection(COLLECTIONS.readerDataClears).findOne({})).toMatchObject({
      status: "failed", error: "write denied", deleted: { impressions: 4, clicks: 2, shares: 2, interest_records: 0 },
    });
  });

  it("resets the usage map's reads and interest and the ranker's evidence, and keeps subscriptions", async () => {
    await db.collection(COLLECTIONS.editions).insertOne({ id: "town-wa-edition", location_id: "town-wa", status: "published", published_at: at });
    await db.collection(COLLECTIONS.editionEntries).insertOne({ edition_id: "town-wa-edition", story_id: "a", disposition: "checks_passed", result: { ranking: { category: "civic" } } });
    expect((await engagementEvidence(db, "town-wa")).get("civic")).toBeDefined();
    expect((await usageSummary(db)).totals).toEqual({ reads: 4, subscriptions: 4, interest: 6 });
    await clearReaderData(db, ALL, "editor@example.test");
    expect((await engagementEvidence(db, "town-wa")).size).toBe(0);
    const summary = await usageSummary(db);
    expect(summary.totals).toEqual({ reads: 0, subscriptions: 4, interest: 0 });
    expect(summary.history).toMatchObject({ first_read: null, first_interest: null });
  });

  it("lets a reader register interest again after a clear", async () => {
    await clearReaderData(db, ALL, "editor@example.test");
    await recordReaderSignup(db, { id: "town-wa", name: "Town, WA" }, "interest@example.test", true);
    await recordReaderSignup(db, { id: "town-wa", name: "Town, WA" }, "both@example.test", true);
    const rows = await usageSummary(db);
    expect(rows.rows.find((row) => row.id === "town-wa")).toMatchObject({ interest: 2, subscriptions: 2 });
  });

  it("keeps every signup and consent byte-for-byte when using the default engagement-only selection", async () => {
    const before = await db.collection(SIGNUPS).find({}).toArray();
    const record = await clearReaderData(db, { location_id: null, data_types: [...DEFAULT_CLEAR_DATA_TYPES] }, "owner@example.test");
    expect(record.data_types).toEqual(DEFAULT_CLEAR_DATA_TYPES);
    expect(record.deleted).toMatchObject({ interest_records: 0, interest_marks: 0, subscriptions: 0, legacy_signups: 0 });
    expect(await db.collection(SIGNUPS).find({}).toArray()).toEqual(before);
    expect(await db.collection(ENGAGEMENT).countDocuments()).toBe(0);
  });

  const selections = Array.from({ length: 63 }, (_, index) => CLEAR_DATA_TYPES.filter((_, bit) => (index + 1) & (1 << bit)));
  it.each(selections.map((data_types) => ({ name: data_types.join(", "), data_types })))("clears only $name in the selected location", async ({ data_types }) => {
    const beforeOther = [
      await db.collection(ENGAGEMENT).find({ location_id: "other-wa" }).toArray(),
      await db.collection(SIGNUPS).find({ location_id: "other-wa" }).toArray(),
    ];
    const selected = (type: ClearDataType) => data_types.includes(type);
    const record = await clearReaderData(db, { location_id: "town-wa", data_types }, "owner@example.test");
    expect(record.data_types).toEqual(data_types);
    expect(record.deleted).toEqual({
      impressions: selected("impressions") ? 2 : 0, clicks: selected("clicks") ? 1 : 0, shares: selected("shares") ? 1 : 0,
      interest_records: selected("interest") ? 1 : 0, interest_marks: selected("interest") ? 2 : 0,
      subscriptions: selected("subscriptions") ? 2 : 0, legacy_signups: selected("legacy_signups") ? 3 : 0,
    });
    for (const [type, action, count] of [["impressions", "view", 2], ["clicks", "open", 1], ["shares", "share", 1]] as const) {
      expect(await db.collection(ENGAGEMENT).countDocuments({ location_id: "town-wa", action })).toBe(selected(type) ? 0 : count);
    }
    const remaining = await db.collection(SIGNUPS).find({ location_id: "town-wa" }).toArray();
    expect(remaining.map((row) => row.email).sort()).toEqual([
      ...(!selected("interest") ? ["interest@example.test"] : []),
      ...(!selected("subscriptions") ? ["subscriber@example.test"] : []),
      ...(!selected("interest") || !selected("subscriptions") ? ["both@example.test"] : []),
      ...(!selected("legacy_signups") ? ["legacy@example.test", "unmarked@example.test"] : []),
      ...(!selected("interest") || !selected("legacy_signups") ? ["legacy-interest@example.test"] : []),
    ].sort());
    expect(remaining.filter((row) => row.interest_signup_at)).toHaveLength(selected("interest") ? 0 : 3);
    expect(remaining.filter((row) => row.subscription_signup_at)).toHaveLength(selected("subscriptions") ? 0 : 2);
    expect(await clearPreview(db)).toMatchObject({ locations: expect.arrayContaining([
      expect.objectContaining({ id: "other-wa", subscriptions: 2, legacy_signups: 3 }),
    ]) });
    expect([
      await db.collection(ENGAGEMENT).find({ location_id: "other-wa" }).toArray(),
      await db.collection(SIGNUPS).find({ location_id: "other-wa" }).toArray(),
    ]).toEqual(beforeOther);
  });

  it("keeps signup-only locations selectable and presents historical audit records safely", async () => {
    await db.collection(ENGAGEMENT).deleteMany({});
    await db.collection(SIGNUPS).deleteMany({ email: { $ne: "subscriber@example.test" } });
    await db.collection(COLLECTIONS.readerDataClears).insertOne({
      by: "owner@example.test", at, finished_at: at, status: "completed", scope: "all", location_id: null, location_name: null,
      deleted: { impressions: 1, clicks: 0, shares: 0, interest_records: 0, interest_marks: 0 },
    });
    const preview = await clearPreview(db);
    expect(preview.locations).toHaveLength(2);
    expect(preview.recent[0]).toMatchObject({ data_types: LEGACY_CLEAR_DATA_TYPES, deleted: { subscriptions: 0, legacy_signups: 0 } });
  });

  it("rejects missing categories even for direct calls before writing an audit or deleting data", async () => {
    await expect(clearReaderData(db, { location_id: null } as never, "owner@example.test")).rejects.toThrow("Invalid data types");
    expect(await db.collection(ENGAGEMENT).countDocuments()).toBe(8);
    expect(await db.collection(COLLECTIONS.readerDataClears).countDocuments()).toBe(0);
  });

  it.each(["subscriptions", "legacy_signups"] as const)("records partial %s deletions if a mixed-row update fails", async (type) => {
    const failing = new Proxy(db, {
      get(target, property) {
        if (property !== "collection") return Reflect.get(target, property);
        return (name: string) => {
          const collection = target.collection(name);
          return name === SIGNUPS ? Object.assign(Object.create(collection), { updateMany: () => Promise.reject(new Error("fixture update denied")) }) : collection;
        };
      },
    });
    await expect(clearReaderData(failing, { location_id: "town-wa", data_types: [type] }, "owner@example.test")).rejects.toThrow("fixture update denied");
    expect(await db.collection(COLLECTIONS.readerDataClears).findOne({})).toMatchObject({
      status: "failed", data_types: [type], deleted: { [type]: type === "subscriptions" ? 1 : 2 },
    });
  });
});

describe("clear request validation", () => {
  it("needs an explicit scope and a confirmation that matches it", () => {
    expect(parseClearRequest({ scope: "all", confirm: ALL_LOCATIONS_CONFIRMATION, data_types: LEGACY_CLEAR_DATA_TYPES })).toEqual(ALL);
    expect(parseClearRequest({ scope: "location", location_id: "town-wa", confirm: "town-wa", data_types: LEGACY_CLEAR_DATA_TYPES })).toEqual(TOWN);
    for (const body of [null, {}, { confirm: ALL_LOCATIONS_CONFIRMATION }, { scope: "location", confirm: ALL_LOCATIONS_CONFIRMATION }, { scope: "location", location_id: "", confirm: "" }, { scope: "location", location_id: { $ne: "" }, confirm: ALL_LOCATIONS_CONFIRMATION }]) {
      expect(() => parseClearRequest(body)).toThrow("Invalid scope");
    }
    for (const body of [{ scope: "all" }, { scope: "all", confirm: "town-wa" }, { scope: "location", location_id: "town-wa", confirm: ALL_LOCATIONS_CONFIRMATION }]) {
      expect(() => parseClearRequest(body)).toThrow("Invalid confirmation");
    }
  });
  it("requires explicit supported nonempty categories and rejects duplicates", () => {
    for (const data_types of [undefined, null, [], "interest", ["unknown"], ["clicks", "clicks"], ["clicks", { $ne: "" }]]) {
      expect(() => parseClearRequest({ scope: "all", confirm: ALL_LOCATIONS_CONFIRMATION, data_types })).toThrow("Invalid data types");
    }
    expect(parseClearRequest({ scope: "all", confirm: ALL_LOCATIONS_CONFIRMATION, data_types: ["subscriptions"] }).data_types).toEqual(["subscriptions"]);
  });
});

describe("clear route", () => {
  it("refuses anyone who is not an admin, for reads and writes", async () => {
    vi.mocked(adminGuard).mockResolvedValue(Response.json({ detail: "Sign in" }, { status: 401 }));
    expect((await GET(new Request(url))).status).toBe(401);
    expect((await POST(post({ scope: "all", confirm: ALL_LOCATIONS_CONFIRMATION }))).status).toBe(401);
    expect(await db.collection(ENGAGEMENT).countDocuments()).toBe(8);
    expect(await db.collection(COLLECTIONS.readerDataClears).countDocuments()).toBe(0);
  });

  it("rejects an unconfirmed clear without deleting or logging anything", async () => {
    for (const body of [{}, { scope: "all" }, { scope: "location", location_id: "town-wa", confirm: "other-wa" },
      { scope: "all", confirm: ALL_LOCATIONS_CONFIRMATION }, { scope: "all", confirm: ALL_LOCATIONS_CONFIRMATION, data_types: [] },
      { scope: "all", confirm: ALL_LOCATIONS_CONFIRMATION, data_types: ["unknown"] }]) {
      expect((await POST(post(body))).status).toBe(400);
    }
    expect(await db.collection(ENGAGEMENT).countDocuments()).toBe(8);
    expect(await db.collection(COLLECTIONS.readerDataClears).countDocuments()).toBe(0);
  });

  it("clears the confirmed scope and records the signed-in admin", async () => {
    const preview = await (await GET(new Request(url))).json();
    expect(preview.totals.impressions).toBe(4);
    const response = await POST(post({ scope: "location", location_id: "town-wa", confirm: "town-wa", data_types: DEFAULT_CLEAR_DATA_TYPES }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ by: "editor@example.test", scope: "location", status: "completed", data_types: DEFAULT_CLEAR_DATA_TYPES });
    expect(await db.collection(ENGAGEMENT).countDocuments()).toBe(4);
    expect(await db.collection(SIGNUPS).countDocuments()).toBe(12);
  });
});
