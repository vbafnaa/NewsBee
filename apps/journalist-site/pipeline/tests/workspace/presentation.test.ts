import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import { ExecutionNotice, RunExecutionSummary, type ExecutionPolicy } from "../../../app/components/execution-policy";

const source = (path: string) => readFile(new URL(`../../../app/${path}`, import.meta.url), "utf8");

it("presents source refresh before edition creation and their matching inline approvals", async () => {
  const dashboard = await source("dashboard.tsx");
  const actions = dashboard.slice(dashboard.indexOf('<div className="card-actions">', dashboard.indexOf('className="run-card"')));
  expect(actions.indexOf(">Refresh source map</ExplainedButton>")).toBeGreaterThan(0);
  expect(actions.indexOf('"Create edition"}</ExplainedButton>')).toBeGreaterThan(0);
  expect(actions.indexOf(">Refresh source map</ExplainedButton>")).toBeLessThan(actions.indexOf('"Create edition"}</ExplainedButton>'));
  expect(actions).toContain('map-run`, { method: "POST", body: JSON.stringify({ options: runOptions, rebuild: true })');
  expect(actions).toContain('ingestion`, { method: "POST", body: JSON.stringify({ options: runOptions })');
  expect(actions.indexOf('kind="map"')).toBeLessThan(actions.indexOf('kind="edition"'));
});

it("keeps purpose and mode visible, summarizes hidden settings and leaves relaxed-rule warnings outside disclosures", async () => {
  const panel = await source("components/run-options-panel.tsx");
  const firstDetails = panel.indexOf("<details");
  expect(panel.indexOf('label="Run purpose"')).toBeLessThan(firstDetails);
  expect(panel.indexOf('label="Run mode"')).toBeLessThan(firstDetails);
  expect(panel).not.toMatch(/<details[^>]*\bopen(?:[ =>])/);
  expect(panel).toContain('options.count_history ? "on" : "off"');
  expect(panel).toContain("options.paid[service.id]} calls");
  expect(panel).toContain("options.guardrails_off.length");
  expect(panel).toMatch(/<\/details>\s+\{loosened && <p className="notice" role="status">/);
});

it("retains visible final-run sponsor and Admin eligibility without claiming consumption", () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(RunExecutionSummary, { run: {
    execution: { sponsorId: "editor", initiatedBy: "editor", credentialVersion: 3, source: "personal", purpose: "final", approvalId: "approved", planHash: "plan" },
    trigger: { by: "editor@example.test" },
  } })));
  const summary = document.querySelector('[aria-label="Persisted run funding"]')!;
  expect(summary.closest("details")).toBeNull();
  expect(summary.textContent).toContain("Final");
  expect(summary.textContent).toContain("editor@example.test");
  expect(summary.textContent).toContain("may consume Admin tokens");
  expect(summary.textContent).toContain("Personal models first");
  expect(summary.textContent).toContain("valid approval and an enabled account required");
  expect(summary.textContent).toContain("Eligibility only; inspect funding records for actual use");
});

it("keeps execution blockers and reconnect guidance visible", () => {
  const policy: ExecutionPolicy = {
    principal: { id: "editor", email: "editor@example.test", role: "editor" },
    reasons: ["Add personal model keys."], editionReasons: [], mapReasons: [],
    canStart: false, canStartEdition: false, canStartMap: false,
    blocker: { id: "busy", locationId: "other", locationName: "Other desk", status: "awaiting_finish", paused: null },
    permissions: { busy: { canSpend: false, canRestart: false, restartReason: null, canReconnect: true, canRequestBackup: false, canClaim: false, reason: "API settings changed.", paused: null } },
  };
  const { document } = parseHTML(renderToStaticMarkup(createElement(ExecutionNotice, { policy, runId: "busy" })));
  expect(document.querySelector("details")).toBeNull();
  expect(document.querySelector('[aria-label="Execution access"]')?.textContent).toContain("never tests or training");
  expect(document.querySelector('a[href="/locations/other?tab=runs&run=busy"]')?.textContent).toBe("Other desk");
  expect(document.querySelector("button")?.textContent).toContain("Reconnect this run");
});

it("removes repeated shell hints and location heading without removing navigation or the skip link", async () => {
  const [shell, tabs] = await Promise.all([source("admin-shell.tsx"), source("locations/[locationId]/location-tabs.tsx")]);
  expect(shell).not.toContain("item.hint");
  expect(shell).toContain('aria-label="Workspace navigation"');
  expect(shell).toContain('href="#workspace-content"');
  expect(shell).toContain('aria-current={active(item.id) ? "page" : undefined}');
  expect(tabs).not.toContain("<h2>{name}</h2>");
  expect(tabs).toContain("Manual pauses after collection and writing. Email is not sent.");
});

it("keeps optional inline backup forms collapsed with actionable status in the summary", async () => {
  const approvals = await source("components/pipeline-approvals.tsx");
  expect(approvals).toContain('<details className="location-settings">');
  expect(approvals).toContain("· {status}</summary>");
  expect(approvals).toContain("Approved · ready to start");
  expect(approvals).toContain("Approved · blocked");
  expect(approvals).toContain("Pending owner review");
  expect(approvals).toContain("Stale request · review");
  expect(approvals).toContain("Approval never starts work automatically.");
  expect(approvals).toMatch(/<\/details>\s+\{error && <p role="alert">/);
  expect(approvals).not.toMatch(/<details[^>]*\bopen(?:[ =>])/);
});

it("uses the account's own profile status instead of repeating global readiness and operator instructions", async () => {
  const [shell, account] = await Promise.all([source("admin-shell.tsx"), source("account/settings.tsx")]);
  expect(shell).toContain('principal && page !== "account"');
  expect(account).toContain("Add a model provider to run pipelines; deployment keys are owner-only.");
  expect(account).not.toContain("Set NEWSBEE_OWNER_EMAIL on the server");
  expect(account).toContain("Ask your administrator to complete owner setup");
  expect(account).toContain("Configuration checks only; no provider calls.");
  expect(account).toContain("Blank fields preserve saved keys");
  expect(account).toContain("Revoke disables the entire profile");
});
