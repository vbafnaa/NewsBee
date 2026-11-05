import { storage } from "@/lib/storage";
import { findGroup, notFound, type GroupContext } from "@/lib/groups";
import { apiError } from "@/lib/http";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: GroupContext) {
  try {
    const group = await findGroup(storage(), context);
    return group ? Response.json({ group }) : notFound();
  } catch (error) { return apiError(error); }
}
