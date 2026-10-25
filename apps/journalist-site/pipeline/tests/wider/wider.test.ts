import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSourceConfig } from "../../storage/source-configs";
import { Fetcher } from "../../connectors/fetcher";
import { hazardsConnector, stateNewsConnector, trendingConnector } from "../../connectors/wider";
import { itemTier, resolveRegion, resolveTrendRegion, trendTier, distanceKm, TREND_RADIUS_KM, tierFor, validateStateSources } from "../../connectors/wider/regions";
import { countBlueskyMentions, parseNewsFeed, parseUsgs, parseWikiTop, spike } from "../../connectors/wider/adapters";
import { type CachedLinks, type ConnectorContext, type LinkCache, type LocationProfile, type SourceTask } from "../../connectors/types";
import { logger } from "../../core/log";
import { COLLECTIONS } from "../../storage/mongo";
import { withMongo } from "../support/mongo";
import { FakeModel } from "../support/fake-model";
import { fixture, ReplayTransport } from "../support/replay";
import { Story, collapse, whenWhere } from "../../editions/stories";
import { hazards, stateNews, trending } from "../../ranking/wider";
import { FeedFormatError } from "../../connectors/common";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34" }]) }));

const TODAY = "2026-10-19";
const ROOT = path.resolve(__dirname, "../fixtures/wider");
const LOCATION: LocationProfile = {
  id: "auburn-wa", name: "Auburn, WA", state: "WA", latitude: 47.3073, longitude: -122.2285,
  systems: [{ latitude: 47.3073, longitude: -122.2285, branches: [], fscskey: "one", name: "Library" }],
};
const mongo = withMongo();
beforeEach(async () => {
  const data = JSON.parse(fixture("wider/config/state-sources.json").toString("utf8"));
  await mongo.db.collection<{ _id: string; config_path: string; data: Record<string, unknown> }>("source_configs").insertOne({ _id: "state-sources", config_path: "config/state-sources.json", data });
});
function context(transport = new ReplayTransport(), location = LOCATION, extra: Partial<ConnectorContext> = {}): ConnectorContext {
  const settings = { mode: "local" as const, root: ROOT, localDataDir: ROOT, modelProviders: [],
    aiLinkDiscovery: false, widerSources: true, pipelineDriveFolderId: null, cronSecret: null };
  const linkCache = { async get() { return null; }, async put() {}, async invalidate() {} };
  return { location, today: TODAY, window: ["2026-10-20", "2026-10-26"], transport: transport.transport, fetcher: new Fetcher(transport.transport), settings,
    db: mongo.db, linkCache, log: logger("wider-test"), ...extra };
}
function task(connector: typeof hazardsConnector | typeof stateNewsConnector | typeof trendingConnector, sourceId: string, name: string): SourceTask {
  return { type: connector.type, source_id: sourceId, name };
}
const hazardTask = task(hazardsConnector, "hazards:usgs", "USGS earthquakes nearby");
const newsTask = task(stateNewsConnector, "statenews", "State newsrooms");
const wikiTask = task(trendingConnector, "trending:wikipedia", "Trending on Wikipedia");
const bskyTask = task(trendingConnector, "trending:bluesky", "Trending on Bluesky");
const fixtureResponse = (name: string) => ({ file: `wider/${name}` });

