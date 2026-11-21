import type { EditionWorkActivity } from "@/pipeline/publications/generation";

export type RunProgressJob = {
  kind: string;
  status: string;
  attempts: number;
  payload?: Record<string, unknown>;
  error?: string | null;
  result?: Record<string, unknown> | null;
  started_at?: number | null;
  completed_at?: number | null;
};

export type RunProgressStage = {
  id: string;
  label: string;
  status: "completed" | "in_progress" | "waiting" | "pending" | "failed" | "cancelled" | "skipped";
  detail: string;
};

type RunProgress = { status: string; error?: string | null; stage_transitions?: Array<{ status: string }> };

export type JobActivity = {
  state: "queued" | "running" | "waiting" | "paused" | "blocked" | "cancelling" | "cancelled" | "failed" | "completed" | "unknown";
  text: string;
};

const stoppedActivity = (status: string): JobActivity | null => {
  switch (status) {
    case "paused": return { state: "paused", text: "Paused" };
    case "blocked": return { state: "blocked", text: "Blocked - needs attention" };
    case "cancelling": return { state: "cancelling", text: "Cancelling - waiting for executing work to settle" };
    case "cancelled": return { state: "cancelled", text: "Cancelled" };
    case "failed": return { state: "failed", text: "Failed - needs attention" };
    default: return null;
  }
};

type ActivityRun = { status: string; execution_blocked?: { reason: string } };

export function sourceMapActivity(run: ActivityRun, jobs: Pick<RunProgressJob, "kind" | "status">[],
  diagnostics?: { issues: Array<{ severity: string }> } | null): JobActivity {
  const stopped = stoppedActivity(run.status);
  if (stopped) return stopped;
  if (run.status === "mapped") return { state: "completed", text: "Source map complete" };
  if (run.execution_blocked || diagnostics?.issues.some((issue) => issue.severity === "failed"))
    return { state: "blocked", text: "Blocked - inspect the run log" };
  if (run.status !== "mapping") return { state: "unknown", text: "Source-map status unavailable" };
  const current = jobs.find((job) => job.status === "running") ?? jobs.find((job) => job.status === "pending");
  if (!current && jobs.some((job) => job.status === "failed"))
    return { state: "blocked", text: "Source-map work failed - inspect recovery" };
  if (!current) return { state: "queued", text: "Waiting for source-map work to be scheduled" };
  const stage = ({
    discover: "Finding and checking sources", agent_round: "Exploring additional sources",
    review_map: "Reviewing sources", finish_map: "Saving source addresses",
  } as Record<string, string>)[current.kind] ?? "Collecting sources";
  return current.status === "running" ? { state: "running", text: stage }
    : { state: "queued", text: `Queued - ${stage.toLowerCase()}` };
}

type EditionActivity = { status: string; children: Array<ActivityRun & { work?: EditionWorkActivity }> };

export function editionGenerationActivity(generation: EditionActivity, now = Date.now() / 1000): JobActivity {
  const stage = editionGenerationStage(generation);
  const work = generation.children.flatMap((child) => child.work ? [child.work] : []);
  if (!work.length) return stage;
  const sourceChecks = work.reduce((sum, item) => sum + item.source_checks_completed, 0);
  const storySteps = work.reduce((sum, item) => sum + item.story_steps_completed, 0);
  const counts = `${sourceChecks} source check${sourceChecks === 1 ? "" : "s"} finished; ${storySteps} story-writing step${storySteps === 1 ? "" : "s"} completed (not a count of approved stories).`;
  const times = work.flatMap((item) => [item.last_started_at, item.last_completed_at])
    .filter((time): time is number => time !== null && Number.isFinite(time) && time > 0 && time <= now);
  const lastActivity = times.length ? Math.max(...times) : null;
  const elapsed = lastActivity === null ? null : Math.floor((now - lastActivity) / 60);
  const recent = elapsed === null ? "No work activity confirmed yet."
    : elapsed < 1 ? "Last work confirmed less than a minute ago."
      : `Last work confirmed ${elapsed} minute${elapsed === 1 ? "" : "s"} ago.`;
  const canAdvance = ["running", "queued"].includes(stage.state);
  const active = [...new Set(work.flatMap((item) => item.active))].sort();
  const unconfirmed = canAdvance && (elapsed === null || elapsed >= 5);
  const current = canAdvance && active.length ? `${unconfirmed ? "Last known step" : "Current step"}: ${active.join("; ")}.` : "";
  return {
    state: unconfirmed ? "waiting" : stage.state,
    text: [`${stage.text}.`, counts, current, recent,
      unconfirmed ? "No recent progress confirmed. A longer step may still be running; inspect activity and recovery if this continues." : ""]
      .filter(Boolean).join(" "),
  };
}

