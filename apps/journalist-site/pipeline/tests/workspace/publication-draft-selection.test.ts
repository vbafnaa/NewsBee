import { act, createElement, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PublicationGeneration from "../../../app/publishing/publication-generation";
import PublicationEditorialWorkspace from "../../../app/publishing/publication-editorial-workspace";
import { adminApi, ApiError } from "../../../lib/admin-client";
import type { PublicationDraft } from "../../publications/generation";
import { NewsroomTasks } from "../../../app/newsroom/newsroom-tasks";

vi.mock("../../../lib/admin-client", async (original) => ({
  ...await original<typeof import("../../../lib/admin-client")>(),
  adminApi: vi.fn(),
}));
vi.mock("../../../app/components/story-evidence", () => ({ default: () => null }));

let root: Root;
/** The open edition: its route (`/editions/[draftId]`) or, on the older single-page URL, `?draft=`. */
const selectedDraft = () => {
  const match = /\/editions\/([^/]+)$/.exec(url.pathname);
  return match ? decodeURIComponent(match[1]) : url.searchParams.get("draft");
};
let container: HTMLElement;
let url: URL;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  url = new URL("https://fixture.test/newsroom/publication?draft=older&keep=yes#reporting");
  Object.defineProperty(window, "location", { configurable: true, get: () => url });
  Object.defineProperty(window, "history", { configurable: true, value: {
    state: null,
    pushState: vi.fn((_state, _title, next) => { url = new URL(next, url); }),
    replaceState: vi.fn((_state, _title, next) => { url = new URL(next, url); }),
  } });
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("starts writing without provider preflight and selects only the new draft, retaining generation identity", async () => {
  url = new URL("https://fixture.test/newsroom/publication/new-edition?generation=unrelated-run");
  window.requestAnimationFrame = (callback) => { callback(0); return 0; };
  window.cancelAnimationFrame = vi.fn();
  let created = false;
  const manual = { ...draft("manual-selected"), origin: "manual" as const };
  delete manual.generation_id;
  const workspace = () => ({
    ...generations(created ? manual : null),
    readerBaseUrl: null, readerLink: { state: "unavailable", detail: "Reader configuration is invalid." },
    drafts: created ? [manual] : [],
    locations: [{ location_id: "north", location_name: "North", ready: true, missing_prerequisites: [] }],
  });
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.includes("/generation-preflight")) throw new Error("Accounting temporarily unavailable");
    if (path.includes("/generations")) return workspace();
    if (path.endsWith("/drafts") && init?.method === "POST") { created = true; return { draft: manual, created: true }; }
    if (path.endsWith("/releases")) return { releases: [] };
    return { draft: manual, images: [], evidence: [], readerBaseUrl: null,
      readerLink: { state: "unavailable", detail: "Reader configuration is invalid." } };
  });
  await act(async () => root.render(createElement(NewsroomTasks, { workspace: "/newsroom/publication" },
    createElement(PublicationGeneration, {
      publicationId: "publication", publicationName: "Weekly", publicationEnabled: true,
      supportMode: false, generationAnchorId: "editions", reportingAnchorId: "reporting",
    }))));
  expect(container.textContent).toContain("Generation preflight unavailable");
  expect(container.querySelector('[data-newsroom-task="new-edition"]')?.closest("[hidden]")).toBeNull();
  expect([...container.querySelectorAll("button")].find((item) => item.textContent === "Generate draft")?.disabled).toBe(true);
  expect([...container.querySelectorAll("button")].find((item) => item.textContent === "Start writing")?.disabled).toBe(false);
  await click("Start writing");
  expect(selectedDraft()).toBe("manual-selected");
  expect(url.pathname).toBe("/newsroom/publication/editions/manual-selected");
  expect(url.searchParams.get("generation")).toBe("unrelated-run");
  expect(container.querySelectorAll(".editorial-workspace")).toHaveLength(1);
  expect(container.textContent).toContain("Reader configuration is invalid.");
  expect(vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method === "POST").map(([path]) => path))
    .toEqual(["publications/publication/drafts"]);
});

