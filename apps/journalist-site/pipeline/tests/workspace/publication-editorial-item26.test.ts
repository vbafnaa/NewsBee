import { act, createElement, type ComponentProps, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PublicationEditorialWorkspace, { rebasePendingDraft } from "../../../app/publishing/publication-editorial-workspace";
import { adminApi, ApiError } from "../../../lib/admin-client";
import type { PublicationDraftPatch } from "../../publications/editorial";
import type { PublicationDraft } from "../../publications/generation";

vi.mock("../../../lib/admin-client", async (original) => ({
  ...await original<typeof import("../../../lib/admin-client")>(), adminApi: vi.fn(),
}));
vi.mock("../../../app/components/story-evidence", () => ({ default: () => null }));

let root: Root;
let container: HTMLElement;
let current: PublicationDraft;
let focused: Element | null;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  focused = null;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused });
  window.HTMLElement.prototype.focus = function () { focused = this; };
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.getElementById("root")!;
  root = createRoot(container);
  current = {
    _id: "selected", publication_id: "publication", generation_id: "generation",
    status: "ready", unpublished: true, editable: true, title: "Weekly",
    window: ["2026-11-09", "2026-11-15"], locations: [], stories: [],
    versions: { publication: "one", preferences: "one", config: "one", source_maps: [] },
    telemetry: { actor: { id: "owner", email: "owner@example.test" }, funding: [] },
    revision: 3, editorial_status: "editing",
    presentation: {
      headline: "Weekly", intro: "", sections: [{ id: "news", title: "News" }, { id: "arts", title: "Arts" }],
      section_order: ["news", "arts"], story_order: ["a", "x", "b", "y"],
      stories: [["a", "Alpha", "news"], ["x", "Exhibit", "arts"], ["b", "Beta", "news"], ["y", "Youth", "arts"]].map(([id, headline, section_id]) => ({
        id, headline, section_id, origin: "original", generated_story_id: null,
        body: "Reported copy", byline: "Reporter", location_tags: [], image_id: null,
        source_metadata: [{ id: `source-${id}`, type: "web", name: "Agenda", url: "https://fixture.test/agenda", note: null }],
      })),
    },
    updated_at: 1, updated_by: { id: "owner", email: "owner@example.test" },
    ready_for_approval_at: null, ready_for_approval_by: null,
    distribution: { reader: false, email: false }, created_at: 1,
  };
  vi.mocked(adminApi).mockReset();
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.endsWith("/releases")) return { releases: [] };
    if (init?.method === "PATCH") return persist(init);
    return { draft: structuredClone(current), images: [], evidence: [] };
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function persist(init: RequestInit) {
  const { operation } = JSON.parse(String(init.body)) as { operation: PublicationDraftPatch };
  current = rebasePendingDraft(current, [{ operation, syncPresentation: true }]);
  current.revision += 1;
  return { draft: structuredClone(current) };
}
async function render(props: Partial<ComponentProps<typeof PublicationEditorialWorkspace>> = {}) {
  await act(async () => root.render(createElement(PublicationEditorialWorkspace, {
    publicationId: "publication", draftId: "selected", canWrite: true, ...props,
  })));
}
function button(name: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((element) => (element.getAttribute("aria-label") ?? element.textContent) === name);
  expect(found, name).toBeDefined();
  return found!;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
function status() { return container.querySelector(".editorial-save-state [role=status]")!; }
function selectedSource(headline: string) {
  return container.querySelector<HTMLSelectElement>(`select[aria-label="Source type 1 for ${headline}"]`)!;
}
async function source(headline: string, value: string) {
  const picker = selectedSource(headline);
  for (const option of picker.options) option.selected = false;
  [...picker.options].find((option) => option.value === value)!.selected = true;
  await act(async () => picker.dispatchEvent(new window.Event("change", { bubbles: true })));
}
function operations() {
  return vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method === "PATCH")
    .map(([, init]) => JSON.parse(String(init!.body)));
}

async function introduction(value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(".editorial-front textarea")!;
  const props = Object.entries(textarea).find(([key]) => key.startsWith("__reactProps"))![1] as {
    onChange: (event: { target: { value: string } }) => void;
  };
  await act(async () => props.onChange({ target: { value } }));
}
async function writeField(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const props = Object.entries(element).find(([key]) => key.startsWith("__reactProps"))![1] as {
    onChange: (event: { target: { value: string } }) => void;
  };
  await act(async () => props.onChange({ target: { value } }));
}

