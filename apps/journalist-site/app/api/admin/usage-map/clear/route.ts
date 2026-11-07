import { adminRoute, jsonBody } from "@/lib/admin-api";
import { currentAdmin, ownerGuard } from "@/lib/admin-session";
import { parseClearRequest } from "@/pipeline/analytics/clear-scope";
import { clearPreview, clearReaderData } from "@/pipeline/analytics/reader-data-clear";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const denied = await ownerGuard(request);
  if (denied) return denied;
  return adminRoute(request, ({ db }) => clearPreview(db));
}

export async function POST(request: Request) {
  const denied = await ownerGuard(request);
  if (denied) return denied;
  return adminRoute(request, async ({ db }) => {
    const scope = parseClearRequest(await jsonBody(request));
    return clearReaderData(db, scope, (await currentAdmin()) ?? "admin");
  });
}
