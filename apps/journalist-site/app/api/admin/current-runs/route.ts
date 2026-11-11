import { adminRoute } from "@/lib/admin-api";
import { expireOverdueRuns } from "@/pipeline/orchestration/diagnostics";
import { currentRuns } from "@/pipeline/orchestration/runs";

export async function GET(request: Request) {
  return adminRoute(request, async ({ db, settings }) => {
    await expireOverdueRuns(db, settings.runTimeoutSeconds);
    return { runs: await currentRuns(db) };
  });
}
