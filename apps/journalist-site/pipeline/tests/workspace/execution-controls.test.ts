import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { afterEach, expect, it, vi } from "vitest";
import ExplainedButton from "../../../app/components/explained-button";
import { ExecutionNotice, executionDisabledReason, useExecutionPolicy, type ExecutionPolicy } from "../../../app/components/execution-policy";
import Dashboard from "../../../app/dashboard";
import SourceRuns from "../../../app/source-map/source-runs";
import { DEFAULT_SETTINGS } from "../../trace/source-run-settings";

const client = vi.hoisted(() => ({ api: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(), push: vi.fn() }));
vi.mock("@/lib/admin-client", async (original) => ({ withPublication: (await original<typeof import("@/lib/admin-client")>()).withPublication, adminApi: client.api, mapApi: client.api }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: client.push }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.ComponentProps<"a">) => createElement("a", props, children) }));

const policy = (): ExecutionPolicy => ({
  principal: { id: "fixture", email: "fixture@example.test", role: "editor" },
  reasons: ["Source map: Add your own serpapi search credentials."],
  editionReasons: [], mapReasons: ["Add your own serpapi search credentials.", "Enable the agent model budget for agentic work."],
  canStart: false, canStartEdition: true, canStartMap: false, blocker: null,
  permissions: { old: { canSpend: false, canRestart: false, restartReason: "Enable gemini's paid-call budget.", canReconnect: true, canClaim: false, reason: "API settings changed: explicitly reconnect this run.", paused: "API settings changed." } },
});
it("keeps edition, map, restart and existing-run explanations operation-specific", () => {
  const data = policy();
  expect(executionDisabledReason(data, "", "edition")).toBeNull();
  expect(executionDisabledReason(data, "", "map")).toContain("serpapi");
  expect(executionDisabledReason(data, "", "map")).toContain("agent model budget");
  expect(executionDisabledReason(data, "", "restart", "old")).toBe("Enable gemini's paid-call budget.");
  expect(executionDisabledReason(data, "", "spend", "old")).toContain("reconnect");
  expect(executionDisabledReason(data, "", "restart", "missing")).toContain("Reload");
});
it("explains loading, readiness errors and the actual global blocking run", () => {
  expect(executionDisabledReason(null, "", "edition")).toContain("Checking execution access");
  expect(executionDisabledReason(null, "Profile cannot be read", "map")).toContain("Profile cannot be read");
  const data = policy();
  data.blocker = { id: "busy-run", locationId: "other-place", locationName: "Other place", status: "awaiting_authoring", paused: "API version changed", kind: "run", publicationGenerationId: null, href: "/locations/other-place?tab=edition&run=busy-run" };
  const reason = executionDisabledReason(data, "", "edition");
  expect(reason).toContain("Other place (paused)");
  expect(reason).toContain("/locations/other-place?tab=edition&run=busy-run");
  expect(reason).not.toContain("serpapi");
});
it("uses the supplied blocker destination and never fabricates a location link for combined work", () => {
  const data = policy();
  data.blocker = {
    id: "child", locationId: "not-a-publication", locationName: "Combined work", status: "collecting", paused: null,
    kind: "publication_child", publicationGenerationId: "parent", href: "/newsroom/real-publication",
  };
  expect(executionDisabledReason(data, "", "edition")).toContain("Open /newsroom/real-publication");
  let markup = renderToStaticMarkup(createElement(ExecutionNotice, { policy: data }));
  expect(parseHTML(markup).document.querySelector("a")?.getAttribute("href")).toBe("/newsroom/real-publication");
  data.blocker.href = null;
  markup = renderToStaticMarkup(createElement(ExecutionNotice, { policy: data }));
  expect(parseHTML(markup).document.querySelector("a")).toBeNull();
  expect(markup).toContain("Combined draft context is unavailable");
  expect(executionDisabledReason(data, "", "edition")).not.toContain("/locations/");
});
it.each(["Missing model key.", "Newsroom busy.", "API settings changed. Reconnect the run.", "Only the person who started this run can continue it."])("makes disabled reasons hoverable and keyboard-described: %s", (reason) => {
  const markup = renderToStaticMarkup(createElement(ExplainedButton, { disabledReason: reason }, "Run pipeline"));
  const { document } = parseHTML(markup);
  const wrapper = document.querySelector(".explained-action")!;
  const button = wrapper.querySelector("button")!;
  const tooltip = document.getElementById(wrapper.getAttribute("aria-describedby")!)!;
  expect(wrapper.getAttribute("tabindex")).toBe("0");
  expect(wrapper.getAttribute("aria-label")).toBe("Run pipeline unavailable");
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
  expect(tooltip.getAttribute("role")).toBe("tooltip");
  expect(tooltip.textContent).toBe(reason);
});
it("leaves an enabled action a native focusable button", () => {
  const markup = renderToStaticMarkup(createElement(ExplainedButton, { disabledReason: null }, "Create edition"));
  const { document } = parseHTML(markup);
  expect(document.querySelector("button")?.hasAttribute("disabled")).toBe(false);
  expect(document.querySelector(".explained-action")).toBeNull();
});

