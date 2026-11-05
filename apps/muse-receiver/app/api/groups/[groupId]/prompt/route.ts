import { storage } from "@/lib/storage";
import { findGroup, notFound, type GroupContext } from "@/lib/groups";
import { apiError } from "@/lib/http";
import { groupPrompt, reportUrl } from "@/lib/prompt";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: GroupContext) {
  try {
    const group = await findGroup(storage(), context);
    if (!group) return notFound();
    const endpoint = reportUrl(group, request.url);
    return Response.json({ prompt: groupPrompt(group, endpoint), reportUrl: endpoint });
  } catch (error) { return apiError(error); }
}
