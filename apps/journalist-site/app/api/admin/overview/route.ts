import { adminRoute } from "@/lib/admin-api";
import { expireOverdueRuns } from "@/pipeline/orchestration/diagnostics";
import { overview } from "@/pipeline/orchestration/overview";

export const dynamic = "force-dynamic";

/** The dashboard: one row per location with its funnel against the previous edition, plus the model, queue and alert strip. */
export async function GET(request: Request) {
  return adminRoute(request, async ({ db, settings }) => {
    await expireOverdueRuns(db, settings.runTimeoutSeconds);
    return overview(db, settings);
  });
}
