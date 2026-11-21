import { describe, expect, it } from "vitest";
import type { PublicationReleaseItem } from "../../../../../shared/publication-release";
import type {
  Edition,
  EditionItem,
  ReaderPublicationBrowseRelease,
} from "../../../../reader-site/src/lib/reader-data";
import { BROWSE_PAGE_SIZE, browseFilters, browseHref, buildBrowsePage, publishedStoryHref } from "../../../../reader-site/src/lib/browse-editions";

const locations = [{ id: "ballard-wa", name: "Ballard, WA" }, { id: "moses-lake-wa", name: "Moses Lake, WA" }];
const item = (id: string | null, headline = "Local story", extra: Partial<EditionItem> = {}): EditionItem => ({
  story_id: id, headline, blurb: "A published local update.", when_where: "Town Hall",
  event_date: "2026-11-12", source_url: "https://example.test/news", kind: "local_news", ...extra,
});
const edition = (id: string, published_at: number, items: EditionItem[], location_id = "ballard-wa"): Edition => ({
  id, published_at, items, location_id, location_name: "Published community",
  headline: `${id} edition`, intro: "", window_start: "2026-11-06", window_end: "2026-11-12",
});
const releaseItem = (headline: string, extra: Partial<PublicationReleaseItem> = {}): PublicationReleaseItem => ({
  item_id: "publication-story",
  story_id: "publication-story",
  origin: "generated",
  source_references: [],
  location_ids: ["ballard-wa"],
  location_names: ["Ballard, WA"],
  section_id: "community",
  section_title: "Community",
  headline,
  blurb: "A current publication release story.",
  byline: "",
  when_where: "",
  event_date: "2026-11-12",
  source_url: "https://example.test/publication",
  sources: [{ name: "Publication source", url: "https://example.test/publication" }],
  rank: 1,
  kind: "local_news",
  ...extra,
});
const publicationRelease = (
  release_id: string,
  published_at: number,
  items: PublicationReleaseItem[] | null,
  extra: Partial<ReaderPublicationBrowseRelease> = {},
): ReaderPublicationBrowseRelease => ({
  key: `publication:weekly:${release_id}`,
  publication_id: "weekly",
  publication_name: "The Neighborhood Weekly",
  release_id,
  title: `${release_id} release`,
  window_start: "2026-11-06",
  window_end: "2026-11-12",
  published_at,
  locations,
  withdrawn: false,
  withdrawal_reason: null,
  latest: Boolean(items),
  items,
  ...extra,
});
const search = (editions: Edition[], query = "", publicationReleases: ReaderPublicationBrowseRelease[] = []) =>
  buildBrowsePage({ locations, editions, publicationReleases }, browseFilters(new URLSearchParams(query)), "/reader", 10_000);

