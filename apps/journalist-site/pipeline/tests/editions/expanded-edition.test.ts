import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { loadSettings } from "../../core/config";
import { authorNextStory, finishAuthoring, rankSection, type AuthoringDeps, type DraftDoc, type RankedCandidate } from "../../editions/authoring";
import { COLLECTIONS } from "../../storage/mongo";
import { CANDIDATES_PER_SECTION, MAX_PER_SOURCE_IN_SECTION, MAX_WIDER_ITEMS, PUBLISHED_PER_SECTION, RATED_PER_SECTION } from "../../sourcemap/sections";
import { FakeModel } from "../support/fake-model";
import { resolveRunOptions, withRunContext } from "../../core/run-options";

vi.mock("../../editions/edition-map", () => ({ writeEditionMap: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../model/story-writer", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../model/story-writer")>(),
  writeFront: vi.fn(async () => ({ headline: "Community news", intro: "Local developments." })),
  writeEmail: vi.fn(async () => ({ blurb: "Read this week's news." })),
}));
let server: MongoMemoryServer, client: MongoClient, db: Db, deps: AuthoringDeps;
beforeAll(async () => {
  server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("expanded-editions");
});
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  await db.dropDatabase();
  deps = { db, settings: loadSettings({ NEWSBEE_MODE: "local" }), model: new FakeModel(() => { throw new Error("No live model calls"); }), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});
