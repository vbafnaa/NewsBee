import { adminRoute } from "@/lib/admin-api";
import { MONGO_LOG, readJobLog, type Job } from "@/pipeline/orchestration/jobs";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

type Context = { params: Promise<{ jobId: string }> };

/** Read the structured attempt log for one job, from MongoDB or, for older runs, its own file. */
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
    const kept = job.log_file.startsWith(MONGO_LOG);
    const content = kept ? await readJobLog(db, jobId) : await store.readText(job.log_file);
    if (content === null) return Response.json({ detail: "This log has expired. The run's stage logs are in its logs folder." }, { status: 404 });
    return new Response(content, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
    });
  });
}
