import { describe, expect, it, vi } from "vitest";
import { assertPublicReportingUrl, parseTrendReport, reportingLinks, discoverReports, communityFeeds } from "../../connectors/wider/trend-context";
import { resolveTrendRegion } from "../../connectors/wider/regions";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async (hostname: string) => [{ address: hostname === "internal.example" ? "127.0.0.1" : "93.184.216.34" }]) }));

const place = resolveTrendRegion({ id: "auburn-wa", name: "Auburn, WA", state: "WA", systems: [], latitude: 47.3073, longitude: -122.2285 }, {
  WA: { name: "Washington", ambiguous_places: ["Auburn"], places: { Seattle: [47.6062, -122.3321], Kent: [47.3809, -122.2348] } },
});
const parse = (html: string, topic = "Auburn") => parseTrendReport(html, "https://news.example/story", topic, "2026-10-19", place);
const article = `<html><head><meta property="og:site_name" content="Regional News"><meta property="og:title" content="Auburn bridge repairs close two lanes">
<meta property="article:published_time" content="2026-10-18T12:00:00Z"></head><body>
<article><p>Auburn, Washington has announced bridge repairs that will close two lanes next week, with a signed detour for drivers.</p>
<p>Auburn searches surged after the bridge closure announcement.</p></article></body></html>`;

describe("sourced trend context", () => {
  it("requires recent substantive local reporting, not an explanation of popularity", () => {
    expect(parse(article)).toMatchObject({
      publisher: "Regional News", url: "https://news.example/story",
      headline: "Auburn bridge repairs close two lanes",
      excerpt: "Auburn, Washington has announced bridge repairs that will close two lanes next week, with a signed detour for drivers.",
    });
    expect(parse(article, "Unrelated Topic")).toBeNull();
    expect(parse(article.replace("2026-10-18", "2026-09-01"))).toBeNull();
    expect(parse(article.replace("2026-10-18", "2026-11-01"))).toBeNull();
    expect(parse(article.replace(/Auburn/g, "Seattle"), "Seattle")).toBeNull();
    expect(parse(article.replace(/Auburn, Washington/g, "King County"))).toBeNull();
    expect(parse(article.replace("Auburn, Washington", "Auburn, Alabama"))).toBeNull();
  });
  it("does not use navigation, scripts, popularity counts or a generic topic description as reporting", () => {
    const noArticle = `<meta property="og:site_name" content="News"><meta property="article:published_time" content="2026-10-18">
      <nav><p>Auburn, Washington repairs close two lanes for a full week while workers replace the surface of the bridge.</p></nav><p>Auburn has 4,000 page views.</p>`;
    expect(parse(noArticle)).toBeNull();
    expect(parse(article.replace(/<p>Auburn, Washington.*?<\/p>/, ""))).toBeNull();
    expect(parse(article.replace("Auburn bridge repairs close two lanes", "Auburn is trending after 10,000 daily views"))).toBeNull();
    const ld = `<script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", headline: "Auburn repairs close two lanes", datePublished: "2026-10-18", publisher: { name: "News" }, articleBody: "Auburn, Washington repairs will close two lanes of the bridge next week, with a signed detour in place for drivers." })}</script>`;
    expect(parse(ld)?.publisher).toBe("News");
  });
  it("extracts recent linked reporting without retaining post text or authors", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ posts: [
      { record: { createdAt: "2026-10-18", text: "private post text", facets: [{ features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://news.example/story" }] }] }, embed: { external: { uri: "https://news.example/report" } } },
      { record: { createdAt: "2026-01-01" }, embed: { external: { uri: "https://news.example/stale" } } },
    ] }));
    expect(reportingLinks(bytes, new Date("2026-10-12"))).toEqual(["https://news.example/report", "https://news.example/story"]);
  });
  it("rejects internal destinations, including DNS and redirect targets", async () => {
    for (const url of ["https://127.0.0.1/report", "https://[::1]/report", "https://10.0.0.1/report", "https://internal.example/report", "http://news.example/report"]) {
      await expect(assertPublicReportingUrl(url)).rejects.toThrow();
    }
    await expect(assertPublicReportingUrl("https://news.example/report")).resolves.toBeUndefined();
  });
});


it("retains failed linked URLs and recovers through an advertised community feed", async () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const transport = vi.fn(async ({ url }: { url: string }) => {
    if (url.endsWith("/robots.txt")) return { url, status: 200, headers: {}, body: bytes("User-agent: *\nAllow: /") };
    if (url.includes("broken.example")) throw new Error("linked article timed out");
    const body = url.endsWith("/feed") ? `<rss><channel><item><guid>report</guid><title>Auburn bridge repairs close two lanes</title><link>https://news.example/story</link><pubDate>Sun, 18 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>` : article;
    return { url, status: 200, headers: {}, body: bytes(body) };
  });
  const ctx = { today: "2026-10-19", transport, fetcher: { get: async () => ["api", bytes(JSON.stringify({ posts: [{ record: { createdAt: "2026-10-18" }, embed: { external: { uri: "https://broken.example/report" } } }] }))] }, log: { warn: vi.fn(), info: vi.fn() } } as unknown as import("../../connectors/types").ConnectorContext;
  await expect(discoverReports(ctx, place, [{ topic: "Auburn", query: "Auburn" }])).rejects.toThrow("https://broken.example/report");
  const result = await discoverReports(ctx, place, [{ topic: "Auburn", query: "Auburn" }], ["https://news.example/feed"]);
  expect(result.reports).toHaveLength(1);
  expect(result.errors.join(" ")).toContain("linked article timed out");
}, 10000);

it("discovers advertised feeds from active community sources and deduplicates hosts", async () => {
  const query = vi.fn(() => ({ limit: () => ({ toArray: async () => [{ url: "https://community.example/about" }, { url: "https://community.example/" }] }) }));
  const transport = vi.fn(async ({ url }: { url: string }) => ({ url, status: 200, headers: {}, body: new TextEncoder().encode(url.endsWith("robots.txt") ? "User-agent: *\nAllow: /" : '<link rel="alternate" type="application/rss+xml" href="/feed">') }));
  const ctx = { location: { id: "test" }, db: { collection: () => ({ find: query }) }, transport } as unknown as import("../../connectors/types").ConnectorContext;
  expect((await communityFeeds(ctx)).feeds).toEqual(["https://community.example/feed"]);
  expect(query.mock.calls[0]).toMatchObject([{ location_id: "test", status: { $in: ["active", "pinned"] }, reader: "web", section: "community" }]);
  expect(transport.mock.calls.filter(([request]) => !request.url.endsWith("robots.txt"))).toHaveLength(1);
}, 10000);

it("accepts explicit WordPress publication times without requiring OpenGraph metadata", () => {
  const html = article.replace('<meta property="article:published_time" content="2026-10-18T12:00:00Z">', '<time class="entry-date published" datetime="2026-10-18T12:00:00Z"></time>').replace('<meta property="og:site_name" content="Regional News">', '');
  expect(parse(html)).toMatchObject({ publisher: "news.example", published_at: "2026-10-18T12:00:00Z" });
  expect(parse(html.replace('entry-date published', 'updated'))).toBeNull();
});
