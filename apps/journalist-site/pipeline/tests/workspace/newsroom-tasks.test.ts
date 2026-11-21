import { act, createElement, useEffect } from "react";
import { parseHTML } from "linkedom";
import { afterEach, expect, it, vi } from "vitest";
import { defaultPublicationSettings } from "../../../../../shared/publication-settings";
import PublicationGeneration from "@/app/publishing/publication-generation";
import PublicationSettingsPanel from "@/app/publishing/publication-settings";
import PublicationSourceFeedback from "@/app/publishing/source-feedback";
import RetainedDisclosure from "@/app/components/retained-disclosure";
import { NewsroomChooserFields, NewsroomDestinations, NewsroomTaskPanel, NewsroomTasks, newsroomTaskForHash } from "@/app/newsroom/newsroom-tasks";
import { NewsroomSideNav } from "@/app/newsroom/newsroom-navigation";

const mocks = vi.hoisted(() => ({ api: vi.fn(), mounted: vi.fn(), unmounted: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/admin-client", () => ({ adminApi: mocks.api }));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => new URL(window.location.href).pathname,
  useSearchParams: () => new URL(window.location.href).searchParams,
}));
vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));
vi.mock("@/app/publishing/publication-editorial-workspace", () => ({
  default: ({ onDraftChange }: { onDraftChange: (draft: unknown) => void }) => {
    useEffect(() => { mocks.mounted(); return () => mocks.unmounted(); }, []);
    return createElement("div", { "data-editor": true },
      createElement("h3", { id: "story-workspace-title" }, "Stories"),
      createElement("h3", { id: "editorial-preview-title" }, "Preview"),
      createElement("h3", { id: "editorial-publish-title" }, "Approval and publish"),
      createElement("h3", { id: "publication-release-history-title" }, "Release history"),
      createElement("input", { "aria-label": "Pending editor fixture", defaultValue: "Pending original reporting" }),
      createElement("button", { onClick: () => onDraftChange({ ...draft, editorial_status: "approved" }) }, "Approve fixture"),
      createElement("button", { onClick: () => onDraftChange({ ...draft, editorial_status: "ready_for_approval" }) }, "Ready fixture"));
  },
}));

