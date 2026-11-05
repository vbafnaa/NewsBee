import { adminRoute } from "@/lib/admin-api";
import { alerts } from "@/pipeline/orchestration/overview";

export const dynamic = "force-dynamic";

/** Open alerts, newest and most severe first; ?location= narrows to one location. */
export async function GET(request: Request) {
  return adminRoute(request, async ({ db, settings }) => ({ alerts: await alerts(db, settings, new URL(request.url).searchParams.get("location") ?? undefined) }));
}
