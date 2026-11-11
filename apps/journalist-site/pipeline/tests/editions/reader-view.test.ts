import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Edition, EditionItem } from "../../../../reader-site/src/lib/reader-data";

const data = vi.hoisted(() => ({ readerData: vi.fn() }));
vi.mock("../../../../reader-site/src/lib/reader-data", () => data);
import { loadEditionPage, loadPipelineEdition, neighborhoodLinks } from "../../../../reader-site/src/lib/edition-view";

const item = (story_id: string, rank: number, kind: EditionItem["kind"], headline: string): EditionItem => ({
  story_id, rank, kind, headline, blurb: "A local update.", event_date: "2026-10-20",
  when_where: "When: Tuesday, October 20, 2 - 3pm. Where: Town Hall, Seattle.",
  source_url: `https://example.test/${story_id}`, source_name: "Town newsroom",
});
const edition = (id: string, published_at: number, items: EditionItem[], location_id = "ballard-wa"): Edition => ({
  id, published_at, items, location_id, location_name: "Ballard, Seattle, WA",
  window_start: "2026-10-19", window_end: "2026-10-25", headline: "Ballard this week", intro: "",
  coverage: ["Gathered from public sources."],
  corrections: [{ reason: "Updated the date.", created_at: 1792435200 }],
});

it("carries labeled event photos through the new reader views using the original edition index", async () => {
  const photo = { image: "https://upload.wikimedia.org/activity.jpg", image_credit: "Photographer", image_source_url: "https://commons.wikimedia.org/wiki/File:Activity.jpg",
    image_role: "stock" as const, image_caption: "Board games", image_date: "2026-10-01", image_license: "CC0", image_license_url: "https://creativecommons.org/publicdomain/zero/1.0/" };
  data.readerData.mockResolvedValue({ locations: [{ id: "ballard-wa", name: "Ballard, WA" }], editions: [edition("photos", 1, [
    { ...item("record", 0, "public_record", "Census data"), ...photo },
    { ...item("games", 9, "event", "Board games"), ...photo },
  ])] });
  const page = (await loadEditionPage("ballard-wa"))!;
  expect(page.articles[0].photo).toBeUndefined(); expect(page.articles[0].image).toBeNull();
  expect(page.articles[1].photo).toMatchObject({ image_role: "stock", image_date: "2026-10-01" });
  expect(page.articles[1].image).toContain("/api/images/ballard-wa?edition=photos&item=1");
  expect(page.eventDays.flatMap(day => day.events)[0].photo).toMatchObject({ image_role: "stock" });
});

beforeEach(() => {
  vi.stubEnv("NEWSBEE_READER_MEDIA_MODE", "photos");
  data.readerData.mockReset();
  data.readerData.mockResolvedValue({
    locations: [{ id: "ballard-wa", name: "Ballard, Seattle, WA" }, { id: "other-wa", name: "Other, WA" }],
    editions: [
      edition("old-edition", 1, [item("old-story", 1, "news_report", "Bus service changes")]),
      edition("latest-edition", 2, [
        item("housing-extra", 7, "public_record", "New apartment construction permit"),
        item("event", 0, "event", "Library story time"),
        item("schools", 5, "school_sports", "Students win"),
        item("news", 1, "news_report", "Light rail service changes"),
        item("record", 2, "public_record", "Apartment permit approved"),
        item("safety", 3, "safety_incident", "Incident at a business"),
        item("community", 4, "local_news", "Volunteers clean the park"),
        item("housing-more", 6, "public_record", "Housing construction begins"),
        item("meeting", 8, "meeting_preview", "City council meeting"),
      ]),
      edition("other-edition", 3, [item("other-story", 1, "news_report", "Other town news")], "other-wa"),
    ],
  });
});
afterEach(() => vi.unstubAllEnvs());

