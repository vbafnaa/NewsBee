import { describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { normalizeStoryImage, safeImageUrl } from "../../../../../shared/story-image";
import { articleMeta, imagesAllowed, pageRights } from "../../connectors/web/page";
import { parseNewsFeed } from "../../connectors/wider/adapters";
import { mergeDetails } from "../../editions/details";
import { STORY_IMAGES, storyImage, storyImages } from "../../editions/authoring";
import { Story } from "../../editions/stories";
import type { HttpTransport } from "../../core/http";
import type { CollectedEvent } from "../../connectors/types";
import { sourceResult, type ConnectorContext } from "../../connectors/types";
import { readSite } from "../../connectors/web";
import { newsSearchConnector } from "../../connectors/newssearch";
import { Fetcher } from "../../connectors/fetcher";

describe("publisher image metadata", () => {
  it.each(["http://example.com/a.jpg", "javascript:alert(1)", "data:image/png,xx", "https://user:pass@example.com/a.jpg", "https://localhost/a.jpg",
    "https://example.local/a.jpg", "https://127.1/a.jpg", "https://2130706433/a.jpg", "https://10.0.0.1/a.jpg", "https://172.16.0.1/a.jpg",
    "https://192.168.1.1/a.jpg", "https://169.254.169.254/a.jpg", "https://[::1]/a.jpg", "https://[::ffff:127.0.0.1]/a.jpg",
    "https://[fc00::1]/a.jpg", "https://example.com:8443/a.jpg", "https://example.com/a%0d.jpg", "\nhttps://example.com/a.jpg"])("rejects unsafe image URL %s", (url) => {
    expect(safeImageUrl(url)).toBeNull();
  });

  it("normalizes publisher relative URLs while preserving signed query strings", () => {
    expect(safeImageUrl("../photo.jpg?token=abc%2B123&width=1200#photo", "https://example.com/news/story")).toBe("https://example.com/photo.jpg?token=abc%2B123&width=1200");
    expect(safeImageUrl("//cdn.example.com/photo.webp", "https://example.com/story")).toBe("https://cdn.example.com/photo.webp");
  });

  it("reads structured image objects, skips unusable candidates and retains supplied provenance", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", headline: "A new park", image: ["http://example.com/insecure.jpg", {
      "@type": "ImageObject", contentUrl: "/photos/park.jpg", caption: "The new park entrance", creditText: "Jane / Parks Department", width: 1600, height: 900,
    }] })}</script>`;
    expect(articleMeta(html, "https://example.com/news/park")).toMatchObject({ image: "https://example.com/photos/park.jpg", image_alt: "The new park entrance",
      image_credit: "Jane / Parks Department", image_source_url: "https://example.com/news/park", image_width: 1600, image_height: 900 });
  });

  it("falls back to Twitter and never invents an image description", () => {
    const html = `<title>Park opens</title><meta content="/photos/park.jpg" name="twitter:image">`;
    const article = articleMeta(html, "https://example.com/news/park");
    expect(article?.image).toBe("https://example.com/photos/park.jpg");
    expect(article).not.toHaveProperty("image_alt");
  });

  it("skips a known tiny schema candidate and selects the next usable publisher photo", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", headline: "A new park", image: [
      { contentUrl: "/thumbnail.jpg", width: 160, height: 90, creditText: "Thumbnail credit" },
      { contentUrl: "/park.jpg", width: 1200, height: 800, creditText: "Park photographer" },
    ] })}</script>`;
    expect(articleMeta(html, "https://example.com/news/park")).toMatchObject({ image: "https://example.com/park.jpg", image_credit: "Park photographer" });
    expect(normalizeStoryImage({ image: "https://example.com/small.jpg", image_width: 239, image_height: 120 })).toBeNull();
    expect(normalizeStoryImage({ image: "https://example.com/short.jpg", image_width: 240, image_height: 119 })).toBeNull();
  });

  it("falls through a known tiny Open Graph photo to a usable Twitter image", () => {
    const html = `<title>New park</title><meta property="og:image" content="/thumbnail.jpg"><meta property="og:image:width" content="80"><meta property="og:image:height" content="80"><meta name="twitter:image" content="/park.jpg">`;
    expect(articleMeta(html, "https://example.com/news/park")?.image).toBe("https://example.com/park.jpg");
  });

  it("extracts feed media rather than audio/video and ignores tracking pixels", () => {
    const xml = `<rss><channel><item><title>New park</title><link>https://example.com/news/park</link><pubDate>2026-10-30T12:00:00Z</pubDate>
      <media:content url="https://cdn.example.com/video.mp4" medium="video"/><media:thumbnail url="/track.gif" width="1" height="1"/>
      <media:content url="/thumbnail.jpg" type="image/jpeg" width="160" height="90"/>
      <media:content url="/photos/park.jpg" type="image/jpeg" width="1600" height="900"><media:credit>Parks Department</media:credit></media:content>
      </item></channel></rss>`;
    expect(parseNewsFeed(new TextEncoder().encode(xml))[0].image).toEqual({ image: "https://example.com/photos/park.jpg", image_source_url: "https://example.com/news/park",
      image_credit: "Parks Department", image_width: 1600, image_height: 900 });
  });

  it("supports Atom image enclosures and publisher HTML alt text", () => {
    const xml = `<feed><entry><title>New park</title><link href="https://example.com/news/park"/><updated>2026-10-30T12:00:00Z</updated>
      <link rel="enclosure" type="image/webp" href="//cdn.example.com/park.webp"/></entry>
      <entry><title>Town hall</title><link href="https://example.com/news/town"/><updated>2026-10-29T12:00:00Z</updated>
      <content><![CDATA[<img src="/town.jpg" alt="Town hall at dusk" width="800" height="600">]]></content></entry></feed>`;
    const items = parseNewsFeed(new TextEncoder().encode(xml));
    expect(items[0].image?.image).toBe("https://cdn.example.com/park.webp");
    expect(items[1].image).toMatchObject({ image: "https://example.com/town.jpg", image_alt: "Town hall at dusk" });
  });

  it("keeps the selected duplicate report's credit with its own image", () => {
    const merged = mergeDetails({ image: "https://first.example.com/photo.jpg", image_source_url: "https://first.example.com/story", image_credit: "First photographer" },
      { image: "https://second.example.com/photo.jpg", image_source_url: "https://second.example.com/story", image_credit: "Second photographer", image_alt: "Second photo" });
    expect(merged).toMatchObject({ image: "https://first.example.com/photo.jpg", image_source_url: "https://first.example.com/story", image_credit: "First photographer" });
    expect(merged).not.toHaveProperty("image_alt");
    expect(normalizeStoryImage({ image: "https://example.com/photo.jpg" })).toEqual({ image: "https://example.com/photo.jpg" });
  });

  it.each(["noimageindex", "noimageai", "max-image-preview:none", "noarchive", "nosnippet", "noai"])("respects publisher %s directives", (directive) => {
    expect(imagesAllowed(pageRights({}, `<meta name="robots" content="${directive}">`))).toBe(false);
  });

  it.each(["homepage", "feed"])("persists an image opt-out from the %s through collection", async (where) => {
    const site = "https://opt-out.example.com/";
    const home = `<title>Town News</title>${where === "homepage" ? '<meta name="robots" content="noimageindex">' : ""}`;
    const feed = `<rss><channel><item><title>New park</title><link>${site}news/park</link><pubDate>2026-10-30T12:00:00Z</pubDate><enclosure url="${site}photo.jpg" type="image/jpeg"/></item></channel></rss>`;
    const transport: HttpTransport = async ({ url }) => {
      const status = url === site || url === `${site}feed` ? 200 : 404;
      return { url, status, body: new TextEncoder().encode(status === 404 ? "" : url === site ? home : feed),
        headers: where === "feed" && url.endsWith("/feed") ? { "x-robots-tag": "noimageindex" } : {} };
    };
    const context = { today: "2026-10-31", transport, fetcher: new Fetcher(transport, undefined, false) } as unknown as ConnectorContext;
    const items = await readSite({ source_id: "web:town", type: "web", name: "Town News", params: { url: site, feed_url: `${site}feed`, inside_area: true } }, context, sourceResult("web:town", "Town News", "ok", ""));
    expect(items).toHaveLength(1);
    expect(items[0].image_blocked).toBe(true);
    expect(items[0].details).not.toHaveProperty("image");
  });
});