const candidate = (index: number, source_id = `news:${Math.floor(index / 5)}`): RankedCandidate => ({
  id: `story-${index}`, title: `Local news ${index}`, description: "Local development.", occurrences: 1, venues: [],
  first_date: "2026-10-29", kind: "local_news", tier: "local", rank: index + 1, section_rank: index + 1,
  source_id, source_type: "news", section: "news", rated_by: "rule", score: 30 - index,
  rating: { id: `story-${index}`, civic: 2, appeal: 1, special: 1, category: "other" },
});
async function seed(status: string, candidates: RankedCandidate[]) {
  const draft: DraftDoc = {
    id: "run", run_id: "run", location_id: "fixture-wa", location_name: "Fixture, WA", today: "2026-10-29",
    window_start: "2026-10-29", window_end: "2026-11-04", status, created_at: 1, model: "fake", provider: "fake", validation_policy: "test",
    events: [], source_results: [], candidates, pool_sections: [{ id: "news", label: "Other local news", stories: candidates.map((item) => item.id) }],
    section_rankings: { news: candidates }, tokens: {}, funnel: {}, ranking: {}, event_count: candidates.length, story_count: candidates.length, started_at_ms: Date.now(),
  };
  await db.collection<DraftDoc>(COLLECTIONS.editions).insertOne(draft);
}
async function entry(index: number, disposition = "checks_passed") {
  const c = candidate(index);
  await db.collection(COLLECTIONS.editionEntries).insertOne({
    id: `run:${c.id}`, edition_id: "run", position: index, disposition, story_id: c.id, source_id: c.source_id, source_type: c.source_type,
    tier: "local", section: "news", event_date: c.first_date, result: {
      story: { id: c.id, title: c.title, kind: "local_news" }, draft: { headline: c.title, summary: "Complete authored story." },
      ranking: { section_rank: c.section_rank, score: c.score }, when_where: "Reported locally.", source_url: "https://example.test/news",
      details: { image: "https://example.test/photo" }, image_caption: "Garden", image_credit: "A neighbour",
    },
  });
}
it("expands the bounded selection and publication budgets without increasing the wider-area quota", () => {
  expect([RATED_PER_SECTION, CANDIDATES_PER_SECTION, PUBLISHED_PER_SECTION, MAX_PER_SOURCE_IN_SECTION, MAX_WIDER_ITEMS]).toEqual([30, 20, 10, 5, 3]);
});
it("selects 20 candidates, permits five per source and keeps source diversity", async () => {
  const ranked = Array.from({ length: 30 }, (_, index) => candidate(index));
  await seed("ranking", ranked);
  await rankSection(deps, "run", "news");
  const draft = (await db.collection<DraftDoc>(COLLECTIONS.editions).findOne({ id: "run" }))!;
  expect(draft.candidates).toHaveLength(20);
  const counts = new Map<string, number>();
  for (const c of draft.candidates) counts.set(c.source_id, (counts.get(c.source_id) ?? 0) + 1);
  expect([...counts.values()]).toEqual([5, 5, 5, 5]);
});
it("still caps a dominant source and wider-area items within the expanded pool", async () => {
  const ranked = Array.from({ length: 30 }, (_, index) => ({
    ...candidate(index, index < 10 ? "news:dominant" : `news:${index}`),
    tier: index >= 10 && index < 18 ? "region" : "local",
  }));
  await seed("ranking", ranked);
  await rankSection(deps, "run", "news");
  const draft = (await db.collection<DraftDoc>(COLLECTIONS.editions).findOne({ id: "run" }))!;
  expect(draft.candidates.filter((c) => c.source_id === "news:dominant")).toHaveLength(5);
  expect(draft.candidates.filter((c) => c.tier === "region")).toHaveLength(3);
  expect(draft.candidates).toHaveLength(20);
});
it("publishes ten passed stories, excludes held results, and carries reviewed photo attribution", async () => {
  await seed("ready", Array.from({ length: 20 }, (_, index) => candidate(index)));
  for (let index = 0; index < 13; index++) await entry(index, index === 0 ? "held" : "checks_passed");
  const result = await finishAuthoring(deps, "run");
  expect(result.edition?.items).toHaveLength(10);
  expect(result.edition?.items.map((item) => item.story_id)).toEqual(Array.from({ length: 10 }, (_, index) => `story-${index + 1}`));
  expect(result.edition?.items[0]).toMatchObject({ blurb: "Complete authored story.", image_caption: "Garden", image_credit: "A neighbour" });
  expect(result.edition?.items[0]).not.toHaveProperty("image"); // An unaudited URL never follows the saved credit.
  const again = await finishAuthoring(deps, "run");
  expect(again.edition?.items).toHaveLength(10);
});
it("does not keep authoring a section after ten stories pass", async () => {
  await seed("drafting", Array.from({ length: 20 }, (_, index) => candidate(index)));
  for (let index = 0; index < 10; index++) await entry(index);
  expect(await authorNextStory(deps, "run")).toEqual({ more: false, done: true });
  expect(deps.model).toHaveProperty("calls", []);
});
it("publishes distinct illustration references and retains story text without photographer attribution", async () => {
  await seed("ready", [candidate(0), candidate(1), candidate(2)]);
  for (let index = 0; index < 3; index++) {
    await entry(index);
    await db.collection(COLLECTIONS.editionEntries).updateOne({ story_id: `story-${index}` }, { $set: {
      "result.draft.headline": index < 2 ? `Mime workshop ${index}` : "New bus service", "result.story.kind": "local_news",
    } });
  }
  const result = await withRunContext({ db, runId: "run", locationId: "fixture-wa", options: resolveRunOptions({ image_mode: "illustrated", paid: {} }, {}) },
    () => finishAuthoring(deps, "run"));
  const payload = result.edition as any;
  expect(payload.media_mode).toBe("illustrated"); expect(payload.items).toHaveLength(3);
  expect(payload.items.map((item: any) => item.illustration_id)).toEqual(["performance", undefined, "transit"]);
  expect(payload.items.every((item: any) => item.blurb === "Complete authored story." && !item.image && !item.image_credit)).toBe(true);
  expect(payload.items[0].illustration_policy).toBe("newsbee-watercolor-v1");
  expect(await db.collection(COLLECTIONS.editions).findOne({ id: payload.id })).toMatchObject({ status: "built" });
  expect(await db.collection(COLLECTIONS.publishedStories).countDocuments()).toBe(0);
});

it("publishes secondary source links without losing original attribution", async () => {
  await seed("ready", [candidate(0)]);
  await entry(0);
  const sources = [{ name: "Original newsroom", url: "https://example.test/news" }, { name: "City records", url: "https://city.example/record" }];
  await db.collection(COLLECTIONS.editionEntries).updateOne({ story_id: "story-0" }, { $set: { "result.sources": sources } });
  expect((await finishAuthoring(deps, "run")).edition?.items[0].sources).toEqual(sources);
});
