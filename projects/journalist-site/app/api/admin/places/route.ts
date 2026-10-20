import { adminRoute } from "@/lib/admin-api";
import { searchPlaces } from "@/pipeline/communities/directory";

/** Census place search for onboarding ("Auburn" or "Auburn, WA"). */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").slice(0, 80);
  return adminRoute(request, async ({ db }) => ({ query, results: await searchPlaces(db, query, params.get("state") ?? undefined) }));
}