it("shows every configured community and requires an explicit selection instead of silently choosing a capped subset", async () => {
  url = new URL("https://fixture.test/newsroom/publication/new-edition");
  const locations = ["North", "South", "East", "West"].map((name) => ({
    location_id: name.toLowerCase(), location_name: name, ready: true, missing_prerequisites: [],
  }));
  vi.mocked(adminApi).mockImplementation(async (path) => {
    if (path.includes("/generation-preflight")) return { remaining: 20, exhausted: false, resetsAt: 1, source: "platform", reasons: [] };
    if (path.includes("/generations")) return {
      ...generations(null), drafts: [], locations, execution: { funding: "managed" },
    };
    throw new Error(`Unexpected request: ${path}`);
  });
  await act(async () => root.render(createElement(NewsroomTasks, { workspace: "/newsroom/publication" },
    createElement(PublicationGeneration, {
      publicationId: "publication", publicationName: "Weekly", publicationEnabled: true,
      supportMode: false, generationAnchorId: "editions", reportingAnchorId: "reporting",
    }))));
  const choices = [...container.querySelectorAll<HTMLInputElement>('.generation-location-grid input[type="checkbox"]')];
  expect(choices).toHaveLength(4);
  expect(choices.filter((input) => input.checked)).toHaveLength(0);
  expect(container.textContent).toContain("no subset has been selected for you");
  expect([...container.querySelectorAll("button")].find((item) => item.textContent === "Start writing")?.disabled).toBe(true);
});

it("never substitutes same-host live, archive or release links for explicit unavailable configuration", async () => {
  const published = { ...draft(), editorial_status: "published" as const, release: {
    release_id: "published-release", published_at: 1,
  } } as PublicationDraft;
  const unavailable = {
    readerBaseUrl: "/reader", readerLink: { state: "unavailable", detail: "Reader configuration is invalid." },
  };
  vi.mocked(adminApi).mockImplementation(async (path) => {
    if (path.includes("/generations")) return { ...generations(published), ...unavailable };
    if (path.endsWith("/releases")) return { releases: [{
      releaseId: "published-release", title: "Released reporting", windowStart: "2026-11-09", windowEnd: "2026-11-15",
      locations: [], contentHash: "fixture-hash", sourceChanges: [], correction: null, action: null,
    }] };
    return { draft: published, images: [], evidence: [], ...unavailable };
  });
  await renderGeneration();
  expect(container.textContent).toContain("Live Reader link unavailable");
  expect(container.textContent).toContain("Reader archive unavailable");
  expect(container.textContent).toContain("Reader release link unavailable");
  expect([...container.querySelectorAll("a[href]")].filter((link) =>
    link.getAttribute("href")?.startsWith("/reader"))).toHaveLength(0);
});

