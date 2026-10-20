import { adminRoute } from "@/lib/admin-api";
import { recentJobs } from "@/pipeline/orchestration/jobs";

export async function GET(request: Request) {
  const location = new URL(request.url).searchParams.get("location") ?? undefined;
  return adminRoute(request, async ({ db }) => ({
    jobs: (await recentJobs(db, 100, location)).map(({ _id, ...job }) => ({ id: _id, ...job })),
  }));
}
