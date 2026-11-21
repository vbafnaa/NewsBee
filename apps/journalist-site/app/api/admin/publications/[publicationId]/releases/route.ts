import { publicationRoute } from "@/lib/admin-api";
import { resolveOutputChannelForPrincipal } from "@/pipeline/orchestration/output-channels";
import { requirePublicationCapability } from "@/pipeline/publications/permissions";
import { listPublicationReleases } from "@/pipeline/publications/releases";

type Context = { params: Promise<{ publicationId: string }> };

export async function GET(request: Request, context: Context) {
  const { publicationId } = await context.params;
  return publicationRoute(request, async (deps) => {
    requirePublicationCapability(deps.principal!, "publication:read");
    const access = await resolveOutputChannelForPrincipal(
      deps.db,
      deps.principal!,
      publicationId,
      "Review publication releases in the support workspace",
    );
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    return { releases: await listPublicationReleases(deps.db, access.context) };
  });
}
