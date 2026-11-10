import { describe, expect, it } from "vitest";
import { articleImageCandidates, articleMeta } from "../../connectors/web/page";

const source = "https://organizer.example/events/show";
describe("editorial image candidate extraction", () => {
  it("keeps each structured image's credit, deduplicates and caps at four candidates", () => {
    const images = Array.from({ length: 6 }, (_, i) => ({ contentUrl: `/photo-${i}.jpg`, creditText: `Photographer ${i}`, width: 2400, height: 1600 }));
    const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", headline: "Local show", image: [images[0], ...images] })}</script>`;
    const candidates = articleImageCandidates(html, source);
    expect(candidates).toHaveLength(4);
    expect(candidates.map(image => image.image_credit)).toEqual(["Photographer 0", "Photographer 1", "Photographer 2", "Photographer 3"]);
    expect(articleMeta(html, source)).toMatchObject({ image: candidates[0].image, image_candidates: candidates });
  });
  it("collects event images and fallbacks, ignoring unsafe URLs and tiny thumbnails", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "Event", image: [
      "https://127.0.0.1/private.jpg", { contentUrl: "/tiny.jpg", width: 80, height: 80 }, { contentUrl: "/event.jpg", creditText: "Pat" },
    ] })}</script><meta property="og:image" content="/event.jpg"><meta name="twitter:image" content="/second.jpg">`;
    expect(articleImageCandidates(html, source).map(image => image.image)).toEqual(["https://organizer.example/event.jpg", "https://organizer.example/second.jpg"]);
  });
  it("uses credited editorial figures and lazy-loaded photographs while excluding navigation and ads", () => {
    const html = `<nav><img src="/logo.jpg"></nav><img src="/ad.jpg"><article>
      <figure><img data-src="/unloaded.jpg" alt="Missing source"></figure>
      <figure><img src="/gathering.jpg" width="2400" height="1600" alt="Neighbors at the gathering"><figcaption>Opening day. Photo: Alex Neighbor</figcaption></figure>
      </article><footer><img src="/footer.jpg"></footer>`;
    expect(articleImageCandidates(html, source)).toEqual([{ image: "https://organizer.example/gathering.jpg", image_source_url: source,
      image_width: 2400, image_height: 1600, image_alt: "Neighbors at the gathering", image_caption: "Opening day. Photo: Alex Neighbor", image_credit: "Alex Neighbor" },
      { image: "https://organizer.example/unloaded.jpg", image_source_url: source, image_alt: "Missing source" }]);
  });
  it("does not infer a capture date or photographer from page publication metadata", () => {
    const html = '<title>Opening</title><meta property="article:published_time" content="2026-11-03"><meta property="og:image" content="/opening.jpg">';
    const image = articleImageCandidates(html, source)[0];
    expect(image).not.toHaveProperty("image_date"); expect(image).not.toHaveProperty("image_credit");
  });
  it("finds a relevant photograph beyond the old four-image limit and chooses its largest declared source", () => {
    const earlier = Array.from({ length: 7 }, (_, i) => `<figure><img src="/background-${i}.jpg" width="1200" height="800" alt="A building"></figure>`).join("");
    const html = `<h1>Route 40 riders celebrate new crossings</h1><article>${earlier}
      <figure><img src="/route-map.jpg" alt="Route 40 map"></figure>
      <figure><picture><source type="image/webp" srcset="/riders-1200.webp 1200w, /riders-2400.webp 2400w"><img src="/riders-small.jpg" width="160" height="90" alt="Route 40 riders at new crossings"></picture><figcaption>Route 40 riders. Photo: Pat Photographer</figcaption></figure></article>`;
    const images = articleImageCandidates(html, source);
    expect(images).toHaveLength(4);
    expect(images[0]).toMatchObject({ image: "https://organizer.example/riders-2400.webp", image_width: 2400, image_credit: "Pat Photographer" });
    expect(images[0]).not.toHaveProperty("image_height");
    expect(images.some(image => image.image.includes("route-map"))).toBe(false);
  });
  it("bounds the metadata pool, ignores related-story images and handles malformed escape sequences", () => {
    const figures = Array.from({ length: 30 }, (_, i) => `<figure><img src="/photo-${i}.jpg" alt="Neighborhood"></figure>`).join("");
    const html = `<main><aside><figure><img src="/unrelated.jpg" alt="A related story"></figure></aside><figure><img src="/photo-%ZZ.jpg"></figure>${figures}</main>`;
    const images = articleImageCandidates(html, source);
    expect(images).toHaveLength(4);
    expect(images.some(image => image.image.includes("unrelated"))).toBe(false);
    expect(images.every(image => !image.image.includes("photo-29"))).toBe(true);
  });
  it("keeps a later subject photograph over twenty earlier candidates and reads article images without figures", () => {
    const earlier = Array.from({ length: 24 }, (_, i) => `<img src="/earlier-${i}.jpg" alt="A building">`).join("");
    const html = `<article><h1>Moses Lake concert</h1>${earlier}<img data-srcset="/concert-2400.jpg 2400w, /concert-1200.jpg 1200w" alt="Moses Lake concert performers"></article>`;
    expect(articleImageCandidates(html, source)[0]).toMatchObject({ image: "https://organizer.example/concert-2400.jpg", image_width: 2400 });
  });
  it("reads legacy WordPress content containers and explicit feature-image credits", () => {
    const html = '<div class="entry-content"><div class="featureImage"><img src="/show.jpg" srcset="/show-original.jpg 2400w" alt="Community gathering"><span class="caption">The gathering. Photo credit: Pat Photographer</span></div></div><aside><img src="/advertisement.jpg"></aside>';
    expect(articleImageCandidates(html, source)).toEqual([{ image: "https://organizer.example/show-original.jpg", image_source_url: source,
      image_width: 2400, image_alt: "Community gathering", image_caption: "The gathering. Photo credit: Pat Photographer", image_credit: "Pat Photographer" }]);
  });
});
