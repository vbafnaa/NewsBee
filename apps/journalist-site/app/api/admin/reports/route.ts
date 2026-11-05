import { adminRoute, jsonBody } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { resolveReport } from "@/pipeline/orchestration/inbox";

/** Mark a reader's problem report resolved: { id }. */
export async function POST(request: Request) {
  return adminRoute(request, async ({ db }) => {
    const body = await jsonBody<{ id?: unknown }>(request);
    if (typeof body.id !== "string") throw new Error("Invalid report: send an id");
    return resolveReport(db, body.id, (await currentAdmin()) ?? "editor");
  });
}
