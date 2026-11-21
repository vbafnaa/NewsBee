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
async function read(pages: Record<string, string>, depth: 1 | 2, extra: Partial<ConnectorContext> = {}, params: Record<string, unknown> = {}) {
  const transport = site(pages);
  const dropped: DroppedItem[] = [];
  const record = sourceResult("web:town", "Town", "ingested", "");
  const context = { today: "2026-11-09", transport, fetcher: new Fetcher(transport, undefined, false), settings: loadSettings({ NEWSBEE_MODE: "local" }), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, db, location: { id: "town", name: "Town, WA", community: { name: "Town" } }, ...extra } as unknown as ConnectorContext;
  const items = await withRunContext({ db, runId: "run", locationId: "town", options: { ...defaultRunOptions({}), paid: {}, scrape_depth: depth } },
    () => readSite({ type: "web", source_id: "web:town", name: "Town", params: { url: ROOT, ...params } }, context, record, dropped));
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

  it("follows only the links in a listing's own content, never its menus, header, sidebar or footer", () => {
    const html = `<body><header><a href="/events/header-promo">Promo</a></header><nav><a href="/events/menu-item">Menu</a><a href="/news/2026/11/08/nav-story">Nav</a></nav>
      <main><a href="/events/fall-festival">Fall</a><a href="/news/2026/11/08/x">X</a></main><aside><a href="/events/sidebar-thing">Side</a></aside><footer><a href="/events/footer-thing">Foot</a></footer></body>`;
    expect(deepLinks(html, `${ROOT}events`, 10).map((url) => new URL(url).pathname).sort()).toEqual(["/events/fall-festival", "/news/2026/11/08/x"]);
    // Listing pages themselves are still found in the home page's menus.
    expect(listingLinks(`<nav><a href="/events">Events</a></nav>`, ROOT, 4).map((link) => link.kind)).toEqual(["events"]);
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
    // Each depth-2 item names the page its link was on.
    expect(items.find((item) => item.title === "Fall Festival")).toMatchObject({ found_on: `${ROOT}events`, found_via: "listing link (events)" });
    expect(items.find((item) => item.title.startsWith("Town park"))?.found_on).toBe(`${ROOT}news`);
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

  // Found by running depth 2 on Moses Lake's live websites.
  it("doesn't take degree, service or staff pages for listings", () => {
    const html = `<a href="/academics/programs-degrees.html">Programs &amp; Degrees</a><a href="/voluntary-stewardship-program">Voluntary Stewardship Program</a>
      <a href="/our-team">Meet the team</a><a href="/about">Washington Interscholastic Activities Association</a><a href="/events.html">Events</a>`;
    expect(listingLinks(html, ROOT, 10).map((link) => new URL(link.url).pathname)).toEqual(["/events.html"]);
  });

  it("reads an event page whose schema.org event has no link of its own (Wix event pages)", async () => {
    const wix = {
      [ROOT]: `<html><head><title>Town</title></head><body><a href="/events">Events</a></body></html>`,
      [`${ROOT}events`]: `<html><head><title>Events | Town</title></head><body><a href="/events/tree-lighting">Tree Lighting</a></body></html>`,
      [`${ROOT}events/tree-lighting`]: `<html><head><title>Tree Lighting | Town</title><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Event",
        name: "Downtown Tree Lighting", startDate: "2026-11-20T16:00:00-08:00", location: { "@type": "Place", name: "Sinkiuse Square", address: "306 Ash Street" } })}</script></head><body></body></html>`,
    };
    const { items } = await read(wix, 2);
    expect(items).toEqual([expect.objectContaining({ title: "Downtown Tree Lighting", kind: "event", event_date: "2026-11-20", source_url: `${ROOT}events/tree-lighting`, crawl_depth: 2, section_hint: "events" })]);
  });

  it("keeps stories on sites that put each page's title in og:site_name", async () => {
    const named = (title: string, day?: string) => `<html><head><title>${title}</title><meta property="og:title" content="${title}"><meta property="og:site_name" content="${title}">${day ? `<meta property="article:published_time" content="${day}T09:00:00Z">` : ""}</head><body><a href="/news">News</a><article><p>${`${title}. `.repeat(30)}</p></article></body></html>`;
    const college = {
      [ROOT]: named("Home - Town College"),
      [`${ROOT}news`]: `<html><head><title>News | Town College</title></head><body><a href="/news/nursing-accreditation">Nursing</a></body></html>`,
      [`${ROOT}news/nursing-accreditation`]: named("Nursing program earns continued national accreditation", "2026-11-08"),
    };
    const { items, dropped } = await read(college, 2);
    expect(items.map((item) => item.title)).toEqual(["Nursing program earns continued national accreditation"]);
    expect(dropped.some((item) => item.reason?.startsWith("title is only the site's name"))).toBe(false);
  });

  it("reads a listing page's own RSS feed as a feed, not as a page", async () => {
    const withRss = {
      [ROOT]: `<html><head><title>Town</title></head><body><a href="/events">Events</a></body></html>`,
      [`${ROOT}events`]: `<html><head><title>Events | Town</title></head><body><a href="/events/_data/current.rss">RSS</a></body></html>`,
      [`${ROOT}events/_data/current.rss`]: `<rss><channel><item><title>Winter concert tickets on sale now</title><link>${ROOT}events/winter-concert</link><pubDate>Sun, 08 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`,
    };
    expect(deepLinks(withRss[`${ROOT}events`], `${ROOT}events`, 10)).toEqual([]);
    const { items, dropped } = await read(withRss, 2);
    expect(items).toEqual([expect.objectContaining({ title: "Winter concert tickets on sale now", crawl_depth: 2, section_hint: "events" })]);
    expect(dropped.some((item) => item.reason === "undated")).toBe(false);
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

  it("in agentic runs, the agent reads an events page that carries only an old publish date, and keeps upcoming events", async () => {
    const page = (title: string, day: string, text: string) => `<html><head><title>${title} | Town</title><meta property="og:title" content="${title}"><meta property="article:published_time" content="${day}T09:00:00Z"></head><body><main><p>${text}</p></main></body></html>`;
    const finals = {
      [ROOT]: `<html><head><title>Town</title></head><body><a href="/events">Events</a></body></html>`,
      [`${ROOT}events`]: `<html><head><title>Events | Town</title></head><body><a href="/events/2026-state-volleyball">Volleyball</a><a href="/events/2024-state-cheer">Cheer</a></body></html>`,
      [`${ROOT}events/2026-state-volleyball`]: page("2026 State Volleyball", "2026-07-24", "The 2026 state volleyball tournament is November 13-14, 2026 at the SunDome."),
      [`${ROOT}events/2024-state-cheer`]: page("2024 State Cheer", "2024-02-01", "The 2024 state cheer championship was held in February."),
    };
    const agentModel = new FakeModel(() => ({ items: [{ title: "State volleyball tournament", date: "2026-11-13", summary: "The state volleyball tournament at the SunDome.", quote: "The 2026 state volleyball tournament is November 13-14, 2026" }] }));
    const { items, dropped } = await read(finals, 2, { agentModel } as never);
    expect(items).toEqual([expect.objectContaining({ title: "State volleyball tournament", kind: "event", event_date: "2026-11-13", extracted_by: "agent", crawl_depth: 2, section_hint: "events" })]);
    // A page that names only past years isn't worth a model call.
    expect(agentModel.calls).toHaveLength(1);
    // What was left out keeps where it was found too.
    expect(dropped).toEqual(expect.arrayContaining([expect.objectContaining({ title: "2024 State Cheer", reason: "outside_window", crawl_depth: 2, found_on: `${ROOT}events` })]));
    // Without the agent, the publish date is all there is.
    expect((await read(finals, 2)).items).toEqual([]);
  });

  it("follows the links on one page an editor accepted, one level deeper, without reading the rest of the site", async () => {
    const story = `${ROOT}news/2026/11/08/park-reopens`;
    const accepted = {
      [ROOT]: event("Home Page Event", "2026-11-12T10:00"),
      [story]: `<html><head><title>Park reopens | Town</title></head><body><nav><a href="/news/2026/11/01/menu-story-in-the-nav">Menu</a></nav>
        <main><p>The park reopens. See <a href="/events/ribbon-cutting">the ribbon cutting</a> and <a href="/news/2026/11/07/new-playground-opens-today">the playground</a>.</p></main>
        <footer><a href="/news/2026/11/02/footer-link-story-here">Footer</a></footer></body></html>`,
      [`${ROOT}events/ribbon-cutting`]: event("Ribbon Cutting", "2026-11-14T10:00"),
      [`${ROOT}news/2026/11/07/new-playground-opens-today`]: article("New playground opens at Town park", "2026-11-07"),
      [`${ROOT}news/2026/11/01/menu-story-in-the-nav`]: article("A story only the menu links to", "2026-11-05"),
      [`${ROOT}news/2026/11/02/footer-link-story-here`]: article("A story only the footer links to", "2026-11-05"),
    };
    const { items, record } = await read(accepted, 1, {}, { follow_page: story, follow_depth: 2, follow_section: "news", follow_title: "Park reopens" });
    expect(items.map((item) => [item.title, item.crawl_depth, item.found_on, item.found_via]).sort()).toEqual([
      ["New playground opens at Town park", 3, story, "link on a page an editor accepted"],
      ["Ribbon Cutting", 3, story, "link on a page an editor accepted"],
    ]);
    // Only that page and its links were read: not the home page, nor the menu and footer links.
    expect(record.detail).toContain(`the links on ${story}, 2 pages at depth 3`);
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
      facts: { kind: "event", description: "A festival in the park.", venue: "City Park", schedule_text: "November 15, 10 am", tier: "local", crawl_depth: 2, found_by: "listing link (events)", found_on: `${ROOT}events`, section_hint: "events" },
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
      description: "A festival in the park.", kind: "event", venue: "City Park", crawl_depth: 2, found_on_page: `${ROOT}events`, found_via: "listing link (events)", followed_by: null,
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