it("parses RSS and Atom safely, orders feed items, and rejects unsafe XML", () => {
  const rss = new TextEncoder().encode(`<?xml version="1.0"?><rss><channel><item><title>Old post.</title><link>https://news.example/old</link><pubDate>Thu, 01 Oct 2026 00:00:00 GMT</pubDate><description>&lt;p&gt;Old&lt;/p&gt;</description></item><item><title>New &amp; useful</title><link>https://news.example/new</link><pubDate>Sat, 17 Oct 2026 00:00:00 GMT</pubDate><description>New &amp;amp; useful</description></item><item><title>Insecure</title><link>http://news.example/no</link><pubDate>Sat, 17 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>`);
  const items = parseNewsFeed(rss);
  expect(items.map((entry) => entry.title)).toEqual(["New & useful", "Old post"]);
  expect(items[0].summary).toContain("New & useful");
  const atom = new TextEncoder().encode('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom item</title><link href="https://news.example/atom"/><id>tag:x</id><updated>2026-10-12T08:00:00Z</updated><summary>Hi</summary></entry></feed>');
  expect(parseNewsFeed(atom)[0]).toMatchObject({ id: "tag:x", link: "https://news.example/atom", title: "Atom item" });
  expect(() => parseNewsFeed(new TextEncoder().encode('<!DOCTYPE x [<!ENTITY a "b">]><rss/>'))).toThrow(FeedFormatError);
  expect(() => parseNewsFeed(new TextEncoder().encode("<rss><channel>"))).toThrow(FeedFormatError);
});
it("uses longer encoded article content instead of discarding it behind a short feed teaser", () => {
  const rss = new TextEncoder().encode(`<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>Road changes</title><link>https://gov.example/change</link><pubDate>Sat, 17 Oct 2026 00:00:00 GMT</pubDate><description>Read more.</description><content:encoded><![CDATA[<p>Auburn bridge lanes close for repairs, with a signed detour.</p>]]></content:encoded></item></channel></rss>`);
  expect(parseNewsFeed(rss)[0].summary).toBe("Auburn bridge lanes close for repairs, with a signed detour.");
});
it("keeps every relevant recent item per newsroom, while retaining freshness and geographic filters", async () => {
  const feedItems = Array.from({ length: 30 }, (_, n) => `<item><title>Auburn service update ${n}</title><link>https://gov.example/${n}</link><pubDate>Sat, 17 Oct 2026 00:00:00 GMT</pubDate><description>Auburn road maintenance details.</description></item>`).join("");
  const replay = new ReplayTransport().on("https://gov.example/rss.xml", { body: `<rss><channel>${feedItems}</channel></rss>` })
    .on("https://dot.example/rss.xml", fixtureResponse("empty-rss.xml"));
  const result = await stateNewsConnector.collect(newsTask, context(replay));
  expect(result.events).toHaveLength(30);
  expect(result.result.skipped_unusable.over_limit).toBeUndefined();
  expect(result.events.every(({ tier }) => tier === "local")).toBe(true);
});

it("parses USGS, Wikimedia, and Bluesky aggregate fixture data", () => {
  const quakes = parseUsgs(fixture("wider/usgs.geojson"), 47.3073, -122.2285);
  expect(quakes.map((quake) => quake.id)).toEqual(["a", "b", "c"]);
  expect(quakes[0]).toMatchObject({ felt: 78, reviewed: true, distance_km: 0 });
  expect(parseWikiTop(fixture("wider/wiki-top.json")).map((article) => article.article)).toEqual(["Kent,_Washington", "List_of_Washington_state_parks", "Unrelated_Film"]);
  expect(spike({ "20261001": 1000, "20261002": 1000, "20261003": 4000, "20261004": 4000, "20261005": 4000 })).toMatchObject({ recent_daily_views: 4000, baseline_daily_views: 1000, ratio: 4 });
  const since = new Date("2026-10-12T00:00:00Z");
  expect(countBlueskyMentions(fixture("wider/bluesky-posts.json"), since)).toBe(1);
});

it("resolves configured regions, ambiguous names, and Census centre fallback", async () => {
  const states = validateStateSources(await loadSourceConfig(mongo.db, ROOT, "state-sources"));
  const place = resolveRegion(LOCATION, states);
  expect([place.town, place.county, place.state_name, place.nearby]).toEqual(["Auburn", "King County", "Washington", ["Kent", "Seattle"]]);
  expect(tierFor(place, ["Auburn Tigers win"])).toBeNull();
  expect(tierFor(place, ["Auburn Tigers win"], true)).toBe("local");
  expect(itemTier(place, "Auburn road closure", null)).toBeNull();
  expect(tierFor(place, ["Kent fair"])).toBeNull();
  expect(tierFor(place, ["Kent fair"], true)).toBe("nearby");
  const census = resolveRegion({ ...LOCATION, id: "newtown-wa", name: "Newtown, WA", latitude: 47.3, longitude: -122.2, systems: [] }, states);
  expect([census.latitude, census.longitude, census.county]).toEqual([47.3, -122.2, null]);
  expect(resolveRegion({ ...LOCATION, id: "bend-or", state: "OR" }, states).configured).toBe(false);
});

