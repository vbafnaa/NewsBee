import { authorizedPipelineRequest } from "@/lib/pipeline-auth";
import { pipelineDeps } from "@/lib/pipeline";
import type { Job } from "@/pipeline/orchestration/jobs";
import { runOne } from "@/pipeline/orchestration/orchestrator";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Executes exactly one queued source job in its own Vercel function invocation. */
export async function POST(request: Request) {
  if (!authorizedPipelineRequest(request)) return Response.json({ detail: "Unauthorized" }, { status: 401 });
  let jobId: unknown;
  try {
    const body = await request.json() as { job_id?: unknown };
    jobId = body.job_id;
  } catch {
    return Response.json({ detail: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(jobId)) {
    return Response.json({ detail: "A valid job_id is required" }, { status: 400 });
  }

  try {
    const deps = await pipelineDeps();
    const job = await deps.db.collection<Job>(COLLECTIONS.jobs).findOne({ _id: jobId, kind: "collect_source" });
    if (!job) return Response.json({ detail: "Source job not found" }, { status: 404 });
    const executed = await runOne(deps, { jobId, kinds: ["collect_source"] });
    if (!executed) return Response.json({ detail: "Source job is not available to run" }, { status: 409 });
    return Response.json({ job_id: jobId, executed: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json({ detail }, { status: 500 });
  }
}
