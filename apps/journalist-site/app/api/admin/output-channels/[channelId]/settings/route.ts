import { jsonBody, publicationRoute } from "@/lib/admin-api";
import { resolveOutputChannelForPrincipal } from "@/pipeline/orchestration/output-channels";
import { activePublicationSupport } from "@/pipeline/publications/support";
import {
  getPublicationSettings,
  updatePublicationSettings,
} from "@/pipeline/publications/settings";
import type { PublicationSettingsPatch } from "../../../../../../../../shared/publication-settings";

type Context = { params: Promise<{ channelId: string }> };

export async function GET(request: Request, context: Context) {
  const { channelId } = await context.params;
  return publicationRoute(request, async (deps) => {
    const access = await resolveOutputChannelForPrincipal(
      deps.db,
      deps.principal!,
      channelId,
      "Review publication settings in the support workspace",
    );
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const support = access.context.role === "privileged"
      ? await activePublicationSupport(deps.db, deps.principal!, channelId) : null;
    return {
      publication: {
        id: access.channel.id, name: access.channel.name, role: access.context.role,
        canWrite: access.context.role !== "privileged" || Boolean(support),
        supportExpiresAt: support?.expires_at ?? null,
      },
      settings: await getPublicationSettings(deps.db, access.context),
    };
  });
}

export async function PATCH(request: Request, context: Context) {
  const { channelId } = await context.params;
  return publicationRoute(request, async (deps) => {
    const access = await resolveOutputChannelForPrincipal(
      deps.db,
      deps.principal!,
      channelId,
      "Update publication settings from the support workspace",
      "write",
    );
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const patch = await jsonBody<PublicationSettingsPatch>(request);
    return {
      settings: await updatePublicationSettings(deps.db, access.context, deps.principal!, patch),
    };
  });
}