it("retries optional links without discarding unfinished reporting or changing the selected draft", async () => {
  vi.useFakeTimers();
  let available = false;
  const metadata = () => available
    ? { readerBaseUrl: "https://reader.fixture.test/reader", readerLink: { state: "available" } }
    : { readerBaseUrl: null, readerLink: { state: "unavailable", detail: "Reader configuration is invalid." } };
  vi.mocked(adminApi).mockImplementation(async (path) => {
    if (path.includes("/generations")) return { ...generations(available ? null : draft()), ...metadata() };
    if (path.endsWith("/releases")) return { releases: [] };
    return { draft: draft(), images: [], evidence: [], ...metadata() };
  });
  await renderGeneration();
  await click("Add story");
  const input = container.querySelector<HTMLInputElement>('.editorial-story:not([hidden]) input[data-story-headline]')!;
  await changeValue(input, "Unfinished reporting");
  await click("Retry Reader links");
  expect(container.textContent).toContain("Reader configuration is invalid.");
  available = true;
  await click("Retry workspace links");
  await click("Retry Reader links");
  expect(container.querySelector<HTMLInputElement>('.editorial-story:not([hidden]) input[data-story-headline]')?.value).toBe("Unfinished reporting");
  expect(container.textContent).not.toContain("Reader configuration is invalid.");
  expect(container.querySelector('a[href="https://reader.fixture.test/reader/publications/publication/archive"]')).not.toBeNull();
  expect(selectedDraft()).toBe("older");
  expect(vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
});

it("keeps configuration preview failures explicit without an iframe or lifecycle mutation", async () => {
  const unavailable = { readerBaseUrl: null,
    readerLink: { state: "unavailable", detail: "Reader configuration is invalid." } };
  vi.mocked(adminApi).mockImplementation(async (path) => {
    if (path.includes("/generations")) return { ...generations(draft()), ...unavailable };
    if (path.endsWith("/releases")) return { releases: [] };
    if (path.includes("/preview?revision=3")) throw new ApiError("Reader configuration is invalid.", 503);
    return { draft: draft(), images: [], evidence: [], ...unavailable };
  });
  await renderGeneration();
  await click("Preview web");
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.querySelector(".editorial-workspace .alert[role=alert]")?.textContent).toContain("Reader configuration is invalid.");
  expect(container.textContent).toContain("Retry Reader links");
  expect(vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
});

function draft(id = "older"): PublicationDraft {
  return {
    _id: id, publication_id: "publication", generation_id: `generation-${id}`,
    status: "ready", unpublished: true, editable: true, title: `Title ${id}`,
    window: ["2026-11-09", "2026-11-15"], locations: [], stories: [],
    versions: { publication: "one", preferences: "one", config: "one", source_maps: [] },
    telemetry: { actor: { id: "owner", email: "owner@example.test" }, funding: [] },
    revision: 3, editorial_status: "editing",
    presentation: { headline: `Headline ${id}`, intro: "", sections: [{ id: "news", title: "News" }],
      section_order: ["news"], stories: [], story_order: [] },
    updated_at: 1, updated_by: { id: "owner", email: "owner@example.test" },
    ready_for_approval_at: null, ready_for_approval_by: null,
    distribution: { reader: false, email: false }, created_at: 1,
  };
}
function generations(selected: PublicationDraft | null, active = false) {
  return {
    publication: { id: "publication", name: "Weekly", role: "owner" },
    limits: { maxLocations: 3 }, locations: [],
    generations: active ? [{ _id: "new-generation", status: "running", window: draft().window,
      created_at: 2, error: null, progress: { total: 0, completed: 0, failed: 0 }, children: [] }] : [],
    draft: selected, drafts: [draft("newer"), draft("older")], draftsNextCursor: null,
    defaultOptions: { flow: "current", mode: "autopilot" },
  };
}
function setupApi() {
  vi.mocked(adminApi).mockImplementation(async (path) => {
    if (path.includes("/generations")) return generations(draft(new URL(path, url).searchParams.get("draft") ?? "older"));
    if (path.endsWith("/releases")) return { releases: [] };
    return { draft: draft(path.split("/").at(-1)), images: [], evidence: [] };
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function changeValue(input: HTMLInputElement, value: string) {
  const props = Object.entries(input).find(([key]) => key.startsWith("__reactProps"))![1] as {
    onChange: (event: { target: { value: string } }) => void;
  };
  await act(async () => props.onChange({ target: { value } }));
}
async function select(id: string) {
  const open = container.querySelector<HTMLAnchorElement>(`a[aria-label="Open edition Title ${id}"]`)!;
  expect(open).not.toBeNull();
  await act(async () => open.click());
}
async function renderGeneration(id = "older") {
  await act(async () => root.render(createElement(PublicationGeneration, {
    publicationId: "publication", publicationName: "Weekly", publicationEnabled: true,
    supportMode: false, generationAnchorId: "editions", reportingAnchorId: "reporting", initialDraftId: id,
  })));
}

it.each([
  { name: "empty coverage", coverage: "empty", attention: "No communities are configured yet" },
  { name: "unready coverage", coverage: "blocked", attention: "1 community isn't ready: South" },
  { name: "mixed coverage", coverage: "mixed", attention: "1 community isn't ready: South" },
  { name: "ready coverage", coverage: "ready", attention: null },
  { name: "active generation", coverage: "ready", active: true, attention: null },
  { name: "failed generation", coverage: "ready", failed: true, attention: "A generation has failed or blocked work" },
])("puts Overview attention in the pipeline card, from real data, for $name", async ({ coverage, active, failed, attention }) => {
  const ready = { location_id: "north", location_name: "North", ready: true, missing_prerequisites: [] };
  const blocked = { location_id: "south", location_name: "South", ready: false, missing_prerequisites: ["Preparation required."] };
  const locations = coverage === "ready" ? [ready] : coverage === "blocked" ? [blocked] : coverage === "mixed" ? [ready, blocked] : [];
  url = new URL("https://fixture.test/newsroom/publication");
  vi.mocked(adminApi).mockImplementation(async (path) => {
    if (path.includes("/generations")) {
      const base = generations(null, active);
      return { ...base, draft: null, locations,
        generations: failed ? [{ _id: "failed", status: "failed", window: draft().window, created_at: 2, error: "boom",
          progress: { total: 1, completed: 0, failed: 1 }, children: [] }] : base.generations };
    }
    if (path.endsWith("/releases")) return { releases: [] };
    throw new Error(`Unexpected request: ${path}`);
  });
  await act(async () => root.render(createElement(NewsroomTasks, { workspace: "/newsroom/publication" },
    createElement(PublicationGeneration, {
      publicationId: "publication", publicationName: "Weekly", publicationEnabled: true,
      supportMode: false, generationAnchorId: "editions", reportingAnchorId: "reporting",
    }))));
  const overview = container.querySelector('[data-newsroom-task="overview"]')!;
  expect(overview.closest("[hidden]")).toBeNull();
  // No separate banner: the pipeline card carries the generation and coverage problems (frame 01).
  expect(overview.querySelector(".jw-attention")).toBeNull();
  const pipelineCard = overview.querySelector<HTMLElement>("#needs-attention")!;
  expect(pipelineCard.classList.contains("jw-area-pipeline")).toBe(true);
  const alerts = [...pipelineCard.querySelectorAll(".jw-card-alert")].map((alert) => alert.textContent).join(" ");
  if (attention) expect(alerts).toContain(attention);
  else expect(alerts).toBe("");
  expect(overview.querySelector("#pipeline-title")?.textContent).toBe(active ? "In progress" : failed ? "Latest generation" : "Nothing generating");
  if (active || failed) {
    expect(overview.querySelectorAll(".jw-steps li")).toHaveLength(4);
    expect(pipelineCard.querySelector(".jw-button-outline")?.textContent).toBe("View pipeline");
    expect(pipelineCard.querySelector(".jw-button-outline")?.getAttribute("href")).toBe("/newsroom/publication/generation");
  }
  if (failed) expect(pipelineCard.querySelector('.jw-card-alert a[href="/newsroom/publication/generation"]')?.textContent).toBe("Resume, retry or cancel");
  // Only the newest drafts are needed for Overview; no draft is fetched or opened.
  expect(vi.mocked(adminApi).mock.calls.map(([path]) => path).filter((path) => path.includes("/generations")))
    .toEqual(["publications/publication/generations?draft="]);
  expect([...overview.querySelectorAll(".jw-list a")].map((link) => link.getAttribute("href")))
    .toEqual(["/newsroom/publication/editions/newer", "/newsroom/publication/editions/older"]);
});

it("keeps explicit same-window selection during generation polling and keys the next editor to its draft", async () => {
  vi.useFakeTimers();
  setupApi();
  vi.mocked(adminApi).mockImplementation(async (path) => {
    if (path.includes("/generations")) return generations(draft(new URL(path, url).searchParams.get("draft") ?? "newer"), true);
    if (path.endsWith("/releases")) return { releases: [] };
    return { draft: draft(path.split("/").at(-1)), images: [], evidence: [] };
  });
  await renderGeneration();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(container.querySelector<HTMLInputElement>(".editorial-front input")?.value).toBe("Headline older");
  await select("newer");
  expect(selectedDraft()).toBe("newer");
  expect(url.pathname).toBe("/newsroom/publication/editions/newer");
  expect(url.searchParams.get("keep")).toBe("yes");
  expect(container.querySelector<HTMLInputElement>(".editorial-front input")?.value).toBe("Headline newer");
  expect(vi.mocked(adminApi).mock.calls.filter(([path]) => path.includes("/drafts/")).map(([path]) => path))
    .toContain("publications/publication/drafts/newer");
});

it("shows paged edition navigation separately and returns to the same retained writer", async () => {
  url.hash = "#editions";
  window.requestAnimationFrame = (callback) => { callback(0); return 0; };
  window.cancelAnimationFrame = vi.fn();
  vi.mocked(adminApi).mockImplementation(async (path) => {
    if (path.includes("/generations")) {
      const query = new URL(path, url).searchParams;
      return { ...generations(draft(query.get("draft") ?? "older")),
        drafts: query.has("draftBefore") ? [draft("oldest")] : [draft("newer"), draft("older")],
        draftsNextCursor: query.has("draftBefore") ? null : "older-page" };
    }
    if (path.endsWith("/releases")) return { releases: [] };
    return { draft: draft(path.split("/").at(-1)), images: [], evidence: [] };
  });
  await act(async () => root.render(createElement(NewsroomTasks, { workspace: "/newsroom/publication" },
    createElement(PublicationGeneration, {
      publicationId: "publication", publicationName: "Weekly", publicationEnabled: true,
      supportMode: false, generationAnchorId: "editions", reportingAnchorId: "reporting", initialDraftId: "older",
    }))));
  const list = container.querySelector(".edition-navigation")!;
  expect(list.closest("[hidden], [inert]")).toBeNull();
  expect(list.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(container.querySelector('select[aria-label="Selected draft"]')).toBeNull();
  await click("Load older drafts");
  expect(list.querySelectorAll("tbody tr")).toHaveLength(3);
  await select("oldest");
  const editor = container.querySelector<HTMLElement>(".editorial-workspace")!;
  expect(editor.closest("[hidden], [inert]")).toBeNull();
  expect(list.closest("[hidden], [inert]")).not.toBeNull();
  expect(selectedDraft()).toBe("oldest");
  expect(url.pathname).toBe("/newsroom/publication/editions/oldest");
  expect(url.searchParams.get("keep")).toBe("yes");
  const writer = editor.querySelector(".editorial-story-panel")!;
  expect(writer.contains(editor.querySelector(".editorial-front-panel"))).toBe(true);
  expect(writer.compareDocumentPosition(editor.querySelector(".editorial-extras")!) & 4).toBeTruthy();
  await click("Add story");
  const article = editor.querySelector(".editorial-story:not([hidden])")!;
  await act(async () => { url.pathname = "/newsroom/publication/editions"; window.dispatchEvent(new window.Event("popstate")); });
  expect(list.closest("[hidden], [inert]")).toBeNull();
  expect(list.querySelector('[aria-current="true"]')?.textContent).toContain("oldest");
  await select("oldest");
  expect(container.querySelector(".editorial-workspace")).toBe(editor);
  expect(editor.querySelector(".editorial-story:not([hidden])")).toBe(article);
  expect(editor.closest("[hidden], [inert]")).toBeNull();
});

it("recovers the explicitly selected generation without switching its independently selected draft or auto-reconnecting on polls", async () => {
  vi.useFakeTimers();
  url.searchParams.set("generation", "blocked-selected");
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (init?.method === "POST") throw new Error("Daily shared allowance exhausted; retry after midnight UTC.");
    if (path.includes("/generations")) return {
      ...generations(draft()),
      generations: [
        { _id: "latest-ready", status: "ready", window: draft().window, created_at: 3, error: null,
          progress: { total: 1, completed: 1, failed: 0 }, children: [] },
        { _id: "blocked-selected", status: "blocked", window: draft().window, created_at: 2, error: "Explicit authorization required.",
          progress: { total: 1, completed: 0, failed: 0 }, children: [] },
      ],
    };
    if (path.endsWith("/releases")) return { releases: [] };
    return { draft: draft(), images: [], evidence: [] };
  });
  await renderGeneration();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  expect(container.querySelector<HTMLInputElement>(".editorial-front input")?.value).toBe("Headline older");
  await click("Authorize resume");
  const [path, init] = vi.mocked(adminApi).mock.calls.find(([, options]) => options?.method === "POST")!;
  expect(path).toBe("publications/publication/generations/blocked-selected");
  expect(JSON.parse(String(init?.body))).toMatchObject({ action: "resume" });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(container.textContent).toContain("Recovery couldn't be confirmed. Refresh the status before trying again, or ask an operator for help.");
  expect(container.textContent).not.toContain("Daily shared allowance exhausted");
  expect(selectedDraft()).toBe("older");
  expect(url.searchParams.get("generation")).toBe("blocked-selected");
  expect(container.querySelector<HTMLInputElement>(".editorial-front input")?.value).toBe("Headline older");
});

it("does not retarget an unavailable generation to the active parent or selected draft", async () => {
  url.searchParams.set("generation", "unavailable-generation");
  vi.mocked(adminApi).mockImplementation(async (path) => {
    if (path.includes("/generations")) return generations(draft(), true);
    if (path.endsWith("/releases")) return { releases: [] };
    return { draft: draft(), images: [], evidence: [] };
  });
  await renderGeneration();
  expect(container.textContent).toContain("selected generation is unavailable");
  expect(container.textContent).not.toContain("Cancel this generation");
  expect(container.querySelector<HTMLInputElement>(".editorial-front input")?.value).toBe("Headline older");
});

it("ignores late generation and editor reads after switching explicit drafts", async () => {
  vi.useFakeTimers();
  let resolvePoll!: (value: ReturnType<typeof generations>) => void;
  let resolveEditor!: (value: { draft: PublicationDraft; images: never[]; evidence: never[] }) => void;
  let reads = 0;
  const signals: Array<AbortSignal | null | undefined> = [];
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.includes("/generations?draft=older")) {
      signals.push(init?.signal);
      if (++reads === 1) return generations(draft(), true);
      return new Promise((resolve) => { resolvePoll = resolve; });
    }
    if (path.endsWith("/drafts/older")) {
      signals.push(init?.signal);
      return new Promise((resolve) => { resolveEditor = resolve; });
    }
    if (path.includes("/generations")) return generations(draft("newer"));
    if (path.endsWith("/releases")) return { releases: [] };
    return { draft: draft("newer"), images: [], evidence: [] };
  });
  await renderGeneration();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  await select("newer");
  await act(async () => {
    resolvePoll(generations(draft(), true));
    resolveEditor({ draft: draft(), images: [], evidence: [] });
  });
  expect(container.querySelector<HTMLInputElement>(".editorial-front input")?.value).toBe("Headline newer");
  expect(selectedDraft()).toBe("newer");
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
});

