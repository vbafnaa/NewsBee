import { jsonBody, publicationRoute } from "@/lib/admin-api";
import { resolveOutputChannelForPrincipal } from "@/pipeline/orchestration/output-channels";
import { requirePublicationCapability } from "@/pipeline/publications/permissions";
import { createPublicationCorrection } from "@/pipeline/publications/releases";

type Context = { params: Promise<{ publicationId: string; releaseId: string }> };

export async function POST(request: Request, context: Context) {
  const { publicationId, releaseId } = await context.params;
  return publicationRoute(request, async (deps) => {
    requirePublicationCapability(deps.principal!, "publication:write");
    const access = await resolveOutputChannelForPrincipal(
      deps.db,
      deps.principal!,
      publicationId,
      "Correct a publication release from the support workspace",
      "write",
    );
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const body = await jsonBody<{ reason?: unknown }>(request);
    return {
      draft: await createPublicationCorrection(
        deps.db,
        access.context,
        releaseId,
        body.reason,
        deps.principal!,
      ),
    };
  });
}