it("keeps saved reporting saved after rejected readiness, then flushes the correction before readiness and exact-revision approval", async () => {
  vi.useFakeTimers();
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.endsWith("/releases")) return { releases: [] };
    if (init?.method === "PATCH") {
      const { operation } = JSON.parse(String(init.body)) as { operation: PublicationDraftPatch };
      if (operation.type === "ready_for_approval") {
        if (!current.presentation.intro.trim()) throw new ApiError("Add a publication introduction.", 422);
        current.editorial_status = "ready_for_approval";
      }
      return persist(init);
    }
    if (path.endsWith("/approve")) {
      expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 6 });
      current.editorial_status = "approved";
      current.approval = {
        revision: 6, content_hash: "approved-content", approved_at: 1,
        approved_by: { id: "journalist", email: "journalist@example.test" },
        snapshot: {
          schema_version: 1, draft_id: current._id, draft_revision: 6,
          title: current.presentation.headline, intro: current.presentation.intro,
          window_start: current.window[0], window_end: current.window[1],
          locations: [], sections: current.presentation.sections, items: [], correction: null,
        },
      };
      return { draft: structuredClone(current) };
    }
    return { draft: structuredClone(current), images: [], evidence: [] };
  });
  const guard: MutableRefObject<(() => Promise<boolean>) | null> = { current: null };
  await render({ beforeDraftChange: guard });
  await source("Alpha", "interview");
  await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  expect(current.revision).toBe(4);
  expect(status().textContent).toBe("Saved");
  await click("Mark ready for approval");
  expect(status().textContent).toBe("Saved");
  expect(container.textContent).not.toContain("Retry my edit");
  expect(container.querySelector("[role=alert]")?.textContent).toContain("Not marked ready for approval. Add a publication introduction.");
  expect(current.editorial_status).toBe("editing");
  await introduction("Original reporting from our communities.");
  expect(status().textContent).toBe("Saving…");
  await click("Mark ready for approval");
  expect(operations()).toEqual([
    { expectedRevision: 3, operation: { type: "story", storyId: "a", sourceMetadata: current.presentation.stories[0].source_metadata } },
    { expectedRevision: 4, operation: { type: "ready_for_approval" } },
    { expectedRevision: 4, operation: { type: "draft", intro: "Original reporting from our communities." } },
    { expectedRevision: 5, operation: { type: "ready_for_approval" } },
  ]);
  expect(status().textContent).toBe("Saved");
  expect(container.querySelector("[role=alert]")).toBeNull();
  await click("Approve revision 6");
  expect(button("Publish to web")).toBeDefined();
  expect(vi.mocked(adminApi).mock.calls.some(([path]) => path.endsWith("/publish"))).toBe(false);
  expect(vi.mocked(adminApi).mock.calls.filter(([path]) => !path.endsWith("/releases"))
    .every(([path]) => path.startsWith("publications/publication/drafts/selected"))).toBe(true);
  let allowed = false;
  await act(async () => { allowed = await guard.current!(); });
  expect(allowed).toBe(true);
});

it("retires a definitively rejected workflow retry without losing corrective content queued behind it", async () => {
  vi.useFakeTimers();
  let readyAttempts = 0;
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.endsWith("/releases")) return { releases: [] };
    if (init?.method === "PATCH") {
      const { operation } = JSON.parse(String(init.body)) as { operation: PublicationDraftPatch };
      if (operation.type === "ready_for_approval") {
        if (++readyAttempts === 1) throw new ApiError("Readiness request outcome is unavailable.", 503);
        throw new ApiError("Add a publication introduction.", 422);
      }
      return persist(init);
    }
    return { draft: structuredClone(current), images: [], evidence: [] };
  });
  await render();
  await click("Mark ready for approval");
  expect(status().textContent).toBe("Not saved");
  await introduction("The correction survives the failed action.");
  await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  expect(operations()).toHaveLength(1);
  await click("Retry my edit");
  expect(operations().map(({ operation }) => operation.type)).toEqual(["ready_for_approval", "ready_for_approval", "draft"]);
  expect(current.presentation.intro).toBe("The correction survives the failed action.");
  expect(status().textContent).toBe("Saved");
  expect(container.textContent).not.toContain("Retry my edit");
  expect(container.querySelector("[role=alert]")?.textContent).toContain("Add a publication introduction.");
  expect(current.editorial_status).toBe("editing");
});

it("shows a rejected reopen as an action error, not unsaved content", async () => {
  current.editorial_status = "ready_for_approval";
  await render();
  vi.mocked(adminApi).mockImplementationOnce(async () => { throw new ApiError("This draft cannot be reopened.", 422); });
  await click("Reopen for editing");
  expect(status().textContent).toBe("Saved");
  expect(container.querySelector("[role=alert]")?.textContent).toContain("Draft was not reopened. This draft cannot be reopened.");
  expect(container.textContent).not.toContain("Retry my edit");
  expect(current.editorial_status).toBe("ready_for_approval");
});