let root: Root | undefined;
afterEach(async () => {
  if (root) { await act(async () => root!.unmount()); root = undefined; }
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
});
function mountDOM() {
  const { window, document } = parseHTML("<html><body><div id=\"root\"></div></body></html>");
  vi.stubGlobal("window", window); vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "location", { configurable: true, value: new URL("https://fixture.test/locations/one?tab=collect-sources&run=A") });
  Object.defineProperty(window, "history", { configurable: true, value: { state: null, replaceState: vi.fn() } });
  Object.defineProperty(window, "confirm", { configurable: true, value: vi.fn(() => true) });
  root = createRoot(document.getElementById("root")!);
  return document;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function detail(id: string) {
  return {
    run: { _id: id, kind: "map", location_id: "one", location_name: `Source ${id}`, status: "mapping", window: ["2099-01-01", "2099-01-08"], sources: [], trigger: { kind: "manual", by: "fixture" } },
    jobs: [], stories: [], health: { candidate_count: 0 },
  };
}
it("keeps inspector, polling and mutation on B when a late poll for A finishes after selection changes", async () => {
  vi.useFakeTimers();
  const document = mountDOM();
  const lateA = deferred<ReturnType<typeof detail>>();
  const lateTraceA = deferred<ReturnType<typeof trace>>();
  function trace(id: string) {
    return {
      run: { id, number: id === "A" ? 1 : 2, location_id: "one", location_name: `Trace ${id}`, status: "mapped", created_at: 1, completed_at: 2, recorded: true },
      settings: DEFAULT_SETTINGS, ending: { tone: "ok", text: `Finished trace ${id}` },
      pages: [], stages: [], limits: [], categories: [], tools: [], log: [], grid: null,
    };
  }
  let aCalls = 0;
  const aSignals: Array<AbortSignal | null | undefined> = [];
  client.api.mockImplementation(async (path, init) => {
    if (path === "runs/A") { aSignals.push(init?.signal); return ++aCalls === 1 ? detail("A") : lateA.promise; }
    if (path === "runs/B") return detail("B");
    if (path === "locations/one/source-runs") return { runs: [], completed: 2 };
    if (path === "locations/one/source-runs/A") return lateTraceA.promise;
    if (path === "locations/one/source-runs/B") return trace("B");
    if (path.startsWith("withdrawals")) return { withdrawals: [] };
    if (path === "health") return { scheduler: { status: "ok", issues: [] }, queue: {}, locations: [] };
    if (path === "locations") return { locations: [] };
    if (path.startsWith("runs?")) return { runs: [] };
    if (path.startsWith("execution")) return { ...policy(), reasons: [], blocker: null };
    if (init?.method === "POST") return {};
    throw new Error(`Unexpected API ${path}`);
  });
  const render = (runId: string | null) => createElement(Fragment, null,
    createElement(Dashboard, { locationId: "one", kind: "map", inspectorOnly: true, runId }),
    createElement(SourceRuns, { locationId: "one", canEdit: false, locations: [], runId }));
  await act(async () => root!.render(render("A")));
  expect(document.getElementById("run-inspector")?.textContent).toContain("Source A");
  await act(async () => { vi.advanceTimersByTime(10_000); });
  expect(aCalls).toBe(2);
  await act(async () => root!.render(render("B")));
  expect(document.getElementById("run-inspector")?.textContent).toContain("Source B");
  expect(document.querySelector(".source-runs")?.textContent).toContain("Finished trace B");
  expect(aSignals.every((signal) => signal?.aborted)).toBe(true);
  await act(async () => { lateA.resolve(detail("A")); lateTraceA.resolve(trace("A")); });
  expect(document.getElementById("run-inspector")?.textContent).toContain("Source B");
  expect(document.querySelector(".source-runs")?.textContent).toContain("Finished trace B");
  expect(document.querySelector(".source-runs")?.textContent).not.toContain("Trace A");
  expect(window.history.replaceState).not.toHaveBeenCalled();
  expect(client.push).not.toHaveBeenCalled();
  const cancel = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Cancel run")!;
  await act(async () => cancel.click());
  expect(client.api).toHaveBeenCalledWith("runs/B/cancel", { method: "POST" });
  expect(client.api).not.toHaveBeenCalledWith("runs/A/cancel", expect.anything());
  const close = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Close")!;
  await act(async () => close.click());
  expect(client.push).toHaveBeenCalledWith("/locations/one?tab=collect-sources", { scroll: false });
  await act(async () => root!.render(render(null)));
  expect(document.getElementById("run-inspector")).toBeNull();
});
it("keys readiness by the selected run and ignores a late old policy response", async () => {
  const document = mountDOM();
  const old = deferred<ExecutionPolicy>();
  const next = { ...policy(), principal: { ...policy().principal, id: "B" } };
  client.api.mockImplementation(async (path) => path === "execution?run=A" ? old.promise : next);
  function Readiness({ runId }: { runId: string }) {
    const { policy: current } = useExecutionPolicy(null, runId);
    return createElement("p", null, current?.principal.id ?? "checking");
  }
  await act(async () => root!.render(createElement(Readiness, { runId: "A" })));
  expect(document.body.textContent).toBe("checking");
  await act(async () => root!.render(createElement(Readiness, { runId: "B" })));
  expect(document.body.textContent).toBe("B");
  await act(async () => old.resolve(policy()));
  expect(document.body.textContent).toBe("B");
  expect(client.api).toHaveBeenCalledWith("execution?run=B", expect.anything());
});