const publicationId = "a".repeat(32);
const workspace = `/newsroom/${publicationId}`;
const draft = {
  _id: "selected-draft", title: "Selected edition", window: ["2026-11-09", "2026-11-15"],
  editorial_status: "editing", revision: 2, stories: [],
  presentation: { story_order: ["included", "excluded"], stories: [
    { id: "included", origin: "original" },
    { id: "excluded", origin: "original", included: false },
  ] },
  locations: [{ id: "north", name: "North" }],
};
const fixture = {
  publication: { id: publicationId, name: "Fixture", role: "editor" },
  limits: { maxLocations: 3 },
  locations: [
    { location_id: "north", location_name: "North", ready: true },
    { location_id: "south", location_name: "South", ready: true },
  ],
  generations: [{ _id: "inspected-generation", status: "ready", window: draft.window, progress: { total: 1, completed: 1, failed: 0 }, children: [] }],
  draft, drafts: [{ ...draft, generation_id: "different-generation", revision: 2, created_at: 1 }],
  draftsNextCursor: null, defaultOptions: { flow: "current" },
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it("hands Video Studio to the newsroom chooser's Videos view without loading providers", async () => {
  const { default: VideoStudioPage } = await import("@/app/video-studio/page");
  await VideoStudioPage({ searchParams: Promise.resolve({}) });
  expect(mocks.redirect).toHaveBeenCalledWith("/newsroom?task=videos");
  expect(mocks.api).not.toHaveBeenCalled();
});

it.each([
  ["#home", "overview"], ["#overview", "overview"], ["", "overview"], ["#generation-activity", "activity"], ["#audience", "settings"], ["#delivery", "settings"],
  ["#new-edition", "new-edition"], ["#videos", "videos"], ["#api-keys", "settings"],
  ["#editions", "editions"], ["#reporting", "writing"], ["#settings", "settings"],
  ["#reporting-title", "writing"], ["#story-workspace-title", "writing"], ["#settings-title", "settings"],
  ["#publication-release-history-title", "writing"], ["#editorial-preview-title", "writing"],
  ["#editorial-publish-title", "writing"], ["#editorial-review-title", "writing"], ["#editorial-original-reporting-title", "writing"],
  ["#edition-headline", "writing"], ["#edition-intro", "writing"], ["#edition-story-a", "writing"],
  ["#edition-sources-a", "writing"], ["#edition-section-a", "writing"],
])("maps legacy and nested destination %s to %s", (hash, expected) => {
  expect(newsroomTaskForHash(hash)).toBe(expected);
});

it.each([
  { role: "owner direct", hash: "#delivery", accessMode: "direct", canWrite: true },
  { role: "assigned Admin", hash: "#audience", accessMode: "direct", canWrite: true },
  { role: "assigned Journalist", hash: "#delivery", accessMode: "direct", canWrite: true },
  { role: "owner inspection", hash: "#audience", accessMode: "inspection", canWrite: false },
  { role: "expired support", hash: "#delivery", accessMode: "support", canWrite: true, supportExpiresAt: 1 },
])("reveals initial $hash coverage without unrelated settings or changing $role capability", async ({ hash, accessMode, canWrite, supportExpiresAt }) => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const location = new URL(`https://newsbee.test${workspace}?draft=exact%2Bdraft&generation=other%2Frun&keep=yes${hash}`);
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "location", { configurable: true, value: location });
  Object.defineProperty(document, "oninput", { configurable: true, value: null });
  let frame: FrameRequestCallback | undefined;
  window.requestAnimationFrame = (callback) => { frame = callback; return 1; };
  window.cancelAnimationFrame = vi.fn();
  const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
  mocks.api.mockResolvedValue({
    channels: [{
      id: publicationId, name: "Role fixture", enabled: true, lifecycleRevision: 4, driveFolderId: "mongo:fixture",
      selectedLocationIds: [], allowedLocationIds: [], destinations: [{ type: "reader", url: "" }],
      accessMode, canWrite, supportExpiresAt,
    }],
    directory: [], locations: [], canManageAllowedCommunities: false,
  });
  const { default: PublishingChannels } = await import("@/app/publishing/channels");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(NewsroomTasks, { workspace },
      createElement(NewsroomSideNav, { publicationId }),
      createElement(NewsroomTaskPanel, { task: "settings" },
        createElement(NewsroomDestinations, { children: createElement(PublishingChannels, { channelId: publicationId, email: "fixture@example.test" }) })),
    )));
    await act(async () => frame?.(0));
    const destinations = document.querySelector<HTMLDetailsElement>("#audience")!;
    const coverage = destinations.querySelector("fieldset")!;
    expect(destinations.hasAttribute("open")).toBe(true);
    expect(coverage.closest("[hidden], [inert], details:not([open])")).toBeNull();
    expect(coverage.hasAttribute("disabled")).toBe(!canWrite || Boolean(supportExpiresAt));
    expect(destinations.querySelector("input[type=url], .channel-fields, .channel-enabled")).toBeNull();
    expect(destinations.querySelector("summary")?.textContent).toBe("Newsroom coverage");
    expect(focus.mock.contexts.at(-1)?.closest("#audience")).toBe(destinations);
    expect(destinations.querySelector("summary")?.getAttribute("tabindex")).not.toBe("-1");
    // Settings lives in the user card's menu, so no sidebar item is marked current.
    expect(document.querySelector('.jw-nav [aria-current="page"]')).toBeNull();
    expect(document.querySelectorAll(".output-channel")).toHaveLength(1);
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api.mock.calls[0][1]?.method).toBeUndefined();
    expect(location.search).toBe("?draft=exact%2Bdraft&generation=other%2Frun&keep=yes");
  } finally {
    await act(async () => root.unmount());
  }
});