function memoryDatabase() {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  return { collections, db: { collection(name: string) {
    const docs = collections.get(name) ?? new Map<string, Record<string, unknown>>(); collections.set(name, docs);
    return { async findOne(query: { _id: string }) { return docs.get(query._id) ?? null; },
      async updateOne(query: { _id: string }, update: { $set: Record<string, unknown> }) { docs.set(query._id, { _id: query._id, ...docs.get(query._id), ...update.$set }); } };
  } } as unknown as Db };
}
function sourceStory(host: string) {
  const story = new Story("park-story", "Park opens", null, "local_news", { source_name: "Town News" } as CollectedEvent);
  story.occurrences.push({ source_id: "web:town", source_event_id: "park", event_date: "2026-10-30", schedule_text: "Friday", venue: "Town News", room: null, source_url: `https://${host}/news/park` });
  return story;
}

describe("independent image discovery", () => {
  it("retains multiple collected candidates without fetching an article and respects image blocks", async () => {
    const { db } = memoryDatabase(); const story = sourceStory("organizer.example.com");
    story.facts.details = { image: "https://organizer.example.com/first.jpg", image_credit: "Alex", image_candidates: [
      { image: "https://organizer.example.com/first.jpg", image_credit: "Alex" },
      { image: "https://organizer.example.com/second.jpg", image_credit: "Pat" },
    ] };
    const transport = vi.fn<HttpTransport>(async () => { throw Error("Must not fetch"); });
    expect((await storyImages({ db, transport }, "town", story)).map(image => image.image_credit)).toEqual(["Alex", "Pat"]);
    expect(transport).not.toHaveBeenCalled();
    story.facts.image_blocked = true;
    expect(await storyImages({ db, transport }, "town", story)).toEqual([]);
  });
  it("ignores search thumbnails and checks the original article's image permissions", async () => {
    const { db } = memoryDatabase();
    const source = "https://search-source.example.com/news/park";
    const context = { db, today: "2026-10-31", location: { id: "town", name: "Town, WA", state: "WA" },
      transport: async (request: { url: string }) => ({ url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ articles: [{
        url: source, title: "Town park opens", seendate: "20261030120000", domain: "Town News", socialimage: "https://search-source.example.com/unverified.jpg",
      }] })) }),
      log: { error: vi.fn() },
    } as unknown as ConnectorContext;
    let events: CollectedEvent[];
    vi.useFakeTimers();
    try {
      const pending = newsSearchConnector.collect({ source_id: "newssearch:gdelt", type: "newssearch", name: "News search", params: { backend: "gdelt" } }, context);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.result.status).toBe("ingested");
      events = result.events;
    } finally { vi.useRealTimers(); }
    expect(events).toHaveLength(1);
    expect(events[0].details).toEqual({ links: [source] });
    const story = sourceStory("search-source.example.com"); story.facts = events[0];
    const transport: HttpTransport = async (request) => ({ url: request.url, status: request.url.endsWith("robots.txt") ? 404 : 200, headers: {},
      body: new TextEncoder().encode('<title>Town park opens</title><meta name="robots" content="noimageindex"><meta property="og:image" content="/restricted.jpg">') });
    expect(await storyImage({ db, transport }, "town", story)).toBeNull();
  });

  it("discovers and persists image metadata without a model, then reuses its cache", async () => {
    const { db, collections } = memoryDatabase();
    const story = sourceStory("image-cache.example.com");
    const requests: string[] = [];
    const transport: HttpTransport = async (request) => {
      requests.push(request.url);
      return { url: request.url, status: request.url.endsWith("robots.txt") ? 404 : 200, headers: {},
        body: new TextEncoder().encode(`<title>Park opens</title><meta property="og:image" content="/park.jpg"><meta property="og:image:alt" content="The park entrance">`) };
    };
    const result = await storyImage({ db, transport }, "town", story);
    expect(result).toEqual({ image: "https://image-cache.example.com/park.jpg", image_source_url: story.first.source_url, image_credit: "Town News", image_alt: "The park entrance" });
    expect(collections.get(STORY_IMAGES)?.size).toBe(1);
    const count = requests.length;
    expect(await storyImage({ db, transport }, "town", story)).toEqual(result);
    expect(requests).toHaveLength(count);
  });

  it("caches unavailable images and continues after source failures", async () => {
    const { db } = memoryDatabase(); const story = sourceStory("unavailable-image.example.com");
    let requests = 0;
    const transport: HttpTransport = async () => { requests += 1; throw new Error("Source unavailable"); };
    expect(await storyImage({ db, transport }, "town", story)).toBeNull();
    const count = requests;
    expect(await storyImage({ db, transport }, "town", story)).toBeNull();
    expect(requests).toBe(count);
  });

  it("blocks a public article redirect to loopback before sending any private-host request", async () => {
    const { db } = memoryDatabase(); const story = sourceStory("private-redirect.example.com");
    const requests: string[] = [];
    const transport: HttpTransport = async (request) => {
      requests.push(request.url);
      if (request.url.endsWith("robots.txt")) return { url: request.url, status: 404, headers: {}, body: new Uint8Array() };
      return { url: request.url, status: 302, headers: { location: "https://127.0.0.1/private" }, body: new Uint8Array() };
    };
    expect(await storyImage({ db, transport }, "town", story)).toBeNull();
    expect(requests).toContain(story.first.source_url);
    expect(requests.every((url) => new URL(url).hostname === "private-redirect.example.com")).toBe(true);
  });

  it.each(["link_only", "image_blocked"])("does not fetch or publish an image for %s stories", async (flag) => {
    const { db } = memoryDatabase(); const story = sourceStory("restricted.example.com");
    story.facts[flag] = true; story.facts.details = { image: "https://restricted.example.com/private.jpg" };
    const transport: HttpTransport = async () => { throw new Error("Should never fetch"); };
    expect(await storyImage({ db, transport }, "town", story)).toBeNull();
  });
});
