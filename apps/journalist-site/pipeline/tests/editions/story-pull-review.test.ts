import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assemble, collectedItems, independentBonus, type CollectedItem } from "../../editions/assemble";
import { siteNameProblem, titleProblem, urlDate } from "../../editions/title-rules";
import { csvCell, saveStoryReview, sourceAcceptRates, storyReviewChange, storyReviewCsv, reviewedStories, CSV_COLUMNS } from "../../editions/story-reviews";
import { pulledStories, reasonKind } from "../../editions/pulled";
import { editorSignal, preRate, rankAgreement } from "../../ranking/pre-ranker";
import { rank } from "../../model/newsworthiness";
import { ModelUnavailableError } from "../../model/runtime";
import { FakeModel } from "../support/fake-model";
import { readSite, siteNameOf } from "../../connectors/web";
import { Fetcher } from "../../connectors/fetcher";
import { sourceResult, type ConnectorContext, type DroppedItem, type LocationProfile } from "../../connectors/types";
import { loadSettings } from "../../core/config";
import { defaultRunOptions, withRunContext } from "../../core/run-options";
import { WINDOWS } from "../../sourcemap/windows";
import { COLLECTIONS } from "../../storage/mongo";
import type { HttpTransport } from "../../core/http";

vi.mock("../../connectors/locality", async (original) => ({ ...await original<typeof import("../../connectors/locality")>(), localityFor: async (context: { location: LocationProfile }) => ({ location: context.location, landmarks: [] }) }));

describe("title rules", () => {
  it("rejects a title that is only the site's name or a navigation heading", () => {
    expect(siteNameProblem("Columbia Basin Herald", ["Columbia Basin Herald"])).toContain("only the site's name");
    expect(siteNameProblem("The Columbia Basin Herald", ["Columbia Basin Herald"])).toContain("only the site's name");
    expect(siteNameProblem("Latest stories | Ellington", [])).toContain("navigation page");
    expect(siteNameProblem("Minor injuries, mobile home destroyed in Moses Lake fire Sunday", ["Columbia Basin Herald"])).toBeNull();
  });

  it("requires four words only of publishers' headlines", () => {
    expect(titleProblem("Council meets", "local_news", [])).toBe('title under 4 words ("Council meets")');
    expect(titleProblem("Council meets | Herald", "news_report", [])).toContain("under 4 words");
    expect(titleProblem("Council approves new park budget", "local_news", [])).toBeNull();
    for (const kind of ["event", "obituary", "game_result", "meeting_preview", "home_sale"]) expect(titleProblem("Storytime", kind, [])).toBeNull();
  });

  it("reads a full date from a story's address", () => {
    expect(urlDate("https://columbiabasinherald.com/news/2026/nov/08/minor-injuries/")).toBe("2026-11-08");
    expect(urlDate("https://example.org/2026/11/8/story")).toBe("2026-11-08");
    expect(urlDate("https://example.org/news/2026-11-08-park-opens")).toBe("2026-11-08");
    expect(urlDate("https://example.org/2026/02/30/not-a-day")).toBeNull();
    expect(urlDate("https://example.org/2026/11/")).toBeNull();
    expect(urlDate("not a url")).toBeNull();
  });

  it("finds the site's own name", () => {
    expect(siteNameOf('<meta property="og:site_name" content="Columbia Basin Herald"/>', "https://x.example/news/2026/nov/08/a/")).toBe("Columbia Basin Herald");
    expect(siteNameOf("<title>Fire Sunday | Columbia Basin Herald</title>", "https://x.example/a")).toBe("Columbia Basin Herald");
    expect(siteNameOf("<title>Columbia Basin Herald</title>", "https://x.example/")).toBe("Columbia Basin Herald");
    expect(siteNameOf("<title>Fire Sunday</title>", "https://x.example/a")).toBeNull();
  });

  it("reads events 30 days ahead", () => {
    expect(WINDOWS.events.ahead).toEqual({ days: 30 });
  });
});

