import { internalRoute } from "@/lib/admin-api";
import { usageRange, usageSummary } from "@/pipeline/analytics/usage";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return internalRoute(request, async ({ db }) => {
    const query = new URL(request.url).searchParams;
    return usageSummary(db, usageRange(query.get("from"), query.get("to")));
  });
}