function editionGenerationStage(generation: EditionActivity): JobActivity {
  const stopped = stoppedActivity(generation.status);
  if (stopped) return stopped;
  if (generation.status === "ready") return { state: "completed", text: "Edition draft ready" };
  if (!["starting", "running", "combining"].includes(generation.status))
    return { state: "unknown", text: "Generation status unavailable" };
  const children = generation.children;
  if (children.some((child) => child.execution_blocked || ["failed", "cancelled", "blocked", "published"].includes(child.status)))
    return { state: "blocked", text: "Community work needs attention - inspect recovery" };
  if (children.some((child) => child.status === "paused")) return { state: "paused", text: "Community work paused" };
  if (children.some((child) => child.status === "cancelling"))
    return { state: "cancelling", text: "Community work cancelling" };
  if (generation.status === "starting") return { state: "queued", text: "Queued - preparing community runs" };
  if (generation.status === "combining") return { state: "running", text: "Combining community drafts" };
  const unfinished = children.filter((child) => child.status !== "built");
  if (!unfinished.length) return { state: "waiting", text: "Waiting for the combined edition draft" };
  if (unfinished.every((child) => ["awaiting_authoring", "awaiting_finish"].includes(child.status)))
    return { state: "waiting", text: "Waiting at a community stage checkpoint" };
  const stages = new Set(unfinished.map((child) => child.status));
  if (unfinished.some((child) => !["collecting", "awaiting_authoring", "authoring", "awaiting_finish", "finishing", "publishing"].includes(child.status)))
    return { state: "unknown", text: "Community stage unavailable - inspect activity" };
  if (stages.size > 1) return { state: "running", text: "Preparing community drafts - multiple stages" };
  switch (unfinished[0].status) {
    case "collecting": return { state: "running", text: "Gathering local reporting" };
    case "authoring": return { state: "running", text: "Writing stories" };
    case "finishing": case "publishing": return { state: "running", text: "Preparing community drafts" };
    default: return { state: "unknown", text: "Community stage unavailable - inspect activity" };
  }
}

/** Source-map runs use different durable jobs from story collection. */
export function sourcePipelineProgress(run: RunProgress, jobs: RunProgressJob[]): RunProgressStage[] {
  const groups = [
    { id: "discover", label: "Discover and check sources", kinds: ["discover"] },
    { id: "agent", label: "Explore additional sources", kinds: ["agent_round"] },
    { id: "review", label: "Review and deduplicate sources", kinds: ["review_map"] },
    { id: "save", label: "Save source addresses", kinds: ["finish_map"] },
  ];
  const finished = run.status === "mapped";
  const failedJob = [...jobs].reverse().find((job) => job.status === "failed");
  const activeJob = jobs.find((job) => job.status === "running");
  return groups.map((group, index) => {
    const own = jobs.filter((job) => group.kinds.includes(job.kind));
    const completed = own.filter((job) => job.status === "completed").length;
    const skipped = !own.length && (finished || groups.slice(index + 1).some((later) => jobs.some((job) => later.kinds.includes(job.kind))));
    const status: RunProgressStage["status"] = own.some((job) => job.status === "failed") ? "failed"
      : own.some((job) => job.status === "running") ? "in_progress"
        : own.some((job) => job.status === "pending") ? "pending"
          : skipped ? "skipped" : (own.length > 0 && completed === own.length) || finished ? "completed"
            : run.status === "cancelled" && jobs.at(-1)?.kind === group.kinds[0] ? "cancelled" : "pending";
    const error = failedJob && group.kinds.includes(failedJob.kind) ? failedJob.error : null;
    const detail = own.length ? `${completed}/${own.length} jobs complete${error ? ` · ${error}` : ""}`
      : skipped ? "Not needed for this run" : activeJob ? `Waiting for ${activeJob.kind.replaceAll("_", " ")}` : "Waiting to start";
    return { id: group.id, label: group.label, status, detail };
  });
}