it("merges same-place earthquakes and counts merged_same_place", async () => {
  const replay = new ReplayTransport().on(/earthquake\.usgs\.gov\/fdsnws\/event\/1\/query/, fixtureResponse("usgs.geojson"));
  const result = await hazardsConnector.collect(hazardTask, context(replay));
  expect(result.result).toMatchObject({ status: "ingested", event_count: 2, feed_kind: "usgs", skipped_unusable: { merged_same_place: 1 } });
  const merged = result.events.find((event) => event.source_event_id === "a+b")!;
  expect(merged).toMatchObject({ title: "2 earthquakes up to magnitude 3.1 near Wilderness Rim, Washington", event_date: "2025-10-15", source_url: "https://earthquake.usgs.gov/b" });
  expect(merged.signals).toEqual({ magnitude: 3.1, distance_km: 0, felt: 124, depth_km: 19, count: 2 });
  expect(merged.description).toContain("In total, 124 people");
});

it("uses Census coordinates for configured locations without a reviewed centre and reports missing or blocked USGS feeds", async () => {
  const censusLocation = { ...LOCATION, id: "newtown-wa", name: "Newtown, WA", latitude: 47.3, longitude: -122.2, systems: [] };
  const replay = new ReplayTransport().on(/earthquake\.usgs\.gov\/fdsnws\/event\/1\/query/, fixtureResponse("usgs.geojson"));
  const result = await hazardsConnector.collect(hazardTask, context(replay, censusLocation));
  expect(result.result.status).toBe("ingested");
  expect(result.result.feed_url).toContain("latitude=47.3000");
  expect(result.result.feed_url).toContain("longitude=-122.2000");
  const missing = await hazardsConnector.collect(hazardTask, context(new ReplayTransport(), { ...censusLocation, latitude: undefined, longitude: undefined }));
  expect(missing.result).toMatchObject({ status: "no_feed", detail: "Location has no coordinates" });
  const blockedTransport = new ReplayTransport().on("https://earthquake.usgs.gov/robots.txt", { body: "User-agent: *\nDisallow: /" });
  const blocked = await hazardsConnector.collect(hazardTask, context(blockedTransport));
  expect(blocked.result.status).toBe("blocked");
});
it("keeps only local or nearby state news and filters sensitive and old items", async () => {
  const replay = new ReplayTransport().on("https://gov.example/rss.xml", fixtureResponse("state-news.xml")).on("https://dot.example/rss.xml", fixtureResponse("empty-rss.xml"));
  const result = await stateNewsConnector.collect(newsTask, context(replay));
  expect(result.result).toMatchObject({ status: "ingested", source_id: "statenews", skipped_outside_window: 0 });
  expect(result.events.map(({ title, tier }) => [title, tier])).toEqual([
    ["Grants open for Auburn small businesses", "local"], ["Governor appoints judge", "region"],
    ["Ferry schedule changes in Seattle", "nearby"], ["Auburn Tigers win", "local"],
  ]);
  expect(result.result.skipped_unusable).toEqual({ sensitive_topic: 1, not_near_town: 1, outside_news_window: 1 });
  expect(result.result.pages_checked).toEqual(["https://gov.example/rss.xml", "https://dot.example/rss.xml"]);
});
it("keeps weather news only when it names the town or county and never rewrites sponsored posts", async () => {
  const entry = (n: number, title: string, extra = "", link = `https://gov.example/w${n}`) => `<item><title>${title}</title><link>${link}</link><pubDate>Sat, 17 Oct 2026 00:00:00 GMT</pubDate>${extra}</item>`;
  const feed = `<rss><channel>${[
    entry(1, "Winter storm warning issued for Auburn"),
    entry(2, "Windstorm knocks out power across King County"),
    entry(3, "Flooding closes roads in Seattle"),
    entry(4, "Ferry schedule changes in Seattle"),
    entry(5, "Sponsored: Auburn's best roofers"),
    entry(6, "Auburn home buying tips", "<category>Sponsored Content</category>"),
    entry(7, "Auburn dealership deals", "", "https://gov.example/partner-content/deals"),
    entry(8, "New Auburn bakery opens", "<description>This content was paid for by Main Street Bakery.</description>"),
  ].join("")}</channel></rss>`;
  const replay = new ReplayTransport().on("https://gov.example/rss.xml", { body: feed }).on("https://dot.example/rss.xml", fixtureResponse("empty-rss.xml"));
  const result = await stateNewsConnector.collect(newsTask, context(replay));
  expect(result.events.map(({ title, tier }) => [title, tier])).toEqual([
    ["Winter storm warning issued for Auburn", "local"], ["Windstorm knocks out power across King County", "region"], ["Ferry schedule changes in Seattle", "nearby"],
  ]);
  expect(result.result.skipped_unusable).toEqual({ hazard_not_local: 1, sponsored: 4 });
});
it("keeps small earthquakes only when they are close to the town", async () => {
  const quake = (id: string, mag: number, lat: number, felt = 0) => ({ id, geometry: { coordinates: [-122.2285, lat, 10] }, properties: { mag, place: `${id} place, Washington`, felt, time: 1760400000000, status: "reviewed", url: `https://earthquake.usgs.gov/${id}` } });
  const body = JSON.stringify({ type: "FeatureCollection", features: [quake("local", 3.0, 47.32), quake("far-small", 3.6, 47.58, 40), quake("far-strong", 4.2, 47.58)] });
  const replay = new ReplayTransport().on(/earthquake\.usgs\.gov\/fdsnws\/event\/1\/query/, { body });
  const result = await hazardsConnector.collect(hazardTask, context(replay));
  expect(result.events.map((event) => [event.source_event_id, event.tier])).toEqual([["far-strong", "nearby"], ["local", "local"]]);
  expect(result.result.skipped_unusable).toEqual({ below_threshold: 1 });
});

