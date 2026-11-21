import { jsonBody, publicationRoute } from "@/lib/admin-api";
import { createManualPublicationDraft } from "@/pipeline/publications/generation";

type Context = { params: Promise<{ publicationId: string }> };

export async function POST(request: Request, context: Context) {
  const { publicationId } = await context.params;
  return publicationRoute(request, async (deps) => {
    const body = await jsonBody<{ locationIds?: unknown; window?: unknown; idempotencyKey?: unknown }>(request);
    if (!body || !Array.isArray(body.locationIds) || body.locationIds.some((id) => typeof id !== "string")) {
      return Response.json({ detail: "Choose valid edition locations." }, { status: 422 });
    }
    const result = await createManualPublicationDraft(deps.db, deps.principal!, {
      publicationId, locationIds: body.locationIds as string[], window: body.window as [string, string],
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
    });
    return Response.json(result, { status: result.created ? 201 : 200 });
  });
}