describe("published story browser", () => {
  it("keeps unloaded latest-release metadata selectable without treating it as historical search content", () => {
    const loaded = publicationRelease("loaded", 30, [releaseItem("Loaded story")]);
    const unloaded = publicationRelease("unloaded", 20, null, { latest: true });
    const result = search([], `location=ballard-wa&edition=${loaded.key}`, [loaded, unloaded]);
    expect(result.stories).toHaveLength(1);
    expect(result.editionOptions.map((entry) => entry.id)).toEqual([loaded.key, unloaded.key]);
    expect(result.history.find((entry) => entry.id === unloaded.key)).toMatchObject({ searchable: true, storyCount: null });
  });

  it("normalizes bounded plain-text searches and page parameters while preserving URL filters", () => {
    const filters = browseFilters(new URLSearchParams({ q: `  coffee   ${"x".repeat(300)} `, page: "-2", historyPage: "10000000" }));
    expect(filters.q).toHaveLength(200);
    expect(filters.q.startsWith("coffee ")).toBe(true);
    expect(filters.page).toBe(1);
    expect(filters.historyPage).toBe(1);
    const href = browseHref("/reader/", { location: "ballard-wa", edition: "old & exact", q: "coffee & music", topic: "culture", page: 2, historyPage: 3 });
    const url = new URL(href, "https://newsbee.test");
    expect(url.pathname).toBe("/reader/browse");
    expect(Object.fromEntries(url.searchParams)).toEqual({ location: "ballard-wa", edition: "old & exact", q: "coffee & music", topic: "culture", page: "2", historyPage: "3" });
  });

  it("serves only directory communities and already published editions without forwarding internal fields", () => {
    const published = { ...edition("public", 10, [{ ...item("yes"), private_notes: "ITEM SECRET" } as EditionItem]), internal_source_map: "EDITION SECRET" };
    const result = search([
      published,
      edition("unpublished", 0, [item("draft")]),
      edition("future", 10_001, [item("scheduled")]),
      edition("invalid-time", Number.NaN, [item("invalid")]),
      edition("removed-community", 20, [item("removed")], "removed-wa"),
    ]);
    expect(result.stories.map((story) => story.headline)).toEqual(["Local story"]);
    expect(result.history.map((entry) => entry.id)).toEqual(["public"]);
    expect(result.locations.map((location) => location.id)).toEqual(["ballard-wa"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("source_url");
  });

  it("isolates communities and rejects an edition belonging to another community", () => {
    const editions = [edition("ballard-issue", 10, [item("shared-id", "Ballard story")]), edition("moses-issue", 20, [item("shared-id", "Moses story")], "moses-lake-wa")];
    expect(search(editions).total).toBe(2);
    expect(search(editions, "location=ballard-wa").stories.map((story) => story.headline)).toEqual(["Ballard story"]);
    const wrong = search(editions, "location=ballard-wa&edition=moses-issue");
    expect(wrong.invalidReason).toContain("selected community");
    expect(wrong.stories).toEqual([]);
    expect(wrong.selectedEdition).toBeNull();
    expect(search(editions, "edition=ballard-issue").stories).toEqual([]);
    expect(search(editions, "location=unknown-wa").stories).toEqual([]);
  });

  it("pins duplicate edition IDs to their community and preserves original anonymous item indices", () => {
    const editions = [edition("shared-edition", 10, [item(null, "First item", { rank: 99 }), item(null, "Second item", { rank: 1 })]), edition("shared-edition", 20, [item("moses", "Moses story")], "moses-lake-wa")];
    const result = search(editions, "location=ballard-wa&edition=shared-edition");
    expect(result.stories).toHaveLength(2);
    const second = result.stories.find((story) => story.headline === "Second item")!;
    expect(new URL(second.href, "https://newsbee.test").searchParams.get("story")).toBe("item:2");
    expect(new URL(second.href, "https://newsbee.test").searchParams.get("location")).toBe("ballard-wa");
    expect(publishedStoryHref("/reader", editions[0], editions[0].items[0], 0)).toBe("/reader?location=ballard-wa&edition=shared-edition&story=item%3A1");
    expect(editions[0].items[0].rank).toBe(99);
  });

  it("deduplicates a repeated story across issues while linking every shown version exactly", () => {
    const result = search([
      edition("older", 10, [item("same", "Original bakery announcement")]),
      edition("newer", 20, [item("same", "Bakery opening date updated")]),
    ]);
    expect(result.total).toBe(1);
    expect(result.stories[0]).toMatchObject({ headline: "Bakery opening date updated", editionId: "newer", versionCount: 2 });
    expect(new URL(result.stories[0].href, "https://newsbee.test").searchParams.get("edition")).toBe("newer");
    expect(new URL(result.stories[0].otherVersions[0].href, "https://newsbee.test").searchParams.get("edition")).toBe("older");
    const oldMatch = search([edition("older", 10, [item("same", "Original bakery announcement")]), edition("newer", 20, [item("same", "Bakery opening date updated")])], "q=original");
    expect(oldMatch.stories[0].editionId).toBe("older");
    expect(oldMatch.stories[0].versionCount).toBe(2);
  });

  it("deduplicates anonymous repeats without merging distinct stories on a shared source page", () => {
    const first = item(null, "Town library meeting");
    const result = search([edition("one", 10, [first]), edition("two", 20, [first, item(null, "Different library meeting"), item(null, "Town library meeting", { event_date: "2026-11-13" })])]);
    expect(result.total).toBe(3);
    expect(result.stories.find((story) => story.headline === "Town library meeting" && story.eventDate === "2026-11-12")?.versionCount).toBe(2);
  });

  it("searches published text and community names with accent-insensitive all-word matching and topic filters", () => {
    const editions = [edition("issue", 10, [
      item("cafe", "Café opens near the park", { kind: "business_opening" }),
      item("bus", "New bus route opens", { blurb: "A direct service through the park." }),
      item("event", "Library story time", { kind: "event" }),
    ])];
    expect(search(editions, "q=cafe+ballard&topic=business").stories.map((story) => story.editionId)).toEqual(["issue"]);
    expect(search(editions, "q=park&topic=transit").stories.map((story) => story.headline)).toEqual(["New bus route opens"]);
    expect(search(editions, "topic=events").stories.map((story) => story.headline)).toEqual(["Library story time"]);
    expect(search(editions, "q=park+missing").total).toBe(0);
    expect(search(editions, "topic=internal").invalidReason).toContain("listed topics");
  });

  it("paginates distinct stories in chronological order without overlap and bounds excessive page numbers", () => {
    const editions = Array.from({ length: 45 }, (_, i) => edition(`issue-${i}`, i + 1, [item(`story-${i}`, `Story ${i}`)]));
    const one = search(editions);
    const two = search(editions, "page=2");
    const last = search(editions, "page=999999");
    expect(one.stories).toHaveLength(BROWSE_PAGE_SIZE);
    expect(two.stories).toHaveLength(BROWSE_PAGE_SIZE);
    expect(last.stories).toHaveLength(5);
    expect(one.stories[0].editionId).toBe("issue-44");
    expect(two.stories[0].editionId).toBe("issue-24");
    expect(last.page).toBe(3);
    expect(new Set([...one.stories, ...two.stories, ...last.stories].map((story) => story.href)).size).toBe(45);
    expect(editions[0].id).toBe("issue-0");
  });

  it("paginates community edition history independently and keeps an old selected issue in bounded options", () => {
    const editions = Array.from({ length: 60 }, (_, i) => edition(`issue-${i}`, i + 1, [item(`story-${i}`)]));
    const result = search(editions, "location=ballard-wa&historyPage=2&edition=issue-0");
    expect(result.historyTotal).toBe(60);
    expect(result.historyPages).toBe(6);
    expect(result.history).toHaveLength(10);
    expect(result.history[0].id).toBe("issue-49");
    expect(result.editionOptions).toHaveLength(51);
    expect(result.editionOptions.at(-1)?.id).toBe("issue-0");
    expect(result.stories).toHaveLength(1);
    expect(result.stories[0].editionId).toBe("issue-0");
  });

  it("bounds version links per story while retaining the full publication count", () => {
    const result = search(Array.from({ length: 15 }, (_, i) => edition(`issue-${i}`, i + 1, [item("same")])));
    expect(result.stories).toHaveLength(1);
    expect(result.stories[0].versionCount).toBe(15);
    expect(result.stories[0].otherVersions).toHaveLength(5);
  });

  it("indexes current publication stories, lists archive releases once, and deduplicates referenced legacy stories", () => {
    const legacy = edition("legacy", 10, [item("source-story", "Original library hours")]);
    const current = publicationRelease("current", 30, [releaseItem("Updated library hours", {
      source_references: [{ location_id: "ballard-wa", edition_id: "legacy", story_id: "source-story" }],
    })]);
    const archived = publicationRelease("archived", 20, null, { latest: false });
    const result = search([legacy], "", [current, archived]);
    expect(result.history).toHaveLength(3);
    expect(result.history.filter((entry) => entry.kind === "publication")).toHaveLength(2);
    expect(result.stories).toHaveLength(1);
    expect(result.stories[0]).toMatchObject({
      headline: "Updated library hours",
      publicationName: "The Neighborhood Weekly",
      kind: "publication",
      versionCount: 2,
    });
    expect(result.stories[0].href).toBe("/reader/publications/weekly/releases/current?story=publication-story");
    expect(result.editionOptions.map((entry) => entry.id)).toContain(current.key);
    expect(result.editionOptions.map((entry) => entry.id)).not.toContain(archived.key);
    expect(result.history.find((entry) => entry.id === archived.key)).toMatchObject({
      href: "/reader/publications/weekly/releases/archived",
      searchable: false,
      storyCount: null,
    });
    expect(search([], "location=moses-lake-wa", [current, archived]).history).toHaveLength(2);
  });
});