it("retains the focused writing region when an initial reporting link finishes loading", async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "location", { configurable: true, value: new URL(`https://newsbee.test${workspace}#reporting`) });
  let frame: FrameRequestCallback | undefined;
  window.requestAnimationFrame = (callback) => { frame = callback; return 1; };
  window.cancelAnimationFrame = vi.fn();
  const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
  let resolve!: (value: typeof fixture) => void;
  mocks.api.mockReturnValue(new Promise<typeof fixture>((complete) => { resolve = complete; }));
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(NewsroomTasks, { workspace },
      createElement(NewsroomSideNav, { publicationId }),
      createElement(PublicationGeneration, {
        publicationId, publicationName: "Fixture", publicationEnabled: true, supportMode: false,
        generationAnchorId: "editions", reportingAnchorId: "reporting", initialDraftId: "selected-draft",
      }),
    )));
    await act(async () => frame?.(0));
    const region = document.querySelector('[data-newsroom-task="writing"]')!;
    expect(focus.mock.contexts.at(-1)).toBe(region);
    await act(async () => resolve(structuredClone(fixture)));
    expect(document.querySelector('[data-newsroom-task="writing"]')).toBe(region);
    expect(document.querySelector("[data-editor]")?.closest("[hidden], [inert]")).toBeNull();
    expect(region.closest("[hidden], [inert]")).toBeNull();
    expect(region.isConnected).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps one editor, exact selections and dirty settings mounted across task/history changes", async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const location = new URL(`https://newsbee.test${workspace}?draft=selected-draft&generation=inspected-generation&keep=a%2Bb&filter=one&filter=two#overview`);
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "location", { configurable: true, value: location });
  Object.defineProperty(window, "history", { configurable: true, value: {
    state: null,
    pushState: (_state: unknown, _title: string, url: string) => { location.href = new URL(url, location).href; },
    replaceState: (_state: unknown, _title: string, url: string) => { location.href = new URL(url, location).href; },
  } });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  window.cancelAnimationFrame = (id) => { frames.delete(id); };
  const flushFrames = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); };
  const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
  Object.defineProperty(document, "oninput", { configurable: true, value: null });
  const { default: PublishingChannels } = await import("@/app/publishing/channels");
  const { default: ReleaseDistribution } = await import("@/app/publishing/[channelId]/releases/[releaseId]/release-distribution");
  const settings = defaultPublicationSettings("Fixture");
  const supportExpiresAt = Date.now() + 60_000;
  const publication = { id: publicationId, name: "Fixture", role: "privileged", canWrite: true, supportExpiresAt };
  let failSave = true;
  let failCoverage = true;
  const channel = {
    id: publicationId, name: "Fixture", enabled: true, destinations: [{ type: "reader", url: "https://reader.example.test" }],
    selectedLocationIds: ["north"], allowedLocationIds: ["north"], lifecycleRevision: 7,
    driveFolderId: "mongo:fixture", canWrite: true, supportExpiresAt, accessMode: "support",
  };
  mocks.api.mockImplementation(async (path: string, options?: { method?: string; body: string }) => {
    if (path.includes("/generations")) return structuredClone(fixture);
    if (path.endsWith("/releases")) return { releases: [] };
    if (path.endsWith("/settings")) {
      if (options?.method === "PATCH") {
        if (failSave) throw new Error("Save conflict fixture");
        const patch = JSON.parse(options.body);
        return { settings: { ...structuredClone(settings), generation_preferences: { revision: 1, values: patch.generation_preferences.values } } };
      }
      return { publication, settings: structuredClone(settings) };
    }
    if (path === "output-channels" || path.startsWith("output-channels?")) {
      if (options?.method === "PATCH") {
        if (failCoverage) throw new Error("Coverage revision conflict fixture");
        return { channel: { ...channel, ...JSON.parse(options.body), lifecycleRevision: 8 } };
      }
      return { channels: [structuredClone(channel)], directory: [], locations: [{ id: "north", name: "North", ready: true }],
        canManageAllowedCommunities: false };
    }
    if (path.endsWith("/source-feedback")) return { publication, sources: [], feedback: [{
      _id: "acknowledged", source_name_snapshot: "Library", location_name: "North", category: "stale",
      message: "Please review the opening hours.", status: "approved", reason: "Checking the current notice.",
    }] };
    if (path.endsWith("/email")) return { campaigns: [{ _id: "old", release_id: "older-release", mode: "release", state: "complete", recipient_count: 2, counts: { delivered: 2 } }] };
    throw new Error(`Unexpected API request: ${path}`);
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const navigate = async (hash: string, event = "hashchange") => {
    await act(async () => { location.hash = hash; window.dispatchEvent(new window.Event(event)); });
    await act(async () => flushFrames());
  };
  const visit = async (path: string, hash = "") => {
    await act(async () => { location.pathname = path; location.hash = hash; window.dispatchEvent(new window.Event("popstate")); });
    await act(async () => flushFrames());
  };
  try {
    await act(async () => root.render(createElement(NewsroomTasks, { workspace },
      createElement(NewsroomSideNav, { publicationId }),
      createElement("form", { id: "chooser" }, createElement(NewsroomChooserFields)),
      createElement(PublicationGeneration, {
        publicationId, publicationName: "Fixture", publicationEnabled: true, supportMode: false,
        generationAnchorId: "editions", reportingAnchorId: "reporting", initialDraftId: "selected-draft",
        initialGenerationId: "inspected-generation",
      }),
      createElement(NewsroomTaskPanel, { task: "settings", lazy: true },
        createElement(PublicationSettingsPanel, { publicationId, publicationName: "Fixture" }),
        createElement(RetainedDisclosure, { title: "Source feedback", children: createElement(PublicationSourceFeedback, { publicationId }) }),
        createElement(NewsroomDestinations, { children: [
          createElement(PublishingChannels, { key: "channels", channelId: publicationId, email: "fixture@example.test" }),
          createElement(ReleaseDistribution, { key: "history", publicationId, draftId: "selected-draft", releaseId: "release", releaseHash: "hash", title: "Released fixture", stories: [] }),
        ] })),
    )));
    expect(mocks.api.mock.calls.map(([path]) => path)).toEqual([
      `publications/${publicationId}/generations?draft=selected-draft&generation=inspected-generation`,
      `publications/${publicationId}/releases`,
    ]);
    expect(document.querySelector('[data-newsroom-task="settings"]')).toBeNull();
    expect(document.querySelector('[data-newsroom-task="delivery"]')).toBeNull();
    expect([...document.querySelectorAll('.jw-nav a')].map((link) => link.textContent?.replace(/KEY$/, ""))).toEqual(
      ["Overview", "New source map", "New edition", "New video", "Source map", "Editions", "Videos", "Analytics", "Newsroom admin"]);
    expect([...document.querySelectorAll('.jw-nav a')].map((link) => link.getAttribute("href"))).toEqual([
      workspace, `${workspace}/source-map/collect`, `${workspace}/new-edition`, `${workspace}/new-video`,
      `${workspace}/source-map`, `${workspace}/editions`, `${workspace}/videos`, `${workspace}/analytics`, `${workspace}/admin`,
    ]);
    expect(document.querySelector('.jw-nav [aria-current="page"]')?.textContent).toBe("Overview");
    expect(document.querySelector(".edition-selection")?.closest("details")).toBeNull();
    await navigate("#settings");
    expect(mocks.api.mock.calls.filter(([path]) => String(path).endsWith("/settings"))).toHaveLength(1);
    expect(mocks.api.mock.calls.some(([path]) => String(path).endsWith("/source-feedback"))).toBe(false);
    expect(mocks.api.mock.calls.some(([path]) => String(path).startsWith("output-channels?"))).toBe(false);
    expect(document.querySelector("#audience")?.hasAttribute("open")).toBe(false);
    expect(document.querySelector(".output-channel")).toBeNull();
    expect([...document.querySelectorAll(".publication-settings input, .publication-settings textarea, .publication-settings select, .publication-settings button")]
      .filter((node) => !node.closest("details:not([open])"))).toHaveLength(5);
    expect(document.querySelector(".publication-settings")?.textContent).not.toContain("Email intro");
    expect(document.querySelector(".publication-settings")?.textContent).not.toContain("Front intro");
    expect(document.querySelector(".publication-settings")?.textContent).toContain("Private preview uses the current saved profile");
    expect(document.querySelector(".publication-settings")?.textContent).toContain("Saving here does not publish or change past releases");
    const profile = document.querySelector<HTMLInputElement>('input[value="Fixture"]')!;
    expect(profile).not.toBeNull();
    profile.type = "text";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(profile, "Unsaved newsroom profile");
      profile.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const preferences = document.querySelector<HTMLDetailsElement>(".publication-settings-disclosure")!;
    const toggle = async (details: HTMLDetailsElement, open: boolean) => {
      await act(async () => { details.open = open; details.dispatchEvent(new window.Event("toggle")); });
    };
    await toggle(preferences, true);
    const voice = preferences.querySelector("select")!;
    await act(async () => {
      voice.querySelector<HTMLOptionElement>('option[value="warm"]')!.selected = true;
      voice.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    const savePreferences = preferences.querySelector<HTMLButtonElement>("button")!;
    await act(async () => savePreferences.click());
    await toggle(preferences, false);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Save conflict fixture");
    expect(preferences.querySelector("summary")?.textContent).toContain("unsaved changes");
    failSave = false;
    await toggle(preferences, true);
    await act(async () => savePreferences.click());
    expect(profile.value).toBe("Unsaved newsroom profile");
    expect(preferences.querySelector("summary")?.textContent).not.toContain("unsaved changes");
    const savedPatch = JSON.parse(mocks.api.mock.calls.findLast(([, options]) => options?.method === "PATCH")![1].body);
    expect(savedPatch.generation_preferences.values.newsletter_intro_length).toBe(settings.generation_preferences.values.newsletter_intro_length);
    expect(savedPatch.generation_preferences.values.front_summary_density).toBe(settings.generation_preferences.values.front_summary_density);
    const feedbackDisclosure = [...document.querySelectorAll<HTMLDetailsElement>("details")].find((item) => item.querySelector("summary")?.textContent === "Source feedback")!;
    await toggle(feedbackDisclosure, true);
    expect(document.querySelector("#source-feedback-title")?.closest("section")?.textContent).toContain("Acknowledged - source change pending");
    expect(feedbackDisclosure.textContent).toContain("Review note: Checking the current notice.");
    const feedbackMessage = feedbackDisclosure.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(feedbackMessage, "Pending feedback");
      feedbackMessage.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await toggle(feedbackDisclosure, false);
    expect(feedbackMessage.closest("[hidden]")).not.toBeNull();
    expect(feedbackMessage.closest("[inert]")).not.toBeNull();
    await toggle(feedbackDisclosure, true);
    expect(feedbackDisclosure.querySelector("textarea")).toBe(feedbackMessage);
    expect(feedbackMessage.value).toBe("Pending feedback");
    await navigate("#audience");
    const destinations = document.querySelector<HTMLDetailsElement>("#audience")!;
    expect(destinations.hasAttribute("open")).toBe(true);
    expect(focus.mock.contexts.at(-1)).toBe(destinations.querySelector("summary"));
    // Settings lives in the user card's menu, so no sidebar item is marked current.
    expect(document.querySelector('.jw-nav [aria-current="page"]')).toBeNull();
    const coverageQuery = destinations.querySelector<HTMLInputElement>('.channel-locations input[type="search"]')!;
    expect(coverageQuery.closest("[hidden], [inert], details:not([open])")).toBeNull();
    expect(destinations.querySelector("input[type=url], .channel-fields, .channel-enabled")).toBeNull();
    await act(async () => {
      setter.call(coverageQuery, "Pending coverage search");
      coverageQuery.dispatchEvent(new window.Event("input", { bubbles: true }));
      destinations.querySelector<HTMLButtonElement>('button[aria-label="Remove North"]')!.click();
    });
    const saveDestinations = [...destinations.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save newsroom coverage")!;
    await act(async () => saveDestinations.click());
    expect(destinations.querySelector('[role="alert"]')?.textContent).toContain("Coverage revision conflict");
    await toggle(destinations, false);
    expect(coverageQuery.closest("[hidden]")).not.toBeNull();
    expect(coverageQuery.closest("[inert]")).not.toBeNull();
    await navigate("#delivery", "popstate");
    expect(destinations.hasAttribute("open")).toBe(true);
    expect(focus.mock.contexts.at(-1)).toBe(document.querySelector("#delivery h2"));
    expect(destinations.querySelector('.channel-locations input[type="search"]')).toBe(coverageQuery);
    expect(coverageQuery.value).toBe("Pending coverage search");
    expect(destinations.querySelector('button[aria-label="Remove North"]')).toBeNull();
    expect(destinations.querySelector('[role="alert"]')?.textContent).toContain("Coverage revision conflict");
    failCoverage = false;
    await act(async () => saveDestinations.click());
    const coveragePatch = JSON.parse(mocks.api.mock.calls.findLast(([, options]) => options?.method === "PATCH")![1].body);
    expect(coveragePatch).toMatchObject({
      id: publicationId, name: "Fixture", enabled: true, lifecycleRevision: 7, selectedLocationIds: [],
      destinations: [{ type: "reader", url: "https://reader.example.test" }],
    });
    expect(coveragePatch).not.toHaveProperty("allowedLocationIds");
    expect(destinations.querySelector('[role="status"]')?.textContent).toContain("No edition was approved or published");
    expect(destinations.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelectorAll(".output-channel")).toHaveLength(1);
    expect(mocks.api.mock.calls.some(([path]) => String(path).endsWith("/email"))).toBe(false);
    const historyDisclosure = document.querySelector<HTMLDetailsElement>(".release-distribution-history")!;
    await toggle(historyDisclosure, true);
    expect(historyDisclosure.textContent).toContain("delivered: 2");
    expect(historyDisclosure.textContent).toContain("older-release");
    expect(historyDisclosure.querySelectorAll("button")).toHaveLength(0);
    await toggle(historyDisclosure, false);
    await toggle(historyDisclosure, true);
    const editor = document.querySelector("[data-editor]")!;
    await navigate("#generation-activity");
    const activity = document.querySelector("#generation-activity")!;
    expect(activity.closest("[hidden], [inert], details")).toBeNull();
    expect(activity.querySelector('select[aria-label="Selected generation"]')).not.toBeNull();
    expect(editor.closest("[hidden]")).not.toBeNull();
    await navigate("#editions", "popstate");
    expect(document.querySelector("[data-editor]")).toBe(editor);
    expect(editor.closest("[hidden], [inert]")).not.toBeNull();
    const editionList = document.querySelector(".edition-navigation")!;
    expect(editionList.closest("[hidden], [inert]")).toBeNull();
    expect(editionList.querySelector('[aria-current="true"]')?.textContent).toContain("Selected edition");
    const calls = mocks.api.mock.calls.length;
    expect(mocks.api.mock.calls.filter(([path]) => String(path).includes("/generations"))).toHaveLength(1);
    expect(mocks.api.mock.calls.find(([path]) => String(path).includes("/generations"))?.[0])
      .toContain("draft=selected-draft&generation=inspected-generation");
    await navigate("#reporting");
    expect(profile.closest("[hidden]")).not.toBeNull();
    // Editions stays highlighted while an edition is open in the editor.
    expect(document.querySelector('.jw-nav [aria-current="page"]')?.textContent).toBe("Editions");
    expect(editor.closest("[hidden]")).toBeNull();
    expect(focus.mock.contexts.at(-1)).toBe(document.querySelector("#reporting-title"));
    await navigate("#story-workspace-title");
    expect(focus.mock.contexts.at(-1)).toBe(document.querySelector("#story-workspace-title"));
    await navigate("#editorial-preview-title");
    expect(focus.mock.contexts.at(-1)).toBe(document.querySelector("#editorial-preview-title"));
    const pendingEditor = document.querySelector<HTMLInputElement>('[aria-label="Pending editor fixture"]')!;
    pendingEditor.value = "Retained unfinished reporting";
    await navigate("#editorial-publish-title");
    expect(focus.mock.contexts.at(-1)).toBe(document.querySelector("#editorial-publish-title"));
    await navigate("#editorial-preview-title", "popstate");
    expect(document.querySelector('[aria-label="Pending editor fixture"]')).toBe(pendingEditor);
    expect(pendingEditor.value).toBe("Retained unfinished reporting");
    await navigate("#publication-release-history-title", "popstate");
    // Editions stays highlighted while an edition is open in the editor.
    expect(document.querySelector('.jw-nav [aria-current="page"]')?.textContent).toBe("Editions");
    await navigate("#settings");
    expect(profile.closest("[hidden]")).toBeNull();
    expect(profile.value).toBe("Unsaved newsroom profile");
    expect(document.querySelector('input[value="Unsaved newsroom profile"]')).toBe(profile);
    expect(document.querySelector("[data-editor]")).toBe(editor);
    expect(mocks.mounted).toHaveBeenCalledTimes(1);
    expect(mocks.unmounted).not.toHaveBeenCalled();
    expect(mocks.api.mock.calls.length).toBe(calls);
    expect(mocks.api.mock.calls.filter(([path]) => String(path).endsWith("/source-feedback"))).toHaveLength(1);
    expect(mocks.api.mock.calls.filter(([path]) => String(path).endsWith("/email"))).toHaveLength(1);
    expect(mocks.api.mock.calls.filter(([path]) => String(path).startsWith("output-channels?"))).toHaveLength(1);
    expect(destinations.querySelector('.channel-locations input[type="search"]')).toBe(coverageQuery);
    expect(coverageQuery.value).toBe("Pending coverage search");
    expect(destinations.querySelector('[role="alert"]')).toBeNull();
    expect(location.searchParams.get("draft")).toBe("selected-draft");
    expect(location.searchParams.get("generation")).toBe("inspected-generation");
    expect(location.searchParams.get("keep")).toBe("a+b");
    expect(location.searchParams.getAll("filter")).toEqual(["one", "two"]);
    expect(mocks.api.mock.calls.filter(([, options]) => options?.method)).toSatisfy((calls: Array<[string, { method: string }]>) =>
      calls.every(([path, options]) => options.method === "PATCH" && (path.endsWith("/settings") || path === "output-channels")));
    expect(document.querySelector<HTMLInputElement>('#chooser input[name="draft"]')?.value).toBe("selected-draft");
    expect(document.querySelector('#chooser input[name="publicationId"]')).toBeNull();
    for (const link of document.querySelectorAll(".jw-nav a")) expect(link.getAttribute("href")).toMatch(new RegExp(`^${workspace}`));
    // Real routes reach the same mounted views as the older hash links.
    await visit(`${workspace}/editions/selected-draft`);
    expect(document.querySelector("[data-editor]")).toBe(editor);
    expect(editor.closest("[hidden]")).toBeNull();
    // Editions stays highlighted while an edition is open in the editor.
    expect(document.querySelector('.jw-nav [aria-current="page"]')?.textContent).toBe("Editions");
    await visit(`${workspace}/settings`);
    expect(profile.closest("[hidden]")).toBeNull();
    expect(profile.value).toBe("Unsaved newsroom profile");
    expect(editor.closest("[hidden]")).not.toBeNull();
    await visit(workspace, "#home");
    const overview = document.querySelector('[data-newsroom-task="overview"]')!;
    expect(overview.closest("[hidden], [inert]")).toBeNull();
    const latest = overview.querySelector(".jw-list")!;
    expect(latest.textContent).toContain("Selected edition");
    expect(latest.querySelector(".jw-pill")?.textContent).toBe("Draft");
    expect(latest.querySelector("a")?.getAttribute("href")).toBe(`${workspace}/editions/selected-draft`);
    expect(overview.querySelector(".jw-area-latest .jw-card-note")).toBeNull();
    await act(async () => document.querySelectorAll<HTMLButtonElement>("[data-editor] button")[1].click());
    expect(latest.querySelector(".jw-pill")?.textContent).toBe("Ready for approval");
    expect(overview.querySelector(".jw-area-latest .jw-card-note")?.textContent).toContain("1 edition is ready for approval");
    await act(async () => document.querySelector<HTMLButtonElement>("[data-editor] button")!.click());
    expect(latest.querySelector(".jw-pill")?.textContent).toBe("Approved");
    expect(document.querySelector("[data-editor]")).toBe(editor);
    expect(mocks.unmounted).not.toHaveBeenCalled();
    vi.spyOn(Date, "now").mockReturnValue(supportExpiresAt + 1);
    await act(async () => window.dispatchEvent(new window.Event("focus")));
    expect(profile.closest("fieldset")?.hasAttribute("disabled")).toBe(true);
    expect(profile.value).toBe("Unsaved newsroom profile");
    expect(feedbackMessage.closest("fieldset")?.hasAttribute("disabled")).toBe(true);
    expect(feedbackMessage.value).toBe("Pending feedback");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1050));
      window.dispatchEvent(new window.Event("focus"));
    });
    expect(coverageQuery.closest("fieldset[disabled]")).not.toBeNull();
    expect(coverageQuery.value).toBe("Pending coverage search");
    expect(mocks.api.mock.calls.length).toBe(calls);
  } finally {
    await act(async () => root.unmount());
  }
});
