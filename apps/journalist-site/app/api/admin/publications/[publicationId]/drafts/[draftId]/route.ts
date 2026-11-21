import { jsonBody, publicationRoute } from "@/lib/admin-api";
import {
  patchPublicationDraft,
  publicationEditorialWorkspace,
  type PublicationDraftPatch,
} from "@/pipeline/publications/editorial";
import { requirePublicationCapability } from "@/pipeline/publications/permissions";
import { resolveOutputChannelForPrincipal } from "@/pipeline/orchestration/output-channels";
import { publicationReaderMetadata } from "@/pipeline/publications/preview";

type Context = { params: Promise<{ publicationId: string; draftId: string }> };

export async function GET(request: Request, context: Context) {
  const { publicationId, draftId } = await context.params;
  return publicationRoute(request, async (deps) => {
    requirePublicationCapability(deps.principal!, "publication:read");
    const access = await resolveOutputChannelForPrincipal(
      deps.db,
      deps.principal!,
      publicationId,
      "Review a publication draft in the support workspace",
    );
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const workspace = await publicationEditorialWorkspace(deps.db, access.context, draftId);
    return workspace ? { ...workspace, ...publicationReaderMetadata() }
      : Response.json({ detail: "Publication draft was not found." }, { status: 404 });
  });
}

export async function PATCH(request: Request, context: Context) {
  const { publicationId, draftId } = await context.params;
  return publicationRoute(request, async (deps) => {
    requirePublicationCapability(deps.principal!, "publication:write");
    const access = await resolveOutputChannelForPrincipal(
      deps.db,
      deps.principal!,
      publicationId,
      "Edit a publication draft from the support workspace",
      "write",
    );
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const body = await jsonBody<{ expectedRevision?: unknown; operation?: unknown }>(request);
    return {
      draft: await patchPublicationDraft(
        deps.db,
        access.context,
        draftId,
        Number(body.expectedRevision),
        body.operation as PublicationDraftPatch,
        deps.principal!,
      ),
    };
  });
}
