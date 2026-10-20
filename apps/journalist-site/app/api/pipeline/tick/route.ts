import { authorizedPipelineRequest } from "@/lib/pipeline-auth";
import { pipelineDeps } from "@/lib/pipeline";
import { queueNextJob } from "@/lib/pipeline-queue";
import { logger } from "@/pipeline/core/log";
import { tick, type OrchestratorDeps } from "@/pipeline/orchestration/orchestrator";
import { nextJobWake, type Job } from "@/pipeline/orchestration/jobs";
import { recordSchedulerSafely } from "@/pipeline/orchestration/scheduler";
import { oldestActiveRun } from "@/pipeline/orchestration/runs";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

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

    const active = await oldestActiveRun(deps.db);
    const pending = active ? await nextJobWake(deps.db, active._id) : null;
    const expired = active ? await deps.db.collection<Job>(COLLECTIONS.jobs).findOne({
      run_id: active._id, status: "running", lease_until: { $lt: Date.now() / 1000 },
    }) : null;
    if (pending || expired) {
      await queueNextJob();
      await recordSchedulerSafely(deps.db, "dispatch", null);
    }
    await recordSchedulerSafely(deps.db, "tick", null);
    return Response.json({ worker_queued: Boolean(pending || expired) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error("tick_failed", { error: detail });
    await recordSchedulerSafely(deps?.db ?? null, "tick", detail);
    return Response.json({ detail }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
