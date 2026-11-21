import { jsonBody, publicationRoute } from "@/lib/admin-api";
import { resolveOutputChannelForPrincipal } from "@/pipeline/orchestration/output-channels";
import { publicationCoverageRequests, requestPublicationCoverage } from "@/pipeline/communities/coverage-requests";

type Context = { params: Promise<{ publicationId: string }> };

async function handle(request: Request, context: Context) {
  const { publicationId } = await context.params;
  return publicationRoute(request, async ({ db, principal }) => {
    const access = await resolveOutputChannelForPrincipal(db, principal!, publicationId,
      "Review or request newsroom coverage preparation", request.method === "POST" ? "write" : "read");
    if (!access) return Response.json({ detail: "Newsroom was not found." }, { status: 404 });
    if (request.method === "GET") return publicationCoverageRequests(db, access.context);
    const body = await jsonBody<{ location_id?: unknown } | null>(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid coverage request: send a request object");
    return requestPublicationCoverage(db, access.context, body.location_id);
  });
}
export const GET = handle;
export const POST = handle;
