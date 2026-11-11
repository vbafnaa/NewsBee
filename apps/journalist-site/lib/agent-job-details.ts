import type { AgentState } from "@/pipeline/agent/map-sources";
import type { Job } from "@/pipeline/orchestration/jobs";

export type AgentCall = { at: number; role: string; provider: string; model: string };

export function agentJobDetails(job: Job, calls: AgentCall[], state: Pick<AgentState, "steps" | "round"> | null) {
  const pass = Number(job.payload.round ?? 0);
  const steps = state?.steps.filter((step) => step.job === pass) ?? [];
  const last = steps.at(-1);
  const models = calls.filter((call) => job.started_at != null && call.at >= job.created_at && (job.completed_at == null || call.at <= job.completed_at))
    .sort((a, b) => a.at - b.at)
    .map(({ role, provider, model }) => ({ role, provider, model }))
    .filter((call, index, all) => all.findIndex((other) => other.role === call.role && other.provider === call.provider && other.model === call.model) === index);
  return {
    pass: pass + 1,
    models,
    steps: steps.length || (typeof job.result?.steps === "number" ? job.result.steps : 0),
    round: job.status === "running" ? state?.round?.n ?? last?.round ?? null : last?.round ?? null,
    stage: job.status === "running" ? state?.round?.stage ?? null : typeof job.result?.stage === "string" ? job.result.stage : null,
    last_step: last ? { action: last.action, tool: last.tool, category: last.category, result: last.result.slice(0, 180) } : null,
  };
}
