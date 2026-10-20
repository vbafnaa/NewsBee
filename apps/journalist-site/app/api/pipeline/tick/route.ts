import { after } from "next/server";
import { authorizedPipelineRequest } from "@/lib/pipeline-auth";
import { pipelineDeps } from "@/lib/pipeline";
import { logger } from "@/pipeline/core/log";
import { tick, type OrchestratorDeps } from "@/pipeline/orchestration/orchestrator";
import { nextJobWake, pendingJobs } from "@/pipeline/orchestration/jobs";
import { describeInternalFailure, markDispatch, recordSchedulerSafely } from "@/pipeline/orchestration/scheduler";
import { oldestActiveRun } from "@/pipeline/orchestration/runs";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const log = logger("scheduler");

/** Vercel Cron (GET) and the local poller (POST): run jobs and dispatch cloud source jobs. */
async function handle(request: Request) {
  if (!authorizedPipelineRequest(request)) return Response.json({ detail: "Unauthorized" }, { status: 401 });
  let deps: OrchestratorDeps | null = null;
  try {
    deps = await pipelineDeps();
    const ctx = deps;
    const cloud = deps.settings.mode === "cloud";
    const result = await tick(deps, cloud
      ? { budgetMs: 30_000, kinds: ["author_start", "author_story", "author_finish"] }
      : { budgetMs: 30_000 });
    const active = await oldestActiveRun(deps.db);
    const sources = cloud && active?.status === "collecting" ? await pendingJobs(deps.db, "collect_source", 1, active._id) : [];
    const next = active ? await nextJobWake(deps.db, active._id) : null;
    if (sources.length || next) {
      after(async () => {
        const secret = ctx.settings.cronSecret;
        if (!secret) {
          await recordSchedulerSafely(ctx.db, "dispatch", "CRON_SECRET is not set, so source workers and follow-up ticks cannot be started.");
          throw new Error("CRON_SECRET is required to dispatch pipeline jobs");
        }
        const sourceUrl = new URL("/api/pipeline/collect-source", request.url);
        const results = await Promise.all(sources.map(async (job) => {
          try {
            const response = await fetch(sourceUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
              body: JSON.stringify({ job_id: job._id }),
              cache: "no-store",
            });
            if (response.status === 409) return true; // Already claimed by another worker or tick.
            if (!response.ok) throw new Error(describeInternalFailure("Source worker", response.status, await response.text()));
            await markDispatch(ctx.db, job._id, null).catch(() => undefined);
            return true;
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            log.error("source_job_dispatch_failed", { job_id: job._id, run_id: job.run_id, error: detail });
            await markDispatch(ctx.db, job._id, detail).catch(() => undefined);
            return false;
          }
        }));
        await recordSchedulerSafely(ctx.db, "dispatch", results.every(Boolean) ? null : "One or more source workers could not be started; see the run's jobs for details.");
        if (results.every(Boolean) && next) {
          const delay = Math.min(30_000, Math.max(0, next.available_at * 1000 - Date.now()));
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          try {
            const response = await fetch(new URL("/api/pipeline/tick", request.url), {
              method: "POST",
              headers: { Authorization: `Bearer ${secret}` },
              cache: "no-store",
            });
            if (!response.ok) throw new Error(describeInternalFailure("Follow-up scheduler tick", response.status, await response.text()));
            await recordSchedulerSafely(ctx.db, "followup", null);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            log.error("followup_tick_failed", { error: detail });
            await recordSchedulerSafely(ctx.db, "followup", detail);
          }
        }
      });
    }
    return Response.json({ ...result, source_jobs_dispatched: sources.length });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error("tick_failed", { error: detail });
    await recordSchedulerSafely(deps?.db ?? null, "tick", detail);
    return Response.json({ detail }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
