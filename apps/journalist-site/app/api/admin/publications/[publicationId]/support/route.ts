import { adminRoute, jsonBody } from "@/lib/admin-api";
import { activePublicationSupport, enterPublicationSupport, exitPublicationSupport } from "@/pipeline/publications/support";

type Context = { params: Promise<{ publicationId: string }> };
const view = (support: Awaited<ReturnType<typeof activePublicationSupport>>) => support ? {
  id: support._id, publicationId: support.publication_id, reason: support.reason,
  enteredAt: support.entered_at, expiresAt: support.expires_at,
} : null;

export async function GET(request: Request, context: Context) {
  return adminRoute(request, async (deps) => ({
    support: view(await activePublicationSupport(deps.db, deps.principal!, (await context.params).publicationId)),
  }));
}

export async function POST(request: Request, context: Context) {
  return adminRoute(request, async (deps) => {
    const { reason } = await jsonBody<{ reason?: unknown }>(request);
    if (typeof reason !== "string" || reason.trim().replace(/\s+/g, " ").length < 10 || reason.trim().length > 300) {
      return Response.json({ detail: "Enter a support reason containing 10 to 300 characters." }, { status: 400 });
    }
    return { support: view(await enterPublicationSupport(deps.db, deps.principal!, (await context.params).publicationId, reason)) };
  });
}

export async function DELETE(request: Request, context: Context) {
  return adminRoute(request, async (deps) => {
    await exitPublicationSupport(deps.db, deps.principal!, (await context.params).publicationId);
    return { support: null };
  });
}
