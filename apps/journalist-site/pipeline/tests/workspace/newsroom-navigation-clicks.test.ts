import { act, createElement, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NewsroomShell from "@/app/newsroom/newsroom-shell";

/*
 * From every journalist page, click each sidebar link, the bell, the brand and every ⋯ menu link, and check the
 * URL moves there. next/link is stood in for by an anchor that navigates a beat later, like the real router
 * waiting on the server, so the test also sees what the person sees in between: the clicked item already active.
 * scripts/check-newsroom-navigation.mjs runs the same walk with real mouse clicks in a browser.
 */
vi.mock("@/auth", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (href: string) => navigate(href), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  const Link = ({ href, onClick, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }) => {
    delete (rest as { prefetch?: boolean }).prefetch;
    return h("a", { ...rest, href, onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      setTimeout(() => navigate(href), 5);
    } }, children);
  };
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});

function navigate(href: string) {
  window.history.pushState(null, "", href);
  window.dispatchEvent(new window.Event("popstate"));
}

const id = "a".repeat(32);
const base = `/newsroom/${id}`;
const JOURNALIST_PAGES = ["", "/new-edition", "/source-map/collect", "/new-video", "/editions/draft-1", "/source-map",
  "/videos", "/editions", "/analytics", "/admin", "/inbox", "/settings", "/generation"].map((path) => base + path);

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  let url = new URL("http://localhost/");
  const location = { get pathname() { return url.pathname; }, get search() { return url.search; }, get hash() { return url.hash; }, get href() { return url.href; } };
  Object.defineProperty(window, "location", { value: location, configurable: true });
  const move = (_state: unknown, _title: string, next?: string | URL | null) => { url = new URL(String(next), url); };
  Object.defineProperty(window, "history", { value: { pushState: move, replaceState: move, state: null }, configurable: true });
  window.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number;
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("location", location);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.getElementById("root")!;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function open(page: string, role: "editor" | "owner") {
  window.history.pushState(null, "", page);
  await act(async () => root.render(createElement(NewsroomShell, {
    email: "editor@example.test", role, publications: [{ id, name: "North" }], publicationId: id, publicationName: "North", inboxWaiting: 2,
  }, createElement("p", null, "page"))));
}

const targets = () => [...container.querySelectorAll<HTMLAnchorElement>(".jw-nav a[href], .jw-topbar a[href], .jw-brand, .jw-user-menu-panel a[href]")];

for (const role of ["editor", "owner"] as const) {
  it(`navigates from every journalist page with every sidebar, top-bar and menu link (${role})`, async () => {
    const tried: string[] = [];
    for (const page of JOURNALIST_PAGES) {
      await open(page, role);
      const hrefs = [...new Set(targets().map((link) => link.getAttribute("href")!))];
      expect(hrefs.length).toBeGreaterThan(8);
      for (const href of hrefs) {
        await open(page, role);
        const link = targets().find((candidate) => candidate.getAttribute("href") === href)!;
        await act(async () => link.click());
        if (link.closest(".jw-nav") && href.startsWith(base)) expect(link.getAttribute("aria-current")).toBe("page");
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
        expect(window.location.pathname, `${page} → ${href}`).toBe(href);
        tried.push(href);
      }
    }
    // Admin is one item for everyone: Newsroom admin, inside the newsroom.
    expect(tried).toContain(`${base}/admin`);
  });
}

it("closes the ⋯ menu and Help after a route change, and on a click elsewhere", async () => {
  await open(base, "owner");
  const menu = container.querySelector(".jw-user-menu")!;
  const help = container.querySelector(".jw-help")!;
  menu.setAttribute("open", "");
  const settings = [...container.querySelectorAll<HTMLAnchorElement>(".jw-user-menu-panel a")].find((link) => link.textContent?.includes("Newsroom settings"))!;
  await act(async () => settings.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(window.location.pathname).toBe(`${base}/settings`);
  expect(menu.hasAttribute("open")).toBe(false);
  help.setAttribute("open", "");
  await act(async () => document.querySelector(".jw-content")!.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
  expect(help.hasAttribute("open")).toBe(false);
});
