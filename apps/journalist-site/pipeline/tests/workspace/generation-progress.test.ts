import { act, createElement } from "react";
import { readFile } from "node:fs/promises";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LiveSourceRun from "../../../app/source-map/live-source-run";
import type { LiveDetail } from "../../../app/source-map/source-run-live-log";
import PublicationGeneration from "../../../app/publishing/publication-generation";
import { NewsroomTasks } from "../../../app/newsroom/newsroom-tasks";
import { adminApi } from "../../../lib/admin-client";
import type { EditionWorkActivity } from "../../publications/generation";

vi.mock("../../../lib/admin-client", async (original) => ({
  ...await original<typeof import("../../../lib/admin-client")>(), adminApi: vi.fn(),
}));
vi.mock("../../../app/publishing/publication-editorial-workspace", () => ({ default: () => null }));

let root: Root, container: HTMLElement, url: URL;
let source: LiveDetail, readFails: boolean;
let generation: {
  _id: string; status: string; window: string[]; created_at: number; error: string | null;
  progress: { total: number; completed: number; failed: number };
  children: Array<{ _id: string; location_id: string; location_name: string; status: string; error?: string; execution_blocked?: { reason: string }; work?: EditionWorkActivity }>;
};

beforeEach(() => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  url = new URL("https://fixture.test/newsroom/assigned#generation-activity");
  Object.defineProperty(window, "location", { configurable: true, get: () => url });
  Object.defineProperty(window, "history", { configurable: true, value: {
    state: null,
    pushState: (_state: unknown, _title: string, next: string) => { url = new URL(next, url); },
    replaceState: (_state: unknown, _title: string, next: string) => { url = new URL(next, url); },
  } });
  window.requestAnimationFrame = (callback) => { callback(0); return 0; };
  window.cancelAnimationFrame = vi.fn();
  vi.stubGlobal("window", window);
  vi.stubGlobal("self", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network/provider request"); }));
  vi.useFakeTimers();
  root = createRoot(document.getElementById("root")!);
  container = document.getElementById("root")!;
  readFails = false;
  source = {
    run: { status: "mapping", created_at: 1, completed_at: null, error: null, trigger: { kind: "manual", by: "operator" } },
    jobs: [], health: {},
  };
  generation = {
    _id: "parent", status: "running", window: ["2026-11-18", "2026-11-24"], created_at: 1, error: null,
    progress: { total: 2, completed: 1, failed: 0 },
    children: [
      { _id: "north-run", location_id: "north", location_name: "North", status: "built" },
      { _id: "south-run", location_id: "south", location_name: "South", status: "authoring" },
    ],
  };
  vi.mocked(adminApi).mockReset();
  vi.mocked(adminApi).mockImplementation(async (path, init) => {
    if (init?.method && init.method !== "GET") throw new Error("Unexpected submission");
    if (readFails) throw new Error("Status store unavailable");
    if (path === "runs/map-run") return structuredClone(source);
    if (path.includes("/generation-preflight")) return {
      remaining: 20, exhausted: false, reasons: [], admission: { available: true, detail: null },
    };
    if (path.includes("/coverage-requests")) return { locations: [], request: null, request_href: "/operations" };
    if (path.startsWith("publications/assigned/generations")) return {
      publication: { id: "assigned", name: "Weekly", role: "editor", canWrite: true },
      limits: { maxLocations: 3 }, locations: [],
      generations: [structuredClone(generation)], draft: null, drafts: [], draftsNextCursor: null,
      defaultOptions: { flow: "current", mode: "autopilot" },
    };
    throw new Error(`Unexpected request: ${path}`);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(vi.mocked(adminApi).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function renderSource() {
  await act(async () => root.render(createElement(LiveSourceRun, { runId: "map-run" })));
}
async function renderEdition(operator = false) {
  await act(async () => root.render(createElement(NewsroomTasks, { workspace: "/newsroom/assigned" },
    createElement(PublicationGeneration, {
      publicationId: "assigned", publicationName: "Weekly", publicationEnabled: true,
      supportMode: false, operator, generationAnchorId: "editions", reportingAnchorId: "reporting",
    }))));
}
function bar(label: string) {
  const element = container.querySelector(`[role="progressbar"][aria-label="${label}"]`);
  expect(element).not.toBeNull();
  return element!;
}
function expectProgress(label: string, state: string, text: string) {
  const element = bar(label);
  expect(element.parentElement?.getAttribute("data-state")).toBe(state);
  expect(element.getAttribute("aria-valuetext")).toContain(text);
  expect(element.parentElement?.querySelector('[role="status"]')?.textContent).toContain(text);
  expect(document.getElementById(element.getAttribute("aria-describedby")!)?.textContent).toContain(text);
  expect(element.getAttribute("aria-valuenow")).toBe(state === "completed" ? "100" : null);
}

it("renders queued source mapping without invented totals, then follows the existing poll into review and completion", async () => {
  await renderSource();
  expectProgress("Generate source map", "queued", "Waiting for source-map work");
  const reads = vi.mocked(adminApi).mock.calls.length;
  source.jobs = [{
    id: "review", kind: "review_map", status: "running", attempts: 1,
    created_at: 1, started_at: 1, completed_at: null, error: null, log_file: null, log_error: null,
  }];
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expectProgress("Generate source map", "running", "Reviewing sources");
  expect(vi.mocked(adminApi).mock.calls.length).toBe(reads + 1);
  source.jobs[0].status = "completed";
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expectProgress("Generate source map", "queued", "Waiting for source-map work");
  source.run.status = "mapped";
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expectProgress("Generate source map", "completed", "Source map complete");
  expect(container.querySelector(".source-live-log")).not.toBeNull();
});

it.each([
  ["discover", "Finding and checking sources"],
  ["agent_round", "Exploring additional sources"],
  ["finish_map", "Saving source addresses"],
])("labels active %s source jobs without treating job counts as overall progress", async (kind, text) => {
  source.jobs = [{
    id: "job", kind, status: "running", attempts: 1,
    created_at: 1, started_at: 1, completed_at: null, error: null, log_file: null, log_error: null,
  }];
  await renderSource();
  expectProgress("Generate source map", "running", text);
});

it.each(["failed", "paused", "blocked", "cancelling", "cancelled"])("keeps a %s source run stopped even with a running job", async (status) => {
  source.run.status = status;
  source.jobs = [{
    id: "job", kind: "discover", status: "running", attempts: 1,
    created_at: 1, started_at: 1, completed_at: null, error: null, log_file: null, log_error: null,
  }];
  await renderSource();
  expectProgress("Generate source map", status, status[0].toUpperCase() + status.slice(1));
});

it.each(["execution", "diagnostics"])("stops a mapping bar on %s blockers", async (kind) => {
  if (kind === "execution") source.run.execution_blocked = { reason: "Credential authorization required", at: 1 };
  else source.health.diagnostics = { issues: [{ severity: "failed", message: "Worker unavailable" }] };
  await renderSource();
  expectProgress("Generate source map", "blocked", "Blocked");
});

it("preserves last-confirmed source state, stops motion on read failure and recovers without new polling", async () => {
  source.jobs = [{
    id: "job", kind: "discover", status: "pending", attempts: 0,
    created_at: 1, started_at: null, completed_at: null, error: null, log_file: null, log_error: null,
  }];
  await renderSource();
  expectProgress("Generate source map", "queued", "Queued - finding");
  readFails = true;
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expectProgress("Generate source map", "unknown", "Last confirmed: Queued - finding");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Status store unavailable");
  readFails = false;
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expectProgress("Generate source map", "queued", "Queued - finding");
});

it("renders partial child completion, combining and parent completion without inventing overall percentages", async () => {
  await renderEdition();
  expectProgress("Generate edition", "running", "Writing stories");
  expect(container.querySelector(".generation-progress")?.textContent).toContain("1 of 2 community drafts ready");
  generation.children[1].status = "built";
  generation.progress.completed = 2;
  const reads = vi.mocked(adminApi).mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expectProgress("Generate edition", "waiting", "Waiting for the combined edition");
  expect(vi.mocked(adminApi).mock.calls.length).toBe(reads + 1);
  generation.status = "combining";
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expectProgress("Generate edition", "running", "Combining community drafts");
  generation.status = "ready";
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expectProgress("Generate edition", "completed", "Edition draft ready");
});

it.each(["starting", "paused", "blocked", "cancelling", "cancelled", "failed"])("renders a %s parent distinctly, never as completed children", async (status) => {
  generation.status = status;
  generation.children.forEach((child) => { child.status = "built"; });
  generation.progress.completed = 2;
  await renderEdition();
  expectProgress("Generate edition", status === "starting" ? "queued" : status, status === "starting" ? "Queued" : status[0].toUpperCase() + status.slice(1));
  expect(container.querySelector(".generation-recovery")).not.toBeNull();
});

it.each(["awaiting_authoring", "awaiting_finish", "failed", "paused", "cancelled", "published", "unrecognized"])("does not animate past a %s community checkpoint or problem", async (status) => {
  generation.children[1].status = status;
  generation.progress.total = 0;
  await renderEdition();
  const state = status.startsWith("awaiting") ? "waiting" : status === "paused" ? "paused"
    : status === "unrecognized" ? "unknown" : "blocked";
  expectProgress("Generate edition", state, status.startsWith("awaiting") ? "checkpoint" : status === "paused" ? "paused"
    : status === "unrecognized" ? "unavailable" : "needs attention");
});

it("keeps publication polling failures visible in activity with last-confirmed state and existing recovery controls", async () => {
  await renderEdition();
  readFails = true;
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expectProgress("Generate edition", "unknown", "Last confirmed: Writing stories");
  expect(container.querySelector('.generation-recovery [role="alert"]')?.textContent).toContain("Edition status couldn't be refreshed");
  expect(container.textContent).not.toContain("Status store unavailable");
  expect(container.querySelector(".generation-recovery")?.textContent).toContain("Cancel this generation");
  readFails = false;
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expectProgress("Generate edition", "running", "Writing stories");
});

it("shows the compact active progress beside the activity link on Editions without changing the generation target", async () => {
  url.hash = "#editions";
  await renderEdition();
  const notice = container.querySelector('.jw-active-generation > .job-progress');
  expect(notice?.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe("Generate edition");
  expect(notice?.parentElement?.querySelector("a")?.getAttribute("href")).toBe("/newsroom/assigned/generation");
  expect(url.searchParams.get("generation")).toBeNull();
});

it("updates confirmed work through the existing edition poll, ages unchanged evidence, and retains it on failed reads", async () => {
  const now = Math.floor(Date.now() / 1000);
  generation.children[1].work = {
    source_checks_completed: 27, story_steps_completed: 9, active: ["Writing a story"],
    last_started_at: now - 39, last_completed_at: now - 60,
  };
  await renderEdition();
  expectProgress("Generate edition", "running", "27 source checks finished; 9 story-writing steps completed");
  expect(bar("Generate edition").getAttribute("aria-valuetext")).toContain("Current step: Writing a story");
  const work = generation.children[1].work;
  work.story_steps_completed = 10;
  work.last_completed_at = now;
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expectProgress("Generate edition", "running", "10 story-writing steps completed");
  expect(container.textContent).toContain("1 of 2 community drafts ready");
  vi.setSystemTime((now + 360) * 1000);
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expectProgress("Generate edition", "waiting", "No recent progress confirmed");
  expect(bar("Generate edition").getAttribute("aria-valuetext")).toContain("Last work confirmed 6 minutes ago");
  expect(bar("Generate edition").getAttribute("aria-valuetext")).not.toContain("Current step");
  readFails = true;
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expectProgress("Generate edition", "unknown", "Last confirmed: Writing stories");
  expect(bar("Generate edition").getAttribute("aria-valuetext")).toContain("10 story-writing steps completed");
  expect(container.textContent).toContain("Cancel this generation");
  readFails = false;
  work.last_started_at = Date.now() / 1000;
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expectProgress("Generate edition", "running", "Last work confirmed less than a minute ago");
  expect(bar("Generate edition").getAttribute("aria-valuenow")).toBeNull();
});

it.each(["editions", "generation-activity"])("shows useful work evidence on %s without technical output or new endpoints", async (tab) => {
  url.hash = `#${tab}`;
  generation.children[1].work = {
    source_checks_completed: 27, story_steps_completed: 9, active: ["Writing a story"],
    last_started_at: Date.now() / 1000 - 39, last_completed_at: null,
  };
  await renderEdition();
  const progress = tab === "editions" ? container.querySelector(".jw-active-generation > .job-progress")
    : container.querySelector(".generation-progress > .job-progress");
  expect(progress?.textContent).toContain("27 source checks finished; 9 story-writing steps completed");
  expect(progress?.textContent).toContain("not a count of approved stories");
  expect(progress?.textContent).not.toMatch(/author_story|collect_source|south-run|north-run/);
  expect(vi.mocked(adminApi).mock.calls.every(([path]) => path.startsWith("publications/assigned/"))).toBe(true);
});

it.each(["running", "blocked", "paused", "failed", "cancelling", "cancelled"])("keeps %s Journalist progress plain-language without technical output or hiding recovery", async (status) => {
  const raw = "Error: INTERNAL_JOB_STREAM run-id-technical at Worker.dispatch (worker.ts:42)";
  generation._id = "technical-parent-id";
  generation.status = status;
  generation.error = raw;
  generation.children[1].error = raw;
  generation.children[1].execution_blocked = { reason: raw };
  await renderEdition();
  const activity = container.querySelector(".generation-recovery")!;
  expect(activity.textContent).toContain("Generation needs attention");
  expect(activity.textContent).toContain("Completed community drafts are saved");
  expect(activity.textContent).toContain("This community needs attention");
  expect(activity.textContent).not.toContain(raw);
  expect(activity.textContent).not.toContain("technical");
  expect(activity.querySelector("pre, code, .job-log-list, .source-live-log")).toBeNull();
  expect([...activity.querySelectorAll("a")].some((link) => /\/runs\/|\/jobs\/|log/i.test(link.href))).toBe(false);
  expect(bar("Generate edition").getAttribute("aria-valuetext")).not.toContain(raw);
  if (["blocked", "paused", "failed"].includes(status)) {
    expect(activity.textContent).toContain("Authorize resume");
    expect(activity.textContent).toContain("Retry missing/failed work only");
  }
  if (status !== "cancelled") expect(activity.textContent).toContain(status === "cancelling" ? "Waiting for executing work to settle" : "Cancel this generation");
});

it("retains diagnostic details for an operator with an editor publication membership", async () => {
  generation.status = "blocked";
  generation.error = "Operator diagnostic: run-id-technical failed in worker.ts:42";
  generation.children[1].execution_blocked = { reason: "Operator-only worker failure details" };
  await renderEdition(true);
  const activity = container.querySelector(".generation-recovery")!;
  expect(activity.textContent).toContain(generation.error);
  expect(activity.textContent).toContain("Operator-only worker failure details");
  expect(activity.querySelector("option")?.textContent).toContain(generation._id);
  readFails = true;
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(activity.textContent).toContain("Status store unavailable");
});

it("retains the legitimate operator source-map live log while generation presentation changes", async () => {
  source.run.status = "failed";
  source.run.error = "Operator-only diagnostic at source-worker.ts:42 (source-run-id)";
  await renderSource();
  expect(container.querySelector(".source-live-log")?.textContent).toContain(source.run.error);
  expectProgress("Generate source map", "failed", "Failed");
});

it("keeps motion CSS scoped to active progress and supplies an equally specific reduced-motion override", async () => {
  const css = await readFile(new URL("../../../app/styles.css", import.meta.url), "utf8");
  const rules = css.match(/[^{}]+\{[^{}]*\banimation:\s*job-progress-travel[^{}]*\}/g);
  expect(rules).toHaveLength(1);
  expect(rules![0]).toContain('.job-progress[data-state="running"] .job-progress-fill');
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.job-progress\[data-state\] \.job-progress-fill\s*\{[^}]*animation: none;[^}]*transition: none;/);
  expect(css).toMatch(/\.job-progress-status\s*\{[^}]*overflow-wrap: anywhere;/);
});
