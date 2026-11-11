import { adminRoute } from "@/lib/admin-api";
import { methodDefinition } from "@/pipeline/discovery/methods";
import { AGENT_STATE, type AgentState } from "@/pipeline/agent/map-sources";
import type { Job } from "@/pipeline/orchestration/jobs";
import { expireOverdueRuns } from "@/pipeline/orchestration/diagnostics";
import { locationHealth } from "@/pipeline/orchestration/health";
import { runJobs } from "@/pipeline/orchestration/jobs";
import { getRun } from "@/pipeline/orchestration/runs";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

type Context = { params: Promise<{ runId: string }> };
type AgentCall = { at: number; role: string; provider: string; model: string };

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

/** One line on why a story ranked where it did (ranking v5 explain record). */
function rankingWhy(ranking: { category?: string; explain?: { base: number; engagement: { multiplier: number; views: number }; rerank: { position: number | null; bonus: number }; diversity_penalty: number; final: number } } | undefined) {
  const explain = ranking?.explain;
  if (!explain) return ranking?.category ?? null;
  const parts = [`${ranking?.category ?? "other"}: rating ${explain.base}`];
  if (explain.engagement.multiplier !== 1) parts.push(`readers ×${explain.engagement.multiplier}${explain.engagement.views ? ` (${explain.engagement.views} views)` : " (exploring)"}`);
  if (explain.rerank.position) parts.push(`editor #${explain.rerank.position} +${explain.rerank.bonus}`);
  if (explain.diversity_penalty) parts.push(`variety −${explain.diversity_penalty}`);
  return `${parts.join(", ")} → ${explain.final}`;
}

/** One run in detail: every source, every job, and every story (held ones with their reasons). */
export async function GET(request: Request, context: Context) {
  const { runId } = await context.params;
  return adminRoute(request, async ({ db, settings }) => {
    await expireOverdueRuns(db, settings.runTimeoutSeconds);
    const run = await getRun(db, runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const entries = run.draft_id
      ? await db.collection(COLLECTIONS.editionEntries)
        .find({ edition_id: run.draft_id }, { projection: { _id: 0, story_id: 1, source_id: 1, tier: 1, position: 1, disposition: 1, result: 1 } })
        .sort({ position: 1 })
        .toArray()
      : [];
    const stories = entries.map((entry) => ({
      story_id: entry.story_id,
      source_id: entry.source_id,
      tier: entry.tier,
      disposition: entry.disposition,
      title: entry.result?.story?.title ?? null,
      draft: entry.result?.draft ?? null,
      source_brief: Boolean(entry.result?.source_brief),
      when_where: entry.result?.when_where ?? null,
      sources: entry.result?.sources ?? (entry.result?.story?.occurrences ?? []).map((source: { source_name?: string; source_url?: string }) => ({ name: source.source_name ?? "Original source", url: source.source_url ?? null })),
      rank: entry.result?.ranking?.rank ?? null,
      why: rankingWhy(entry.result?.ranking),
      reasons: entry.disposition === "held"
        ? (entry.result?.validation_errors?.length ? entry.result.validation_errors : entry.result?.error ? [entry.result.error] : [])
        : [],
      image: entry.result?.image_pipeline ?? (entry.disposition === "held" ? { status: "not_applicable", reason: "story_held" } : { status: "pending", reason: "image_stage_not_run" }),
    }));
    const jobs = await runJobs(db, runId);
    const hasAgentJobs = jobs.some((job) => job.kind === "agent_round");
    const [funding, agentCalls, usageCalls, agentState] = await Promise.all([
      db.collection("journalist_funding_audit").find({ run_id: runId }, { projection: { _id: 0 } }).sort({ at: -1 }).limit(50).toArray(),
      hasAgentJobs ? db.collection<AgentCall>("journalist_funding_audit")
        .find({ run_id: runId, role: { $in: ["agent", "discovery"] } }, { projection: { _id: 0, at: 1, role: 1, provider: 1, model: 1 } }).toArray() : [],
      hasAgentJobs ? db.collection<{ created_at: number; role: string; provider: string; model: string }>(COLLECTIONS.modelUsage)
        .find({ run_id: runId, role: { $in: ["agent", "discovery"] } }, { projection: { _id: 0, created_at: 1, role: 1, provider: 1, model: 1 } }).toArray() : [],
      hasAgentJobs ? db.collection<AgentState>(AGENT_STATE).findOne({ _id: runId }, { projection: { steps: 1, round: 1 } }) : null,
    ]);
    const recordedCalls = [...agentCalls, ...usageCalls.map(({ created_at, ...call }) => ({ ...call, at: created_at }))];
    return {
      run,
      funding,
      health: await locationHealth(db, run, { id: run.location_id, name: run.location_name }, { runTimeoutSeconds: settings.runTimeoutSeconds }),
      jobs: jobs.map(({ _id, payload, ...job }) => ({
        id: _id, ...job,
        ...(job.kind === "discover" && typeof payload?.method === "string"
          ? { discovery_label: methodDefinition(payload.method)?.label ?? payload.method.replaceAll("_", " ") } : {}),
        ...(job.kind === "agent_round" ? { agent: agentJobDetails({ _id, payload, ...job }, recordedCalls, agentState) } : {}),
      })),
      stories,
    };
  });
}
