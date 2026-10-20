import { handleCallback } from "@vercel/queue";
import { processNextJob } from "@/lib/pipeline-queue-worker";

export const maxDuration = 300;

/** Vercel invokes this private queue-triggered function; no public token or HTTP self-call. */
const handleMessage = handleCallback(async () => {
  await processNextJob();
});

export async function POST(request: Request) {
  return handleMessage(request);
}