it("retries an image conflict without waiting on its own persistence barrier", async () => {
  const current = draft();
  current.presentation.stories = [{
    id: "original", origin: "original", generated_story_id: null, section_id: "news",
    headline: "Local reporting", body: "A reported story", byline: "Reporter", location_tags: [],
    source_metadata: [], image_id: "image",
  }];
  current.presentation.story_order = ["original"];
  let deletes = 0;
  const images = [{ _id: "image", image: { image: "https://fixture.test/photo.jpg", image_credit: "Fixture",
    image_alt: "Park", image_caption: "A park", image_license: "CC BY" } }];
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.includes("/generations")) return generations(current);
    if (path.endsWith("/releases")) return { releases: [] };
    if (init?.method === "DELETE") {
      if (++deletes === 1) throw new ApiError("Image conflict", 409);
      return { draft: { ...current, revision: 4 } };
    }
    return { draft: current, images, evidence: [] };
  });
  await renderGeneration();
  await click("Remove image");
  expect(container.textContent).toContain("Image conflict");
  await click("Retry my edit");
  expect(deletes).toBe(2);
  expect(container.querySelector(".editorial-image img")).toBeNull();
  await select("newer");
  expect(selectedDraft()).toBe("newer");
});

it("shows missing media review and permits deliberately choosing no image", async () => {
  const current = draft();
  current.presentation.stories = [{
    id: "original", origin: "original", generated_story_id: null, section_id: "news",
    headline: "Local reporting", body: "A reported story", byline: "Reporter", location_tags: [],
    source_metadata: [], image_id: "unavailable",
    image_review: { status: "needs_review", reason: "Immutable media bytes are unavailable." },
  }];
  current.presentation.story_order = ["original"];
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.includes("/generations")) return generations(current);
    if (path.endsWith("/releases")) return { releases: [] };
    if (init?.method === "PATCH") return { draft: { ...current, revision: 4, presentation: {
      ...current.presentation, stories: [{ ...current.presentation.stories[0], image_id: null,
        image_review: { status: "removed", reason: "Removed by the editor." } }],
    } } };
    return { draft: current, images: [], evidence: [] };
  });
  await renderGeneration();
  expect(container.textContent).toContain("Image needs review: Immutable media bytes are unavailable.");
  await click("Use no image");
  expect(container.textContent).not.toContain("Image needs review:");
  const saved = vi.mocked(adminApi).mock.calls.find(([, init]) => init?.method === "PATCH")!;
  expect(JSON.parse(saved[1]!.body as string)).toMatchObject({
    expectedRevision: 3, operation: { type: "story", storyId: "original", imageId: null },
  });
});

