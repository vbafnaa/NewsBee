import { jobChainToken } from "./pipeline-auth";
import { describeInternalFailure } from "@/pipeline/orchestration/scheduler";

/** Wake exactly one pipeline worker; it will hand off to the next job after it exits. */
export async function callNextJob(requestUrl: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for portal-started pipeline jobs");
  const response = await fetch(new URL("/api/pipeline/advance", requestUrl), {
    method: "POST",
    headers: { "x-newsbee-job-token": jobChainToken(secret) },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(describeInternalFailure("Pipeline job", response.status, await response.text()));
}
