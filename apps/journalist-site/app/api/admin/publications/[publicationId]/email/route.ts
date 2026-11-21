import { publicationRoute } from "@/lib/admin-api";
import { listPublicationEmailCampaigns } from "@/pipeline/email/campaigns";
import { EMAIL_ACTIVATION_BLOCKERS } from "@/pipeline/email/provider";
import { resolveOutputChannelForPrincipal } from "@/pipeline/orchestration/output-channels";
import { requirePublicationCapability } from "@/pipeline/publications/permissions";
import { emailUnavailableResponse } from "../../../../../../../../shared/email-availability";

type Context = { params: Promise<{ publicationId: string }> };

export async function GET(request: Request, context: Context) {
  const { publicationId } = await context.params;
  return publicationRoute(request, async (deps) => {
    requirePublicationCapability(deps.principal!, "publication:read");
    const publication = await resolveOutputChannelForPrincipal(
      deps.db, deps.principal!, publicationId,
      "Review publication email in the support workspace", "read",
    );
    if (!publication) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    return {
      campaigns: await listPublicationEmailCampaigns(deps.db, publication.context),
      activationBlockers: EMAIL_ACTIVATION_BLOCKERS,
    };
  });
}

export async function POST(request: Request, _context: Context) {
  return publicationRoute(request, async (deps) => {
    requirePublicationCapability(deps.principal!, "publication:write");
    return emailUnavailableResponse();
  });
}