it("never opens another editor when an explicit selected draft is unavailable", async () => {
  setupApi();
  vi.mocked(adminApi).mockImplementation(async (path) => path.includes("/generations")
    ? generations(null) : path.endsWith("/coverage-requests") ? { locations: [], request: null } : { releases: [] });
  await renderGeneration("foreign-or-missing");
  expect(container.textContent).toContain("No other draft is open for editing or publication");
  expect(container.querySelector(".editorial-workspace")).toBeNull();
  expect(vi.mocked(adminApi).mock.calls.some(([path]) => path.includes("/drafts/"))).toBe(false);
});

it("preflights the selected saved revision in the actual Reader and never retains a stale preview", async () => {
  let stale = false;
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.includes("/preview?revision=")) {
      if (stale) throw new ApiError("Selected revision changed.", 409);
      return { preview_url: `https://fixture.test/reader/publications/publication/drafts/older?revision=${path.split("revision=")[1]}` };
    }
    if (path.includes("/generations")) return generations(draft());
    if (path.endsWith("/releases")) return { releases: [] };
    if (init?.method === "PATCH") return { draft: { ...draft(), revision: 4, editorial_status: "ready_for_approval" } };
    return { draft: draft(), images: [], evidence: [] };
  });
  await renderGeneration();
  await click("Preview web");
  expect(container.querySelector("iframe")?.getAttribute("src"))
    .toBe("https://fixture.test/reader/publications/publication/drafts/older?revision=3");
  expect(container.textContent).toContain("not published");
  await click("Mark ready for approval");
  expect(container.querySelector("iframe")).toBeNull();
  stale = true;
  await click("Preview web");
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.textContent).toContain("Selected revision changed.");
  expect(vi.mocked(adminApi).mock.calls.filter(([path]) => path.includes("/preview?")).map(([path]) => path))
    .toEqual([
      "publications/publication/drafts/older/preview?revision=3",
      "publications/publication/drafts/older/preview?revision=4",
    ]);
});

