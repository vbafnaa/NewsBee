import { publicationRoute, jsonBody } from "@/lib/admin-api";
import { publicationOwnership, transferPublicationOwnership } from "@/pipeline/publications/ownership";

type Params = { params: Promise<{ publicationId: string }> };

export async function GET(request: Request, { params }: Params) {
  return publicationRoute(request, async ({ db, principal }) => {
    const { publicationId } = await params;
    return publicationOwnership(db, principal!, publicationId);
  });
}

export async function POST(request: Request, { params }: Params) {
  return publicationRoute(request, async ({ db, principal }) => {
    const { publicationId } = await params;
    return transferPublicationOwnership(db, principal!, publicationId, await jsonBody(request));
  });
}