it("keeps a failed corrective introduction pending and prevents readiness until it actually persists", async () => {
  vi.useFakeTimers();
  await render();
  vi.mocked(adminApi).mockImplementationOnce(async () => { throw new ApiError("Add a publication introduction.", 422); });
  await click("Mark ready for approval");
  await introduction("A correction that must be saved.");
  vi.mocked(adminApi).mockImplementationOnce(async () => { throw new ApiError("Introduction save rejected.", 422); });
  await click("Mark ready for approval");
  expect(operations().map(({ operation }) => operation.type)).toEqual(["ready_for_approval", "draft"]);
  expect(status().textContent).toBe("Not saved");
  expect(container.textContent).toContain("Introduction save rejected.");
  expect(current.presentation.intro).toBe("");
  expect(current.editorial_status).toBe("editing");
  expect(container.querySelector<HTMLTextAreaElement>(".editorial-front textarea")?.value).toBe("A correction that must be saved.");
  await click("Retry my edit");
  expect(current.presentation.intro).toBe("A correction that must be saved.");
  expect(status().textContent).toBe("Saved");
  expect(current.editorial_status).toBe("editing");
  expect(operations().map(({ operation }) => operation.type)).toEqual(["ready_for_approval", "draft", "draft"]);
});

it.each([
  new ApiError("Another editor changed this draft.", 409),
  new ApiError("Write access expired.", 403),
  new ApiError("Server outcome unavailable.", 503),
  new TypeError("Network request failed."),
])("retains the persistence barrier for a workflow failure with uncertain or unavailable state: %s", async (failure) => {
  vi.useFakeTimers();
  const guard: MutableRefObject<(() => Promise<boolean>) | null> = { current: null };
  await render({ beforeDraftChange: guard });
  vi.mocked(adminApi).mockImplementationOnce(async () => { throw failure; });
  await click("Mark ready for approval");
  expect(status().textContent).toBe(failure instanceof ApiError && failure.status === 409 ? "Conflict" : "Not saved");
  await introduction("Keep this corrective edit.");
  await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  expect(operations()).toHaveLength(1);
  expect(container.querySelector<HTMLTextAreaElement>(".editorial-front textarea")?.value).toBe("Keep this corrective edit.");
  await click("Preview web");
  expect(vi.mocked(adminApi).mock.calls.some(([path]) => path.includes("/preview?"))).toBe(false);
  let allowed = true;
  await act(async () => { allowed = await guard.current!(); });
  expect(allowed).toBe(false);
  expect(button("Retry my edit")).toBeDefined();
});

it("keeps unfinished or failed game choices behind the existing navigation and preview barriers", async () => {
  current.presentation.save_the_bee = { word: "CLOVER", clue: "A plant with three little leaves." };
  vi.stubGlobal("FormData", class {
    constructor(private form: HTMLFormElement) {}
    get(name: string) { return this.form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)?.value ?? null; }
  });
  const beforeDraftChange: MutableRefObject<(() => Promise<boolean>) | null> = { current: null };
  await render({ task: "editions", beforeDraftChange });
  const form = container.querySelector<HTMLFormElement>('form[aria-label="Optional Save the Bee"]')!;
  form.reset = () => { form.dispatchEvent(new window.Event("reset", { bubbles: true })); };
  const word = form.querySelector<HTMLInputElement>('input[name="word"]')!;
  word.value = "TULIP";
  form.querySelector<HTMLTextAreaElement>('textarea[name="clue"]')!.value = "A cup-shaped spring flower.";
  await act(async () => word.dispatchEvent(new window.Event("input", { bubbles: true })));
  expect(status().textContent).toBe("Not saved");
  let canLeave = true;
  await act(async () => { canLeave = await beforeDraftChange.current!(); });
  expect(canLeave).toBe(false);
  await click("Preview web");
  expect(container.querySelector("iframe")).toBeNull();
  vi.mocked(adminApi).mockImplementationOnce(async () => { throw new ApiError("Game choice was not saved.", 503); });
  await act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  expect(word.value).toBe("TULIP");
  expect(status().textContent).toBe("Not saved");
  expect(operations().at(-1)?.operation).toEqual({
    type: "bee_game", game: { word: "TULIP", clue: "A cup-shaped spring flower." },
  });
  await act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  expect(current.presentation.save_the_bee?.word).toBe("TULIP");
  expect(status().textContent).toBe("Saved");
  await act(async () => { canLeave = await beforeDraftChange.current!(); });
  expect(canLeave).toBe(true);
});

