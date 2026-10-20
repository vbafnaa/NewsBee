import { adminRoute } from "@/lib/admin-api";
import { locationHealth } from "@/pipeline/orchestration/health";
import { runJobs } from "@/pipeline/orchestration/jobs";
import { getRun } from "@/pipeline/orchestration/runs";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

type Context = { params: Promise<{ runId: string }> };

/** One run in detail: every source, every job, and every story (held ones with their reasons). */
export async function GET(request: Request, context: Context) {
  const { runId } = await context.params;
  return adminRoute(request, async ({ db }) => {
    const run = await getRun(db, runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const entries = run.draft_id
      ? await db.collection(COLLECTIONS.editionEntries)
        .find({ edition_id: run.draft_id }, { projection: { _id: 0, story_id: 1, source_id: 1, tier: 1, position: 1, disposition: 1, result: 1 } })
        .sort({ position: 1 })
        .toArray()
      : [];
    const stories = entries.map((entry) => ({
      story_id: entry.story_id,
      source_id: entry.source_id,
      tier: entry.tier,
      disposition: entry.disposition,
      title: entry.result?.story?.title ?? null,
      reasons: entry.disposition === "held"
        ? (entry.result?.validation_errors?.length ? entry.result.validation_errors : entry.result?.error ? [entry.result.error] : [])
        : [],
    }));
    return {
      run,
      health: await locationHealth(db, run, { id: run.location_id, name: run.location_name }),
      jobs: (await runJobs(db, runId)).map(({ _id, payload: _payload, ...job }) => ({ id: _id, ...job })),
      stories,
    };
  });
}
