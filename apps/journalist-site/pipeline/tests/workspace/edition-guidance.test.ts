import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, expect, it, vi } from "vitest";
import PublicationEditorialWorkspace from "@/app/publishing/publication-editorial-workspace";
import { editionEssentials, editionNextStage } from "@/app/publishing/edition-guidance";
import type { PublicationDraft } from "@/pipeline/publications/generation";
import { adminApi, ApiError } from "@/lib/admin-client";
import { NewsroomTaskPanel, NewsroomTasks } from "@/app/newsroom/newsroom-tasks";

vi.mock("@/lib/admin-client", async (original) => ({
  ...await original<typeof import("@/lib/admin-client")>(), adminApi: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URL(window.location.href).searchParams,
  usePathname: () => new URL(window.location.href).pathname,
}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture(): PublicationDraft {
  return {
    _id: "selected", publication_id: "publication", generation_id: "generation",
    status: "ready", unpublished: true, editable: true, title: "Weekly",
    window: ["2026-11-09", "2026-11-15"], locations: [{ id: "north", name: "North", source_map_version: 1 }],
    stories: [],
    versions: { publication: "one", preferences: "one", config: "one", source_maps: [] },
    telemetry: { actor: { id: "journalist", email: "journalist@example.test" }, funding: [] },
    revision: 3, editorial_status: "editing",
    presentation: {
      headline: "Weekly", intro: "", sections: [{ id: "news", title: "News" }],
      section_order: ["news"], story_order: ["a", "b"],
      stories: ["a", "b"].map((id) => ({
        id, headline: id, section_id: "news", origin: "original", generated_story_id: null,
        included: id === "a", body: "Reported copy", byline: "Reporter", location_tags: ["north"], image_id: null,
        source_metadata: [{ id: `source-${id}`, type: "web", name: "Agenda", url: "https://fixture.test/agenda", note: null }],
      })),
    },
    updated_at: 1, updated_by: { id: "journalist", email: "journalist@example.test" },
    ready_for_approval_at: null, ready_for_approval_by: null,
    distribution: { reader: false, email: false }, created_at: 1,
  };
}

it("links incomplete copy without treating optional preview or excluded copy as a readiness gate", () => {
  const draft = fixture();
  draft.presentation.stories[1].body = "";
  expect(editionEssentials(draft)).toEqual([{ href: "#edition-intro", label: "Add a publication introduction." }]);
  draft.presentation.intro = "This week's local reporting.";
  expect(editionEssentials(draft)).toEqual([]);
  expect(editionNextStage("editing")).toBe("#editorial-workspace-title");
  for (const status of ["ready_for_approval", "approved", "publishing", "published"] as const) {
    expect(editionNextStage(status)).toBe("#editorial-publish-title");
  }
});

it("keeps unassigned originals and incomplete or duplicate public sources linked in review", () => {
  const draft = fixture();
  draft.presentation.intro = "This week's local reporting.";
  const story = draft.presentation.stories[0];
  story.section_id = "";
  story.source_metadata[0].url = "http://fixture.test/agenda";
  expect(editionEssentials(draft)).toEqual([
    { href: "#edition-section-a", label: 'Choose a section for "a".' },
    { href: "#edition-sources-a", label: 'Complete sources for "a".' },
  ]);
  story.section_id = "news";
  story.source_metadata[0].url = "https://fixture.test/agenda";
  story.source_metadata.push({ ...story.source_metadata[0], id: "duplicate", url: "https://fixture.test/agenda?utm_source=tracking" });
  expect(editionEssentials(draft)).toEqual([{ href: "#edition-sources-a", label: 'Complete sources for "a".' }]);
  story.source_metadata.pop();
  expect(editionEssentials(draft)).toEqual([]);
});

it.each([false, true])("discloses generated evidence progressively while keeping safety flags visible (flagged=%s)", async (flagged) => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.defineProperty(document, "oninput", { configurable: true, value: null });
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const draft = fixture();
  draft.presentation.stories[0].origin = "generated";
  draft.presentation.stories[0].generated_story_id = "generated";
  draft.stories = [{
    id: "generated", canonical_identity: "source:agenda", location_tags: [{ id: "north", name: "North" }],
    references: [],
    snapshot: { headline: "Council agenda", summary: "Reported copy", when_where: null, event_date: null,
      kind: "civic", section: "news", sources: [], image: null },
    review: { status: flagged ? "held" : "ready", flags: flagged ? ["unclassified_safety_hold"] : [] },
  }];
  vi.mocked(adminApi).mockReset();
  vi.mocked(adminApi).mockImplementation(async (path) => path.endsWith("/releases") ? { releases: [] }
    : { draft, images: [], evidence: [{ story_id: "generated", review: draft.stories[0].review, sources: [], items: [] }] });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(PublicationEditorialWorkspace, { publicationId: "publication", draftId: "selected", canWrite: true })));
    const details = document.querySelector<HTMLDetailsElement>(".editorial-story-evidence details")!;
    expect(details.hasAttribute("open")).toBe(flagged);
    if (flagged) expect(details.textContent).toContain("unclassified_safety_hold");
    const body = document.querySelector('[aria-label="Story body for a"]');
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Add story")!.click());
    const reporting = document.querySelector<HTMLInputElement>('.editorial-story:not([hidden]) input[data-story-headline]')!;
    reporting.value = "Unfinished original reporting";
    await act(async () => { details.open = !details.open; details.dispatchEvent(new window.Event("toggle")); });
    expect(document.querySelector('[aria-label="Story body for a"]')).toBe(body);
    expect(document.querySelectorAll(".editorial-story:not([hidden])")).toHaveLength(1);
    expect(reporting.value).toBe("Unfinished original reporting");
    expect(vi.mocked(adminApi).mock.calls.every(([, options]) => !options?.method)).toBe(true);
  } finally { await act(async () => root.unmount()); }
});

