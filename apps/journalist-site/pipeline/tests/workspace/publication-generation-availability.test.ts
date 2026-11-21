import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PublicationGeneration from "../../../app/publishing/publication-generation";
import { NewsroomTasks } from "../../../app/newsroom/newsroom-tasks";
import { adminApi, ApiError, apiJson } from "../../../lib/admin-client";

vi.mock("../../../lib/admin-client", async (original) => ({
  ...await original<typeof import("../../../lib/admin-client")>(), adminApi: vi.fn(),
}));
vi.mock("../../../app/publishing/publication-editorial-workspace", () => ({ default: () => null }));

let root: Root, container: HTMLElement, url: URL;
let available: boolean, failRead: boolean, malformed: boolean;
let preflightSignals: AbortSignal[];
const busyDetail = "Shared generation capacity is busy. Recheck availability shortly, or start writing without generation.";
const allowance = () => ({
  remaining: 20, exhausted: false, resetsAt: 1, source: "personal", reasons: [],
  admission: { available, detail: available ? null : busyDetail },
});
beforeEach(() => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  url = new URL("https://fixture.test/newsroom/assigned/new-edition");
  Object.defineProperty(window, "location", { configurable: true, get: () => url });
  Object.defineProperty(window, "history", { configurable: true, value: {
    state: null, pushState: (_state: unknown, _title: string, next: string) => { url = new URL(next, url); },
    replaceState: (_state: unknown, _title: string, next: string) => { url = new URL(next, url); },
  } });
  window.requestAnimationFrame = (callback) => { callback(0); return 0; };
  window.cancelAnimationFrame = vi.fn();
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.getElementById("root")!;
  root = createRoot(container);
  available = false; failRead = false; malformed = false; preflightSignals = [];
  vi.mocked(adminApi).mockReset();
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.includes("/generation-preflight")) {
      preflightSignals.push(init!.signal as AbortSignal);
      if (failRead) throw new Error("Availability read failed");
      return malformed ? { ...allowance(), admission: undefined } : allowance();
    }
    if (init?.method === "POST") throw new ApiError(busyDetail, 409, "generation_busy");
    if (path.includes("/generations")) return {
      publication: { id: "assigned", name: "Weekly", role: "editor", canWrite: true },
      limits: { maxLocations: 3 },
      locations: [{ location_id: "north", location_name: "North", ready: true, missing_prerequisites: [] }],
      generations: [], draft: null, drafts: [], draftsNextCursor: null,
      defaultOptions: { flow: "current", mode: "autopilot" }, execution: { funding: "personal" },
    };
    throw new Error(`Unexpected request: ${path}`);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(operator = false) {
  await act(async () => root.render(createElement(NewsroomTasks, { workspace: "/newsroom/assigned" },
    createElement(PublicationGeneration, {
      publicationId: "assigned", publicationName: "Weekly", publicationEnabled: true,
      supportMode: false, operator, generationAnchorId: "editions", reportingAnchorId: "reporting",
    }))));
}
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(result).toBeDefined();
  return result!;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function navigate(view: string) {
  await act(async () => { url.pathname = `/newsroom/assigned/${view}`; window.dispatchEvent(new window.Event("popstate")); });
}

