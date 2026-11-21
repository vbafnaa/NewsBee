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

/** Signed recovery: one task, then independent cloud delivery or a local HTTP handoff. */
export async function POST(request: Request) {
  if (!authorizedJobChain(request)) return Response.json({ detail: "Unauthorized" }, { status: 401 });
  try {
    const deps = await pipelineDeps();
    await maintain(deps);
    const executed = await runOne(deps);
    if (deps.settings.mode === "cloud") {
      try {
        await continueQueue(deps, executed, queueNextJob);
        await recordSchedulerSafely(deps.db, "followup", null);
      } catch (error) {
        const detail = `Cloud pipeline continuation requires Vercel Queues delivery: ${String(error)}`;
        log.error("followup_failed", { error: detail });
        await recordSchedulerSafely(deps.db, "followup", detail);
        return Response.json({ executed, detail }, { status: 503 });
      }
      return Response.json({ executed });
    }
    after(async () => {
      try {
        await continueQueue(deps, executed, async (delaySeconds) => {
          // The local poller handles backoff without keeping an HTTP request alive.
          if (!delaySeconds) await callNextJob(request.url);
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
