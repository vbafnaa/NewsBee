import { adminRoute } from "@/lib/admin-api";
import { expireOverdueRuns } from "@/pipeline/orchestration/diagnostics";
import { locationHealth } from "@/pipeline/orchestration/health";
import { runJobs } from "@/pipeline/orchestration/jobs";
import { getRun } from "@/pipeline/orchestration/runs";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

type Context = { params: Promise<{ runId: string }> };

/** One line on why a story ranked where it did (ranking v5 explain record). */
function rankingWhy(ranking: { category?: string; explain?: { base: number; engagement: { multiplier: number; views: number }; rerank: { position: number | null; bonus: number }; diversity_penalty: number; final: number } } | undefined) {
  const explain = ranking?.explain;
  if (!explain) return ranking?.category ?? null;
  const parts = [`${ranking?.category ?? "other"}: rating ${explain.base}`];
  if (explain.engagement.multiplier !== 1) parts.push(`readers ×${explain.engagement.multiplier}${explain.engagement.views ? ` (${explain.engagement.views} views)` : " (exploring)"}`);
  if (explain.rerank.position) parts.push(`editor #${explain.rerank.position} +${explain.rerank.bonus}`);
  if (explain.diversity_penalty) parts.push(`variety −${explain.diversity_penalty}`);
  return `${parts.join(", ")} → ${explain.final}`;
}

/** One run in detail: every source, every job, and every story (held ones with their reasons). */
export async function GET(request: Request, context: Context) {
  const { runId } = await context.params;
  return adminRoute(request, async ({ db, settings }) => {
    await expireOverdueRuns(db, settings.runTimeoutSeconds);
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
      rank: entry.result?.ranking?.rank ?? null,
      why: rankingWhy(entry.result?.ranking),
      reasons: entry.disposition === "held"
        ? (entry.result?.validation_errors?.length ? entry.result.validation_errors : entry.result?.error ? [entry.result.error] : [])
        : [],
      image: entry.result?.image_pipeline ?? (entry.disposition === "held" ? { status: "not_applicable", reason: "story_held" } : { status: "pending", reason: "image_stage_not_run" }),
    }));
    return {
      run,
      funding: await db.collection("journalist_funding_audit").find({ run_id: runId }, { projection: { _id: 0 } }).sort({ at: -1 }).limit(50).toArray(),
      health: await locationHealth(db, run, { id: run.location_id, name: run.location_name }, { runTimeoutSeconds: settings.runTimeoutSeconds }),
      jobs: (await runJobs(db, runId)).map(({ _id, payload: _payload, ...job }) => ({ id: _id, ...job })),
      stories,
    };
  });
}