describe("the web reader on a source saved as one dated story", () => {
  it("reads the publisher's feed from its home page, and names the home page instead of calling it undated", async () => {
    const root = "https://herald.example/";
    const story = `${root}news/2026/nov/01/old-police-logs/`;
    const pages: Record<string, string> = {
      [`${root}robots.txt`]: "User-agent: *\nAllow: /\n",
      [story]: `<html><head><title>Police logs | Herald</title><meta property="og:site_name" content="Herald"></head><body><article><p>Logs.</p></article><a href="/">Home</a></body></html>`,
      [root]: `<html><head><title>Herald</title><link type="application/rss+xml" rel="alternate" href="/rss/headlines/"></head><body></body></html>`,
      [`${root}rss/headlines/`]: `<rss><channel><item><title>Mobile home destroyed in Fixture fire Sunday</title><link>${root}news/2026/nov/08/fire/</link><pubDate>Sun, 08 Nov 2026 11:21:00 -0700</pubDate></item></channel></rss>`,
    };
    const transport: HttpTransport = async (request) => {
      const body = pages[request.url];
      return { url: request.url, status: body ? 200 : 404, headers: {}, body: new TextEncoder().encode(body ?? "") };
    };
    const context = { today: "2026-11-09", transport, fetcher: new Fetcher(transport, undefined, false) } as unknown as ConnectorContext;
    const items = await readSite({ type: "web", source_id: "web:herald", name: "Police logs for Jan. 21-24", params: { url: story } }, context, sourceResult("web:herald", "Herald", "ingested", ""));
    expect(items.map((item) => item.title)).toEqual(["Mobile home destroyed in Fixture fire Sunday"]);
    expect(items[0].site_name).toBe("Herald");
  });

  it("drops a linked section front titled with the site's name, and dates a story from its address", async () => {
    const root = "https://paper.example/";
    const front = `${root}news/local-news-front-page/`;
    const pages: Record<string, string> = {
      [`${root}robots.txt`]: "User-agent: *\nAllow: /\n",
      [`${root}section/`]: `<html><head><title>Local | Paper</title></head><body><a href="${front}">Local news</a><a href="${root}news/2026/nov/07/library-opens-new-wing/">Library</a></body></html>`,
      [front]: '<html><head><title>Local news | Paper</title><meta property="og:title" content="Paper"></head><body><p>Front page</p></body></html>',
      [`${root}news/2026/nov/07/library-opens-new-wing/`]: `<html><head><title>Library opens new wing downtown | Paper</title></head><body><article><p>${"The library opened a new wing. ".repeat(20)}</p></article></body></html>`,
    };
    const transport: HttpTransport = async (request) => {
      const body = pages[request.url];
      return { url: request.url, status: body ? 200 : 404, headers: {}, body: new TextEncoder().encode(body ?? "") };
    };
    const dropped: DroppedItem[] = [];
    const context = { today: "2026-11-09", transport, fetcher: new Fetcher(transport, undefined, false), settings: loadSettings({ NEWSBEE_MODE: "local" }), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as ConnectorContext;
    const items = await readSite({ type: "web", source_id: "web:paper", name: "Paper", params: { url: `${root}section/` } }, context, sourceResult("web:paper", "Paper", "ingested", ""), dropped);
    expect(items.map((item) => [item.title, item.event_date])).toEqual([["Library opens new wing downtown | Paper", "2026-11-07"]]);
    expect(dropped.find((item) => item.url === front)?.reason).toBe('title is only the site\'s name ("Paper")');
  });
});

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("story-pull-review"); });
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => { await db.dropDatabase(); });

const location = { id: "test", name: "Test, WA", state: "WA", systems: [], community: { name: "Fixture", parent_name: "Town", coverage_terms: [] } } as unknown as LocationProfile;
async function pool(facts: Array<Record<string, unknown> & { source?: string; source_name?: string }>) {
  await collectedItems(db).insertMany(facts.map((fact, index) => ({
    _id: `run:${index}`, run_id: "run", location_id: "test", source_id: fact.source ?? `source:${index}`, source_name: fact.source_name ?? "Fixture News", created_at: 1, status: "collected", reason: null, step: "reader",
    title: String(fact.title), url: fact.source_url as string, event_date: fact.event_date as string,
    facts: { source_event_id: String(index), venue: "Library", schedule_text: "November 8", needs_locality: false, tier: "local", kind: "local_news", event_date: "2026-11-08", ...fact },
  } as CollectedItem)));
  const transport = vi.fn(async () => { throw new Error("Unexpected network request"); });
  return withRunContext({ db, runId: "run", locationId: "test", options: { ...defaultRunOptions({}), paid: {}, count_history: false } }, () => assemble({
    db, runId: "run", location, today: "2026-11-09", settings: loadSettings({ NEWSBEE_MODE: "local" }), transport, fetcher: new Fetcher(transport), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  }));
}

