import { describe, expect, it, vi } from "vitest";
import { assertPublicReportingUrl, parseTrendReport, reportingLinks } from "../../connectors/wider/trend-context";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async (hostname: string) => [{ address: hostname === "internal.example" ? "127.0.0.1" : "93.184.216.34" }]) }));

const article = `<html><head><meta property="og:site_name" content="Regional News"><meta property="og:title" content="Seattle Seahawks win">
<meta property="article:published_time" content="2026-10-18T12:00:00Z"></head><body>
<article><p>The Seattle Seahawks won their game with a late touchdown.</p><p>Seattle Seahawks searches surged after the team's last-minute victory.</p></article></body></html>`;

describe("sourced trend context", () => {
  it("requires a recent report naming the topic and explicitly explaining attention", () => {
    expect(parseTrendReport(article, "https://news.example/story", "Seattle Seahawks", "2026-10-19")).toMatchObject({
      publisher: "Regional News", url: "https://news.example/story",
      reason: "Seattle Seahawks searches surged after the team's last-minute victory.",
      excerpt: "The Seattle Seahawks won their game with a late touchdown.",
    });
    expect(parseTrendReport(article, "https://news.example/story", "Unrelated Topic", "2026-10-19")).toBeNull();
    expect(parseTrendReport(article.replace("2026-10-18", "2026-09-01"), "https://news.example/story", "Seattle Seahawks", "2026-10-19")).toBeNull();
    expect(parseTrendReport(article.replace("2026-10-18", "2026-11-01"), "https://news.example/story", "Seattle Seahawks", "2026-10-19")).toBeNull();
    expect(parseTrendReport(article.replace("searches surged after", "won following"), "https://news.example/story", "Seattle Seahawks", "2026-10-19")).toBeNull();
    expect(parseTrendReport(article.replace("surged after", "surged around"), "https://news.example/story", "Seattle Seahawks", "2026-10-19")).toBeNull();
  });
  it("does not use navigation, scripts, popularity counts or a generic topic description as reporting", () => {
    const noArticle = `<meta property="og:site_name" content="News"><meta property="article:published_time" content="2026-10-18">
      <nav><p>Seattle Seahawks trending after a win.</p></nav><p>Seattle Seahawks have 4,000 page views.</p>`;
    expect(parseTrendReport(noArticle, "https://news.example/story", "Seattle Seahawks", "2026-10-19")).toBeNull();
    const ld = `<script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", datePublished: "2026-10-18", publisher: { name: "News" }, articleBody: "Seattle Seahawks are trending after winning their game." })}</script>`;
    expect(parseTrendReport(ld, "https://news.example/story", "Seattle Seahawks", "2026-10-19")?.publisher).toBe("News");
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
