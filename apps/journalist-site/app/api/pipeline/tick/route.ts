import { authorizedPipelineRequest } from "@/lib/pipeline-auth";
import { pipelineDeps } from "@/lib/pipeline";
import { queueNextJob } from "@/lib/pipeline-queue";
import { logger } from "@/pipeline/core/log";
import { tick, type OrchestratorDeps } from "@/pipeline/orchestration/orchestrator";
import { dispatchPlan } from "@/pipeline/orchestration/dispatch";
import { recordSchedulerSafely } from "@/pipeline/orchestration/scheduler";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const log = logger("scheduler");

/** Optional Vercel Cron recovers stalled cloud jobs; the local poller runs jobs directly. */
async function handle(request: Request) {
  if (!authorizedPipelineRequest(request)) return Response.json({ detail: "Unauthorized" }, { status: 401 });
  let deps: OrchestratorDeps | null = null;
  try {
    deps = await pipelineDeps();
    if (deps.settings.mode !== "cloud") return Response.json(await tick(deps, { budgetMs: 30_000 }));

    const plan = await dispatchPlan(deps.db, deps.settings.collectConcurrency);
    const workers = plan.send || (plan.wakeIn !== null ? 1 : 0);
    for (let index = 0; index < workers; index += 1) await queueNextJob();
    if (workers) await recordSchedulerSafely(deps.db, "dispatch", null);
    await recordSchedulerSafely(deps.db, "tick", null);
    return Response.json({ worker_queued: workers > 0 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error("tick_failed", { error: detail });
    await recordSchedulerSafely(deps?.db ?? null, "tick", detail);
    return Response.json({ detail }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
