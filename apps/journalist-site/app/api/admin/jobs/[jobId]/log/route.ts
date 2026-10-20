import { adminRoute } from "@/lib/admin-api";
import type { Job } from "@/pipeline/orchestration/jobs";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

type Context = { params: Promise<{ jobId: string }> };

/** Read the structured attempt log for one job from the configured artifact store. */
export async function GET(request: Request, context: Context) {
  const { jobId } = await context.params;
  return adminRoute(request, async ({ db, store }) => {
    const job = await db.collection<Job>(COLLECTIONS.jobs).findOne(
      { _id: jobId },
      { projection: { log_file: 1, log_error: 1 } },
    );
    if (!job) return Response.json({ detail: "Job not found" }, { status: 404 });
    if (typeof job.log_file !== "string") {
      return Response.json({ detail: job.log_error ?? "Log is not available yet" }, { status: job.log_error ? 503 : 404 });
    }
    const content = await store.readText(job.log_file);
    return new Response(content, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
    });
  });
}
