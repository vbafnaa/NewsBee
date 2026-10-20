import { after } from "next/server";
import { authorizedJobChain } from "@/lib/pipeline-auth";
import { callNextJob } from "@/lib/job-chain";
import { pipelineDeps } from "@/lib/pipeline";
import { logger } from "@/pipeline/core/log";
import { expireOverdueRuns } from "@/pipeline/orchestration/diagnostics";
import { runOne } from "@/pipeline/orchestration/orchestrator";
import { nextJobWake } from "@/pipeline/orchestration/jobs";
import { recordSchedulerSafely } from "@/pipeline/orchestration/scheduler";
import { oldestActiveRun } from "@/pipeline/orchestration/runs";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const log = logger("job-chain");
const now = () => Date.now() / 1000;

/** Portal-started pipeline: one task per invocation, then call this endpoint for the next. */
export async function POST(request: Request) {
  if (!authorizedJobChain(request)) return Response.json({ detail: "Unauthorized" }, { status: 401 });
  try {
    const deps = await pipelineDeps();
    await deps.db.collection(COLLECTIONS.heartbeat).updateOne(
      { _id: "scheduler" as never }, { $set: { last_tick_at: now() } }, { upsert: true },
    );
    await expireOverdueRuns(deps.db, deps.settings.runTimeoutSeconds);
    const active = await oldestActiveRun(deps.db);
    const pending = active ? await nextJobWake(deps.db, active._id) : null;
    if (pending && pending.available_at * 1000 > Date.now()) {
      // Delay in a separate call, so a rate-limit wait cannot consume a worker's function lifetime.
      const delay = Math.min(120_000, Math.max(0, pending.available_at * 1000 - Date.now()));
      after(async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        try {
          await callNextJob(request.url);
          await recordSchedulerSafely(deps.db, "followup", null);
        }
        catch (error) {
          log.error("followup_failed", { error: String(error) });
          await recordSchedulerSafely(deps.db, "followup", String(error));
        }
      });
      return Response.json({ waiting_seconds: Math.ceil(delay / 1000) });
    }

    const executed = await runOne(deps);
    if (executed) await recordSchedulerSafely(deps.db, "dispatch", null);
    await deps.db.collection(COLLECTIONS.heartbeat).updateOne(
      { _id: "scheduler" as never }, { $set: { last_tick_finished_at: now(), last_tick_executed: Number(executed) } },
    );
    if (executed) {
      after(async () => {
        try {
          await callNextJob(request.url);
          await recordSchedulerSafely(deps.db, "followup", null);
        } catch (error) {
          log.error("followup_failed", { error: String(error) });
          await recordSchedulerSafely(deps.db, "followup", String(error));
        }
      });
    }
    return Response.json({ executed });
  } catch (error) {
    log.error("job_chain_failed", { error: String(error) });
    return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
