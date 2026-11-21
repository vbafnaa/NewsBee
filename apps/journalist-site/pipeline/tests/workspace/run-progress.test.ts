import { expect, it } from "vitest";
import { editionGenerationActivity, editionPipelineProgress, sourcePipelineProgress, type RunProgressJob } from "../../../app/run-progress";
import type { EditionWorkActivity } from "../../publications/generation";

const job = (kind: string, status: string, result: Record<string, unknown> | null = null): RunProgressJob => ({
  kind, status, attempts: 1, error: null, result,
});

const work: EditionWorkActivity = {
  source_checks_completed: 27, story_steps_completed: 9, active: ["Writing a story"],
  last_started_at: 961, last_completed_at: 940,
};

it("summarizes durable edition work without equating writing steps to included stories or an overall total", () => {
  const activity = editionGenerationActivity({ status: "running", children: [
    { status: "authoring", work },
    { status: "built", work: { ...work, active: [], source_checks_completed: 2, story_steps_completed: 3 } },
  ] }, 1000);
  expect(activity).toEqual({ state: "running", text: expect.stringContaining("29 source checks finished; 12 story-writing steps completed") });
  expect(activity.text).toContain("not a count of approved stories");
  expect(activity.text).toContain("Current step: Writing a story");
  expect(activity.text).toContain("Last work confirmed less than a minute ago");
});

it("ages actual work boundaries, not poll/parent freshness, and resumes only with newer work evidence", () => {
  const generation = { status: "running", updated_at: 2000, children: [{ status: "authoring", work: { ...work } }] };
  expect(editionGenerationActivity(generation, 1260).state).toBe("running");
  generation.updated_at = 3000;
  const stale = editionGenerationActivity(generation, 1261);
  expect(stale.state).toBe("waiting");
  expect(stale.text).toContain("Last work confirmed 5 minutes ago");
  expect(stale.text).toContain("Last known step: Writing a story");
  expect(stale.text).toContain("A longer step may still be running");
  generation.children[0].work.last_completed_at = 1250;
  expect(editionGenerationActivity(generation, 1261).state).toBe("running");
});

it("does not claim recent progress for empty, invalid or future work timestamps", () => {
  for (const time of [null, 0, NaN, 2000]) {
    const activity = editionGenerationActivity({ status: "running", children: [{
      status: "authoring", work: { ...work, last_started_at: time, last_completed_at: null },
    }] }, 1000);
    expect(activity.state).toBe("waiting");
    expect(activity.text).toContain("No work activity confirmed yet");
  }
});

it.each(["paused", "blocked", "cancelling", "cancelled", "failed", "ready"])("keeps %s precedence over recent work evidence", (status) => {
  const activity = editionGenerationActivity({ status, children: [{ status: "authoring", work }] }, 1000);
  expect(activity.state).toBe(status === "ready" ? "completed" : status);
  expect(activity.text).not.toContain("Current step");
  expect(activity.text).not.toContain("No recent progress");
  expect(activity.text).toContain("9 story-writing steps completed");
});

it("keeps a child's recovery warning ahead of recently running work", () => {
  const activity = editionGenerationActivity({ status: "running", children: [{
    status: "authoring", work, execution_blocked: { reason: "Internal provider diagnostic" },
  }] }, 1000);
  expect(activity.state).toBe("blocked");
  expect(activity.text).toContain("needs attention - inspect recovery");
  expect(activity.text).not.toContain("Current step");
  expect(activity.text).not.toContain("Internal provider diagnostic");
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
