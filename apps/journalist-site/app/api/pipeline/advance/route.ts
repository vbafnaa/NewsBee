import { after } from "next/server";
import { authorizedJobChain } from "@/lib/pipeline-auth";
import { callNextJob } from "@/lib/job-chain";
import { pipelineDeps } from "@/lib/pipeline";
import { queueNextJob } from "@/lib/pipeline-queue";
import { logger } from "@/pipeline/core/log";
import { continueQueue, maintain } from "@/pipeline/orchestration/dispatch";
import { runOne } from "@/pipeline/orchestration/orchestrator";
import { recordSchedulerSafely } from "@/pipeline/orchestration/scheduler";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const log = logger("job-chain");

/** Portal-started pipeline: one task per invocation, then start the next. No call waits here on a backoff. */
export async function POST(request: Request) {
  if (!authorizedJobChain(request)) return Response.json({ detail: "Unauthorized" }, { status: 401 });
  try {
    const deps = await pipelineDeps();
    await maintain(deps);
    const executed = await runOne(deps);
    after(async () => {
      try {
        // In the cloud the queue can delay a message. Locally a wait is left to the next poller tick.
        await continueQueue(deps, executed, async (delaySeconds) => {
          if (deps.settings.mode === "cloud") await queueNextJob(delaySeconds);
          else if (!delaySeconds) await callNextJob(request.url);
        });
      } catch (error) {
        log.error("followup_failed", { error: String(error) });
        await recordSchedulerSafely(deps.db, "followup", String(error));
      }
    });
    return Response.json({ executed });
  } catch (error) {
    log.error("job_chain_failed", { error: String(error) });
    return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
