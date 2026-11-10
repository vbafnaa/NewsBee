import { expect, it } from "vitest";
import { editionPipelineProgress, sourcePipelineProgress, type RunProgressJob } from "../../../app/run-progress";

const job = (kind: string, status: string, result: Record<string, unknown> | null = null): RunProgressJob => ({
  kind, status, attempts: 1, error: null, result,
});

it("tracks source collection, assembly, ranking and story writing as separate run steps", () => {
  const stages = editionPipelineProgress(
    { status: "authoring", stage_transitions: [{ status: "collecting" }, { status: "awaiting_authoring" }, { status: "authoring" }] },
    [
      job("collect_source", "completed"),
      job("author_start", "completed", { sections: ["events", "schools"] }),
      job("author_rank", "completed", { section: "events" }),
      job("author_rank", "running", { section: "schools" }),
    ],
  );

  expect(stages.map(({ status }) => status)).toEqual(["completed", "completed", "in_progress", "pending", "pending"]);
  expect(stages[0].detail).toBe("1/1 source jobs completed");
  expect(stages[2].detail).toBe("1/2 sections ranked");
});

it("shows the manual front-page checkpoint and marks a built edition fully complete", () => {
  const jobs = [
    job("collect_source", "completed"),
    job("author_start", "completed", { sections: ["events"] }),
    job("author_rank", "completed", { section: "events" }),
    job("author_story", "completed", { more: false }),
  ];
  const waiting = editionPipelineProgress({ status: "awaiting_finish", stage_transitions: [{ status: "awaiting_finish" }] }, jobs);
  expect(waiting.map(({ status }) => status)).toEqual(["completed", "completed", "completed", "completed", "waiting"]);
  expect(waiting[4].detail).toBe("Edition front page and email preview");

  const built = editionPipelineProgress({ status: "built" }, [...jobs, job("author_finish", "completed")]);
  expect(built.map(({ status }) => status)).toEqual(["completed", "completed", "completed", "completed", "completed"]);
  expect(built[4].detail).toBe("Edition and email preview saved");
});

it("marks ranking as not needed when assembly finds no story sections", () => {
  const stages = editionPipelineProgress(
    { status: "authoring", stage_transitions: [{ status: "authoring" }] },
    [job("author_start", "completed", { sections: [] })],
  );
  expect(stages[2]).toMatchObject({ status: "skipped", detail: "No sections needed ranking" });
});

it("shows an empty collection as complete and the authoring precondition as failed", () => {
  const stages = editionPipelineProgress(
    { status: "failed", error: "No usable items were collected.", stage_transitions: [{ status: "collecting" }, { status: "awaiting_authoring" }] },
    [job("collect_source", "completed")],
  );
  expect(stages[0].status).toBe("completed");
  expect(stages[1]).toMatchObject({ status: "failed", detail: expect.stringContaining("No usable items were collected.") });
});

it("preserves completed phases when a later story-writing job fails", () => {
  const stages = editionPipelineProgress(
    { status: "failed", stage_transitions: [{ status: "authoring" }] },
    [
      job("collect_source", "completed"),
      job("author_start", "completed", { sections: ["events"] }),
      job("author_rank", "completed", { section: "events" }),
      job("author_story", "failed"),
    ],
  );
  expect(stages.map(({ status }) => status)).toEqual(["completed", "completed", "completed", "failed", "pending"]);
});

it("shows the source map's discovery, optional agent, review and save stages separately", () => {
  const jobs = [job("discover", "completed"), job("agent_round", "completed"), job("review_map", "running")];
  const active = sourcePipelineProgress({ status: "mapping" }, jobs);
  expect(active.map(({ status }) => status)).toEqual(["completed", "completed", "in_progress", "pending"]);
  expect(active[2].detail).toContain("0/1 jobs complete");
  const done = sourcePipelineProgress({ status: "mapped" }, [...jobs.slice(0, 2), job("review_map", "completed"), job("finish_map", "completed")]);
  expect(done.map(({ status }) => status)).toEqual(["completed", "completed", "completed", "completed"]);
  expect(sourcePipelineProgress({ status: "mapped" }, [job("review_map", "completed"), job("finish_map", "completed")])[1].status).toBe("skipped");
});

it("calls out the blocked source-map stage and its job error", () => {
  const stages = sourcePipelineProgress({ status: "failed" }, [job("discover", "completed"), { ...job("review_map", "failed"), error: "Review timed out" }]);
  expect(stages[2]).toMatchObject({ status: "failed", detail: expect.stringContaining("Review timed out") });
});
