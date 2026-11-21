import { jsonBody, newsroomScopedRoute } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { resolveReport, storyReports } from "@/pipeline/orchestration/inbox";
import { assertLocationInScope } from "@/pipeline/publications/newsroom-scope";

/** Mark a reader's problem report resolved: { id }. Journalists may resolve reports for their newsroom's communities. */
export async function POST(request: Request) {
  return newsroomScopedRoute(request, async ({ db }, scope) => {
    const body = await jsonBody<{ id?: unknown }>(request);
    if (typeof body.id !== "string") throw new Error("Invalid report: send an id");
    const report = await storyReports(db).findOne({ _id: body.id }, { projection: { location_id: 1 } });
    if (!report) throw new Error(`Unknown report: ${body.id}`);
    assertLocationInScope(scope, report.location_id, "Report");
    return resolveReport(db, body.id, (await currentAdmin()) ?? "editor");
  });
}
