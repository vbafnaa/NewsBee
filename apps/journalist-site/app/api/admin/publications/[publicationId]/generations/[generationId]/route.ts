import { jsonBody, kickPipeline, publicationRoute } from "@/lib/admin-api";
import { recoverPublicationGeneration } from "@/pipeline/publications/generation-recovery";

type Context = { params: Promise<{ publicationId: string; generationId: string }> };

export async function POST(request: Request, context: Context) {
  const { publicationId, generationId } = await context.params;
  return publicationRoute(request, async (deps) => {
    const body = await jsonBody<{ action?: unknown; funding?: unknown; reason?: unknown }>(request);
    if (!["cancel", "retry", "resume"].includes(String(body.action))
      || body.funding !== undefined && !["platform", "personal"].includes(String(body.funding))
      || body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 300)) {
      return Response.json({ detail: "Choose a valid generation recovery action and funding." }, { status: 422 });
    }
    const generation = await recoverPublicationGeneration(deps, deps.principal!, {
      publicationId, generationId, action: body.action as "cancel" | "retry" | "resume",
      funding: body.funding as "platform" | "personal" | undefined, reason: body.reason as string | undefined,
    });
    if (generation && ["starting", "running", "combining"].includes(generation.status)) kickPipeline(deps, request.url);
    return { generation };
  });
}
