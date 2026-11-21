import { adminRoute, jsonBody } from "@/lib/admin-api";
import { transitionLocationReadiness, type StoredLocationPreparationState } from "@/pipeline/communities/readiness";

type Context = { params: Promise<{ locationId: string }> };

export async function PATCH(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db, principal }) => {
    if (!principal) throw new Error("Sign in as an approved journalist.");
    const body = await jsonBody<{ state?: unknown; reason?: unknown }>(request);
    if (!["preparing", "ready", "blocked"].includes(String(body.state))) throw new Error("Invalid readiness state");
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") {
      throw new Error("Invalid readiness reason");
    }
    return {
      location: await transitionLocationReadiness(
        db,
        locationId,
        body.state as StoredLocationPreparationState,
        principal,
        body.reason as string | null | undefined,
      ),
    };
  });
}