it("protects unconfirmed original creation on picker and browser-history switches", async () => {
  vi.useFakeTimers();
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (init?.method === "PATCH") throw new ApiError("Creation outcome unconfirmed", 503);
    if (path.includes("/generations")) return generations(draft(new URL(path, url).searchParams.get("draft") ?? "older"));
    if (path.endsWith("/releases")) return { releases: [] };
    return { draft: draft(path.split("/").at(-1)), images: [], evidence: [] };
  });
  await renderGeneration();
  await click("Add story");
  const input = container.querySelector<HTMLInputElement>('.editorial-story:not([hidden]) input[data-story-headline]')!;
  await changeValue(input, "Unfinished reporting");
  await select("newer");
  expect(selectedDraft()).toBe("older");
  expect(container.querySelector<HTMLInputElement>('.editorial-story:not([hidden]) input[data-story-headline]')?.value).toBe("Unfinished reporting");
  url.searchParams.set("draft", "newer");
  await act(async () => window.dispatchEvent(new window.Event("popstate")));
  expect(selectedDraft()).toBe("older");
  expect(container.textContent).toContain("Edits are not saved");
  await click("Preview web");
  expect(container.querySelector("iframe")).toBeNull();
  expect(vi.mocked(adminApi).mock.calls.some(([path]) => path.includes("/preview?"))).toBe(false);
});

