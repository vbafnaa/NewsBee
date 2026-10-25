import { describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../core/config";
import { logger } from "../../core/log";
import { Fetcher } from "../../connectors/fetcher";
import { trendingConnector } from "../../connectors/wider";
import { resolveTrendRegion } from "../../connectors/wider/regions";
import { reportingSearches } from "../../connectors/wider/trend-discovery";
import { parseTrendReport } from "../../connectors/wider/trend-context";
import type { ConnectorContext, LocationProfile, SourceTask } from "../../connectors/types";
import { collapse, Story } from "../../editions/stories";
import { trending } from "../../ranking/wider";
import { COLLECTIONS } from "../../storage/mongo";
import { withMongo } from "../support/mongo";
import { ReplayTransport } from "../support/replay";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34" }]) }));

const mongo = withMongo();
const settings = loadSettings({ NEWSBEE_WIDER_SOURCES: "1" });
// A provider-style profile outside the reviewed state catalog.
const location: LocationProfile = {
  id: "osm-r123-or", name: "Hillside, Brookhaven, OR", state: "OR",
  latitude: 45.5, longitude: -122.6,
  community: {
    name: "Hillside", state: "OR", state_name: "Oregon", parent_id: "brookhaven-or", parent_name: "Brookhaven",
    latitude: 45.5, longitude: -122.6, aliases: ["Hill Side"], coverage_terms: ["Hillside", "Lower Hillside"],
    library_branches: ["Juniper Branch Library"], newsrooms: [],
  },
  systems: [{ name: "County libraries", fscskey: "one", branches: [{ name: "Juniper Branch Library", address: "20 Oak Lane" }] }],
};
const bsky: SourceTask = { source_id: "trending:bluesky", name: "Community reporting links", type: "trending" };
const wiki: SourceTask = { source_id: "trending:wikipedia", name: "Wikipedia-discovered local reporting", type: "trending" };
function context(replay: ReplayTransport, profile = location): ConnectorContext {
  return {
    location: profile, today: "2026-10-19", window: ["2026-10-20", "2026-10-26"], settings, db: mongo.db,
    transport: replay.transport, fetcher: new Fetcher(replay.transport), log: logger("community-reporting-test"),
    linkCache: { async get() { return null; }, async put() {}, async invalidate() {} },
  };
}
const posts = (...urls: string[]) => ({ posts: urls.map((url) => ({
  record: { createdAt: "2026-10-18" }, embed: { external: { uri: url } },
})) });
const article = (title: string, text: string, publisher = "Community News", day = "2026-10-18") =>
  `<meta property="og:site_name" content="${publisher}"><meta property="og:title" content="${title}"><meta property="article:published_time" content="${day}"><article><p>${text}</p></article>`;
const feed = (urls: string[]) => `<rss><channel>${urls.map((url) =>
  `<item><title>Local report</title><link>${url}</link><pubDate>Sun, 18 Oct 2026 12:00:00 GMT</pubDate></item>`).join("")}</channel></rss>`;
const branchText = "Juniper Branch Library will close for building repairs next week, with a temporary collection point and extended loan deadlines for its patrons.";
const queries = (replay: ReplayTransport) => replay.requests.filter(({ url }) => url.includes("searchPosts")).map(({ url }) => new URL(url).searchParams.get("q"));

describe("automated community reporting", () => {
  it("derives parent-qualified identities, aliases, coverage terms and selected venues without a state catalog", () => {
    const place = resolveTrendRegion(location, {});
    expect(place.configured).toBe(true);
    expect(reportingSearches(place).map(({ query }) => query)).toEqual([
      '"Hillside" "Brookhaven"', '"Lower Hillside" "Brookhaven"', '"Hill Side" "Brookhaven"', '"Juniper Branch Library" "Brookhaven"',
    ]);
    const large = structuredClone(location);
    large.community!.coverage_terms = Array.from({ length: 20 }, (_, n) => `Subarea ${n}`);
    large.systems[0].branches = Array.from({ length: 20 }, (_, n) => ({ name: `Branch ${n}`, address: `${n} Oak Lane` }));
    expect(reportingSearches(resolveTrendRegion(large, {}))).toHaveLength(6);
    large.community!.parent_name = large.community!.name;
    expect(reportingSearches(resolveTrendRegion(large, {}))[0].query).toBe('"Hillside" "Oregon"');
  });

  it("collects alias, subarea and venue reporting without Wikipedia, rejecting parent-only stories", async () => {
    const replay = new ReplayTransport().on(/searchPosts/, (request) => {
      const query = new URL(request.url).searchParams.get("q")!;
      const slug = query.includes("Juniper") ? "library" : query.includes("Lower") ? "subarea" : query.includes("Hill Side") ? "alias" : "city";
      return { body: posts(`https://news.example/${slug}`) };
    })
      .on("https://news.example/library", { body: article("Library repairs", branchText) })
      .on("https://news.example/subarea", { body: article("Lower Hillside park opens", "Lower Hillside has opened a new community park with accessible walking paths, picnic areas and a playground for families throughout the year.") })
      .on("https://news.example/alias", { body: article("Hill Side market opens", "Hill Side residents can visit a new weekly market featuring produce, local food vendors and community information stalls beginning this Saturday.") })
      .on("https://news.example/city", { body: article("Brookhaven budget update", "Brookhaven has published its annual citywide budget, with administrative spending and office supplies discussed at the latest council meeting.") });
    const result = await trendingConnector.collect(bsky, context(replay));
    expect(result.result.status).toBe("ingested");
    expect(result.events).toHaveLength(3);
    expect(result.events[0].title).toBe("Library repairs");
    expect(result.events.find(({ title }) => title === "Library repairs")?.community_relevance).toMatchObject({ method: "selected_venue", matches: ["Juniper Branch Library", "20 Oak Lane"] });
    expect(result.events.find(({ title }) => title === "Hill Side market opens")?.community_relevance).toMatchObject({ method: "community_mention", matches: ["Hill Side"] });
    expect(result.events.every(({ tier }) => tier === "local")).toBe(true);
    expect(queries(replay)).toHaveLength(4);
    expect(replay.requests.some(({ url }) => /wikipedia|wikimedia|getTrends/.test(url))).toBe(false);
    expect(result.result.discovery_errors).toEqual([]);
  });

  it("uses discovered feeds even when all social searches fail, and exposes partial failures", async () => {
    const profile = structuredClone(location);
    profile.community!.newsrooms = [
      { name: "Community News", feed: "https://local.example/feed" },
      { name: "Duplicate", feed: "https://local.example/feed" },
    ];
    const replay = new ReplayTransport()
      .on("https://local.example/feed", { body: feed(["https://local.example/library", "https://local.example/unrelated"]) })
      .on("https://local.example/library", { body: article("Library repairs", branchText) })
      .on("https://local.example/unrelated", { body: article("Brookhaven meeting", "Brookhaven council members discussed administrative matters and the citywide budget during their regular meeting at city hall on Tuesday evening.") });
    const result = await trendingConnector.collect(bsky, context(replay, profile));
    expect(result.result.status).toBe("ingested");
    expect(result.events.map(({ title }) => title)).toEqual(["Library repairs"]);
    expect(result.result.discovery_errors).toHaveLength(4);
    expect(result.result.publisher_feeds).toEqual(["https://local.example/feed"]);
    expect(replay.requests.filter(({ url }) => url === "https://local.example/feed")).toHaveLength(1);
  });

  it("retains public-source protections for publisher feeds and reports complete discovery failure", async () => {
    const profile = structuredClone(location);
    profile.community!.newsrooms = [{ name: "Blocked News", feed: "https://blocked.example/feed" }];
    const replay = new ReplayTransport().on("https://blocked.example/robots.txt", { body: "User-agent: *\nDisallow: /" });
    const blocked = await trendingConnector.collect(bsky, context(replay, profile));
    expect(blocked.result.status).toBe("failed");
    expect(blocked.result.detail).toContain("robots.txt disallows");
    expect(replay.requests.some(({ url }) => url === "https://blocked.example/feed")).toBe(false);
    profile.community!.newsrooms = [{ name: "Invalid News", feed: "https://127.0.0.1/feed" }];
    const invalid = await trendingConnector.collect(bsky, context(replay, profile));
    expect(invalid.result.status).toBe("failed");
    expect(invalid.result.detail).toContain("non-public address");
    expect(replay.requests.some(({ url }) => url.includes("127.0.0.1"))).toBe(false);
  });

  it("deduplicates across search/feed discovery and newsroom collection", async () => {
    const profile = structuredClone(location);
    profile.community!.newsrooms = [{ name: "Community News", feed: "https://local.example/feed" }];
    const url = "https://news.example/library";
    const replay = new ReplayTransport().on(/searchPosts/, { body: posts(url) })
      .on("https://local.example/feed", { body: feed([url]) })
      .on(url, { body: article("Hillside library repairs", `${branchText} Hillside residents should check opening hours.`) });
    const result = await trendingConnector.collect(bsky, context(replay, profile));
    expect(result.events).toHaveLength(1);
    expect(replay.requests.filter((request) => request.url === url)).toHaveLength(1);
    const stories = collapse([
      { source_id: bsky.source_id, facts: result.events[0] },
      { source_id: "statenews", facts: { ...result.events[0], title: "Alternate feed headline", kind: "state_news", trend_context: undefined } },
      { source_id: wiki.source_id, facts: { ...result.events[0], kind: "trending_topic" } },
    ]);
    expect(stories).toHaveLength(1);
    expect(stories[0].occurrences).toHaveLength(3);
    const newsroom = { source_id: "statenews", facts: { ...result.events[0], title: "Alternate feed headline", kind: "state_news", trend_context: undefined } };
    expect(stories[0].id).toBe(collapse([newsroom])[0].id);
    expect(collapse([newsroom, { source_id: bsky.source_id, facts: result.events[0] }])[0].id).toBe(stories[0].id);
  });

  it("samples every search, keeps every fetched article and respects the article-fetch budget", async () => {
    const profile = structuredClone(location);
    profile.community!.coverage_terms = ["Hillside", "Subarea A", "Subarea B", "Subarea C"];
    profile.systems[0].branches.push({ name: "Cedar Branch", address: "22 Oak Lane" });
    profile.community!.newsrooms = Array.from({ length: 4 }, (_, index) => ({ name: `Publisher ${index}`, feed: `https://local.example/feed-${index}` }));
    const replay = new ReplayTransport().on(/searchPosts/, (request) => {
      const topic = new URL(request.url).searchParams.get("q")!.split('"')[1];
      return { body: posts(...Array.from({ length: 3 }, (_, n) => `https://news.example/${encodeURIComponent(topic)}/${n}`)) };
    }).on(/https:\/\/local\.example\/feed-/, (request) => ({ body: feed(Array.from({ length: 3 }, (_, n) => `https://news.example/feed-${request.url.at(-1)}/${n}`)) }))
      .on(/^https:\/\/news\.example\//, (request) => {
        const topic = decodeURIComponent(new URL(request.url).pathname.split("/")[1]);
        return { body: article(`${topic} service update`, `${topic} Hillside residents can use the extended community opening hours announced this week, with additional services available on Saturday.`, topic) };
      });
    const result = await trendingConnector.collect(bsky, context(replay, profile));
    expect(queries(replay)).toHaveLength(6);
    expect(replay.requests.filter(({ url }) => /local\.example\/feed-/.test(url))).toHaveLength(3);
    expect(replay.requests.filter(({ url }) => url.startsWith("https://news.example/") && !url.endsWith("robots.txt"))).toHaveLength(12);
    expect(result.events).toHaveLength(12);
    expect(new Set(result.events.map(({ source_url }) => source_url)).size).toBe(12);
    expect(result.events.some(({ title }) => title.includes("Juniper"))).toBe(true);
  });

  it("resolves real Wikipedia titles, excludes other places and invalidates caches when coverage changes", async () => {
    const replay = new ReplayTransport()
      .on(/en\.wikipedia\.org\/w\/api\.php/, { body: { query: { pages: {
        "1": { title: "Hillside (Brookhaven)", extract: "Hillside is a neighborhood of Brookhaven in Oregon." },
        "2": { title: "Hillside, Other State", extract: "Hillside is a town in a different state." },
        "3": { title: "Brookhaven", extract: "Brookhaven is a large municipality." },
      } } } })
      .on(/metrics\/pageviews\/per-article/, { body: { items: Array.from({ length: 17 }, (_, n) => ({ timestamp: `202610${String(n + 1).padStart(2, "0")}00`, views: 100 })) } });
    const ctx = context(replay);
    const first = await trendingConnector.collect(wiki, ctx);
    expect(first.result.status).toBe("ingested");
    expect(first.events).toEqual([]);
    expect(first.result.skipped_unusable.not_trending).toBe(1);
    const wikiRequests = () => replay.requests.filter(({ url }) => url.includes("/w/api.php"));
    expect(wikiRequests()).toHaveLength(1);
    expect(new URL(wikiRequests()[0].url).searchParams.get("gsrsearch")).toBe('"Hillside" "Brookhaven"');
    expect(replay.requests.filter(({ url }) => url.includes("/per-article/")).map(({ url }) => decodeURIComponent(url))).toEqual([
      expect.stringContaining("/Hillside_(Brookhaven)/"),
    ]);
    expect(replay.requests.some(({ url }) => url.includes("/top/"))).toBe(false);
    await trendingConnector.collect(wiki, ctx);
    expect(wikiRequests()).toHaveLength(1);
    const changed = structuredClone(location);
    changed.community!.coverage_terms.push("New subarea");
    await trendingConnector.collect(wiki, context(replay, changed));
    expect(wikiRequests()).toHaveLength(2);
  });

  it("reports Wikipedia discovery failures without caching them or blocking independent reporting", async () => {
    const replay = new ReplayTransport().on(/en\.wikipedia\.org\/w\/api\.php/, { body: { error: { code: "unavailable" } } })
      .on(/searchPosts/, { body: posts("https://news.example/library") })
      .on("https://news.example/library", { body: article("Library repairs", branchText) });
    expect((await trendingConnector.collect(wiki, context(replay))).result.status).toBe("failed");
    expect(await mongo.db.collection(COLLECTIONS.wideCache).countDocuments()).toBe(0);
    expect((await trendingConnector.collect(bsky, context(replay))).events).toHaveLength(1);
  });

  it("distinguishes an absent encyclopedia page from malformed discovery responses", async () => {
    const empty = new ReplayTransport().on(/en\.wikipedia\.org\/w\/api\.php/, { body: { batchcomplete: "" } });
    expect((await trendingConnector.collect(wiki, context(empty))).result.status).toBe("ingested");
    const changed = structuredClone(location);
    changed.community!.coverage_terms.push("New coverage");
    const malformed = new ReplayTransport().on(/en\.wikipedia\.org\/w\/api\.php/, { body: {} });
    const failed = await trendingConnector.collect(wiki, context(malformed, changed));
    expect(failed.result.status).toBe("failed");
    expect(failed.result.detail).toContain("Invalid Wikipedia community pages");
  });

  it("requires parent context for generic community names and rejects old or sponsored reporting", () => {
    const profile = structuredClone(location);
    profile.community!.name = "Downtown";
    profile.community!.coverage_terms = ["Downtown"];
    profile.community!.aliases = [];
    const place = resolveTrendRegion(profile, {});
    const text = "Downtown residents can visit a new community market with fresh produce, local food stalls and extended opening hours on Saturdays.";
    const parse = (html: string) => parseTrendReport(html, "https://news.example/story", "Downtown", "2026-10-19", place);
    expect(parse(article("Downtown market opens", text))).toBeNull();
    expect(parse(article("Downtown market opens", `${text} The market is in Brookhaven.`))).not.toBeNull();
    expect(parse(article("Downtown market opens", `${text} Brookhaven.`, "News", "2026-09-01"))).toBeNull();
    expect(parse(article("Sponsored: Downtown market opens", `${text} Brookhaven.`))).toBeNull();
  });

  it("ranks practical local reporting above stronger attention and newer generic stories", () => {
    const story = (title: string, day: string, ratio: number) => {
      const facts = { source_event_id: title, title, event_date: day, schedule_text: day, venue: "News", source_url: "https://news.example/story", kind: "trending_topic", tier: "local", signals: { ratio } };
      const value = new Story(title, title, null, facts.kind, facts);
      value.occurrences.push({ source_id: "trending:wikipedia", ...facts, room: null });
      return value;
    };
    const stories = [
      story("Celebrity visits Hillside", "2026-10-19", 100),
      story("Library repairs close building", "2026-10-18", 0),
      story("Park paths close for repairs", "2026-10-17", 10),
    ];
    expect(trending(stories).map(({ title }) => title)).toEqual([
      "Library repairs close building", "Park paths close for repairs", "Celebrity visits Hillside",
    ]);
  });
});