it.each([true, false])("keeps exact per-run edition diagnostics contextual and read-only for operator=%s", async (operator) => {
  const original = vi.mocked(adminApi).getMockImplementation()!;
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    const result = await original(path, init) as Record<string, unknown>;
    if (!path.includes("/generations")) return result;
    return { ...result, generations: [{
      _id: "generation-selected", status: "ready", window: ["2026-11-01", "2026-11-07"], created_at: 123,
      progress: { total: 2, completed: 2, failed: 0 }, error: null,
      children: [
        { _id: "run north", location_id: "north/a", location_name: "North", status: "built" },
        { _id: "run-south", location_id: "south", location_name: "South", status: "built" },
      ],
    }] };
  });
  url.searchParams.set("generation", "generation-selected");
  await render(operator);
  const links = [...container.querySelectorAll<HTMLAnchorElement>('a[href^="/edition-map?"]')];
  expect(links).toHaveLength(operator ? 2 : 0);
  if (operator) {
    expect(links.map((link) => [...new URL(link.getAttribute("href")!, url).searchParams.entries()])).toEqual([
      [["location", "north/a"], ["run", "run north"]],
      [["location", "south"], ["run", "run-south"]],
    ]);
    for (const link of links) {
      expect(link.textContent).toContain("read-only funnel / comparison");
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
  }
  expect(url.pathname).toBe("/newsroom/assigned/new-edition");
  expect(url.searchParams.get("generation")).toBe("generation-selected");
  expect(vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

it("explains shared busy capacity before submission, keeps writing available, and recovers on recheck without stray 0 or API settings", async () => {
  await render();
  expect(button("Generate draft").disabled).toBe(true);
  expect(button("Start writing").disabled).toBe(false);
  expect(container.querySelector(".generation-start")!.textContent).toContain(busyDetail);
  expect(container.querySelector(".generation-start a[href='/account']")).toBeNull();
  const standaloneZeroes = [...container.querySelector(".generation-start")!.childNodes]
    .filter((node) => node.nodeType === 3 && node.textContent?.trim() === "0");
  expect(standaloneZeroes).toHaveLength(0);
  expect(vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  available = true;
  await click("Recheck availability");
  expect(button("Generate draft").disabled).toBe(false);
  expect(container.textContent).not.toContain(busyDetail);
  expect(container.textContent).toContain("no place is reserved");
});

it("polls while setup is visible and aborts in-flight reads and timers when hidden", async () => {
  await render();
  const initial = preflightSignals.length;
  available = true;
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(preflightSignals).toHaveLength(initial + 1);
  expect(button("Generate draft").disabled).toBe(false);
  await navigate("settings");
  expect(preflightSignals.at(-1)!.aborted).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(preflightSignals).toHaveLength(initial + 1);
  await navigate("new-edition");
  expect(preflightSignals).toHaveLength(initial + 2);
  vi.mocked(adminApi).mockImplementation(async (_path, init) => {
    preflightSignals.push(init!.signal as AbortSignal);
    return new Promise(() => {});
  });
  await click("Recheck availability");
  await navigate("settings");
  expect(preflightSignals.at(-1)!.aborted).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(preflightSignals).toHaveLength(initial + 3);
});

it.each(["failed", "malformed"])("shows an explicit retryable %s preflight, without blocking manual writing", async (kind) => {
  available = true;
  failRead = kind === "failed"; malformed = kind === "malformed";
  await render();
  expect(container.textContent).toContain("Generation preflight unavailable");
  expect(button("Generate draft").disabled).toBe(true);
  expect(button("Start writing").disabled).toBe(false);
  expect(container.querySelector(".generation-start a[href='/account']")).toBeNull();
  failRead = false; malformed = false;
  await click("Recheck availability");
  expect(button("Generate draft").disabled).toBe(false);
});

it("can create a writing draft despite busy capacity, exhausted allowance and provider blockers", async () => {
  const original = vi.mocked(adminApi).getMockImplementation()!;
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (path.includes("/generation-preflight")) return {
      ...allowance(), exhausted: true, remaining: 0, reasons: ["No generation provider is configured."],
    };
    if (path.endsWith("/drafts") && init?.method === "POST") return { draft: { _id: "manual-draft" } };
    return original(path, init);
  });
  await render();
  expect(button("Generate draft").disabled).toBe(true);
  expect(button("Start writing").disabled).toBe(false);
  await click("Start writing");
  expect(url.pathname).toBe("/newsroom/assigned/editions/manual-draft");
  expect(url.searchParams.get("draft")).toBeNull();
  expect(vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method === "POST").map(([path]) => path))
    .toEqual(["publications/assigned/drafts"]);
});

it("keeps a submit-time admission race explicit, retains the request key, and never automatically resubmits", async () => {
  available = true;
  await render();
  const submit = async () => {
    await act(async () => {
      container.querySelector("form.generation-start")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    // A long generation starts only after the confirm dialog.
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("New edition");
    expect(vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(posted);
    await click("Start generation");
    posted += 1;
  };
  let posted = 0;
  await submit();
  expect(container.textContent).toContain("No new generation was created");
  expect(button("Generate draft").disabled).toBe(true);
  expect(button("Start writing").disabled).toBe(false);
  expect(container.querySelector(".generation-start a[href='/account']")).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  const posts = () => vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method === "POST");
  expect(posts()).toHaveLength(1);
  await submit();
  expect(posts()).toHaveLength(2);
  expect(JSON.parse(posts()[0][1]!.body as string).idempotencyKey)
    .toBe(JSON.parse(posts()[1][1]!.body as string).idempotencyKey);
});

it("preserves structured admission conflict codes from the actual API client", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    code: "generation_busy", detail: busyDetail,
  }, { status: 409 })));
  await expect(apiJson("/fixture")).rejects.toMatchObject({ status: 409, code: "generation_busy", message: busyDetail });
});