it("moves within the displayed section while preserving the complete interleaved order and endpoint focus", async () => {
  await render({ task: "reporting" });
  // Position and section controls live on the side panel's Layout tab.
  await click("Layout");
  expect(button("Layout").getAttribute("aria-selected")).toBe("true");
  expect(button("Move story Alpha up in News").disabled).toBe(true);
  expect(button("Move story Beta down in News").disabled).toBe(true);
  expect(button("Move story Exhibit up in Arts").disabled).toBe(true);
  expect(button("Move story Youth down in Arts").disabled).toBe(true);
  await click("Move story Beta up in News");
  expect(operations()).toEqual([{ expectedRevision: 3, operation: { type: "story_order", storyIds: ["b", "x", "a", "y"] } }]);
  expect([...container.querySelectorAll('.editorial-story[data-story-section="news"]')].map((node) => node.getAttribute("aria-label")))
    .toEqual(["Beta in News", "Alpha in News"]);
  expect(button("Move story Beta up in News").disabled).toBe(true);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Beta in News");
  expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  expect(container.textContent).toContain("Beta: position 1 of 2 in News.");
  await act(async () => container.querySelector<HTMLAnchorElement>('a[href="#edition-story-x"]')!.click());
  container.querySelector<HTMLDetailsElement>('[data-section-id="arts"] > details')!.open = true;
  await click("Move section Arts up");
  expect(operations()[1]).toEqual({ expectedRevision: 4, operation: { type: "section_order", sectionIds: ["arts", "news"] } });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Arts section");
  expect(current.presentation.story_order).toEqual(["b", "x", "a", "y"]);
  const sectionPicker = container.querySelector<HTMLSelectElement>('select[aria-label="Section for Alpha"]')!;
  await act(async () => container.querySelector<HTMLAnchorElement>('a[href="#edition-story-a"]')!.click());
  sectionPicker.focus();
  for (const option of sectionPicker.options) option.selected = false;
  [...sectionPicker.options].find((option) => option.value === "arts")!.selected = true;
  await act(async () => sectionPicker.dispatchEvent(new window.Event("change", { bubbles: true })));
  expect(operations()[2]).toEqual({ expectedRevision: 5, operation: { type: "story", storyId: "a", sectionId: "arts" } });
  expect(current.presentation.story_order).toEqual(["b", "x", "a", "y"]);
  expect(current.presentation.section_order).toEqual(["arts", "news"]);
  expect(document.activeElement).toBe(sectionPicker);
  expect(sectionPicker.isConnected).toBe(true);
});

it("locks all mutation groups without unmounting attempted reporting when write access expires", async () => {
  vi.useFakeTimers();
  await render({ task: "editions" });
  await click("Add story");
  const form = container.querySelector(".editorial-story:not([hidden])")!;
  const input = form.querySelector<HTMLInputElement>('input[data-story-headline]')!;
  await writeField(input, "Attempted reporting survives expiry");
  await render({ task: "editions", canWrite: false });
  expect(container.querySelector(".editorial-story:not([hidden])")).toBe(form);
  expect(input.value).toBe("Attempted reporting survives expiry");
  for (const selector of [".editorial-front-panel", ".editorial-sections", ".editorial-publish"]) {
    expect(container.querySelector<HTMLFieldSetElement>(selector)?.hasAttribute("disabled")).toBe(true);
  }
  expect(container.textContent).toContain("Attempted input stays here");
  expect(operations()).toEqual([]);
});

it("enters one shared editor without empty server writes, then queues typing behind confirmed creation", async () => {
  vi.useFakeTimers();
  Object.defineProperty(window, "location", { configurable: true, value: new URL("https://fixture.test/newsroom/publication?draft=selected&generation=exact#edition-story-a") });
  let finish!: () => void;
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.endsWith("/releases")) return { releases: [] };
    if (init?.method === "PATCH") {
      if (JSON.parse(String(init.body)).operation.type === "add_original_story") {
        await new Promise<void>((resolve) => { finish = resolve; });
      }
      return persist(init);
    }
    return { draft: structuredClone(current), images: [], evidence: [] };
  });
  await render();
  await click("Add story");
  const active = container.querySelector<HTMLElement>(".editorial-story:not([hidden])")!;
  const id = active.dataset.storyId!;
  const headline = active.querySelector<HTMLInputElement>("input[data-story-headline]")!;
  expect(document.activeElement).toBe(headline);
  expect(container.querySelectorAll(".editorial-story:not([hidden])")).toHaveLength(1);
  expect(container.querySelector(".editorial-original-form")).toBeNull();
  await click("Add story");
  expect(container.querySelector(".editorial-story:not([hidden])")).toBe(active);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(operations()).toEqual([]);
  await click("Mark ready for approval");
  expect(operations()).toEqual([]);
  expect(container.textContent).toContain("Start typing or remove an empty new story");
  await writeField(headline, "First unfinished headline  ");
  await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  expect(operations()[0].operation).toMatchObject({
    type: "add_original_story", storyId: id,
    story: { headline: "First unfinished headline  ", body: "", byline: "", sectionId: "", locationTags: [], sourceMetadata: [] },
  });
  const body = active.querySelector<HTMLTextAreaElement>("textarea")!;
  await writeField(body, "Typing while the first response is pending.\n");
  await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  expect(operations()).toHaveLength(1);
  expect(status().textContent).toBe("Saving…");
  await act(async () => finish());
  expect(operations().map(({ operation }) => operation.type)).toEqual(["add_original_story", "story"]);
  expect(current.presentation.stories.find((story) => story.id === id)).toMatchObject({
    headline: "First unfinished headline  ", body: "Typing while the first response is pending.\n", included: true,
  });
  expect(container.querySelector(".editorial-story:not([hidden])")).toBe(active);
  expect(status().textContent).toBe("Saved");
  for (const storyId of ["a", id]) {
    window.location.hash = `#edition-story-${storyId}`;
    await act(async () => window.dispatchEvent(new window.Event("popstate")));
    expect(container.querySelector(".editorial-story:not([hidden])")?.getAttribute("data-story-id")).toBe(storyId);
  }
});

