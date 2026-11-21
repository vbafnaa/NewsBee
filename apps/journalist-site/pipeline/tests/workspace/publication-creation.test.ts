import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { expect, it, vi } from "vitest";
import NewsroomPage from "../../../app/newsroom/page";
import { readableName } from "../../../lib/readable-name";
import type { NewsroomDirectoryEntry } from "../../orchestration/output-channels";

const state = vi.hoisted(() => ({
  principal: { id: "journalist", email: "journalist@example.test", role: "editor" },
  list: vi.fn<() => Promise<NewsroomDirectoryEntry[]>>(async () => []),
}));
vi.mock("@/lib/portal-access", () => ({
  requireSignedInPrincipal: async () => state.principal,
}));
vi.mock("@/lib/pipeline", () => ({ pipelineDeps: async () => ({ db: {} }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
  notFound: () => { throw new Error("not found"); },
  useSearchParams: () => new URLSearchParams("draft=exact-draft&generation=other-run&keep=a%2Bb"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/newsroom/active-room/editions",
}));
vi.mock("@/pipeline/orchestration/output-channels", () => ({ listOutputChannelDirectory: state.list }));
vi.mock("@/auth", () => ({ signOut: vi.fn() }));
vi.mock("@/lib/display-name", async () => {
  const { readableName } = await import("@/lib/readable-name");
  return { readableName, principalDisplayName: async (principal: { email: string }) => readableName("", principal.email) };
});
vi.mock("../../../app/publishing/channels", () => ({
  default: ({ email, creationOnly, surface }: { email: string; creationOnly: boolean; surface: string }) =>
    createElement("div", { id: "publication-creation", "data-email": email, "data-creation-only": creationOnly, "data-surface": surface }),
}));

it("shows assignment guidance without newsroom creation to an unassigned journalist", async () => {
  const markup = renderToStaticMarkup(await NewsroomPage({ searchParams: Promise.resolve({}) }));
  expect(state.list).toHaveBeenCalledWith({}, state.principal);
  expect(markup).toContain("Ask an administrator to assign you");
  expect(markup).not.toContain('id="publication-creation"');
  expect(markup).not.toContain("/admin");
});

it("retains deliberate operator newsroom creation", async () => {
  state.principal.role = "admin";
  const markup = renderToStaticMarkup(await NewsroomPage({ searchParams: Promise.resolve({}) }));
  state.principal.role = "editor";
  expect(markup).toContain('id="publication-creation"');
  expect(markup).toContain('data-creation-only="true"');
  expect(markup).toContain('data-email="journalist@example.test"');
  expect(markup).toContain('data-surface="newsroom"');
});

it("opens an authorized inspection selector choice without requiring direct membership", async () => {
  state.list.mockResolvedValueOnce([{
    id: "inspect", name: "Inspectable newsroom", enabled: true, selectedLocationIds: [],
    destinations: [{ type: "reader" }], accessMode: "inspection",
  }]);
  await expect(NewsroomPage({ searchParams: Promise.resolve({
    publicationId: "inspect", task: "editions", draft: "exact-draft", generation: "different-generation",
  }) })).rejects.toThrow("redirect:/newsroom/inspect/editions/exact-draft?generation=different-generation");
  state.list.mockResolvedValueOnce([{
    id: "inspect", name: "Inspectable newsroom", enabled: true, selectedLocationIds: [],
    destinations: [{ type: "reader" }], accessMode: "inspection",
  }]);
  await expect(NewsroomPage({ searchParams: Promise.resolve({ publicationId: "inspect", task: "videos" }) }))
    .rejects.toThrow("redirect:/newsroom/inspect/videos");
});

it.each([
  ["reporting", "editions/exact%20draft%2F%2B%3F", "#reporting"],
  ["story-workspace-title", "editions/exact%20draft%2F%2B%3F", "#story-workspace-title"],
  ["delivery", "settings", "#delivery"],
  ["audience", "settings", "#audience"],
  ["editorial-preview-title", "editions/exact%20draft%2F%2B%3F", "#editorial-preview-title"],
  ["publication-release-history-title", "editions/exact%20draft%2F%2B%3F", "#publication-release-history-title"],
])("retains exact selections and unrelated chooser queries for %s", async (task, route, hash) => {
    state.list.mockResolvedValueOnce([{
      id: "inspect", name: "Inspectable newsroom", enabled: true, selectedLocationIds: [],
      destinations: [{ type: "reader" }], accessMode: "inspection",
    }]);
    await expect(NewsroomPage({ searchParams: Promise.resolve({
      publicationId: "inspect", task, draft: "exact draft/+?", generation: "other/+?", keep: "a+b",
      filter: ["one", "two"],
    }) })).rejects.toThrow(`redirect:/newsroom/inspect/${route}?generation=other%2F%2B%3F&keep=a%2Bb&filter=one&filter=two${hash}`);
  },
);

it("keeps a requested destination and selection on chooser cards", async () => {
  state.list.mockResolvedValueOnce([{
    id: "inspect", name: "Inspectable newsroom", enabled: true, selectedLocationIds: [],
    destinations: [{ type: "reader" }], accessMode: "inspection",
  }]);
  const markup = renderToStaticMarkup(await NewsroomPage({ searchParams: Promise.resolve({
    task: "delivery", draft: "older", generation: "separate", keep: "yes",
  }) }));
  expect(markup).toContain('/newsroom/inspect/settings?generation=separate&amp;keep=yes#delivery');
});

const archiveDirectory: NewsroomDirectoryEntry[] = [
  { id: "reader-site", name: "Archived Reader", enabled: false, archivedAt: 123, lifecycleRevision: 1,
    selectedLocationIds: [], destinations: [{ type: "reader" }], accessMode: "direct" },
  { id: "active-room", name: "Active newsroom", enabled: true, archivedAt: null, lifecycleRevision: 0,
    selectedLocationIds: [], destinations: [{ type: "reader" }], accessMode: "inspection" },
  { id: "paused-room", name: "Paused newsroom", enabled: false, archivedAt: null, lifecycleRevision: 0,
    selectedLocationIds: [], destinations: [{ type: "reader" }], accessMode: "direct" },
];

it("omits archived cards without hiding paused rooms or breaking exact archived handoffs", async () => {
  state.list.mockResolvedValueOnce(archiveDirectory);
  const markup = renderToStaticMarkup(await NewsroomPage({ searchParams: Promise.resolve({}) }));
  expect(markup).not.toContain("Archived Reader");
  expect(markup).toContain("Active newsroom");
  expect(markup).toContain("Paused newsroom");
  expect(parseHTML(markup).document.querySelectorAll(".publication-card")).toHaveLength(2);
  state.list.mockResolvedValueOnce(archiveDirectory);
  await expect(NewsroomPage({ searchParams: Promise.resolve({
    publicationId: "reader-site", draft: "exact-draft", task: "editions",
  }) })).rejects.toThrow("redirect:/newsroom/reader-site/editions/exact-draft");
});

it("filters ordinary selector choices but retains the exact archived workspace as disabled context", async () => {
  const { default: NewsroomShell } = await vi.importActual<typeof import("../../../app/newsroom/newsroom-shell")>("../../../app/newsroom/newsroom-shell");
  const shell = (publicationId?: string, publications = archiveDirectory) => renderToStaticMarkup(createElement(NewsroomShell, {
    email: "owner@example.test", role: "owner", publications, publicationId, children: "Exact workspace retained",
  }));
  expect(shell()).not.toContain("Archived Reader");
  const exact = shell("reader-site");
  expect(exact).toContain('value="reader-site" disabled="" selected=""');
  expect(exact).toContain("Archived Reader · Archived");
  expect(exact).toContain("Exact workspace retained");
  expect(exact).toContain("Active newsroom");
  expect(exact).toContain("Paused newsroom");
  expect(shell("reader-site", archiveDirectory.slice(0, 1))).not.toMatch(/<option value="reader-site"(?![^>]*disabled)/);
});

it("renders one chooser heading and each saved name once without duplicate navigation or routine status", async () => {
  state.list.mockResolvedValueOnce([{
    id: "moses", name: "Moses Lake Newsroom", enabled: true, archivedAt: null, lifecycleRevision: 0,
    selectedLocationIds: ["moses-lake"], destinations: [{ type: "reader" }, { type: "video" }], accessMode: "direct",
  }]);
  const { document } = parseHTML(renderToStaticMarkup(await NewsroomPage({ searchParams: Promise.resolve({}) })));
  expect([...document.querySelectorAll("h1")].map((heading) => heading.textContent)).toEqual(["Your work"]);
  expect(document.querySelector("h1")?.id).toBe("workspace-title");
  expect(document.querySelectorAll(".jw-nav a, .jw-operations-link")).toHaveLength(0);
  expect(document.querySelector(".jw-brand")?.textContent).toBe("NewsbeeWorkspace");
  expect(document.querySelector("main")?.textContent?.match(/Moses Lake Newsroom/g)).toHaveLength(1);
  const card = document.querySelector(".publication-card")!;
  expect(card.querySelector(".jw-eyebrow")).toBeNull();
  expect(card.textContent).toContain("1 covered community · Web + Video");
  expect(card.querySelector("a")?.textContent).toBe("Open");
  expect(card.querySelector("a")?.getAttribute("aria-label")).toBe("Open Moses Lake Newsroom");
  expect(card.querySelector("a")?.getAttribute("href")).toBe("/newsroom/moses");
  expect(document.querySelector('a[href="/account/security"]')).not.toBeNull();
  expect(document.querySelector(".jw-user button")?.textContent).toBe("Sign out");
});

it("keeps inspection, paused and coverage warnings with concise, contextual actions", async () => {
  state.list.mockResolvedValueOnce(archiveDirectory.slice(1));
  const { document } = parseHTML(renderToStaticMarkup(await NewsroomPage({
    searchParams: Promise.resolve({ task: "delivery", draft: "exact-draft" }),
  })));
  expect(document.querySelector(".jw-page-description")?.textContent).toBe("Choose a newsroom to continue.");
  const cards = [...document.querySelectorAll(".publication-card")];
  expect(cards[0].querySelector(".jw-eyebrow")?.textContent).toContain("Read-only inspection · Coverage setup needed");
  expect(cards[0].querySelector("a")?.textContent).toBe("Inspect");
  expect(cards[0].querySelector("a")?.getAttribute("aria-label")).toBe("Inspect Active newsroom");
  expect(cards[0].querySelector("a")?.getAttribute("href")).toBe("/newsroom/active-room/settings#delivery");
  expect(cards[1].querySelector(".jw-eyebrow")?.textContent).toContain("Coverage setup needed · Paused");
});

it.each([["editor", false], ["admin", true], ["owner", true]] as const)("retains selected-workspace switching, landmarks and %s account links", async (role, operator) => {
  const { default: NewsroomShell } = await import("../../../app/newsroom/newsroom-shell");
  const { document } = parseHTML(renderToStaticMarkup(createElement(NewsroomShell, {
    email: "fixture.writer@example.test", name: readableName("", "fixture.writer@example.test"), role, publications: archiveDirectory,
    publicationId: "active-room", publicationName: "Active newsroom", inboxWaiting: 3, children: "Selected edition",
  })));
  expect(document.querySelector(".jw-topbar-context")?.textContent).toContain("Active newsroom");
  expect(document.querySelector('label[for="newsroom-publication"]')?.textContent).toBe("Newsroom workspace");
  expect(document.querySelector('option[selected]')?.textContent).toBe("Active newsroom · Inspect");
  expect(document.querySelector("form.jw-switcher")?.getAttribute("action")).toBe("/newsroom");
  expect(document.querySelector<HTMLInputElement>('.jw-switcher input[name="task"]')?.getAttribute("value")).toBe("editions");
  // The final sidebar: Editions is one item (the editor highlights it), Videos replaces Channels, and Admin is one
  // Newsroom admin page for everyone; its links into Operations are locked there, not in the sidebar.
  expect([...document.querySelectorAll('nav[aria-label="Newsroom navigation"] a')].map((link) => link.textContent?.replace(/KEY$/, ""))).toEqual(
    ["Overview", "New source map", "New edition", "New video", "Source map", "Editions", "Videos", "Analytics", "Newsroom admin"]);
  expect([...document.querySelectorAll(".jw-nav .jw-nav-label")].map((label) => label.textContent)).toEqual(["Workspace", "Create", "Current", "Admin"]);
  expect([...document.querySelectorAll('nav[aria-label="Newsroom navigation"] a')].map((link) => link.getAttribute("href"))).toEqual([
    "/newsroom/active-room", "/newsroom/active-room/source-map/collect", "/newsroom/active-room/new-edition", "/newsroom/active-room/new-video",
    "/newsroom/active-room/source-map", "/newsroom/active-room/editions", "/newsroom/active-room/videos", "/newsroom/active-room/analytics",
    "/newsroom/active-room/admin"]);
  expect(document.querySelector('.jw-nav a[href="/health"], .jw-nav a[href="/site-backup"], .jw-nav-locked')).toBeNull();
  // No pills unless the newsroom is paused or an operator is inside it under support or inspection.
  expect(document.querySelector(".jw-topbar-pill")).toBeNull();
  expect(document.querySelector('.jw-user-menu a[href="/admin"]') !== null).toBe(operator);
  // The bell opens the inbox and shows a dot while items wait; Settings sits in the ⋯ menu.
  const bell = document.querySelector<HTMLAnchorElement>(".jw-topbar .jw-icon-button")!;
  expect(bell.getAttribute("href")).toBe("/newsroom/active-room/inbox");
  expect(bell.getAttribute("aria-label")).toBe("Inbox, 3 waiting");
  expect(bell.hasAttribute("data-unread")).toBe(true);
  expect(document.querySelector('.jw-user-menu a[href="/newsroom/active-room/settings"]')?.textContent).toBe("Newsroom settings");
  expect(document.querySelector(".jw-user-text strong")?.textContent).toBe("Fixture Writer");
  expect(document.querySelector(".jw-user-text small")?.textContent).toBe(role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Location journalist");
  expect(document.querySelector(".jw-avatar")?.textContent).toBe("FW");
  // Password & sign-in, Operations and Sign out live in the ⋯ menu, not as stacked links.
  const menu = document.querySelector(".jw-user-menu")!;
  expect(menu.querySelector("summary")?.getAttribute("aria-label")).toBe("Account menu");
  expect(menu.querySelector('a[href="/account/security"]')).not.toBeNull();
  expect(menu.querySelector("button")?.textContent).toBe("Sign out");
  expect(document.querySelector('a[href="/account/security"]')).not.toBeNull();
  expect(document.querySelector(".skip-workspace")?.getAttribute("href")).toBe("#workspace-content");
});

it.each([
  [{ paused: true }, ["Newsroom paused"]],
  [{ support: "active" }, ["Publication-bound support active"]],
  [{ support: "inspection", paused: true }, ["Newsroom paused", "Read-only operator inspection"]],
] as const)("shows the paused and support indicators in the top bar on every newsroom page (%o)", async (state, pills) => {
  const { default: NewsroomShell } = await import("../../../app/newsroom/newsroom-shell");
  const { document } = parseHTML(renderToStaticMarkup(createElement(NewsroomShell, {
    email: "fixture.writer@example.test", role: "admin", publications: archiveDirectory,
    publicationId: "active-room", publicationName: "Active newsroom", children: "Any page", ...state,
  })));
  expect([...document.querySelectorAll(".jw-topbar .jw-topbar-pill")].map((pill) => pill.textContent)).toEqual(pills);
});
