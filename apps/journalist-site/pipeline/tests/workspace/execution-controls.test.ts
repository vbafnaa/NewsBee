import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import ExplainedButton from "../../../app/components/explained-button";
import { executionDisabledReason, type ExecutionPolicy } from "../../../app/components/execution-policy";

const policy = (): ExecutionPolicy => ({
  principal: { id: "fixture", email: "fixture@example.test", role: "editor" },
  reasons: ["Source map: Add your own serpapi search credentials."],
  editionReasons: [], mapReasons: ["Add your own serpapi search credentials.", "Enable the agent model budget for agentic work."],
  canStart: false, canStartEdition: true, canStartMap: false, blocker: null,
  permissions: { old: { canSpend: false, canRestart: false, restartReason: "Enable gemini's paid-call budget.", canReconnect: true, canRequestBackup: false, canClaim: false, reason: "API settings changed: explicitly reconnect this run.", paused: "API settings changed." } },
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
  data.blocker = { id: "busy-run", locationId: "other-place", locationName: "Other place", status: "awaiting_authoring", paused: "API version changed" };
  const reason = executionDisabledReason(data, "", "edition");
  expect(reason).toContain("Other place (paused)");
  expect(reason).toContain("/locations/other-place?tab=runs&run=busy-run");
  expect(reason).not.toContain("serpapi");
});
it.each(["Missing model key.", "Approval is pending.", "API settings changed. Request fresh approval.", "Only the original requester may start this plan."])("makes disabled reasons hoverable and keyboard-described: %s", (reason) => {
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
