import { expect, it } from "vitest";
import { healthHistory } from "../../orchestration/health-history";
import { newRun, runs } from "../../orchestration/runs";
import { withMongo } from "../support/mongo";

const mongo = withMongo();
const NOW = Date.parse("2026-10-20T12:00:00Z");

it("aggregates real daily run/story/source outcomes and durations, filtering by location and completion date", async () => {
  const run = newRun({ id: "auburn-wa", name: "Auburn, WA" }, { by: "test", kind: "manual" }, "2026-10-20", ["2026-10-20", "2026-10-26"], [
    { source_id: "library:one", name: "Library", type: "library" },
    { source_id: "meetings:one", name: "Meetings", type: "meetings" },
    { source_id: "trending:one", name: "Trends", type: "trending" },
  ]);
  run.status = "published";
  run.completed_at = NOW / 1000 - 60;
  run.created_at = run.completed_at - 120;
  run.sources = run.sources.map((source, index) => ({ ...source, status: "completed", result_status: ["ingested", "failed", "no_context"][index] }));
  run.published = { items: 4, held: 2, held_reasons: {}, channels: [], artifacts: {} };
  await runs(mongo.db).insertMany([
    run,
    { ...run, _id: "failed-other-town", location_id: "seattle-wa", status: "failed", published: null },
    { ...run, _id: "still-running", status: "authoring", completed_at: null, published: null },
    { ...run, _id: "too-old", completed_at: (NOW - 40 * 86400000) / 1000 },
  ]);
  const all = await healthHistory(mongo.db, 7, null, NOW);
  expect(all.series).toHaveLength(7);
  expect(all.series.at(-1)).toMatchObject({ day: "2026-10-20", completed_runs: 1, failed_runs: 1, published_items: 4, held_items: 2,
    source_ready: 2, source_failed: 2, source_unavailable: 2, average_duration_seconds: 120 });
  const filtered = await healthHistory(mongo.db, 30, "auburn-wa", NOW);
  expect(filtered.series).toHaveLength(30);
  expect(filtered.series.at(-1)).toMatchObject({ completed_runs: 1, failed_runs: 0, source_ready: 1, source_failed: 1, source_unavailable: 1 });
  expect(filtered.series[0]).toMatchObject({ completed_runs: 0, average_duration_seconds: null });
  expect(filtered.timezone).toBe("UTC");
});

it("does not manufacture duration or health history on empty days", async () => {
  const history = await healthHistory(mongo.db, 7, null, NOW);
  expect(history.series[0].day).toBe("2026-10-14");
  expect(history.series.every((day) => day.average_duration_seconds === null && day.completed_runs === 0)).toBe(true);
});
