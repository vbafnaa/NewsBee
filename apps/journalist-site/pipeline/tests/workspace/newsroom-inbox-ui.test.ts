import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { adminApi } from "../../../lib/admin-client";
import InboxView from "../../../app/inbox/inbox-view";
import NeighbourStoryReview from "../../../app/neighbour-stories/neighbour-story-review";
import { PublicationScope } from "../../../app/components/publication-scope";

vi.mock("../../../lib/admin-client", async (original) => ({ ...await original<typeof import("../../../lib/admin-client")>(), adminApi: vi.fn() }));
vi.mock("../../../app/newsroom/[publicationId]/newsroom-context", () => ({
  loadNewsroom: async () => ({ publication: { name: "North newsroom" } }),
}));

let root: Root;
let container: HTMLElement;
const inbox = {
  counts: { held_stories: 1, suggestions: 1, source_feedback: 0, reports: 1, reader_stories: 0, family_notices: 0 },
  held: [{ id: "draft-1:story-1", run_id: "run-1", run_status: "editing", location_id: "north", location_name: "North", story_id: "story-1",
    title: "Held story", section: null, reasons: ["unfinished_sentence"], floor: null, draft_id: "draft-1", presentation_story_id: "p-1" }],
  suggestions: [{ _id: "suggestion-1", location_id: "north", location_name: "North", name: "North paper", url: "https://north.example.test", section: "news", why: null, submitted_at: "2026-11-19" }],
  source_feedback: [],
  reports: [{ _id: "report-1", location_id: "north", headline: "A story", message: "Typo", submitted_at: "2026-11-19", story_id: null, edition_id: "location-run" }],
};

beforeEach(() => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.getElementById("root")!;
  root = createRoot(container);
  vi.mocked(adminApi).mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("scopes every inbox call to the newsroom and keeps its links in the journalist workspace", async () => {
  vi.mocked(adminApi).mockImplementation(async (path) => path.startsWith("inbox") ? structuredClone(inbox) : {});
  await act(async () => root.render(createElement(PublicationScope, { publicationId: "north-room" }, createElement(InboxView))));
  expect(vi.mocked(adminApi).mock.calls[0][0]).toBe("inbox?publication=north-room");
  const links = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
  expect(links).toContain("/newsroom/north-room/editions/draft-1#edition-story-p-1");
  expect(links).toContain("/newsroom/north-room/editions");
  expect(links.some((href) => href?.startsWith("/locations/"))).toBe(false);
  // The run-level rewrite is an operator tool, not offered for a newsroom's own drafts.
  expect(container.textContent).not.toContain("Extract details and rewrite");
  const approve = [...container.querySelectorAll("button")].find((button) => button.textContent === "Approve")!;
  await act(async () => approve.click());
  expect(vi.mocked(adminApi).mock.calls.find(([, init]) => init?.method === "POST")).toEqual([
    "suggestions?publication=north-room", { method: "POST", body: JSON.stringify({ id: "suggestion-1", decision: "approved" }) },
  ]);
  const resolve = [...container.querySelectorAll("button")].find((button) => button.textContent === "Mark resolved")!;
  await act(async () => resolve.click());
  expect(vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method === "POST").map(([path]) => path))
    .toEqual(["suggestions?publication=north-room", "reports?publication=north-room"]);
});

it("keeps Operations' inbox unscoped and pointing at location tools", async () => {
  vi.mocked(adminApi).mockImplementation(async () => structuredClone({ ...inbox, held: [{ ...inbox.held[0], draft_id: undefined, run_status: "authoring" }] }));
  await act(async () => root.render(createElement(InboxView)));
  expect(vi.mocked(adminApi).mock.calls[0][0]).toBe("inbox");
  expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toContain("/locations/north?tab=edition&run=run-1");
  expect(container.textContent).toContain("Extract details and rewrite");
});

it("sends reader-story reviews from a newsroom with its scope", async () => {
  const fetcher = vi.fn(async () => Response.json({ submissions: [] }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(createElement(PublicationScope, { publicationId: "north-room" }, createElement(NeighbourStoryReview))));
  expect(fetcher.mock.calls[0][0]).toBe("/api/admin/reader-stories?status=pending&publication=north-room");
});

it("labels the analytics page as sample data", async () => {
  const { default: AnalyticsPage } = await import("../../../app/newsroom/[publicationId]/analytics/page");
  const markup = renderToStaticMarkup(await AnalyticsPage({ params: Promise.resolve({ publicationId: "north-room" }) }));
  const { document } = parseHTML(markup);
  expect(document.querySelector(".jw-sample-banner")?.textContent).toContain("Preview · sample data. Real analytics ship in a later release.");
  expect([...document.querySelectorAll(".jw-stat .jw-eyebrow")].map((label) => label.textContent)).toEqual(["Page views", "Unique readers", "Avg. read time", "Video plays"]);
  expect([...document.querySelectorAll(".jw-stat .jw-stat-detail")].every((detail) => detail.textContent?.startsWith("Sample"))).toBe(true);
  expect(document.querySelector("select")?.textContent).toContain("Last 30 days");
});
