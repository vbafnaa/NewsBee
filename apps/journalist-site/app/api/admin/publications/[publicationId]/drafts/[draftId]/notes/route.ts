import { jsonBody, publicationRoute } from "@/lib/admin-api";
import {
  createPublicationInterviewNote,
  deletePublicationInterviewNote,
  listPublicationInterviewNotes,
  updatePublicationInterviewNote,
} from "@/pipeline/publications/editorial";
import { requirePublicationCapability } from "@/pipeline/publications/permissions";
import { resolveOutputChannelForPrincipal } from "@/pipeline/orchestration/output-channels";

type Context = { params: Promise<{ publicationId: string; draftId: string }> };

async function accessFor(
  deps: Parameters<Parameters<typeof publicationRoute>[1]>[0],
  publicationId: string,
) {
  requirePublicationCapability(deps.principal!, "publication:write");
  return resolveOutputChannelForPrincipal(
    deps.db,
    deps.principal!,
    publicationId,
    "Change publication interview notes from the support workspace",
    "write",
  );
}

async function readContextFor(
  deps: Parameters<Parameters<typeof publicationRoute>[1]>[0],
  publicationId: string,
  reason: string,
) {
  requirePublicationCapability(deps.principal!, "publication:read");
  const access = await resolveOutputChannelForPrincipal(
    deps.db,
    deps.principal!,
    publicationId,
    reason.trim() || "Review publication interview notes in the support workspace",
  );
  return access?.context ?? null;
}

export async function GET(request: Request, context: Context) {
  const { publicationId, draftId } = await context.params;
  return publicationRoute(request, async (deps) => {
    const parameters = new URL(request.url).searchParams;
    const publicationContext = await readContextFor(deps, publicationId, parameters.get("reason") ?? "");
    if (!publicationContext) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const storyId = parameters.get("storyId") ?? "";
    return { notes: await listPublicationInterviewNotes(deps.db, publicationContext, draftId, storyId) };
  });
}

export async function POST(request: Request, context: Context) {
  const { publicationId, draftId } = await context.params;
  return publicationRoute(request, async (deps) => {
    const access = await accessFor(deps, publicationId);
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const body = await jsonBody<{ storyId?: unknown; expectedDraftRevision?: unknown; note?: unknown }>(request);
    return createPublicationInterviewNote(
      deps.db,
      access.context,
      draftId,
      String(body.storyId ?? ""),
      Number(body.expectedDraftRevision),
      body.note,
      deps.principal!,
    );
  });
}

export async function PATCH(request: Request, context: Context) {
  const { publicationId, draftId } = await context.params;
  return publicationRoute(request, async (deps) => {
    const access = await accessFor(deps, publicationId);
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const body = await jsonBody<{
      storyId?: unknown;
      noteId?: unknown;
      expectedDraftRevision?: unknown;
      expectedNoteRevision?: unknown;
      note?: unknown;
    }>(request);
    return updatePublicationInterviewNote(
      deps.db,
      access.context,
      draftId,
      String(body.storyId ?? ""),
      String(body.noteId ?? ""),
      Number(body.expectedDraftRevision),
      Number(body.expectedNoteRevision),
      body.note,
      deps.principal!,
    );
  });
}

export async function DELETE(request: Request, context: Context) {
  const { publicationId, draftId } = await context.params;
  return publicationRoute(request, async (deps) => {
    const access = await accessFor(deps, publicationId);
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const body = await jsonBody<{
      storyId?: unknown;
      noteId?: unknown;
      expectedDraftRevision?: unknown;
      expectedNoteRevision?: unknown;
    }>(request);
    return deletePublicationInterviewNote(
      deps.db,
      access.context,
      draftId,
      String(body.storyId ?? ""),
      String(body.noteId ?? ""),
      Number(body.expectedDraftRevision),
      Number(body.expectedNoteRevision),
      deps.principal!,
    );
  });
}
