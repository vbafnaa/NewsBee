import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { collectedItems, type CollectedItem } from "../../editions/assemble";
import { startAuthoring, rankSection, authorNextStory, finishAuthoring } from "../../editions/authoring";
import { defaultRunOptions, withRunContext } from "../../core/run-options";
import { loadSettings } from "../../core/config";
import { saveText } from "../../editions/details";
import { COLLECTIONS } from "../../storage/mongo";
import { FakeModel } from "../support/fake-model";
import type { LocationProfile } from "../../connectors/types";
vi.mock("../../connectors/locality", async (original) => ({ ...await original<typeof import("../../connectors/locality")>(), localityFor: async (ctx: { location: LocationProfile }) => ({ location: ctx.location, landmarks: [] }) }));
vi.mock("../../editions/edition-map", () => ({ writeEditionMap: vi.fn().mockResolvedValue(undefined) }));
let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("pipeline2-acceptance"); });
afterAll(async () => { await client?.close(); await server?.stop(); });
it("filters sources, merges copies, ranks, writes grounded articles and builds an unpublished edition", async () => {
  const location = { id: "fixture", name: "Fixture, WA", state: "WA", systems: [], community: { name: "Fixture", parent_name: "Town", coverage_terms: [] } } as LocationProfile;
  const title = "Cedar Park playground plans";
  const sourceText = "The council approved $50,000 for a Cedar Park playground. Construction has not started. Residents can comment until November 8.";
  const rows = [
    { id: "official", title, tier: "local", source_tier: "official", source_url: "https://council.example/playground", description: "Cedar Park playground plans were considered." },
    { id: "copy", title, tier: "local", source_tier: "repost", source_url: "https://repost.example/playground", description: "A much longer secondhand description of Cedar Park playground plans that should not replace the official source." },
    { id: "rejected", title: "Rejected source announcement", tier: "local", source_url: "https://rejected.example/story", description: "A local announcement." },
    { id: "distant", title: "Distant poetry event", kind: "event", tier: "nearby", source_url: "https://distant.example/event", description: "A poetry event outside the local area." },
  ];
  await db.collection("source_map").insertMany(rows.map((row) => ({ location_id: location.id, source_id: row.id, status: row.id === "rejected" ? "rejected" : "active", source_tier: row.source_tier, section: "news" })));
  await collectedItems(db).insertMany(rows.map((row) => ({ _id: row.id, run_id: "run", location_id: location.id, source_id: row.id, source_name: row.id, status: "collected", step: "reader", reason: null, created_at: 1, title: row.title, url: row.source_url, event_date: "2026-11-08", facts: { source_event_id: row.id, kind: "local_news", event_date: "2026-11-08", schedule_text: "November 8", venue: "Cedar Park", room: null, needs_locality: false, ...row } } as CollectedItem)));
  await saveText(db, rows[0].source_url, sourceText, { canonical_url: rows[0].source_url, reuse_allowed: true });
  const model = new FakeModel(({ prompt }) => {
    if (prompt.startsWith("Rate each")) { const candidates = JSON.parse(prompt.split("Candidates:\n")[1]); return { ratings: candidates.map((c: { id: string }) => ({ id: c.id, category: "civic_and_practical", civic: 3, appeal: 2, special: 2 })) }; }
    if (prompt.startsWith("You edit")) return { headline: "Cedar Park playground plans receive $50,000", intro: "The council approved a playground budget." };
    if (prompt.startsWith("You write the email")) return { blurb: "Read about the $50,000 playground budget." };
    return { headline: "Cedar Park playground plans receive funding", summary: "The council approved $50,000 for a Cedar Park playground. Construction has not started." };
  });
  const deps = { db, settings: loadSettings({ NEWSBEE_MODE: "local" }), model, transport: vi.fn(async () => { throw new Error("No external requests in acceptance test"); }), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  await withRunContext({ db, runId: "run", locationId: location.id, options: { ...defaultRunOptions({ NEWSBEE_GUARDRAILS_OFF: "none" }), count_history: false } }, async () => {
    const started = await startAuthoring(deps, { location, runId: "run", today: "2026-11-08", window: ["2026-11-08", "2026-11-14"], sourceResults: [] });
    expect(started.sections).toHaveLength(1);
    for (const section of started.sections) await rankSection(deps, "run", section);
    const written = await authorNextStory(deps, "run");
    expect(written.result).toMatchObject({ disposition: "checks_passed", source_url: rows[0].source_url });
    const built = await finishAuthoring(deps, "run");
    expect(built.edition?.items).toHaveLength(1);
    expect(built.edition?.items[0]).toMatchObject({ source_url: rows[0].source_url, blurb: expect.stringContaining("$50,000") });
    expect(built.summary?.front).toMatchObject({ fallback: false });
    expect(built.summary?.email).toMatchObject({ fallback: false });
    expect(await db.collection(COLLECTIONS.editions).findOne({ id: "run" })).toMatchObject({ status: "built" });
    expect(await db.collection(COLLECTIONS.publishedStories).countDocuments()).toBe(0);
  });
  expect(await collectedItems(db).findOne({ _id: "rejected" })).toMatchObject({ status: "dropped", step: "source_review" });
  expect(await collectedItems(db).findOne({ _id: "distant" })).toMatchObject({ status: "dropped" });
});
