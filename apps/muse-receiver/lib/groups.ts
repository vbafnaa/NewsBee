import type { Storage } from "./storage";

export type GroupContext = { params: Promise<{ groupId: string }> };
export async function findGroup(store: Storage, context: GroupContext) {
  const { groupId } = await context.params;
  if (!/^[a-f0-9-]{36}$/.test(groupId)) return null;
  return store.findGroup(groupId);
}
export const notFound = () => Response.json({ error: "Group not found" }, { status: 404 });
