import { adminRoute } from "@/lib/admin-api";
import { diagnoseRuns, expireOverdueRuns } from "@/pipeline/orchestration/diagnostics";
import { recentRuns } from "@/pipeline/orchestration/runs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const locationId = params.get("location") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(params.get("limit") ?? 20) || 20));
  const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
  return adminRoute(request, async ({ db, settings }) => {
    await expireOverdueRuns(db, settings.runTimeoutSeconds);
    const page = await recentRuns(db, { locationId, limit: limit + 1, offset });
    const visible = page.slice(0, limit);
    const diagnostics = await diagnoseRuns(db, visible, settings.runTimeoutSeconds);
    return { runs: visible.map((run) => ({ ...run, diagnostics: diagnostics.get(run._id) ?? null })), hasMore: page.length > limit };
  });
}
