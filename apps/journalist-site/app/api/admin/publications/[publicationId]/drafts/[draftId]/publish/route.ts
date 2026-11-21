import { jsonBody, publicationRoute } from "@/lib/admin-api";
import { resolveOutputChannelForPrincipal } from "@/pipeline/orchestration/output-channels";
import { requirePublicationCapability } from "@/pipeline/publications/permissions";
import { publishPublicationDraft } from "@/pipeline/publications/releases";

type Context = { params: Promise<{ publicationId: string; draftId: string }> };

export async function POST(request: Request, context: Context) {
  const { publicationId, draftId } = await context.params;
  return publicationRoute(request, async (deps) => {
    requirePublicationCapability(deps.principal!, "publication:write");
    const access = await resolveOutputChannelForPrincipal(
      deps.db,
      deps.principal!,
      publicationId,
      "Publish a publication draft from the support workspace",
      "write",
    );
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const body = await jsonBody<{ expectedRevision?: unknown; expectedContentHash?: unknown }>(request);
    if (typeof body.expectedContentHash !== "string") {
      return Response.json({ detail: "Approved content hash is required." }, { status: 422 });
    }
    return {
      draft: await publishPublicationDraft(
        deps.db,
        deps.store,
        access.context,
        draftId,
        Number(body.expectedRevision),
        body.expectedContentHash,
        deps.principal!,
      ),
    };
  });
}
