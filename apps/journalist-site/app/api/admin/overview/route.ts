import { adminRoute } from "@/lib/admin-api";
import { expireOverdueRuns } from "@/pipeline/orchestration/diagnostics";
import { overview } from "@/pipeline/orchestration/overview";

export const dynamic = "force-dynamic";

/** Queue-first operations data plus one bulk-loaded row per location. */
export async function GET(request: Request) {
  return adminRoute(request, async ({ db, settings }) => {
    await expireOverdueRuns(db, settings.runTimeoutSeconds);
    return overview(db, settings);
  });
}