it("replays a lost creation response with the same identity and retains newer typed text", async () => {
  vi.useFakeTimers();
  let loseResponse = true;
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.endsWith("/releases")) return { releases: [] };
    if (init?.method === "PATCH") {
      const { operation } = JSON.parse(String(init.body));
      const result = persist(init);
      if (operation.type === "add_original_story" && loseResponse) {
        loseResponse = false;
        throw new TypeError("Creation response lost");
      }
      return result;
    }
    return { draft: structuredClone(current), images: [], evidence: [] };
  });
  await render();
  await click("Add story");
  const active = container.querySelector<HTMLElement>(".editorial-story:not([hidden])")!;
  const id = active.dataset.storyId!;
  await writeField(active.querySelector("input[data-story-headline]")!, "Unfinished original");
  await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  expect(status().textContent).toBe("Not saved");
  await writeField(active.querySelector("textarea")!, "A later paragraph survives retry.");
  await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  expect(operations()).toHaveLength(1);
  await click("Retry my edit");
  expect(operations().slice(0, 2).map(({ operation }) => operation.storyId)).toEqual([id, id]);
  expect(operations()[1].operation).toEqual(operations()[0].operation);
  expect(current.presentation.stories.filter((story) => story.id === id)).toHaveLength(1);
  expect(current.presentation.stories.find((story) => story.id === id)?.body).toBe("A later paragraph survives retry.");
  expect(active.querySelector("textarea")?.value).toBe("A later paragraph survives retry.");
  expect(status().textContent).toBe("Saved");
});

it("allows correcting a definitively rejected initial creation without weakening unknown-outcome replay", async () => {
  vi.useFakeTimers();
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.endsWith("/releases")) return { releases: [] };
    if (init?.method === "PATCH") {
      const { operation } = JSON.parse(String(init.body));
      if (operation.type === "add_original_story" && operation.story.headline.includes("\u0001")) {
        throw new ApiError("Story headline is invalid.", 422);
      }
      return persist(init);
    }
    return { draft: structuredClone(current), images: [], evidence: [] };
  });
  await render();
  await click("Add story");
  const active = container.querySelector<HTMLElement>(".editorial-story:not([hidden])")!;
  const headline = active.querySelector<HTMLInputElement>("input[data-story-headline]")!;
  await writeField(headline, "Rejected\u0001clipboard text");
  await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  expect(status().textContent).toBe("Not saved");
  await writeField(headline, "Corrected headline");
  await writeField(active.querySelector("textarea")!, "The subsequent paragraph is retained.");
  await click("Retry my edit");
  expect(operations().map(({ operation }) => operation.type)).toEqual(["add_original_story", "add_original_story"]);
  expect(operations()[1].operation).toMatchObject({
    storyId: active.dataset.storyId, story: { headline: "Corrected headline", body: "The subsequent paragraph is retained." },
  });
  expect(current.presentation.stories.find((story) => story.id === active.dataset.storyId)?.body).toBe("The subsequent paragraph is retained.");
  expect(status().textContent).toBe("Saved");
});

it("retains dirty story and auxiliary buffers when choosing another story and secondary task", async () => {
  vi.useFakeTimers();
  const guard: MutableRefObject<(() => Promise<boolean>) | null> = { current: null };
  await render({ beforeDraftChange: guard });
  const first = container.querySelector<HTMLElement>('[data-story-id="a"]')!;
  const note = first.querySelector<HTMLTextAreaElement>(".editorial-note-form textarea")!;
  note.value = "Private unsaved interview context";
  await act(async () => note.dispatchEvent(new window.Event("input", { bubbles: true })));
  expect(status().textContent).toBe("Not saved");
  await writeField(first.querySelector("textarea")!, "Unfinished Alpha copy.");
  await act(async () => container.querySelector<HTMLAnchorElement>('a[href="#edition-story-x"]')!.click());
  expect(first.hidden).toBe(true);
  expect(container.querySelectorAll(".editorial-story:not([hidden])")).toHaveLength(1);
  await render({ task: "activity", beforeDraftChange: guard });
  await render({ task: "editions", beforeDraftChange: guard });
  await act(async () => container.querySelector<HTMLAnchorElement>('a[href="#edition-story-a"]')!.click());
  expect(first.hidden).toBe(false);
  expect(first.querySelector(".editorial-note-form textarea")).toBe(note);
  expect(note.value).toBe("Private unsaved interview context");
  expect(first.querySelector("textarea")?.value).toBe("Unfinished Alpha copy.");
  let mayLeave = true;
  await act(async () => { mayLeave = await guard.current!(); });
  expect(mayLeave).toBe(false);
  expect(current.presentation.stories[0].body).toBe("Unfinished Alpha copy.");
});

