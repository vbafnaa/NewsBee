import { adminRoute } from "@/lib/admin-api";
import { searchPlaces } from "@/pipeline/communities/directory";
import { ensureDirectories } from "@/pipeline/communities/bootstrap";

export const maxDuration = 300;

/** Census place search for onboarding ("Auburn" or "Auburn, WA"). */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").slice(0, 80);
  return adminRoute(request, async ({ db }) => {
    if (query.trim().length < 2) return { query, results: [] };
    await ensureDirectories(db);
    return { query, results: await searchPlaces(db, query, params.get("state") ?? undefined) };
  });
}