it.each([409, 403, 503])("keeps a conflicted, inaccessible or uncertain workflow operation behind the persistence barrier after %s", async (status) => {
  const guard: MutableRefObject<(() => Promise<boolean>) | null> = { current: null };
  setupApi();
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (init?.method === "PATCH") throw new ApiError("Fixture persistence failure", status);
    if (path.endsWith("/releases")) return { releases: [] };
    return { draft: draft(), images: [], evidence: [] };
  });

  await act(async () => root.render(createElement(PublicationEditorialWorkspace, {
    canWrite: true,
    publicationId: "publication", draftId: "older", beforeDraftChange: guard,
  })));
  await click("Mark ready for approval");
  expect(container.textContent).toContain("Fixture persistence failure");
  let allowed = true;
  await act(async () => { allowed = await guard.current!(); });
  expect(allowed).toBe(false);
  const patches = vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method === "PATCH");
  expect(patches).toHaveLength(1);
  expect(JSON.parse(patches[0][1]!.body as string)).toMatchObject({ expectedRevision: 3 });
  expect(container.querySelector<HTMLInputElement>(".editorial-front input")?.value).toBe("Headline older");
});

it("preserves failed autosave input and blocks switching and lifecycle actions until retry succeeds", async () => {
    const current = draft();
    current.presentation.stories = [{
      id: "original", origin: "original", generated_story_id: null, section_id: "news",
      headline: "Local reporting", body: "A reported story", byline: "Reporter", location_tags: [],
      source_metadata: [{ id: "source", type: "web", name: "Agenda", url: "https://fixture.test/agenda", note: null }],
      image_id: null,
    }];
    current.presentation.story_order = ["original"];
    let fail = true;
    let failRetryRead = false;
    const unavailable = { readerBaseUrl: null,
      readerLink: { state: "unavailable", detail: "Reader configuration is invalid." } };
    vi.mocked(adminApi).mockImplementation(async (path, init) => {
      if (path.includes("/generations")) return { ...generations(current), ...unavailable };
      if (path.endsWith("/releases")) return { releases: [] };
      if (init?.method === "PATCH") {
        if (fail) throw new ApiError("Autosave validation failed", 422);
        return { draft: { ...current, revision: 4 } };
      }
      if (failRetryRead) throw new ApiError("Retry read failed", 503);
      return { draft: current, images: [], evidence: [], ...unavailable };
    });
    await renderGeneration();
    const sourceType = container.querySelector<HTMLSelectElement>('select[aria-label="Source type 1 for Local reporting"]')!;
    for (const option of sourceType.options) option.selected = false;
    [...sourceType.options].find((option) => option.value === "interview")!.selected = true;
    await act(async () => sourceType.dispatchEvent(new window.Event("change", { bubbles: true })));
    await select("newer");
    expect(selectedDraft()).toBe("older");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Source type 1 for Local reporting"]')?.value).toBe("interview");
    await click("Mark ready for approval");
    await click("Preview web");
    expect(container.querySelector("iframe")).toBeNull();
    expect(vi.mocked(adminApi).mock.calls.some(([path]) => path.includes("/preview?"))).toBe(false);
    let patches = vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0][1]!.body as string)).toMatchObject({
      expectedRevision: 3, operation: { type: "story", sourceMetadata: [{ type: "interview" }] },
    });
    await click("Retry workspace links");
    await click("Retry Reader links");
    expect(container.textContent).toContain("Autosave validation failed");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Source type 1 for Local reporting"]')?.value).toBe("interview");
    expect(selectedDraft()).toBe("older");
    expect(vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    fail = false;
    failRetryRead = true;
    await click("Retry my edit");
    expect(container.textContent).toContain("Retry read failed");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Source type 1 for Local reporting"]')?.value).toBe("interview");
    failRetryRead = false;
    await click("Retry my edit");
    patches = vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches.every(([, init]) => JSON.parse(init!.body as string).operation.type === "story")).toBe(true);
    await select("newer");
    expect(selectedDraft()).toBe("newer");
});
