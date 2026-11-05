import { adminRoute } from "@/lib/admin-api";
import { inbox } from "@/pipeline/orchestration/inbox";

export const dynamic = "force-dynamic";

/** Everything waiting for an editor: held stories, reader stories, family notices, source suggestions and problem reports. */
export async function GET(request: Request) {
  return adminRoute(request, async ({ db }) => inbox(db, new URL(request.url).searchParams.get("location") || undefined));
}
