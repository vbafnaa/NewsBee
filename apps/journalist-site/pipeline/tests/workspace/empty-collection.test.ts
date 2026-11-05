import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("keeps the empty state, counts and retry actions wired to the current source workspace", async () => {
  const dashboard = await readFile(new URL("../../../app/dashboard.tsx", import.meta.url), "utf8");
  const health = await readFile(new URL("../../../app/health/health-dashboard.tsx", import.meta.url), "utf8");
  expect(dashboard).toContain("Collection finished");
  expect(dashboard).toContain('action === "authoring" && candidates === 0');
  expect(dashboard).toContain("{row.candidate_count}");
  expect(dashboard).toContain("coverage.gaps.map");
  expect(dashboard).toContain('restartSelected(run, true)');
  expect(dashboard).toContain('if (retryCollection) await api(`runs/${encodeURIComponent(run._id)}/cancel`');
  expect(dashboard).toContain("Review sources</a>");
  expect(dashboard).toContain("/locations/${encodeURIComponent(run.location_id)}?tab=sources");
  expect(dashboard).not.toContain("#pipeline-connectors");
  expect(health).toContain('row.candidate_count === 0');
  expect(health).toContain('row.stage === "awaiting_finish"');
});