const AFTER_COLLECTION = ["awaiting_authoring", "authoring", "awaiting_finish", "finishing", "publishing", "built", "published"];
const AFTER_AUTHORING = ["awaiting_finish", "finishing", "publishing", "built", "published"];
const PROCESSING = ["collecting", "authoring", "finishing", "publishing"];

/** Present the durable source and authoring jobs as the edition's user-facing pipeline. */
export function editionPipelineProgress(run: RunProgress, jobs: RunProgressJob[]): RunProgressStage[] {
  const jobsOf = (kinds: string[]) => jobs.filter((job) => kinds.includes(job.kind));
  const lastProcessingStage = run.stage_transitions?.map((transition) => transition.status).filter((status) => PROCESSING.includes(status)).at(-1);
  const transitions = new Set(run.stage_transitions?.map((transition) => transition.status) ?? []);
  const completedEdition = ["built", "published"].includes(run.status);
  const reachedAuthoring = ["authoring", ...AFTER_AUTHORING].includes(run.status)
    || transitions.has("authoring") || transitions.has("awaiting_finish");
  const collectionJobs = jobsOf(["collect_source"]);
  const authorStart = jobsOf(["author_start"]).at(-1);
  const rankJobs = jobsOf(["author_rank"]);
  const storyJobs = jobsOf(["author_story"]);
  const finishJobs = jobsOf(["author_finish"]);
  const expectedSections = Array.isArray(authorStart?.result?.sections) ? authorStart.result.sections.length : null;
  const completedRanks = rankJobs.filter((job) => job.status === "completed").length;
  const rankingComplete = expectedSections !== null && completedRanks >= expectedSections;
  const failedAuthorJob = [...jobs].reverse().find((job) =>
    ["author_start", "author_rank", "author_story"].includes(job.kind) && job.status === "failed");
  const collectionDone = AFTER_COLLECTION.includes(run.status)
    || transitions.has("awaiting_authoring") || reachedAuthoring;
  const collectionStatus: RunProgressStage["status"] = collectionDone ? "completed"
    : run.status === "collecting" ? "in_progress"
      : run.status === "failed" && lastProcessingStage === "collecting" ? "failed"
        : run.status === "cancelled" && lastProcessingStage === "collecting" ? "cancelled" : "pending";

  const collectionProducedNoCandidates = run.status === "failed" && transitions.has("awaiting_authoring") && !authorStart;
  const assemblyStatus: RunProgressStage["status"] = authorStart?.status === "completed" || completedEdition || AFTER_AUTHORING.includes(run.status) || transitions.has("awaiting_finish") ? "completed"
    : run.status === "awaiting_authoring" ? "waiting"
      : run.status === "authoring" ? authorStart?.status === "completed" ? "completed" : "in_progress"
        : run.status === "failed" && (collectionProducedNoCandidates || failedAuthorJob?.kind === "author_start" || (lastProcessingStage === "authoring" && !failedAuthorJob)) ? "failed"
          : run.status === "cancelled" && lastProcessingStage === "authoring" && !authorStart?.status ? "cancelled" : "pending";

  let rankingStatus: RunProgressStage["status"];
  if (expectedSections === 0 && authorStart?.status === "completed") rankingStatus = "skipped";
  else if (rankingComplete) rankingStatus = "completed";
  else if (completedEdition || AFTER_AUTHORING.includes(run.status) || transitions.has("awaiting_finish")) rankingStatus = "completed";
  else if (run.status === "awaiting_authoring") rankingStatus = "pending";
  else if (run.status === "authoring" && authorStart?.status === "completed") rankingStatus = "in_progress";
  else if (run.status === "failed" && (failedAuthorJob?.kind === "author_rank" || (lastProcessingStage === "authoring" && authorStart?.status === "completed" && !storyJobs.length))) rankingStatus = "failed";
  else if (run.status === "cancelled" && lastProcessingStage === "authoring" && authorStart?.status === "completed" && !storyJobs.length) rankingStatus = "cancelled";
  else rankingStatus = "pending";
  const storiesDone = storyJobs.filter((job) => job.status === "completed").length;
  const lastStory = storyJobs.at(-1);
  let writingStatus: RunProgressStage["status"];
  if (completedEdition || AFTER_AUTHORING.includes(run.status) || transitions.has("awaiting_finish")
    || lastStory?.status === "completed" && lastStory.result?.more === false) writingStatus = "completed";
  else if (run.status === "authoring" && rankingStatus === "completed") writingStatus = "in_progress";
  else if (run.status === "failed" && failedAuthorJob?.kind === "author_story") writingStatus = "failed";
  else if (run.status === "cancelled" && lastProcessingStage === "authoring" && rankingStatus === "completed") writingStatus = "cancelled";
  else writingStatus = "pending";

  let finishingStatus: RunProgressStage["status"];
  if (completedEdition) finishingStatus = "completed";
  else if (run.status === "awaiting_finish") finishingStatus = "waiting";
  else if (["finishing", "publishing"].includes(run.status)) finishingStatus = "in_progress";
  else if (run.status === "failed" && ["finishing", "publishing"].includes(lastProcessingStage ?? "")) finishingStatus = "failed";
  else if (run.status === "cancelled" && ["finishing", "publishing"].includes(lastProcessingStage ?? "")) finishingStatus = "cancelled";
  else finishingStatus = "pending";

  const collectionCompleted = collectionJobs.filter((job) => job.status === "completed").length;
  const collectionDetail = collectionJobs.length
    ? `${collectionCompleted}/${collectionJobs.length} source jobs completed`
    : collectionDone ? "No source jobs recorded" : "Waiting for source planning";
  const rankDetail = expectedSections === null
    ? `${completedRanks} section jobs completed`
    : expectedSections === 0 ? "No sections needed ranking" : `${completedRanks}/${expectedSections} sections ranked`;
  const storyDetail = storyJobs.length ? `${storiesDone} story jobs completed` : "Story-writing jobs not started";
  const finishDetail = finishJobs.some((job) => job.status === "completed") || completedEdition
    ? "Edition and email preview saved"
    : "Edition front page and email preview";

  const stages: RunProgressStage[] = [
    { id: "collect", label: "Collect source items", status: collectionStatus, detail: collectionDetail },
    { id: "assemble", label: "Filter, merge and assemble", status: assemblyStatus, detail: "Locality, duplicates, repeat ledger and story sections" },
    { id: "rank", label: "Enrich and rank candidates", status: rankingStatus, detail: rankDetail },
    { id: "write", label: "Extract details and write stories", status: writingStatus, detail: storyDetail },
    { id: "finish", label: "Build edition front page and email", status: finishingStatus, detail: finishDetail },
  ];
  if (run.status === "failed" && run.error) {
    const failedStage = stages.find((stage) => stage.status === "failed");
    if (failedStage) failedStage.detail = `${failedStage.detail} · ${run.error}`;
  }
  return stages;
}
