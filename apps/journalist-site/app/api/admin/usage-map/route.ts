import { adminRoute } from "@/lib/admin-api";
import { usageRange, usageSummary } from "@/pipeline/analytics/usage";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return adminRoute(request, async ({ db }) => {
    const query = new URL(request.url).searchParams;
    return usageSummary(db, usageRange(query.get("from"), query.get("to")));
  });
}
