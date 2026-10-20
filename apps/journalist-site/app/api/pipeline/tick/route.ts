import { after } from "next/server";
import { authorizedPipelineRequest } from "@/lib/pipeline-auth";
import { pipelineDeps } from "@/lib/pipeline";
import { logger } from "@/pipeline/core/log";
import { tick } from "@/pipeline/orchestration/orchestrator";
import { nextPendingJob, pendingJobs } from "@/pipeline/orchestration/jobs";
import { oldestActiveRun } from "@/pipeline/orchestration/runs";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const log = logger("scheduler");

/** Vercel Cron (GET) and the local poller (POST): run jobs and dispatch cloud source jobs. */
async function handle(request: Request) {
  if (!authorizedPipelineRequest(request)) return Response.json({ detail: "Unauthorized" }, { status: 401 });
  try {
    const deps = await pipelineDeps();
    const cloud = deps.settings.mode === "cloud";
    const result = await tick(deps, cloud
      ? { budgetMs: 30_000, kinds: ["author_start", "author_story", "author_finish"] }
      : { budgetMs: 30_000 });
    const active = cloud ? await oldestActiveRun(deps.db) : null;
    const sources = active ? await pendingJobs(deps.db, "collect_source", 1, active._id) : [];
    const next = active ? await nextPendingJob(deps.db, active._id) : null;
    if (sources.length || next) {
      after(async () => {
        const secret = process.env.CRON_SECRET;
        if (!secret) throw new Error("CRON_SECRET is required to dispatch cloud pipeline jobs");
        const sourceUrl = new URL("/api/pipeline/collect-source", request.url);
        const results = await Promise.all(sources.map(async (job) => {
          try {
            const response = await fetch(sourceUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
              body: JSON.stringify({ job_id: job._id }),
              cache: "no-store",
            });
            if (!response.ok) throw new Error(`Worker returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
            return true;
          } catch (error) {
            log.error("source_job_dispatch_failed", {
              job_id: job._id,
              run_id: job.run_id,
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          }
        }));
        if (results.every(Boolean) && next) {
          const delay = Math.min(30_000, Math.max(0, next.available_at * 1000 - Date.now()));
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          try {
            const response = await fetch(new URL("/api/pipeline/tick", request.url), {
              method: "POST",
              headers: { Authorization: `Bearer ${secret}` },
              cache: "no-store",
            });
            if (!response.ok) throw new Error(`Scheduler returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
          } catch (error) {
            log.error("followup_tick_failed", { error: error instanceof Error ? error.message : String(error) });
          }
        }
      });
    }
    return Response.json({ ...result, source_jobs_dispatched: sources.length });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error("tick_failed", { error: detail });
    return Response.json({ detail }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