describe("assembly", () => {
  it("leaves out titles that fail the title rules, with the reason, and counts them", async () => {
    const result = await pool([
      { title: "Fixture News", source_url: "https://news.example/" },
      { title: "Short headline", source_url: "https://news.example/a" },
      { title: "Storytime", kind: "event", source_url: "https://library.example/storytime" },
      { title: "Fixture council approves the park budget", source_url: "https://news.example/b" },
    ]);
    expect(result.funnel.title_dropped).toBe(2);
    expect(await collectedItems(db).findOne({ _id: "run:0" })).toMatchObject({ status: "dropped", step: "title", reason: expect.stringContaining("only the site's name") });
    expect(await collectedItems(db).findOne({ _id: "run:1" })).toMatchObject({ status: "dropped", step: "title", reason: expect.stringContaining("under 4 words") });
    expect(result.funnel.pooled).toBe(2);
  });

  it("saves replication before merging: copies, sources and independent publishers, reposts not counted", async () => {
    await db.collection("source_map").insertMany([
      { location_id: "test", source_id: "a1", url: "https://herald.example/news/", status: "active" },
      { location_id: "test", source_id: "a2", url: "https://herald.example/police/", status: "active" },
      { location_id: "test", source_id: "b", url: "https://city.example/", status: "active" },
      { location_id: "test", source_id: "c", url: "https://rewrites.example/", status: "active", source_tier: "repost" },
    ]);
    const title = "Fixture council approves the park budget";
    const result = await pool([
      { title, source: "a1", source_url: "https://herald.example/1" },
      { title, source: "a2", source_url: "https://herald.example/2" },
      { title, source: "b", source_url: "https://city.example/1" },
      { title, source: "c", source_url: "https://rewrites.example/1" },
    ]);
    expect(result.funnel.after_merge).toBe(1);
    expect(result.funnel.merged_copies).toBe(3);
    const items = await collectedItems(db).find().toArray();
    for (const item of items) expect(item.replication).toEqual({ copies: 4, sources: 4, independent: 2, publishers: ["herald.example", "city.example"] });
  });

  it("scores independent confirmation, not copies", () => {
    expect(independentBonus(1)).toBe(0);
    expect(independentBonus(2)).toBe(1.5);
    expect(independentBonus(4)).toBe(3);
    expect(independentBonus(20)).toBe(3);
  });
});

