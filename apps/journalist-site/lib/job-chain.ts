import { jobChainToken } from "./pipeline-auth";
import { describeInternalFailure } from "@/pipeline/orchestration/scheduler";

/** Wake exactly one pipeline worker; it will hand off to the next job after it exits. */
export async function callNextJob(requestUrl: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for portal-started pipeline jobs");
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(new URL("/api/pipeline/advance", requestUrl), {
      method: "POST",
      headers: { "x-newsbee-job-token": jobChainToken(secret) },
      cache: "no-store",
    });
    if (response.ok) return;
    const body = await response.text();
    // A suspended/busy local process can deliver a request after its two-minute token
    // expires. Sign once more at dispatch time; a real secret mismatch still fails.
    if (attempt === 0 && response.status === 401 && /"detail"\s*:\s*"Unauthorized"/.test(body)) continue;
    throw new Error(describeInternalFailure("Pipeline job", response.status, body));
  }
}
