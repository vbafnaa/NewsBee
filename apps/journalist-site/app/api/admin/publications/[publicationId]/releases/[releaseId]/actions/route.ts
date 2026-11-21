import { jsonBody, publicationRoute } from "@/lib/admin-api";
import { resolveOutputChannelForPrincipal } from "@/pipeline/orchestration/output-channels";
import { requirePublicationCapability } from "@/pipeline/publications/permissions";
import { changePublicationReleaseAvailability } from "@/pipeline/publications/releases";

type Context = { params: Promise<{ publicationId: string; releaseId: string }> };

export async function POST(request: Request, context: Context) {
  const { publicationId, releaseId } = await context.params;
  return publicationRoute(request, async (deps) => {
    requirePublicationCapability(deps.principal!, "publication:write");
    const access = await resolveOutputChannelForPrincipal(
      deps.db,
      deps.principal!,
      publicationId,
      "Change a publication release from the support workspace",
      "write",
    );
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const body = await jsonBody<{ action?: unknown; reason?: unknown }>(request);
    if (!["withdraw", "restore"].includes(String(body.action))) {
      return Response.json({ detail: "Choose withdraw or restore." }, { status: 422 });
    }
    return {
      manifest: await changePublicationReleaseAvailability(
        deps.db,
        deps.store,
        access.context,
        releaseId,
        body.action as "withdraw" | "restore",
        body.reason,
        deps.principal!,
      ),
    };
  });
}
