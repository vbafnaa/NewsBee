import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RunItems from "../../../app/locations/[locationId]/run-items";
import { adminApi } from "../../../lib/admin-client";

vi.mock("../../../lib/admin-client", () => ({ adminApi: vi.fn() }));
vi.mock("../../../app/locations/[locationId]/item-trace", () => ({ default: () => null }));
vi.mock("../../../app/locations/[locationId]/story-review", () => ({ default: () => null }));
vi.mock("../../../app/components/execution-policy", () => ({ useExecutionPolicy: () => ({ policy: null }) }));

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  const { window, document } = parseHTML("<html><body><div id=\"root\"></div></body></html>");
  Object.defineProperty(window, "location", { configurable: true, value: { search: "?run=first" } });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.getElementById("root")!;
  root = createRoot(container);
  vi.mocked(adminApi).mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

function page(path: string) {
  const offset = Number(new URL(path, "https://fixture.test").searchParams.get("offset") ?? 0);
  const count = Math.min(100, 501 - offset);
  return {
    summary: { items: 501, links: 501, repeated_links: 0, repeated_copies: 0, merged_into_stories: 0, repeats_of_printed: 0, title_rejected: 0, by_status: {}, reviewed: { accept: 0, reject: 0 }, truncated: false },
    sources: [], total: 501, offset,
    groups: Array.from({ length: count }, (_, index) => ({
      key: `story:${offset + index}`, item_id: `item:${offset + index}`, title: `Story ${offset + index}`,
      url: null, event_date: null, status: "collected", step: "reader", reason: null, section: null,
      rank: null, score: null, why: null, copies: 1, sources: 1, source_names: [], items: [], replication: null, pre_rank: null, review: null,
    })),
  };
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
  expect(button).toBeDefined();
  await act(async () => { button.click(); });
}

it("reaches the 501st story and can return to the preceding page", async () => {
  vi.mocked(adminApi).mockImplementation(async (path) => page(path));
  await act(async () => root.render(createElement(RunItems, { locationId: "test" })));
  for (let index = 0; index < 5; index++) await click("Next");
  expect(container.textContent).toContain("Story 500");
  expect(container.textContent).toContain("501\u2013501 of 501");
  expect([...container.querySelectorAll("button")].find((item) => item.textContent === "Next")?.disabled).toBe(true);
  expect(vi.mocked(adminApi).mock.calls.at(-1)?.[0]).toContain("offset=500");
  await click("Previous");
  expect(container.textContent).toContain("Story 400");
  expect(container.textContent).not.toContain("Story 500");
});

it("ignores an earlier run's late response after switching runs", async () => {
  let resolveFirst!: (value: ReturnType<typeof page>) => void;
  vi.mocked(adminApi).mockImplementation(async (path) => path.startsWith("runs/first/")
    ? new Promise((resolve) => { resolveFirst = resolve; })
    : { ...page(path), groups: [{ ...page(path).groups[0], title: "Second run story" }] });
  await act(async () => root.render(createElement(RunItems, { locationId: "test" })));
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent("newsbee:inspect-run", { detail: { runId: "second" } }));
  });
  expect(container.textContent).toContain("Second run story");
  await act(async () => { resolveFirst(page("runs/first/pulled")); });
  expect(container.textContent).toContain("Second run story");
  expect(container.textContent).not.toContain("Story 0");
});
