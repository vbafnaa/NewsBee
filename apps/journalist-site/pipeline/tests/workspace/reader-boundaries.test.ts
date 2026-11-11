import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const data = vi.hoisted(() => ({ readerData: vi.fn(), saveEngagement: vi.fn() }));
vi.mock("../../../../reader-site/src/lib/reader-data", () => data);
import { POST } from "../../../../reader-site/src/pages/api/engagement";
import { GET } from "../../../../reader-site/src/pages/api/editions/[location_id]";

beforeEach(() => {
  data.readerData.mockResolvedValue({
    locations: [{ id: "town-wa" }],
    editions: [
      { id: "older-edition", location_id: "town-wa", published_at: 1, items: [{ story_id: "story-a" }] },
      { id: "latest-edition", location_id: "town-wa", published_at: 2, items: [{ story_id: "story-b" }] },
      { id: "other-town", location_id: "other-wa", published_at: 3, items: [] },
    ],
  });
});
afterEach(() => { vi.resetAllMocks(); });

function event(body: unknown, origin = "http://localhost") {
  return POST({ request: new Request("http://localhost/api/engagement", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }), url: new URL("http://localhost/api/engagement") } as Parameters<typeof POST>[0]);
}

it("records one valid edition read including editions with no tracked story IDs", async () => {
  expect((await event({ location_id: "town-wa", edition_id: "older-edition", action: "view", story_ids: ["story-a"] })).status).toBe(204);
  expect(data.saveEngagement).toHaveBeenCalledTimes(1);
  expect((await event({ location_id: "town-wa", edition_id: "older-edition", action: "view", story_ids: [] })).status).toBe(204);
});

it("rejects cross-origin events and mismatched or nonexistent editions and stories", async () => {
  for (const body of [
    { location_id: "town-wa", edition_id: "other-town", action: "view", story_ids: [] },
    { location_id: "town-wa", edition_id: "not-an-edition", action: "view", story_ids: [] },
    { location_id: "town-wa", edition_id: "older-edition", action: "open", story_id: "story-b" },
  ]) expect((await event(body)).status).toBe(422);
  expect((await event({}, "https://example.test")).status).toBe(403);
  expect(data.saveEngagement).not.toHaveBeenCalled();
});

it("opens the exact published edition selected from the workspace without crossing locations", async () => {
  const request = (edition: string) => GET({ params: { location_id: "town-wa" }, url: new URL(`http://localhost/api/editions/town-wa?edition=${edition}`) } as Parameters<typeof GET>[0]);
  expect((await (await request("older-edition")).json()).id).toBe("older-edition");
  expect((await request("other-town")).status).toBe(404);
  expect((await request("missing")).status).toBe(404);
});

it("keeps coverage notes but moves external source links and reports into the full article", async () => {
  const page = await readFile(new URL("../../../../reader-site/src/pages/index.astro", import.meta.url), "utf8");
  const frame = await readFile(new URL("../../../../reader-site/src/components/edition/NeighborhoodPage.astro", import.meta.url), "utf8");
  const sources = await readFile(new URL("../../../../reader-site/src/components/edition/SourceNotes.astro", import.meta.url), "utf8");
  const legacy = await readFile(new URL("../../../../reader-site/src/pages/sources.astro", import.meta.url), "utf8");
  expect(frame).toContain("<SourceNotes page={page}");
  expect(sources).toContain("data-edition-notes");
  expect(sources).not.toContain("source.source_url");
  expect(sources).not.toContain("ReportStory");
  expect(sources).toContain('id="suggest-source-link"');
  expect(sources).toContain("page.edition.coverage");
  expect([page, frame, sources].join("\n")).not.toMatch(/How we found this|Where this news comes from|\/sources\?location|\/source-map/);
  expect(legacy).toContain("Astro.redirect");
  expect(legacy).not.toMatch(/editionMap|reader-data|funnel|source\.items/);
  const article = await readFile(new URL("../../../../reader-site/src/components/edition/ArticlePage.astro", import.meta.url), "utf8");
  expect(article).toContain("article.sources");
  expect(article).toContain("href={source.url}");
  expect(article).toContain("<ReportStory");
  expect(article).toContain("data-share-story");
  expect(article).toContain("window.print()");
  for (const name of ["TopNews", "Newsroom", "EventsWeek", "EventsList", "SectionList"]) {
    const preview = await readFile(new URL(`../../../../reader-site/src/components/edition/${name}.astro`, import.meta.url), "utf8");
    expect(preview).not.toContain("ReportStory");
  }
});