it("validates AI-discovered state newsroom feeds and caches the better run", async () => {
  const data = JSON.parse(fixture("wider/config/state-sources.json").toString("utf8"));
  data.WA.newsrooms[0].page = "https://gov.example/newsroom";
  await mongo.db.collection<{ _id: string; config_path: string; data: Record<string, unknown> }>("source_configs").updateOne(
    { _id: "state-sources" }, { $set: { data } },
  );
  const model = new FakeModel(() => ({ urls: ["https://gov.example/extra.xml"] }));
  const cached: { current: CachedLinks | null } = { current: null };
  const linkCache: LinkCache = {
    async get() { return cached.current; },
    async put(entry) { cached.current = { ...entry, discovered_at: TODAY }; },
    async invalidate() { cached.current = null; },
  };
  const replay = new ReplayTransport()
    .on("https://gov.example/rss.xml", fixtureResponse("empty-rss.xml"))
    .on("https://dot.example/rss.xml", fixtureResponse("empty-rss.xml"))
    .on("https://gov.example/newsroom", { body: '<a href="https://gov.example/extra.xml">News feed</a>' })
    .on("https://gov.example/extra.xml", fixtureResponse("state-news.xml"));
  const base = context(replay);
  const aiContext = { ...base, model, linkCache, settings: { ...base.settings, aiLinkDiscovery: true } };
  const first = await stateNewsConnector.collect(newsTask, aiContext);
  expect(first.events.length).toBeGreaterThan(0);
  expect(first.result.link_discovery).toMatchObject({ method: "ai" });
  expect(cached.current?.url).toBe("https://gov.example/extra.xml");
  const modelCalls = model.calls.length;
  const second = await stateNewsConnector.collect(newsTask, aiContext);
  expect(second.result.link_discovery).toMatchObject({ method: "cache" });
  expect(model.calls).toHaveLength(modelCalls);
});

