import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/admin-api", () => ({ adminRoute: vi.fn() }));
import { JobLog } from "../../../app/dashboard";
import { agentJobDetails } from "../../../app/api/admin/runs/[runId]/route";

type Job = Parameters<typeof agentJobDetails>[0];
type State = Parameters<typeof agentJobDetails>[2];

const job = (overrides: Partial<Job> = {}): Job => ({
  _id: "job-one", kind: "agent_round", run_id: "run-one", location_id: "loc-one", dedupe_key: "agent:run-one:0",
  payload: { round: 0 }, status: "completed", attempts: 1, created_at: 90, available_at: 90,
  started_at: 100, completed_at: 200, lease_until: null, claim_token: null, error: null,
  result: { stage: "search" }, log_file: null, log_error: null, ...overrides,
});

it("attributes actual planning and source-check models only to the agent job that called them", () => {
  const calls = [
    { at: 89, role: "agent", provider: "old", model: "other-job" },
    { at: 95, role: "agent", provider: "gemini", model: "previous-attempt" },
    { at: 101, role: "agent", provider: "gemini", model: "flash-lite" },
    { at: 102, role: "agent", provider: "gemini", model: "flash-lite" },
    { at: 104, role: "agent", provider: "openai", model: "fallback" },
    { at: 105, role: "discovery", provider: "gemini", model: "checker" },
    { at: 201, role: "agent", provider: "old", model: "next-job" },
  ];
  const state = { round: { n: 4, stage: "triage" }, steps: [
    { job: 0, step: 3, round: 2, action: "search", tool: "exa", category: "civic", result: "Found a local library" },
    { job: 1, step: 4, round: 3, action: "plan", tool: null, category: null, result: "Next job" },
  ] } as State;
  const details = agentJobDetails(job(), calls, state);
  expect(details).toMatchObject({ pass: 1, steps: 1, round: 2, stage: "search", last_step: { action: "search", result: "Found a local library" } });
  expect(details.models).toEqual([
    { role: "agent", provider: "gemini", model: "previous-attempt" },
    { role: "agent", provider: "gemini", model: "flash-lite" },
    { role: "agent", provider: "openai", model: "fallback" },
    { role: "discovery", provider: "gemini", model: "checker" },
  ]);
  expect(agentJobDetails(job({ status: "running", completed_at: null }), calls, state)).toMatchObject({ round: 4, stage: "triage" });
  expect(agentJobDetails(job({ status: "cancelled", started_at: null, completed_at: 99 }), calls, null)).toMatchObject({ models: [], steps: 0, round: null, last_step: null });
  expect(agentJobDetails(job({ result: { stage: "judge", steps: 7 } }), [], null)).toMatchObject({ models: [], steps: 7, stage: "judge" });
});

it("explains the agent job, its models and latest work even when no text log exists", () => {
  const activity = agentJobDetails(job(), [
    { at: 101, role: "agent", provider: "gemini", model: "flash-lite" },
    { at: 105, role: "discovery", provider: "gemini", model: "checker" },
  ], { round: null, steps: [{ job: 0, step: 3, round: 2, action: "search", tool: "exa", category: "civic", result: "Found a local library" }] } as State);
  const run = { _id: "run-one", kind: "map", location_id: "loc-one" } as Parameters<typeof JobLog>[0]["run"];
  const render = (agent: typeof activity) => parseHTML(renderToStaticMarkup(createElement(JobLog, {
    job: { ...job(), id: "job-one", agent }, run, initiallyOpen: true, busy: false,
  }))).document;
  const document = render(activity);
  const text = document.querySelector(".job-log-entry")!.textContent!;
  expect(text).toContain("Explore additional sources · agent job 1");
  expect(text).toContain("Planning & triage: gemini / flash-lite");
  expect(text).toContain("Source check: gemini / checker");
  expect(text).toContain("round 2 · search");
  expect(text).toContain("Latest step: search · civic · exa — Found a local library");
  expect(document.querySelector('a[href="/source-map?location=loc-one&tab=runs&run=run-one"]')?.textContent).toContain("all agent search steps");
  expect(text).toContain("No log recorded for this job.");
  expect(render(agentJobDetails(job({ status: "cancelled", started_at: null, completed_at: 99 }), [], null)).querySelector(".job-log-entry")?.textContent).toContain("No model calls recorded for this job");
});
