import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, expect, it, vi } from "vitest";
import ReleaseVideoManager from "@/app/publishing/[channelId]/releases/[releaseId]/video/[storyId]/release-video-manager";
import ReleaseDistribution from "@/app/publishing/[channelId]/releases/[releaseId]/release-distribution";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([true, false])("uses authoritative Admin write capability %s, never managed-funding copy or navigation-side provider work", async (canWrite) => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "location", { configurable: true, value: new URL("https://newsbee.test/newsroom/selected") });
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const fetcher = vi.fn(async () => Response.json({
    principalRole: "admin", canWrite, supportExpiresAt: canWrite ? now + 60_000 : null,
    story: { title: "Immutable story" },
    package: { spokenScript: "Saved script", videoPrompt: "Saved prompt", subtitlesSrt: "" },
    videos: [], desktopConfigured: true, desktopFunding: "personal",
  }));
  vi.stubGlobal("fetch", fetcher);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(ReleaseVideoManager, {
      publicationId: "selected", releaseId: "exact-release", storyId: "exact-story",
    })));
    const form = document.querySelector("fieldset")!;
    expect(form.hasAttribute("disabled")).toBe(!canWrite);
    expect(document.body.textContent).toContain("Admins always use their own model and video keys");
    expect(document.body.textContent).not.toContain("Newsbee-managed Desktop Video is provided by the newsroom");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([
      "/api/admin/publications/selected/releases/exact-release/video/exact-story",
    ]);
    if (canWrite) {
      now += 60_001;
      await act(async () => window.dispatchEvent(new window.Event("focus")));
      expect(form.hasAttribute("disabled")).toBe(true);
      expect(document.body.textContent).toContain("Read-only inspection or expired support");
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(document.querySelector("textarea")?.defaultValue).toBe("Saved script");
  } finally {
    await act(async () => root.unmount());
  }
});

it("offers an exact authored UUID story in edition video handoff without starting generation", async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const storyId = "9278950c-bd14-40ca-9806-419b380a43d8";
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(ReleaseDistribution, {
      publicationId: "selected", draftId: "retained+draft", releaseId: "exact+release", releaseHash: "hash",
      title: "Authored edition", stories: [{ id: storyId, headline: "Reported here", locations: ["North"] }],
    })));
    expect(document.querySelector('a[aria-label="Create video for Reported here"]')?.getAttribute("href"))
      .toBe(`/newsroom/selected/releases/exact%2Brelease/video/${storyId}`);
    expect([...document.querySelectorAll("a")].find((link) => link.textContent === "Back to edition")?.getAttribute("href"))
      .toBe("/newsroom/selected/editions/retained%2Bdraft");
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("does not start generation or spend funds");
    expect(document.body.textContent).not.toContain("does not insert videos or games");
  } finally { await act(async () => root.unmount()); }
});

it("opens the authored story read-only until Create script is deliberately requested", async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetcher = vi.fn(async () => Response.json({
    principalRole: "editor", canWrite: true, story: { title: "Authored original", summary: "Full retained reporting" },
    videos: [], desktopConfigured: true, desktopFunding: "managed",
  }));
  vi.stubGlobal("fetch", fetcher);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(ReleaseVideoManager, {
      publicationId: "selected", releaseId: "exact-release", storyId: "9278950c-bd14-40ca-9806-419b380a43d8",
    })));
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "Create script and captions");
    expect(button?.hasAttribute("disabled")).toBe(false);
    expect(document.querySelector(".section-heading details")?.hasAttribute("open")).toBe(false);
    expect(document.querySelector("code")?.closest("details")?.hasAttribute("open")).toBe(false);
    expect(document.body.textContent).toContain("may consume the newsroom's managed allowance");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual(["/api/admin/publications/selected/releases/exact-release/video/9278950c-bd14-40ca-9806-419b380a43d8"]);
  } finally { await act(async () => root.unmount()); }
});