it("retains the persisted new story and exact private-note/image buffers when assigning its first section", async () => {
  vi.useFakeTimers();
  await render();
  await click("Add story");
  const article = container.querySelector<HTMLElement>(".editorial-story:not([hidden])")!;
  const id = article.dataset.storyId!;
  await writeField(article.querySelector<HTMLInputElement>("input[data-story-headline]")!, "Unfinished reporting");
  await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  expect(current.presentation.stories.find((story) => story.id === id)?.section_id).toBe("");
  const note = article.querySelector<HTMLTextAreaElement>(".editorial-note-form textarea")!;
  const image = article.querySelector<HTMLInputElement>('.editorial-image input[name="image"]')!;
  note.value = "  Private interview context\nstill unfinished.  ";
  image.value = "https://fixture.test/unfinished-photo.jpg";
  await act(async () => {
    note.dispatchEvent(new window.Event("input", { bubbles: true }));
    image.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  const section = article.querySelector<HTMLSelectElement>(`select[id="edition-section-${id}"]`)!;
  await act(async () => {
    const props = Object.entries(section).find(([key]) => key.startsWith("__reactProps"))![1] as {
      onChange: (event: { target: { value: string } }) => void;
    };
    props.onChange({ target: { value: "news" } });
  });
  expect(current.presentation.stories.find((story) => story.id === id)?.section_id).toBe("news");
  expect(container.querySelector(`[data-story-id="${id}"]`)).toBe(article);
  expect(article.querySelector(".editorial-note-form textarea")).toBe(note);
  expect(article.querySelector('.editorial-image input[name="image"]')).toBe(image);
  expect(note.value).toBe("  Private interview context\nstill unfinished.  ");
  expect(image.value).toBe("https://fixture.test/unfinished-photo.jpg");
  expect(status().textContent).toBe("Not saved");
});

it("reveals required sources and section controls and focuses them without discarding other stories", async () => {
  const story = current.presentation.stories.find((candidate) => candidate.id === "x")!;
  story.section_id = "";
  story.source_metadata[0].url = null;
  await render();
  const article = container.querySelector<HTMLElement>('[data-story-id="x"]')!;
  const source = article.querySelector<HTMLInputElement>('[aria-label="Source URL 1 for Exhibit"]')!;
  expect(source.closest("details")!.open).toBeFalsy();
  await act(async () => container.querySelector<HTMLAnchorElement>('.edition-issues a[href="#edition-sources-x"]')!.click());
  expect(article.hidden).toBe(false);
  expect(source.closest("details")!.open).toBe(true);
  expect(document.activeElement).toBe(source);
  const section = article.querySelector<HTMLSelectElement>("#edition-section-x")!;
  expect(section.closest("[hidden]")).not.toBeNull();
  await act(async () => container.querySelector<HTMLAnchorElement>('.edition-issues a[href="#edition-section-x"]')!.click());
  // Section and locations sit on the Layout tab, which the correction link opens.
  expect(section.closest("[hidden]")).toBeNull();
  expect(button("Layout").getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(section);
  expect(container.querySelectorAll(".editorial-story:not([hidden])")).toHaveLength(1);
  expect(operations()).toEqual([]);
});

it("keeps the compact story chooser available for read-only inspection and honors exact story history", async () => {
  const location = new URL("https://fixture.test/newsroom/publication?draft=selected&generation=other%2Frun&keep=yes#edition-story-b");
  Object.defineProperty(window, "location", { configurable: true, value: location });
  await render({ canWrite: false });
  expect(container.querySelector(".editorial-story:not([hidden])")?.getAttribute("data-story-id")).toBe("b");
  const chooser = container.querySelector<HTMLSelectElement>('select[aria-label="Active story"]')!;
  expect(chooser.closest("fieldset[disabled], [inert]")).toBeNull();
  expect(button("Add story").disabled).toBe(true);
  expect(container.querySelector(".editorial-sections")?.hasAttribute("disabled")).toBe(true);
  for (const id of ["x", "b"]) {
    location.hash = `#edition-story-${id}`;
    await act(async () => window.dispatchEvent(new window.Event("popstate")));
    expect(container.querySelector(".editorial-story:not([hidden])")?.getAttribute("data-story-id")).toBe(id);
    expect(container.querySelectorAll(".editorial-story:not([hidden])")).toHaveLength(1);
  }
  expect(location.search).toBe("?draft=selected&generation=other%2Frun&keep=yes");
  expect(operations()).toEqual([]);
});

it("retains the editor, forms, pending work and exact draft across task visibility changes", async () => {
  vi.useFakeTimers();
  const onDraftChange = vi.fn();
  await render({ task: "reporting", onDraftChange });
  const editor = container.querySelector<HTMLElement>(".editorial-workspace")!;
  const reporting = container.querySelector<HTMLElement>(".editorial-story-panel")!;
  expect(reporting.hidden).toBe(false);
  expect(reporting.getAttribute("aria-labelledby")).toBe("story-workspace-title");
  expect(container.querySelector<HTMLElement>(".editorial-front-panel")!.hidden).toBe(false);
  expect(container.querySelector<HTMLElement>(".editorial-preview")!.hidden).toBe(false);
  await click("Add story");
  const form = container.querySelector(".editorial-story:not([hidden])")!;
  await source("Alpha", "interview");
  expect(status().textContent).toBe("Saving…");
  await render({ task: "activity", onDraftChange });
  expect(container.querySelector(".editorial-workspace")).toBe(editor);
  expect(editor.hidden).toBe(true);
  expect(editor.hasAttribute("inert")).toBe(true);
  await render({ task: "editions", onDraftChange });
  expect(editor.hidden).toBe(false);
  expect(reporting.hidden).toBe(false);
  expect(reporting.hasAttribute("inert")).toBe(false);
  expect(container.querySelector(".editorial-story:not([hidden])")).toBe(form);
  expect(status().textContent).toBe("Saving…");
  await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  expect(status().textContent).toBe("Start typing to save");
  expect(onDraftChange.mock.calls.at(-1)?.[0]).toMatchObject({ _id: "selected", revision: 4 });
  await render({ task: "reporting", onDraftChange });
  expect(selectedSource("Alpha").value).toBe("interview");
  expect(container.querySelector(".editorial-story:not([hidden])")).toBe(form);
  expect(vi.mocked(adminApi).mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
});

it("never briefly announces Saved while another scheduled edit or queued write remains", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  let writes = 0;
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.endsWith("/releases")) return { releases: [] };
    if (init?.method === "PATCH") {
      if (++writes === 2) await new Promise<void>((resolve) => { finish = resolve; });
      return persist(init);
    }
    return { draft: structuredClone(current), images: [], evidence: [] };
  });
  await render();
  const notices: string[] = [];
  const observer = new window.MutationObserver(() => notices.push(status().textContent ?? ""));
  observer.observe(status(), { childList: true, subtree: true, characterData: true });
  await source("Alpha", "interview");
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  await source("Beta", "observation");
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  expect(writes).toBe(1);
  expect(status().textContent).toBe("Saving…");
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(writes).toBe(2);
  expect(status().textContent).toBe("Saving…");
  expect(notices).not.toContain("Saved");
  await act(async () => finish());
  expect(status().textContent).toBe("Saved");
  expect(status().getAttribute("aria-live")).toBe("polite");
  observer.disconnect();
});

