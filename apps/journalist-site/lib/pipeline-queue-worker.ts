import { queueNextJob } from "./pipeline-queue";
import { pipelineDeps } from "./pipeline";
import { logger } from "@/pipeline/core/log";
import { continueQueue, maintain } from "@/pipeline/orchestration/dispatch";
import { runOne } from "@/pipeline/orchestration/orchestrator";
import { markQueueDelivery, recordSchedulerSafely } from "@/pipeline/orchestration/scheduler";

const log = logger("pipeline-queue");

/** One MongoDB job per queue delivery. Queue messages, unlike self-fetches, start independent invocations. */
export async function processNextJob() {
  const deps = await pipelineDeps();
  try {
    await markQueueDelivery(deps.db);
    const maintained = await maintain(deps);
    const executed = await runOne(deps);
    await continueQueue(deps, executed, queueNextJob);
    if (maintained) {
      await recordSchedulerSafely(deps.db, "dispatch", null);
      await recordSchedulerSafely(deps.db, "followup", null);
    }
  } catch (error) {
    log.error("worker_or_handoff_failed", { error: String(error) });
    await recordSchedulerSafely(deps.db, "followup", String(error));
    throw error; // Queue retries an interrupted handoff instead of silently stranding pending jobs.
  }
}
