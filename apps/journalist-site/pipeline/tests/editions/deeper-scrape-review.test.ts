import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readSite } from "../../connectors/web";
import { deepLinks, listingLinks } from "../../connectors/web/page";
import { Fetcher } from "../../connectors/fetcher";
import { sourceResult, type ConnectorContext, type DroppedItem } from "../../connectors/types";
import { loadSettings } from "../../core/config";
import { defaultRunOptions, resolveRunOptions, withRunContext } from "../../core/run-options";
import type { HttpTransport } from "../../core/http";
import { collectedItems, type CollectedItem } from "../../editions/assemble";
import { saveText } from "../../editions/details";
import { CSV_COLUMNS, reviewedStories, saveStoryReview, storyReviewCsv, storyReviewJsonl } from "../../editions/story-reviews";
import { STORY_REASONS } from "../../editions/story-reasons";
import { pulledStories } from "../../editions/pulled";
import { COLLECTIONS } from "../../storage/mongo";
import { FakeModel } from "../support/fake-model";

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("deeper-scrape-review"); });
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => { await db.dropDatabase(); });

const ROOT = "https://town.example/";
const event = (name: string, start: string) => `<html><head><title>${name}</title><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Event", name, startDate: start, url: `${ROOT}events/${name.toLowerCase().replace(/\W+/g, "-")}`, location: { "@type": "Place", name: "City Park" } })}</script></head><body><p>${name}</p></body></html>`;
const article = (title: string, day: string) => `<html><head><title>${title} | Town</title><meta property="og:title" content="${title}"><meta property="article:published_time" content="${day}T09:00:00Z"></head><body><article><p>${`${title}. `.repeat(30)}</p></article></body></html>`;
function site(pages: Record<string, string>): HttpTransport {
  return async (request) => {
    const body = request.url.endsWith("robots.txt") ? "User-agent: *\nAllow: /\n" : pages[request.url];
    return { url: request.url, status: body ? 200 : 404, headers: {}, body: new TextEncoder().encode(body ?? "") };
  };
}
async function read(pages: Record<string, string>, depth: 1 | 2, extra: Partial<ConnectorContext> = {}) {
  const transport = site(pages);
  const dropped: DroppedItem[] = [];
  const record = sourceResult("web:town", "Town", "ingested", "");
  const context = { today: "2026-11-09", transport, fetcher: new Fetcher(transport, undefined, false), settings: loadSettings({ NEWSBEE_MODE: "local" }), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, db, location: { id: "town", name: "Town, WA", community: { name: "Town" } }, ...extra } as unknown as ConnectorContext;
  const items = await withRunContext({ db, runId: "run", locationId: "town", options: { ...defaultRunOptions({}), paid: {}, scrape_depth: depth } },
    () => readSite({ type: "web", source_id: "web:town", name: "Town", params: { url: ROOT } }, context, record, dropped));
  return { items, dropped, record };
}

describe("finding listing pages and what they list", () => {
  it("finds listing pages, events first, and never a single story", () => {
    const html = `<a href="/news">News</a><a href="/about">About</a><a href="/calendar">Calendar</a><a href="/athletics/schedule">Schedule</a>
      <a href="/news/2026/11/08/park-reopens">Park</a><a href="/news/council-votes-on-new-park-budget-tonight">Council</a><a href="https://other.example/events">Elsewhere</a>`;
    expect(listingLinks(html, ROOT, 10).map((link) => [new URL(link.url).pathname, link.kind, link.section])).toEqual([
      ["/calendar", "events", "events"], ["/athletics/schedule", "sports", "sports"], ["/news", "news", null],
    ]);
  });

  it("follows the pages below a listing and story-like links", () => {
    const html = `<a href="/events/fall-festival">Fall</a><a href="/events">All events</a><a href="/news/2026/11/08/x">X</a><a href="/privacy">Privacy</a>`;
    expect(deepLinks(html, `${ROOT}events`, 10).map((url) => new URL(url).pathname).sort()).toEqual(["/events/fall-festival", "/news/2026/11/08/x"]);
  });
});