it.each([409, 422])("preserves failed values, meaningful status and the persistence barrier after %s until explicit retry", async (code) => {
  vi.useFakeTimers();
  let failing = true;
  const guard: MutableRefObject<(() => Promise<boolean>) | null> = { current: null };
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.endsWith("/releases")) return { releases: [] };
    if (init?.method === "PATCH") {
      if (failing) throw new ApiError("Source edit rejected", code);
      return persist(init);
    }
    return { draft: structuredClone(current), images: [], evidence: [] };
  });
  await render({ beforeDraftChange: guard });
  await source("Alpha", "interview");
  await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  expect(status().textContent).toBe(code === 409 ? "Conflict" : "Not saved");
  await source("Beta", "observation");
  expect(status().textContent).toBe(code === 409 ? "Conflict" : "Not saved");
  await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  expect(operations()).toHaveLength(1);
  expect(selectedSource("Alpha").value).toBe("interview");
  expect(selectedSource("Beta").value).toBe("observation");
  await click("Preview web");
  expect(vi.mocked(adminApi).mock.calls.some(([path]) => path.includes("/preview?"))).toBe(false);
  let allowed = true;
  await act(async () => { allowed = await guard.current!(); });
  expect(allowed).toBe(false);
  failing = false;
  await click("Retry my edit");
  expect(operations().slice(1).map((entry) => entry.expectedRevision)).toEqual([3, 4]);
  expect(selectedSource("Alpha").value).toBe("interview");
  expect(selectedSource("Beta").value).toBe("observation");
  expect(status().textContent).toBe("Saved");
  await act(async () => { allowed = await guard.current!(); });
  expect(allowed).toBe(true);
});

it("does not clear one story's image validation failure after another story or field saves", async () => {
  current.presentation.stories.slice(0, 2).forEach((story) => { story.image_id = `image-${story.id}`; });
  const images = ["a", "x"].map((id) => ({ _id: `image-${id}`, image: {
    image: "https://fixture.test/photo.jpg", image_credit: "Fixture", image_alt: "Park",
    image_caption: "Park", image_license: "CC BY",
  } }));
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.endsWith("/releases")) return { releases: [] };
    if (init?.method === "DELETE") {
      const { imageId } = JSON.parse(String(init.body));
      if (imageId === "image-a") throw new ApiError("Image Alpha failed validation", 422);
      current.presentation.stories.find((story) => story.image_id === imageId)!.image_id = null;
      current.revision += 1;
      return { draft: structuredClone(current) };
    }
    if (init?.method === "PATCH") return persist(init);
    return { draft: structuredClone(current), images, evidence: [] };
  });
  await render();
  const alpha = container.querySelector<HTMLElement>('article[aria-label="Alpha in News"]')!;
  const exhibit = container.querySelector<HTMLElement>('article[aria-label="Exhibit in Arts"]')!;
  await act(async () => [...alpha.querySelectorAll("button")].find((item) => item.textContent === "Remove image")!.click());
  expect(status().textContent).toBe("Not saved");
  await act(async () => [...exhibit.querySelectorAll("button")].find((item) => item.textContent === "Remove image")!.click());
  expect(status().textContent).toBe("Not saved");
  expect(container.textContent).toContain("Image Alpha failed validation");
  await source("Beta", "observation");
  await act(async () => container.querySelector(".editorial-workspace")!.dispatchEvent(new window.Event("focusout", { bubbles: true })));
  expect(operations()).toHaveLength(1);
  expect(status().textContent).toBe("Not saved");
  await click("Preview web");
  expect(vi.mocked(adminApi).mock.calls.some(([path]) => path.includes("/preview?"))).toBe(false);
});