describe("the local pre-ranker", () => {
  it("rates with named rules on the model's scale", () => {
    const pre = preRate({ id: "s", title: "Fixture council votes on water levy", kind: "local_news", tier: "local", source_tier: "official", section: "civic", first_date: "2026-11-08", occurrences: 1, independent: 3 }, { today: "2026-11-09" });
    expect(pre.rating).toMatchObject({ civic: 2, appeal: 3, special: 2, category: "government_and_policy" });
    expect(pre.score).toBe(2 * 3 + 3 * 2 + 2);
    expect(pre.rules).toContain("civic +1: official source");
    expect(pre.rules).toContain("appeal +1: 3 independent publishers");
  });

  it("treats routine events as not special, and learns from editors only with enough reviews", () => {
    expect(preRate({ id: "e", title: "Weekly storytime", kind: "event", first_date: "2026-11-10", occurrences: 4 }, { today: "2026-11-09" }).rating.special).toBe(0);
    expect(editorSignal({ accepted: 4, rejected: 0 })).toBe(0);
    expect(editorSignal({ accepted: 7, rejected: 2 })).toBe(1);
    expect(editorSignal({ accepted: 1, rejected: 5 })).toBe(-1);
  });

  it("measures agreement by rank", () => {
    expect(rankAgreement([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(rankAgreement([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1);
    expect(rankAgreement([1, 2], [1, 2])).toBeNull();
  });

  it("stands in when the model gives no rating", async () => {
    const model = new FakeModel(() => new ModelUnavailableError("Gemini reached this run's limit"));
    const candidates = [{ id: "a", title: "A", occurrences: 1, venues: [], first_date: "2026-11-09", kind: "local_news" }];
    const [ranked] = await rank(model, candidates, () => ({ id: "a", category: "other", civic: 3, appeal: 3, special: 3 }));
    expect(ranked[0]).toMatchObject({ rated_by: "pre_ranker", score: 18 });
    const [old] = await rank(model, candidates);
    expect(old[0].rated_by).toBe("rule");
  });
});

describe("story reviews", () => {
  async function seedRun() {
    await db.collection(COLLECTIONS.runs).insertOne({ _id: "run", location_id: "test", location_name: "Test, WA", today: "2026-11-09", source_snapshot: [{ source_id: "s1", url: "https://herald.example/" }] } as never);
    await collectedItems(db).insertMany([
      { _id: "run:1", run_id: "run", location_id: "test", source_id: "s1", source_name: "Herald", title: "Fire destroys mobile home", url: "https://herald.example/a?utm_source=x", event_date: "2026-11-08", status: "published", reason: null, step: "authoring", facts: null, created_at: 1, rank: 1, replication: { copies: 2, sources: 2, independent: 1, publishers: ["herald.example"] } },
      { _id: "run:2", run_id: "run", location_id: "test", source_id: "s2", source_name: "Herald police", title: "Fire destroys mobile home", url: "https://www.herald.example/a?utm_source=x", event_date: "2026-11-08", status: "dropped", reason: "merged", step: "merge", facts: null, created_at: 1 },
      { _id: "run:3", run_id: "run", location_id: "test", source_id: "s1", source_name: "Herald", title: "Herald", url: "https://herald.example/", event_date: null, status: "dropped", reason: 'title is only the site\'s name ("Herald")', step: "reader", facts: null, created_at: 1 },
    ] as CollectedItem[]);
  }

  it("checks a review: a reason from the decision's list, and an explanation for Other", () => {
    expect(storyReviewChange({ decision: "accept", reason_code: "SA1" })).toEqual({ decision: "accept", reason_code: "SA1", reason: null });
    expect(() => storyReviewChange({ decision: "accept", reason_code: "SR1" })).toThrow("doesn't belong");
    expect(() => storyReviewChange({ decision: "reject" })).toThrow("choose a reason");
    expect(() => storyReviewChange({ decision: "reject", reason_code: "SR8" })).toThrow("explain the Other reason");
    expect(storyReviewChange({ decision: null, reason_code: "SA1", reason: "x" })).toEqual({ decision: null, reason_code: null, reason: null });
  });

  it("saves one decision for every copy of a link, keeps history, and exports it", async () => {
    await seedRun();
    const saved = await saveStoryReview(db, "run", "run:2", { decision: "accept", reason_code: "SA2", reason: "Residents need this" }, "editor@example.org");
    expect(saved).toMatchObject({ item_ids: ["run:1", "run:2"], source_names: ["Herald", "Herald police"], story_date: "2026-11-08", location_name: "Test, WA", pipeline_status: "published", by: "editor@example.org" });
    const csv = storyReviewCsv(await reviewedStories(db, { locationId: "test" }), "2026-11-10T00:00:00.000Z");
    const [header, row] = csv.trim().split("\r\n");
    expect(header).toBe(CSV_COLUMNS.join(","));
    expect(row.startsWith('"Test, WA",test,run,2026-11-09,')).toBe(true);
    expect(row).toContain("2026-11-10T00:00:00.000Z");
    expect(row).toContain("Fire destroys mobile home");
    expect(row).toContain("SA2");
    expect(await db.collection("story_reviews").countDocuments()).toBe(1);
    await saveStoryReview(db, "run", "run:1", { decision: null, reason_code: null, reason: null }, "editor@example.org");
    expect(await reviewedStories(db, { runId: "run" })).toHaveLength(0);
    expect(await db.collection("story_reviews").countDocuments()).toBe(2);
  });

  it("guards CSV cells against spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell('say "hi", then')).toBe('"say ""hi"", then"');
    expect(csvCell(["a", "b"])).toBe("a; b");
    expect(csvCell(null)).toBe("");
  });

  it("counts editors' decisions per source for the pre-ranker", async () => {
    await seedRun();
    await saveStoryReview(db, "run", "run:1", { decision: "reject", reason_code: "SR6", reason: null }, "editor@example.org");
    expect((await sourceAcceptRates(db, "test")).get("s1")).toEqual({ accepted: 0, rejected: 1 });
  });

  it("lists every link once with its copies, the sources' findings, and the review", async () => {
    await seedRun();
    await saveStoryReview(db, "run", "run:1", { decision: "accept", reason_code: "SA1", reason: null }, "editor@example.org");
    const page = await pulledStories(db, "run");
    expect(page.summary).toMatchObject({ items: 3, links: 2, repeated_links: 1, repeated_copies: 1, title_rejected: 1, reviewed: { accept: 1, reject: 0 } });
    expect(page.groups[0]).toMatchObject({ status: "published", copies: 2, sources: 2, review: { decision: "accept", reason_code: "SA1" } });
    expect(page.sources.find((source) => source.source_id === "s1")).toMatchObject({ found: 2, kept: 1, dropped: 1, published: 1, reasons: [{ reason: 'title is only the site\'s name ("…")', count: 1 }] });
    expect((await pulledStories(db, "run", { decision: "unreviewed" })).groups.map((group) => group.title)).toEqual(["Herald"]);
    expect((await pulledStories(db, "run", { reason: "site's name" })).total).toBe(1);
    expect(reasonKind(null, "reader")).toBe("left out by the reader");
  });
});
