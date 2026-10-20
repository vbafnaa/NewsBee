import { adminRoute } from "@/lib/admin-api";
import { healthHistory } from "@/pipeline/orchestration/health-history";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const days = params.get("days") ?? "7";
  const location = params.get("location") || null;
  if (days !== "7" && days !== "30") return Response.json({ detail: "days must be 7 or 30" }, { status: 422 });
  if (location && !/^[a-z0-9-]{1,100}$/.test(location)) return Response.json({ detail: "Invalid location" }, { status: 422 });
  return adminRoute(request, async ({ db }) => healthHistory(db, days === "30" ? 30 : 7, location));
}
