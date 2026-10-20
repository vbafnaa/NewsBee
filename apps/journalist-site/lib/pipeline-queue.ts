import { send } from "@vercel/queue";

export const PIPELINE_TOPIC = "journalist-pipeline-jobs";

/** Queue a fresh worker invocation; the MongoDB lease selects exactly one eligible job. */
export async function queueNextJob(delaySeconds = 0) {
  await send(PIPELINE_TOPIC, { action: "advance" }, delaySeconds > 0 ? { delaySeconds } : undefined);
}
