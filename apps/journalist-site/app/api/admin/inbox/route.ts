import { newsroomScopedRoute } from "@/lib/admin-api";
import { inbox } from "@/pipeline/orchestration/inbox";

export const dynamic = "force-dynamic";

/**
 * Everything waiting for an editor: held stories, reader stories, family notices, source suggestions and problem reports.
 * Operators see every community; from a newsroom (`?publication=`) only that newsroom's communities.
 */
export async function GET(request: Request) {
  return newsroomScopedRoute(request, async ({ db, principal }, scope) =>
    inbox(db, new URL(request.url).searchParams.get("location") || undefined, principal, scope));
}