it("focuses an asynchronously loaded exact stage and uses the existing ready, approve and explicit publish controls", async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const location = new URL("https://newsbee.test/newsroom/publication?draft=selected&generation=exact%2Brun&keep=yes#editorial-publish-title");
  Object.defineProperty(window, "location", { configurable: true, value: location });
  Object.defineProperty(document, "oninput", { configurable: true, value: null });
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const frames: FrameRequestCallback[] = [];
  window.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  window.cancelAnimationFrame = vi.fn();
  const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
  let current = fixture();
  let resolve!: (value: unknown) => void;
  const initial = new Promise((complete) => { resolve = complete; });
  let firstLoad = true;
  vi.mocked(adminApi).mockReset();
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.endsWith("/releases")) return { releases: [] };
    if (!init?.method) {
      if (firstLoad) { firstLoad = false; return initial; }
      return { draft: structuredClone(current), images: [], evidence: [] };
    }
    if (init.method === "PATCH") {
      const { operation } = JSON.parse(String(init.body));
      if (operation.type === "draft") {
        current.presentation.intro = operation.intro;
        return { draft: structuredClone(current) };
      }
      expect(JSON.parse(String(init.body))).toMatchObject({ operation: { type: "ready_for_approval" }, expectedRevision: 3 });
      if (!current.presentation.intro.trim()) throw new ApiError("Add a publication introduction.", 422);
      current = { ...current, editorial_status: "ready_for_approval", revision: 4 };
      return { draft: structuredClone(current) };
    }
    if (path.endsWith("/approve")) {
      expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: 4 });
      current = { ...current, editorial_status: "approved", approval: {
        revision: 4, content_hash: "exact-hash", approved_at: 1, approved_by: current.updated_by,
      } };
    } else if (path.endsWith("/publish")) {
      expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: 4, expectedContentHash: "exact-hash" });
      current = { ...current, editorial_status: "published" };
    } else throw new Error(`Unexpected request: ${path}`);
    return { draft: structuredClone(current) };
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const click = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
    expect(button, label).toBeDefined();
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(createElement(NewsroomTasks, { workspace: "/newsroom/publication" },
      createElement(NewsroomTaskPanel, { task: "writing" },
        createElement(PublicationEditorialWorkspace, { publicationId: "publication", draftId: "selected", canWrite: true })),
    )));
    await act(async () => frames.splice(0).forEach((frame) => frame(0)));
    await act(async () => resolve({ draft: structuredClone(current), images: [], evidence: [] }));
    expect(focus.mock.contexts.at(-1)).toBe(document.getElementById("editorial-publish-title"));
    expect(document.querySelector(".edition-guide")?.textContent).toContain("1 included story");
    expect(document.querySelector("#edition-intro")?.hasAttribute("required")).toBe(true);
    expect(document.querySelector('.editorial-publish a[href="#edition-intro"]')).not.toBeNull();
    const article = document.getElementById("edition-story-a")!;
    expect(article.querySelector("summary")).not.toBeNull();
    await act(async () => {
      location.hash = "#edition-story-a";
      window.dispatchEvent(new window.Event("hashchange"));
    });
    await act(async () => frames.splice(0).forEach((frame) => frame(0)));
    expect(focus.mock.contexts.at(-1)).toBe(article);
    await act(async () => {
      location.hash = "#edition-intro";
      window.dispatchEvent(new window.Event("hashchange"));
    });

    await act(async () => frames.splice(0).forEach((frame) => frame(0)));
    expect(focus.mock.contexts.at(-1)).toBe(document.getElementById("edition-intro"));
    expect(document.querySelector(".edition-guide")!.compareDocumentPosition(document.querySelector(".editorial-story")!) & 4).toBeTruthy();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    await click("Mark ready for approval");
    expect(document.querySelector(".editorial-workspace")?.textContent).toContain("Add a publication introduction.");
    const intro = document.querySelector<HTMLTextAreaElement>("#edition-intro")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(intro, "This week's reporting.");
      intro.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await click("Mark ready for approval");
    expect(document.querySelector(".edition-guide")?.textContent).toContain("ready for approval");
    expect(vi.mocked(adminApi).mock.calls.some(([path]) => path.endsWith("/approve"))).toBe(false);
    await click("Approve revision 4");
    for (const link of document.querySelectorAll<HTMLAnchorElement>(".edition-guide nav a")) {
      expect(document.getElementById(link.getAttribute("href")!.slice(1))).not.toBeNull();
    }
    expect(document.querySelector(".edition-guide nav a")?.getAttribute("href")).toBe("#editorial-publish-title");
    expect(vi.mocked(adminApi).mock.calls.some(([path]) => path.endsWith("/publish"))).toBe(false);
    await click("Publish to web");
    expect(document.querySelector(".edition-guide nav a")?.getAttribute("href")).toBe("#editorial-publish-title");
    expect(document.getElementById("editorial-review-title")).not.toBeNull();
    expect(document.querySelector(".edition-guide")?.textContent).toContain("published");
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect(location.search).toBe("?draft=selected&generation=exact%2Brun&keep=yes");
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  ["ready_for_approval", "Reopen for editing"],
  ["approved", "Reopen for editing"],
  ["publishing", "Reporting cannot be changed while publication is in progress."],
  ["published", "This published release is immutable."],
] as const)("gives truthful original-reporting guidance for %s", async (status, expected) => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const draft = { ...fixture(), editorial_status: status };
  vi.mocked(adminApi).mockReset();
  vi.mocked(adminApi).mockImplementation(async (path) => path.endsWith("/releases") ? { releases: [] }
    : { draft, images: [], evidence: [] });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(PublicationEditorialWorkspace, { publicationId: "publication", draftId: "selected", canWrite: true })));
    const guidance = document.getElementById("editorial-original-reporting-title")!.parentElement!;
    expect(guidance.textContent).toContain(expected);
    if (status === "publishing" || status === "published") expect(guidance.textContent).not.toContain("Reopen");
    if (status === "published") expect(guidance.querySelector("a")?.getAttribute("href")).toBe("#publication-release-history-title");
  } finally { await act(async () => root.unmount()); }
});

