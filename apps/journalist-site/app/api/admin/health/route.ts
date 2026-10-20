import { adminRoute } from "@/lib/admin-api";
import { healthSummary } from "@/pipeline/orchestration/health";

export async function GET(request: Request) {
  return adminRoute(request, async ({ db, model }) => healthSummary(db, model));
}