it("lays the edition out as a canvas with a Content/Layout panel, a stage action and an Add content menu", async () => {
  vi.useFakeTimers();
  Object.defineProperty(window, "location", { configurable: true, value: new URL("https://fixture.test/newsroom/publication/editions/selected") });
  await render({ task: "writing" });
  // Header: status pill, save state, preview toggle and the next stage action.
  expect(container.querySelector(".jw-editor-title .jw-pill")?.textContent).toBe("Draft");
  expect(status().textContent).toBe("Saved");
  expect(button("Mark ready for approval")).toBeDefined();
  // Canvas: one selectable block per story, in edition order, with the first selected.
  const blocks = [...container.querySelectorAll<HTMLAnchorElement>(".jw-canvas-blocks a")];
  expect(blocks.map((block) => block.getAttribute("href"))).toEqual(["#edition-story-a", "#edition-story-x", "#edition-story-b", "#edition-story-y"]);
  expect(blocks.map((block) => block.getAttribute("aria-current"))).toEqual(["true", null, null, null]);
  expect(blocks[1].textContent).toContain("Arts");
  expect(blocks[1].textContent).toContain("Source: Agenda");
  await act(async () => blocks[2].click());
  expect(container.querySelector(".editorial-story:not([hidden])")?.getAttribute("data-story-id")).toBe("b");
  // Content tab holds copy, sources and removal; Layout holds section, locations, order and inclusion.
  const article = container.querySelector<HTMLElement>('[data-story-id="b"]')!;
  expect(article.querySelector('input[data-story-headline]')!.closest("[hidden]")).toBeNull();
  expect(article.querySelector('[aria-label="Remove story Beta"]')!.closest("[hidden]")).toBeNull();
  expect(article.querySelector("#edition-section-b")!.closest("[hidden]")).not.toBeNull();
  await click("Layout");
  expect(article.querySelector("#edition-section-b")!.closest("[hidden]")).toBeNull();
  expect(button("Move story Beta up in News").closest("[hidden]")).toBeNull();
  expect(article.querySelector('input[data-story-headline]')!.closest("[hidden]")).not.toBeNull();
  // The edition front block edits the headline and introduction.
  await act(async () => container.querySelector<HTMLButtonElement>(".jw-canvas-front")!.click());
  expect(container.querySelector(".editorial-front-panel")!.closest("[hidden]")).toBeNull();
  expect(container.querySelector(".editorial-sections")!.hasAttribute("hidden")).toBe(true);
  // Preview hides the side panel; Mobile narrows the canvas.
  await click("Preview");
  expect(container.querySelector(".jw-editor-panel")!.hasAttribute("hidden")).toBe(true);
  expect(button("Exit preview").getAttribute("aria-pressed")).toBe("true");
  await click("Mobile");
  expect(container.querySelector(".jw-canvas")!.getAttribute("data-device")).toBe("mobile");
  await click("Exit preview");
  // Add content maps only to what exists: a story, Save the Bee, sponsor placements.
  await click("Add content");
  const menu = container.querySelector("#editorial-add-content")!;
  expect(menu.hasAttribute("hidden")).toBe(false);
  expect([...menu.querySelectorAll(".jw-add-item")].map((item) => item.textContent)).toEqual(["Add story", "Save the Bee", "Sponsor placements"]);
  expect(menu.querySelector("a")?.getAttribute("href")).toBe("/newsroom/publication/settings#sponsor-placements");
  await click("Save the Bee");
  expect(container.querySelector<HTMLDetailsElement>("#editorial-extras")!.open).toBe(true);
  expect(operations()).toEqual([]);
});

it.each([
  ["ready_for_approval", "Approve", true],
  ["approved", "Publish", true],
  ["published", null, false],
] as const)("offers the %s stage action and reopen only where they apply", async (state, action, reopen) => {
  current.editorial_status = state;
  if (state !== "ready_for_approval") current.approval = { revision: 3, content_hash: "hash", approved_at: 1, approved_by: { id: "owner", email: "owner@example.test" } } as PublicationDraft["approval"];
  await render({ task: "writing" });
  const actions = [...container.querySelectorAll(".jw-editor-actions button")].map((item) => item.textContent);
  expect(actions.includes("Reopen")).toBe(reopen);
  if (action) expect(actions.at(-1)).toBe(action);
  else expect(actions).toEqual(["Preview"]);
});
