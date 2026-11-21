import { adminRoute } from "@/lib/admin-api";
import { expireOverdueRuns } from "@/pipeline/orchestration/diagnostics";
import { healthSummary } from "@/pipeline/orchestration/health";
import { safeManagedHealthSettings } from "@/pipeline/accounts/execution";

export async function GET(request: Request) {
  return adminRoute(request, async ({ db, model, settings }) => {
    await expireOverdueRuns(db, settings.runTimeoutSeconds);
    return healthSummary(db, model, safeManagedHealthSettings(settings));
  });
}
