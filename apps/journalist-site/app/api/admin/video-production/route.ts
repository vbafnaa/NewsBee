import { adminRoute } from "@/lib/admin-api";
import { adminGuard } from "@/lib/admin-session";
import { personalRequestDeps } from "@/pipeline/accounts/runtime";
import { falVideoConfigured, falVideoModel } from "@/pipeline/connectors/fal-video";
import { videoLocations, videoStoriesForLocation } from "@/pipeline/video-production";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await adminGuard(request);
  if (denied) return denied;
  return adminRoute(request, async (deps) => {
    const personal = await personalRequestDeps(deps, deps.principal!, undefined, false, false);
    const locationId = new URL(request.url).searchParams.get("locationId");
    if (!locationId) return { locations: await videoLocations(deps.db), falConfigured: falVideoConfigured(personal.settings.integrations.falKey), model: falVideoModel() };
    return { ...(await videoStoriesForLocation(deps.db, locationId)), falConfigured: falVideoConfigured(personal.settings.integrations.falKey), model: falVideoModel() };
  });
}
