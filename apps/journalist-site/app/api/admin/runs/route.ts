import { adminRoute } from "@/lib/admin-api";
import { recentRuns } from "@/pipeline/orchestration/runs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const locationId = params.get("location") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(params.get("limit") ?? 20) || 20));
  return adminRoute(request, async ({ db }) => ({ runs: await recentRuns(db, { locationId, limit }) }));
}