it.each(["available", "withdrawn", "correction-required"] as const)("keeps the published edition video handoff exact and release-safe (%s)", async (state) => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const draft = { ...fixture(), editorial_status: "published", release: { release_id: "selected+release" } };
  const selectedRelease = {
    draftId: draft._id, releaseId: draft.release.release_id, title: "Selected edition",
    windowStart: draft.window[0], windowEnd: draft.window[1], locations: [], contentHash: "hash",
    sourceChanges: [], correctionRequired: state === "correction-required",
    action: state === "withdrawn" ? { action: "withdraw", reason: "Withdrawn", at: 1 } : null,
  };
  vi.mocked(adminApi).mockReset();
  vi.mocked(adminApi).mockImplementation(async (path) => path.endsWith("/releases")
    ? { releases: [selectedRelease, { ...selectedRelease, releaseId: "other-release", action: null, correctionRequired: false }] }
    : { draft, images: [], evidence: [], readerBaseUrl: "https://reader.example.test" });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(PublicationEditorialWorkspace, {
      publicationId: "publication", draftId: "selected", canWrite: true,
    })));
    const guide = document.querySelector(".edition-guide")!;
    const studio = [...guide.querySelectorAll("a")].find((link) => link.textContent === "Video Studio");
    expect(studio?.getAttribute("href") ?? null).toBe(state === "available" ? "/newsroom/publication/releases/selected%2Brelease" : null);
    expect(guide.querySelector("a")?.getAttribute("href")).toBe("https://reader.example.test/publications/publication/releases/selected%2Brelease");
    expect(document.querySelector(".editorial-save-state")?.textContent).toContain("Published · read-only");
    expect(document.querySelector(".editorial-story-panel")?.textContent).not.toContain("Unfinished copy autosaves");
    expect(document.querySelector("#editorial-original-reporting-title")?.textContent).toBe("Published edition");
    expect(document.querySelector(".published-story-copy")?.textContent).toContain("Reported copy");
    expect(document.querySelector('[aria-label="Story body for a"]')).toBeNull();
    expect(document.querySelector("#editorial-review-title h3")).toBeNull();
    expect(document.querySelector(".editorial-preview")?.hasAttribute("hidden")).toBe(true);
    expect(vi.mocked(adminApi).mock.calls.every(([, options]) => !options?.method)).toBe(true);
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Create correction")).toBe(true);
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === (state === "withdrawn" ? "Restore" : "Withdraw"))).toBe(true);
  } finally { await act(async () => root.unmount()); }
});
