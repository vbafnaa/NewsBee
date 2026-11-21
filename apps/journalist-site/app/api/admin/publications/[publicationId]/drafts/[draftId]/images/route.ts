import { jsonBody, publicationRoute } from "@/lib/admin-api";
import {
  createPublicationDraftImage,
  removePublicationDraftImage,
} from "@/pipeline/publications/editorial";
import { requirePublicationCapability } from "@/pipeline/publications/permissions";
import { resolveOutputChannelForPrincipal } from "@/pipeline/orchestration/output-channels";

type Context = { params: Promise<{ publicationId: string; draftId: string }> };

export async function POST(request: Request, context: Context) {
  const { publicationId, draftId } = await context.params;
  return publicationRoute(request, async (deps) => {
    requirePublicationCapability(deps.principal!, "publication:write");
    const access = await resolveOutputChannelForPrincipal(
      deps.db,
      deps.principal!,
      publicationId,
      "Attach a publication image from the support workspace",
      "write",
    );
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const body = await jsonBody<{
      storyId?: unknown;
      expectedRevision?: unknown;
      image?: unknown;
    }>(request);
    return createPublicationDraftImage(
      deps.db,
      access.context,
      draftId,
      String(body.storyId ?? ""),
      Number(body.expectedRevision),
      body.image,
      deps.principal!,
    );
  });
}

export async function DELETE(request: Request, context: Context) {
  const { publicationId, draftId } = await context.params;
  return publicationRoute(request, async (deps) => {
    requirePublicationCapability(deps.principal!, "publication:write");
    const access = await resolveOutputChannelForPrincipal(
      deps.db,
      deps.principal!,
      publicationId,
      "Remove a publication image from the support workspace",
      "write",
    );
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const body = await jsonBody<{
      imageId?: unknown;
      expectedRevision?: unknown;
    }>(request);
    return {
      draft: await removePublicationDraftImage(
        deps.db,
        access.context,
        draftId,
        String(body.imageId ?? ""),
        Number(body.expectedRevision),
        deps.principal!,
      ),
    };
  });
}
