import { jsonBody, publicationRoute } from "@/lib/admin-api";
import {
  listPublicationSourceFeedback,
  submitPublicationSourceFeedback,
} from "@/pipeline/connectors/manual-links";
import { resolveOutputChannelForPrincipal } from "@/pipeline/orchestration/output-channels";
import { sourceMap } from "@/pipeline/sourcemap/store";
import { activePublicationSupport } from "@/pipeline/publications/support";

type Context = { params: Promise<{ channelId: string }> };

export async function GET(request: Request, context: Context) {
  const { channelId } = await context.params;
  return publicationRoute(request, async (deps) => {
    const access = await resolveOutputChannelForPrincipal(
      deps.db,
      deps.principal!,
      channelId,
      "Review publication source feedback in the support workspace",
    );
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const locationIds = access.channel.selectedLocationIds;
    const sources = locationIds.length ? await sourceMap(deps.db).find({
      location_id: { $in: locationIds },
      status: { $nin: ["rejected"] },
    }, { projection: { source_id: 1, location_id: 1, name: 1, url: 1, section: 1 } })
      .sort({ location_id: 1, name: 1 }).limit(1000).toArray() : [];
    const support = access.context.role === "privileged"
      ? await activePublicationSupport(deps.db, deps.principal!, channelId) : null;
    return {
      publication: {
        canWrite: access.context.role !== "privileged" || Boolean(support),
        supportExpiresAt: support?.expires_at ?? null,
      },
      feedback: await listPublicationSourceFeedback(deps.db, { publicationId: channelId, status: "all" }),
      sources,
    };
  });
}

export async function POST(request: Request, context: Context) {
  const { channelId } = await context.params;
  return publicationRoute(request, async (deps) => {
    const access = await resolveOutputChannelForPrincipal(
      deps.db,
      deps.principal!,
      channelId,
      "Submit publication source feedback from the support workspace",
      "write",
    );
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const feedback = await submitPublicationSourceFeedback(
      deps.db,
      access.context,
      deps.principal!,
      await jsonBody(request),
    );
    return Response.json({ feedback }, { status: 201 });
  });
}
