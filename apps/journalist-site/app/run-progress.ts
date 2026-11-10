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
