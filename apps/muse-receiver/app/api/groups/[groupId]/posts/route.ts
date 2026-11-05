import { storage } from "@/lib/storage";
import { findGroup, notFound, type GroupContext } from "@/lib/groups";
import { apiError } from "@/lib/http";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: GroupContext) {
  try {
    const store = storage();
    const group = await findGroup(store, context);
    if (!group) return notFound();
    const pageInput = new URL(request.url).searchParams.get("page") ?? "0";
    const page = /^\d{1,5}$/.test(pageInput) ? Number(pageInput) : 0;
    const [{ posts, hasMore }, reports] = await Promise.all([store.listPosts(group.id, page), store.listReports(group.id)]);
    return Response.json({ posts, reports, page, hasMore });
  } catch (error) { return apiError(error); }
}