describe("website depth", () => {
  const pages = {
    [ROOT]: `<html><head><title>Town</title></head><body><a href="/events">Events</a><a href="/news">News</a></body></html>`,
    [`${ROOT}events`]: `<html><head><title>Events | Town</title></head><body><a href="/events/fall-festival">Fall Festival</a><a href="/events/book-sale">Book sale</a></body></html>`,
    [`${ROOT}events/fall-festival`]: event("Fall Festival", "2026-11-15T10:00"),
    [`${ROOT}events/book-sale`]: event("Book Sale", "2026-11-20T09:00"),
    [`${ROOT}news`]: `<html><head><title>News | Town</title></head><body><a href="/news/2026/11/08/park-reopens">Park reopens</a><a href="/news/2025/01/02/old-story">Old</a></body></html>`,
    [`${ROOT}news/2026/11/08/park-reopens`]: article("Town park reopens after repairs", "2026-11-08"),
  };

  it("depth 1 stays on the home page's own links", async () => {
    const { items } = await read(pages, 1);
    expect(items).toEqual([]);
  });

  it("depth 2 reads listing pages, events first, and the stories and events they link to", async () => {
    const { items, dropped, record } = await read(pages, 2);
    expect(items.map((item) => [item.title, item.kind, item.crawl_depth, item.section_hint])).toEqual(expect.arrayContaining([
      ["Fall Festival", "event", 2, "events"], ["Book Sale", "event", 2, "events"], ["Town park reopens after repairs", "local_news", 2, null],
    ]));
    expect(items.find((item) => item.title.startsWith("Town park"))?.found_by).toBe("listing link (news)");
    // The listing pages are shown with what was followed; the old story is never fetched.
    expect(dropped.map((item) => item.reason)).toEqual(expect.arrayContaining(["listing page (events): 2 links followed (depth 2)", "listing page (news): 1 links followed (depth 2)"]));
    expect(record.pages_checked.some((url) => url.includes("old-story"))).toBe(false);
    expect(record.detail).toContain("2 listing pages, 3 pages at depth 2");
  });

  it("still reads event listings when the site has a news feed", async () => {
    const withFeed = {
      ...pages,
      [ROOT]: `<html><head><title>Town</title><link type="application/rss+xml" rel="alternate" href="/feed"></head><body><a href="/events">Events</a></body></html>`,
      [`${ROOT}feed`]: `<rss><channel><item><title>Library hours change for winter</title><link>${ROOT}news/hours</link><pubDate>Sun, 08 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`,
    };
    const { items, record } = await read(withFeed, 2);
    expect(items.map((item) => item.title).sort()).toEqual(["Book Sale", "Fall Festival", "Library hours change for winter"]);
    expect(record.detail).toContain("1 event listing pages, 2 pages at depth 2");
  });

  it("in agentic runs, the agent reads a listing page with nothing to follow, with a verbatim quote per item", async () => {
    const quiet = {
      [ROOT]: `<html><head><title>Town</title></head><body><a href="/events">Events</a></body></html>`,
      [`${ROOT}events`]: `<html><head><title>Events | Town</title></head><body><main><p>Pumpkin Walk at City Park on November 14, 2026 from 5 pm.</p></main></body></html>`,
    };
    const agentModel = new FakeModel(() => ({ items: [{ title: "Pumpkin Walk", date: "2026-11-08", summary: "A pumpkin walk at City Park.", quote: "Pumpkin Walk at City Park on November 14, 2026" }] }));
    const { items } = await read(quiet, 2, { agentModel } as never);
    expect(items).toEqual([expect.objectContaining({ title: "Pumpkin Walk", extracted_by: "agent", found_via: "listing page (events)", crawl_depth: 1, section_hint: "events" })]);
  });

  it("is a run option: 2 by default for new runs, 1 or 2 only", () => {
    expect(defaultRunOptions({}).scrape_depth).toBe(2);
    expect(defaultRunOptions({ NEWSBEE_SCRAPE_DEPTH: "1" }).scrape_depth).toBe(1);
    expect(resolveRunOptions({ scrape_depth: 1 }, {}).scrape_depth).toBe(1);
    expect(() => resolveRunOptions({ scrape_depth: 3 }, {})).toThrow("Website depth must be one of: 1, 2");
  });
});

