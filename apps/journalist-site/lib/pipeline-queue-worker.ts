import { queueNextJob } from "./pipeline-queue";
import { pipelineDeps } from "./pipeline";
import { logger } from "@/pipeline/core/log";
import { expireOverdueRuns } from "@/pipeline/orchestration/diagnostics";
import { nextJobWake } from "@/pipeline/orchestration/jobs";
import { runOne } from "@/pipeline/orchestration/orchestrator";
import { oldestActiveRun } from "@/pipeline/orchestration/runs";
import { recordSchedulerSafely } from "@/pipeline/orchestration/scheduler";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

const log = logger("pipeline-queue");
const now = () => Date.now() / 1000;

/** One MongoDB job per queue delivery. Queue messages, unlike self-fetches, start independent invocations. */
export async function processNextJob() {
  const deps = await pipelineDeps();
  try {
    await deps.db.collection(COLLECTIONS.heartbeat).updateOne(
      { _id: "scheduler" as never }, { $set: { last_tick_at: now() } }, { upsert: true },
    );
    await expireOverdueRuns(deps.db, deps.settings.runTimeoutSeconds);
    const active = await oldestActiveRun(deps.db);
    const pending = active ? await nextJobWake(deps.db, active._id) : null;
    if (pending && pending.available_at > now()) {
      await queueNextJob(Math.ceil(pending.available_at - now()));
      await recordSchedulerSafely(deps.db, "followup", null);
      return;
    }

    const executed = await runOne(deps);
    await deps.db.collection(COLLECTIONS.heartbeat).updateOne(
      { _id: "scheduler" as never }, { $set: { last_tick_finished_at: now(), last_tick_executed: Number(executed) } },
    );
    if (executed) {
      await recordSchedulerSafely(deps.db, "dispatch", null);
      await queueNextJob();
      await recordSchedulerSafely(deps.db, "followup", null);
    } else if (active) {
      // A second wake-up may find the singleton worker busy. Keep a delayed recovery
      // delivery so an interrupted worker does not strand the run when its lease expires.
      const remaining = await nextJobWake(deps.db, active._id);
      if (remaining) {
        await queueNextJob(Math.max(1, Math.ceil(remaining.available_at - now())));
        await recordSchedulerSafely(deps.db, "followup", null);
      }
    }
  } catch (error) {
    log.error("worker_or_handoff_failed", { error: String(error) });
    await recordSchedulerSafely(deps.db, "followup", String(error));
    throw error; // Queue retries an interrupted handoff instead of silently stranding pending jobs.
  }
}
