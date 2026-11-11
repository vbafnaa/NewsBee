export type MapStage = "review" | "save";

export function mapJobIsPast(kind: string, jobs: { kind: string }[]): boolean {
  return jobs.some((later) =>
    (["discover", "agent_round"].includes(kind) && ["review_map", "finish_map"].includes(later.kind))
    || (kind === "review_map" && later.kind === "finish_map"));
}

export function availableMapStages(run: { kind?: string; status: string; stage_transitions?: { status: string }[] }, jobs: { kind: string; status: string }[]): MapStage[] {
  if (run.kind !== "map" || run.status !== "failed" || !run.stage_transitions?.some((entry) => entry.status === "mapping")) return [];
  const reviews = jobs.filter((job) => job.kind === "review_map");
  const saves = jobs.filter((job) => job.kind === "finish_map");
  if (jobs.some((job) => job.status === "running")) return [];
  if (!reviews.length && !saves.length) return ["review"];
  if (reviews.length && reviews.every((job) => ["completed", "failed", "cancelled"].includes(job.status))
    && !saves.some((job) => job.status === "completed")
    && saves.every((job) => ["failed", "cancelled"].includes(job.status))) return ["save"];
  return [];
}
