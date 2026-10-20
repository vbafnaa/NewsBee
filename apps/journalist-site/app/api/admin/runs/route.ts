import { adminRoute } from "@/lib/admin-api";
import { diagnoseRuns, expireOverdueRuns } from "@/pipeline/orchestration/diagnostics";
import { recentRuns } from "@/pipeline/orchestration/runs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const locationId = params.get("location") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(params.get("limit") ?? 20) || 20));
  return adminRoute(request, async ({ db, settings }) => {
    await expireOverdueRuns(db, settings.runTimeoutSeconds);
    const runs = await recentRuns(db, { locationId, limit });
    const diagnostics = await diagnoseRuns(db, runs, settings.runTimeoutSeconds);
    return { runs: runs.map((run) => ({ ...run, diagnostics: diagnostics.get(run._id) ?? null })) };
  });
}