describe("reviewing with a category and exporting everything", () => {
  async function seed() {
    await db.collection(COLLECTIONS.runs).insertOne({ _id: "run", location_id: "town", location_name: "Town, WA", today: "2026-11-09", window: ["2026-11-09", "2026-11-15"], draft_id: "run",
      options: { ...defaultRunOptions({}), flow: "agentic", scrape_depth: 2 }, playbook_version: "pb1",
      source_snapshot: [{ source_id: "web:town", name: "Town", url: ROOT, reader: "web", status: "active", section: "news", found_by: "government", detail: "", tier: "official", topics: [], collected: true, skip_reason: null }] } as never);
    await collectedItems(db).insertOne({ _id: "run:1", run_id: "run", location_id: "town", source_id: "web:town", source_name: "Town", title: "Fall Festival", url: `${ROOT}events/fall-festival`, event_date: "2026-11-15",
      status: "dropped", reason: "event venue outside neighborhood: City Park", step: "locality", created_at: 1, story_id: "s1",
      facts: { kind: "event", description: "A festival in the park.", venue: "City Park", schedule_text: "November 15, 10 am", tier: "local", crawl_depth: 2, found_by: "listing link (events)", section_hint: "events" },
      model_rating: { rated_by: "model", category: "arts_and_culture", civic: 1, appeal: 3, special: 2 }, pre_rank: { score: 11, civic: 0, appeal: 3, special: 2, rules: ["appeal +1: names the place"], policy: "pre_ranker_v1" } } as unknown as CollectedItem);
    await saveText(db, `${ROOT}events/fall-festival`, "The Fall Festival returns to City Park with music, food trucks and a pumpkin contest for families.", { canonical_url: `${ROOT}events/fall-festival`, reuse_allowed: true });
    await db.collection("story_details").insertOne({ _id: "town:s1:details_v2_supported", details: { people: ["Mayor Lee"], organisations: [], places: ["City Park"], when: "Nov 15", numbers: [], what: ["festival"], why: null, quote: null, next_step: null } } as never);
    await db.collection(COLLECTIONS.editionEntries).insertOne({ edition_id: "run", story_id: "s1", disposition: "checks_passed", result: { draft: { headline: "Fall Festival returns", summary: "Music and food at City Park." } } });
  }

  it("has more reasons, each code used once", () => {
    const codes = [...STORY_REASONS.accept, ...STORY_REASONS.reject].map((reason) => reason.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual(expect.arrayContaining(["SA6", "SA12", "SR9", "SR15"]));
  });

  it("keeps the category, whether the editor overruled the pipeline, and a full snapshot", async () => {
    await seed();
    const saved = await saveStoryReview(db, "run", "run:1", { decision: "accept", reason_code: "SA3", reason: null, category: "events" }, "editor@example.org");
    expect(saved).toMatchObject({ category: "events", pipeline_kept: false, disagrees: true, run_settings: { flow: "agentic", scrape_depth: 2, playbook_version: "pb1", window: ["2026-11-09", "2026-11-15"] } });
    expect(saved.story).toMatchObject({
      description: "A festival in the park.", kind: "event", venue: "City Park", crawl_depth: 2, found_on_page: "listing link (events)",
      sources: [{ source_id: "web:town", url: ROOT, reader: "web", tier: "official", found_by: "government" }],
      model_rating: { civic: 1, appeal: 3 }, details: { people: ["Mayor Lee"] }, writing: { headline: "Fall Festival returns" },
      text_excerpt: "The Fall Festival returns to City Park with music, food trucks and a pumpkin contest for families.",
    });
    expect((await pulledStories(db, "run")).groups[0].review).toMatchObject({ category: "events" });
  });

  it("exports one column per fact as CSV, and the whole snapshot as JSONL", async () => {
    await seed();
    await saveStoryReview(db, "run", "run:1", { decision: "accept", reason_code: "SA3", reason: "Big local event", category: "events" }, "editor@example.org");
    const docs = await reviewedStories(db, { runId: "run" });
    const [header, row] = storyReviewCsv(docs, "2026-11-10T00:00:00.000Z").trim().split("\r\n");
    expect(header.split(",")).toEqual(CSV_COLUMNS);
    expect(CSV_COLUMNS).toEqual(expect.arrayContaining(["editor_category", "editor_disagrees", "crawl_depth", "model_civic", "pre_rank_rules", "details_people", "written_headline", "text_excerpt", "website_depth"]));
    const cells = Object.fromEntries(CSV_COLUMNS.map((name, index) => [name, row.match(/("([^"]|"")*"|[^,]*)(,|$)/g)![index].replace(/,$/, "")]));
    expect(cells).toMatchObject({ editor_category: "events", editor_disagrees: "true", crawl_depth: "2", website_depth: "2", model_civic: "1", details_people: "Mayor Lee", written_headline: "Fall Festival returns", reason_note: "Big local event" });
    const line = JSON.parse(storyReviewJsonl(docs, "2026-11-10T00:00:00.000Z").trim());
    expect(line).toMatchObject({ id: "run:url:town.example/events/fall-festival", exported_at: "2026-11-10T00:00:00.000Z", category: "events", editor_category_label: "Events and things to do", story: { kind: "event" } });
  });
});