it("reports all-newsroom failures and wraps unexpected crashes as failed source results", async () => {
  const noFeeds = await stateNewsConnector.collect(newsTask, context(new ReplayTransport()));
  expect(noFeeds.result.status).toBe("failed");
  const broken = new ReplayTransport().on(/earthquake\.usgs\.gov\/fdsnws/, () => { throw new Error("fixture crash"); });
  const crashed = await hazardsConnector.collect(hazardTask, context(broken));
  expect(crashed).toMatchObject({ result: { status: "failed", detail: "Error: fixture crash" }, events: [] });
});

it("discovers actual local reporting from both connectors and excludes Seattle for Auburn", async () => {
  const replay = new ReplayTransport()
    .on(/metrics\/pageviews\/top\//, fixtureResponse("wiki-top.json"))
    .on(/user\/Seattle_Seahawks\/daily\//, fixtureResponse("wiki-seahawks.json"))
    .on(/user\/Mount_Rainier\/daily\//, fixtureResponse("wiki-rainier.json"))
    .on(/user\/Kent%2C_Washington\/daily\//, fixtureResponse("wiki-kent.json"))
    .on(/app\.bsky\.unspecced\.getTrends/, fixtureResponse("bluesky-trends.json"))
    .on(/app\.bsky\.feed\.searchPosts/, (request) => {
      const query = new URL(request.url).searchParams.get("q") ?? "";
      const topic = query.includes("Kent") ? "Kent, Washington" : "Auburn, Washington";
      return { body: { posts: [{ record: { createdAt: "2026-10-18T00:00:00Z" }, embed: { external: { uri: `https://news.example/${encodeURIComponent(topic)}` } } }] } };
    })
    .on(/^https:\/\/news\.example\//, (request) => {
      const topic = decodeURIComponent(new URL(request.url).pathname.slice(1));
      return { body: `<meta property="og:site_name" content="Regional News"><meta property="og:title" content="${topic} bridge repairs close lanes"><meta property="article:published_time" content="2026-10-18T12:00:00Z"><article><p>${topic} has announced bridge repairs that close two lanes next week, with a signed detour for drivers using the road.</p></article>` };
    });
  const ctx = context(replay);
  const wiki = await trendingConnector.collect(wikiTask, ctx);
  expect(wiki.result.status).toBe("ingested");
  expect(wiki.events.map((event) => [event.title, event.tier])).toEqual([["Kent, Washington bridge repairs close lanes", "nearby"]]);
  expect(wiki.events.every((event) => event.source_url.startsWith("https://news.example/") && event.description?.includes("Reporting by Regional News"))).toBe(true);
  expect(wiki.events[0]).toMatchObject({ event_date: "2026-10-18", venue: "Regional News" });
  expect(wiki.events[0].description).not.toMatch(/views|posts|trending|attention/i);
  expect(replay.requests.filter((request) => /user\/(?:Seattle_Seahawks|Mount_Rainier)/.test(request.url))).toHaveLength(0);
  const statewideBefore = replay.requests.filter((request) => /pageviews\/top/.test(request.url)).length;
  await trendingConnector.collect(wikiTask, ctx);
  expect(replay.requests.filter((request) => /pageviews\/top/.test(request.url))).toHaveLength(statewideBefore);
  const bsky = await trendingConnector.collect(bskyTask, ctx);
  expect(bsky.events.map((event) => [event.title, event.kind, event.tier])).toEqual([
    ["Auburn, Washington bridge repairs close lanes", "social_trend", "local"],
    ["Kent, Washington bridge repairs close lanes", "social_trend", "nearby"],
  ]);
  expect(bsky.events.every((event) => !/views|posts|trending|attention/i.test(event.description ?? ""))).toBe(true);
  const stories = collapse([...wiki.events.map((facts) => ({ source_id: wikiTask.source_id, facts })),
    ...bsky.events.map((facts) => ({ source_id: bskyTask.source_id, facts }))]);
  expect(stories).toHaveLength(2);
  const kent = stories.find(({ title }) => title.includes("Kent"))!;
  expect(kent.occurrences).toHaveLength(2);
  expect(whenWhere(kent)).toMatch(/^Published .* by Regional News\.$/);
  await trendingConnector.collect(bskyTask, ctx);
  expect(replay.requests.filter((request) => request.url.includes("getTrends"))).toHaveLength(0);
  const records = await mongo.db.collection(COLLECTIONS.wideCache).countDocuments();
  expect(records).toBe(2);
});

it("omits popularity-only trends with observable reasons instead of inventing a story", async () => {
  const replay = new ReplayTransport()
    .on(/app\.bsky\.unspecced\.getTrends/, fixtureResponse("bluesky-trends.json"))
    .on(/app\.bsky\.feed\.searchPosts/, fixtureResponse("bluesky-posts.json"));
  const result = await trendingConnector.collect(bskyTask, context(replay));
  expect(result.events).toEqual([]);
  expect(result.result.status).toBe("no_context");
  expect(result.result.skipped_unusable.no_story_context).toBe(1);
  expect(result.result.detail).toContain("popularity counts and national trends are not news");
  expect(await mongo.db.collection(COLLECTIONS.wideCache).countDocuments({ key: /^trend-context/ })).toBe(0);
});

it("uses a 15-mile trend radius, not county/state names or the general 50 km news radius", async () => {
  const states = validateStateSources(await loadSourceConfig(mongo.db, ROOT, "state-sources"));
  const place = resolveTrendRegion(LOCATION, states);
  expect(TREND_RADIUS_KM).toBeCloseTo(24.14016);
  expect(place.nearby).toEqual(["Kent"]);
  expect(trendTier(place, "The Real World: Seattle", "Seattle, Washington television series")).toBeNull();
  expect(trendTier(place, "King County announcement")).toBeNull();
  expect(trendTier(place, "Auburn Tigers", "Alabama")).toBeNull();
  expect(trendTier(place, "Kent, Washington repairs")).toBe("nearby");
  const lat = LOCATION.latitude!;
  const degrees = TREND_RADIUS_KM / distanceKm(lat, 0, lat + 1, 0);
  states.WA.places = { Inside: [lat + degrees - 0.00001, LOCATION.longitude!], Outside: [lat + degrees + 0.00001, LOCATION.longitude!] };
  expect(resolveTrendRegion(LOCATION, states).nearby).toEqual(["Inside"]);
  expect(resolveTrendRegion({ ...LOCATION, id: "unknown-wa", systems: [], latitude: undefined, longitude: undefined }, states).nearby).toEqual([]);
});

it("rejects unrelated Seattle reporting returned by local Bluesky search and ignores old statewide caches", async () => {
  await mongo.db.collection(COLLECTIONS.wideCache).insertMany([
    { key: `bluesky:WA:${TODAY}`, value: { trends: [{ name: "The Real World: Seattle", post_count: 10000 }] } },
    { key: `trend-context-v1:old:${TODAY}`, value: { report: { title: "The Real World: Seattle" } } },
  ]);
  const replay = new ReplayTransport()
    .on(/app\.bsky\.feed\.searchPosts/, { body: { posts: [
      { record: { createdAt: "2026-10-18" }, embed: { external: { uri: "https://news.example/seattle" } } },
    ] } })
    .on("https://news.example/seattle", { body: `<meta property="og:site_name" content="News"><meta property="og:title" content="The Real World: Seattle returns"><meta property="article:published_time" content="2026-10-18"><p>The Real World: Seattle returns for an anniversary broadcast in Seattle, Washington, featuring interviews and footage from the television series.</p><aside><p>Auburn, Washington drivers will see a detour after city staff announced repairs to the local bridge next week.</p></aside>` });
  const result = await trendingConnector.collect(bskyTask, context(replay));
  expect(result.events).toEqual([]);
  expect(result.result.status).toBe("no_context");
  const queries = replay.requests.filter(({ url }) => url.includes("searchPosts")).map(({ url }) => new URL(url).searchParams.get("q"));
  expect(queries).toEqual(['"Auburn" "Washington"', '"Kent" "Washington"']);
});

it("reports failed local reporting discovery as a failure rather than a successful empty result", async () => {
  const result = await trendingConnector.collect(bskyTask, context(new ReplayTransport()));
  expect(result.events).toEqual([]);
  expect(result.result.status).toBe("failed");
  expect(result.result.detail).toContain("Local reporting discovery unavailable");
  const brokenReport = new ReplayTransport().on(/app\.bsky\.feed\.searchPosts/, { body: { posts: [
    { record: { createdAt: "2026-10-18" }, embed: { external: { uri: "https://news.example/unavailable" } } },
  ] } });
  const unavailable = await trendingConnector.collect(bskyTask, context(brokenReport));
  expect(unavailable.result.status).toBe("failed");
  expect(unavailable.result.detail).toContain("All linked reporting unavailable");
});

it("does not persist failed Wikipedia statewide measurements", async () => {
  const replay = new ReplayTransport();
  const result = await trendingConnector.collect(wikiTask, context(replay));
  expect(result.result.status).toBe("failed");
  expect(await mongo.db.collection(COLLECTIONS.wideCache).countDocuments()).toBe(0);
});

it("gates all wider source tasks on widerSources", () => {
  const settings = context().settings;
  const off = { ...settings, widerSources: false };
  expect(hazardsConnector.sources(LOCATION, off)).toEqual([]);
  expect(stateNewsConnector.sources(LOCATION, off)).toEqual([]);
  expect(trendingConnector.sources(LOCATION, off)).toEqual([]);
  expect(hazardsConnector.sources(LOCATION, settings)[0].source_id).toBe("hazards:usgs");
  expect(trendingConnector.sources(LOCATION, settings).map((source) => source.source_id)).toEqual(["trending:wikipedia", "trending:bluesky"]);
});

function story(title: string, day: string, facts: Record<string, unknown>) {
  const item = new Story(title, title, null, String(facts.kind ?? "event"), facts as never);
  item.occurrences.push({ source_id: "source", source_event_id: title, event_date: day, schedule_text: day, venue: String(facts.venue ?? ""), room: null, source_url: "https://example.com" });
  return item;
}
const names = (items: Story[]) => items.map((item) => item.title);
it("ranks wider stories by tier and type-specific signals, spreading publishers and kinds", () => {
  expect(names(hazards([
    story("Far big", "2026-10-15", { tier: "region", signals: { magnitude: 4.5, distance_km: 80 } }),
    story("Near small", "2026-10-15", { tier: "local", signals: { magnitude: 3, distance_km: 5 } }),
    story("Near bigger", "2026-10-15", { tier: "local", signals: { magnitude: 3.2, distance_km: 20 } }),
  ]))).toEqual(["Near bigger", "Near small", "Far big"]);
  expect(names(stateNews([
    story("Governor appoints new director", "2026-10-18", { tier: "nearby", venue: "Governor" }),
    story("Lane closures on I-5 this weekend", "2026-10-17", { tier: "nearby", venue: "WSDOT" }),
    story("Bridge paint project", "2026-10-14", { tier: "nearby", venue: "WSDOT" }),
    story("Scam warning for consumers", "2026-10-10", { tier: "nearby", venue: "AG" }),
    story("King County grant program", "2026-10-01", { tier: "region", venue: "Governor" }),
  ]))).toEqual(["King County grant program", "Lane closures on I-5 this weekend", "Scam warning for consumers", "Governor appoints new director", "Bridge paint project"]);
  expect(names(trending([
    story("Big wiki", TODAY, { tier: "nearby", kind: "trending_topic", signals: { ratio: 6 } }),
    story("Small wiki", TODAY, { tier: "nearby", kind: "trending_topic", signals: { ratio: 2 } }),
    story("Social", TODAY, { tier: "nearby", kind: "social_trend", signals: { post_count: 300 } }),
    story("Town wiki", TODAY, { tier: "local", kind: "trending_topic", signals: { ratio: 1.6 } }),
  ]))).toEqual(["Town wiki", "Big wiki", "Social", "Small wiki"]);
});
