// The Overview's "Edition pipeline" card, derived only from a generation's real child statuses.

export type PipelineChild = { status: string; error?: string | null; execution_blocked?: unknown };
export type PipelineGeneration = {
  status: string;
  progress: { total: number; completed: number; failed: number };
  children: PipelineChild[];
};
export type PipelineStage = { label: string; detail: string; state: "done" | "current" | "waiting" | "failed" };

const STAGES = [
  { label: "Gather local reporting", detail: "Collecting stories from each community's sources" },
  { label: "Draft stories", detail: "Writing and checking each story" },
  { label: "Prepare community drafts", detail: "Finishing each community's draft" },
  { label: "Combine into one edition", detail: "Merging communities into the draft you edit" },
];
const PROBLEM = new Set(["failed", "cancelled", "blocked", "paused", "cancelling", "published"]);

function childStage(status: string): number | null {
  if (status === "collecting") return 0;
  if (status === "awaiting_authoring" || status === "authoring") return 1;
  if (status === "awaiting_finish" || status === "finishing" || status === "publishing") return 2;
  if (status === "built") return 3;
  return null;
}

export const activeGenerationStatuses = new Set(["starting", "running", "combining", "blocked", "paused", "cancelling"]);

export function generationNeedsAttention(generation: PipelineGeneration) {
  return ["failed", "blocked", "paused"].includes(generation.status)
    || generation.children.some((child) => Boolean(child.error || child.execution_blocked) || PROBLEM.has(child.status) && child.status !== "cancelling");
}

/** Which of the four generation stages are done, running, waiting or stuck, and an overall percentage. */
export function editionPipeline(generation: PipelineGeneration): { stages: PipelineStage[]; percent: number } {
  if (generation.status === "ready") {
    return { stages: STAGES.map((stage) => ({ ...stage, state: "done" })), percent: 100 };
  }
  const known = generation.children.map((child) => childStage(child.status)).filter((stage): stage is number => stage !== null);
  const current = generation.status === "starting" || !generation.children.length ? 0
    : generation.status === "combining" ? 3
      : known.length ? Math.min(...known) : 0;
  const stuck = generationNeedsAttention(generation) || ["failed", "cancelled"].includes(generation.status);
  const childScore = generation.children.length
    ? generation.children.reduce((sum, child) => sum + (childStage(child.status) ?? current), 0) / generation.children.length
    : 0;
  const percent = Math.max(0, Math.min(99, Math.round(((generation.status === "combining" ? 3 : childScore) / STAGES.length) * 100)));
  return {
    percent,
    stages: STAGES.map((stage, index) => ({
      ...stage,
      state: index < current ? "done" : index === current ? stuck ? "failed" : "current" : "waiting",
    })),
  };
}