it("uses distinct illustrations consistently across cards, events and full articles", async () => {
  vi.stubEnv("NEWSBEE_READER_MEDIA_MODE", "illustrated");
  data.readerData.mockResolvedValue({ locations: [{ id: "ballard-wa", name: "Ballard, WA" }], editions: [edition("art", 1, [
    item("mime-a", 1, "event", "Mime workshop"), item("mime-b", 2, "event", "Another mime class"),
    item("bus", 3, "local_news", "New bus lanes open"), item("police", 4, "safety_incident", "Police report"),
  ])] });
  const page = (await loadEditionPage("ballard-wa"))!;
  expect(page.articles[0].illustration?.id).toBe("performance");
  expect(page.articles[1].illustration?.id).toBe("event-calendar");
  expect(page.articles[2].illustration?.id).toBe("transit");
  expect(page.articles[3].illustration).toBeUndefined();
  expect(page.topStories.find(story => story.storyId === "bus")?.illustration).toEqual(page.articles[2].illustration);
  expect(page.eventDays.flatMap(day => day.events).find(event => event.storyId === "mime-a")?.illustration).toEqual(page.articles[0].illustration);
  expect(page.articles.every(article => !article.photo && !article.image)).toBe(true);
});

describe("server-rendered reader editions", () => {
  it("uses the latest edition and keeps rank, topics, events, public sources and notices", async () => {
    const page = await loadEditionPage("ballard-wa", null, new Date("2026-10-20T20:00:00Z"));
    expect(page?.edition.id).toBe("latest-edition");
    expect(page?.topStories.map((story) => story.storyId)).toEqual(["news", "record", "safety", "community", "schools"]);
    expect(page?.topStories.map((story) => story.category)).toEqual(["Transit", "Housing", "Safety", "Community", "Sports"]);
    expect(page?.sections.map((section) => section.id)).toEqual(["housing"]);
    expect(page?.sections[0].stories.map((story) => story.storyId)).toEqual(["housing-more", "housing-extra"]);
    expect(page?.allSections.find((section) => section.id === "housing")?.stories).toHaveLength(3);
    expect(page?.eventDays).toHaveLength(7);
    expect(page?.eventDays.find((day) => day.isToday)?.events).toEqual([
      expect.objectContaining({ title: "Library story time", time: "2 PM", storyId: "event" }),
      expect.objectContaining({ title: "City council meeting", category: "Civic", storyId: "meeting" }),
    ]);
    expect(page?.sources).toHaveLength(9);
    expect(page?.edition.coverage).toEqual(["Gathered from public sources."]);
    expect(page?.edition.corrections[0].reason).toBe("Updated the date.");
    expect(data.readerData).toHaveBeenCalledTimes(1);
  });

  it("opens an exact published edition and preserves it across section and event navigation", async () => {
    const page = await loadEditionPage("ballard-wa", "old-edition");
    expect(page?.edition.id).toBe("old-edition");
    expect(page?.topStories.map((story) => story.storyId)).toEqual(["old-story"]);
    const links = neighborhoodLinks(page!);
    expect(links.page).toMatch(/\?location=ballard-wa&edition=old-edition$/);
    expect(links.section("transit")).toBe(`${links.page}&section=transit`);
    expect(links.events("2026-10-20")).toBe(`${links.page}&section=events&day=2026-10-20`);
    expect(links.suggest).toMatch(/\/suggest\?location=ballard-wa$/);
    expect((await loadPipelineEdition("ballard-wa", "old-edition"))?.id).toBe("old-edition");
  });

  it("never substitutes the latest edition or a different location for an invalid explicit edition", async () => {
    for (const id of ["missing", "other-edition"]) {
      expect(await loadEditionPage("ballard-wa", id)).toBeNull();
      expect(await loadPipelineEdition("ballard-wa", id)).toBeNull();
    }
    expect(await loadEditionPage("unknown-wa")).toBeNull();
  });

  it("keeps unpublished locations on the picker path and supports empty published editions", async () => {
    data.readerData.mockResolvedValue({
      locations: [{ id: "empty-wa", name: "Empty, WA" }, { id: "unpublished-wa", name: "Unpublished, WA" }],
      editions: [edition("empty-edition", 1, [], "empty-wa")],
    });
    expect(await loadEditionPage("unpublished-wa")).toBeNull();
    const page = await loadEditionPage("empty-wa");
    expect(page?.edition.id).toBe("empty-edition");
    expect(page?.visible).toEqual([]);
    expect(page?.sources).toEqual([]);
    expect(neighborhoodLinks(page!).page).not.toContain("edition=");
  });

  it("links every preview to its full article in the exact edition, never to the source", async () => {
    const page = (await loadEditionPage("ballard-wa"))!;
    const stories = [...page.topStories, ...page.allSections.flatMap((section) => section.stories),
      ...page.eventDays.flatMap((day) => day.events)];
    for (const story of stories) {
      const url = new URL(story.href!, "https://newsbee.test");
      expect(url.origin).toBe("https://newsbee.test");
      expect(url.searchParams.get("location")).toBe("ballard-wa");
      expect(url.searchParams.get("edition")).toBe("latest-edition");
      expect(url.searchParams.get("story")).toBe(story.storyId);
    }
    expect(page.articles).toHaveLength(9);
    expect(page.articles.find((article) => article.key === "safety")).toMatchObject({
      text: "A local update.", sourceUrl: "https://example.test/safety", image: null,
    });
  });

  it("keeps all expanded edition items accessible, including news with no topic and old items with no ID", async () => {
    const items = Array.from({ length: 60 }, (_, index) => ({
      ...item(`story-${index}`, index, "safety_incident", "Local update"),
      ...(index === 59 ? { story_id: null, source_url: null } : {}),
    }));
    data.readerData.mockResolvedValue({
      locations: [{ id: "ballard-wa", name: "Ballard, WA" }],
      editions: [edition("large-edition", 1, items)],
    });
    const page = (await loadEditionPage("ballard-wa"))!;
    expect(page.topStories).toHaveLength(5);
    expect(page.allSections).toEqual([]);
    expect(page.articles).toHaveLength(60);
    expect(page.articles[59].key).toBe("item:60");
    expect(new URL(page.articles[59].href, "https://newsbee.test").searchParams.get("story")).toBe("item:60");
    expect(page.articles[59].sourceUrl).toBeNull();
  });

  it("only exposes credited HTTPS photos and safe source URLs", async () => {
    const unsafe = { ...item("unsafe", 1, "local_news", "Local news"), source_url: "javascript:alert(1)", image: "https://example.test/photo.jpg" };
    const credited = { ...item("photo", 2, "reader_story", "A neighbour's photo"), image: "https://example.test/approved.jpg", image_caption: "Community garden", image_credit: "A neighbour" };
    data.readerData.mockResolvedValue({
      locations: [{ id: "ballard-wa", name: "Ballard, WA" }], editions: [edition("photos", 1, [unsafe, credited])],
    });
    const page = (await loadEditionPage("ballard-wa"))!;
    expect(page.articles[0]).toMatchObject({ sourceUrl: null, image: null });
    expect(page.articles[1]).toMatchObject({ image: credited.image, imageCredit: credited.image_credit });
  });
});

it("preserves linked secondary attribution, deduplicates tracking URLs and excludes unsafe links", async () => {
  const story = item("multi", 1, "news_report", "Park renovation");
  story.sources = [
    { name: "Town newsroom", url: story.source_url! + "?utm_source=feed" },
    { name: "Parks Department", url: "https://parks.example/record" },
    { name: "Unsafe", url: "javascript:alert(1)" },
  ];
  data.readerData.mockResolvedValue({ locations: [{ id: "ballard-wa", name: "Ballard, Seattle, WA" }], editions: [edition("multi-edition", 3, [story])] });
  const page = await loadEditionPage("ballard-wa");
  expect(page?.articles[0].sources).toEqual([
    { name: "Town newsroom", url: story.source_url },
    { name: "Parks Department", url: "https://parks.example/record" },
  ]);
  expect(page?.sources).toHaveLength(2);
});
