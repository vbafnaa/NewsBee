import { describe, expect, it, vi } from "vitest";
import { assertPublicReportingUrl, parseTrendReport, reportingLinks } from "../../connectors/wider/trend-context";
import { resolveTrendRegion } from "../../connectors/wider/regions";
import { publicOnlyTransport } from "../../connectors/public-http";

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
  it("rejects publishers that forbid automated or AI use", async () => {
    for (const url of ["https://www.seattletimes.com/seattle-news/", "https://kuow.org/stories/x", "https://mynorthwest.com/feed/"]) {
      await expect(assertPublicReportingUrl(url)).rejects.toThrow("does not permit automated");
    }
  });
  it("guards collection requests without overriding their timeout", async () => {
    const seen: Array<number | undefined> = [];
    const transport = publicOnlyTransport(async (request) => {
      seen.push(request.timeoutMs);
      return { status: 200, url: request.url, headers: {}, body: new Uint8Array() };
    });
    await transport({ url: "https://news.example/feed", timeoutMs: 12_000 });
    await expect(transport({ url: "https://internal.example/feed" })).rejects.toThrow("non-public address");
    expect(seen).toEqual([12_000]);
  });
});
