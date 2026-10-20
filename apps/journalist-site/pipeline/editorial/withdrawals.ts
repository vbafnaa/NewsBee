import type { Db } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import type { Story } from "../editions/stories";

export type Withdrawal = { location_id: string; story_id: string; reason: string; created_at: number; source_refs: [string, string][]; active?: boolean; restored_at?: number };
export async function forLocation(db: Db, locationId: string): Promise<Record<string, Withdrawal>> {
  const rows = await db.collection<Withdrawal>(COLLECTIONS.withdrawals).find({ location_id: locationId, active: { $ne: false } }).sort({ created_at: 1, story_id: 1 }).toArray();
  return Object.fromEntries(rows.map((row) => [row.story_id, row]));
}
export function matching(story: Pick<Story, "id" | "occurrences">, decisions: Record<string, Withdrawal>): Withdrawal[] {
  const references = new Set(story.occurrences.map((item) => `${item.source_id}\0${item.source_event_id}`));
  return Object.values(decisions).filter((decision) => story.id === decision.story_id || decision.source_refs.some(([source, event]) => references.has(`${source}\0${event}`)));
}
export async function withdraw(db: Db, editionId: string, storyId: string, reason: string) {
  reason = reason.trim();
  if (reason.length < 10 || reason.length > 500) throw new Error("A public correction reason must be 10-500 characters");
  const edition = await db.collection(COLLECTIONS.editions).findOne({ id: editionId, status: "published" });
  if (!edition) throw new Error(`No published edition: ${editionId}`);
  const entry = await db.collection(COLLECTIONS.editionEntries).findOne({ edition_id: editionId, disposition: { $ne: "held" }, "result.story.id": storyId });
  if (!entry) throw new Error(`No published story ${storyId} in edition ${editionId}`);
  const existing = await db.collection<Withdrawal>(COLLECTIONS.withdrawals).findOne({ location_id: edition.location_id, story_id: storyId });
  if (existing) {
    if (existing.reason !== reason) throw new Error("Withdrawal already exists; its audit reason cannot be overwritten");
    if (existing.active !== false) return;
    await db.collection<Withdrawal>(COLLECTIONS.withdrawals).updateOne(
      { location_id: edition.location_id, story_id: storyId },
      { $set: { active: true }, $unset: { restored_at: "" } },
    );
    return;
  }
  const refs = (entry.result.story.occurrences ?? []).map((item: {source_id:string;source_event_id:string}) => [item.source_id, item.source_event_id] as [string,string]);
  await db.collection<Withdrawal>(COLLECTIONS.withdrawals).insertOne({ location_id: edition.location_id, story_id: storyId, reason, source_refs: refs, created_at: Date.now() / 1000, active: true });
}
export async function restore(db: Db, locationId: string, storyId: string) {
  const result = await db.collection(COLLECTIONS.withdrawals).updateOne({ location_id: locationId, story_id: storyId, active: { $ne: false } }, { $set: { active: false, restored_at: Date.now() / 1000 } });
  if (!result.matchedCount) throw new Error(`No active withdrawal for story ${storyId}`);
}
export async function list(db: Db, locationId: string, includeRestored = false) {
  return db.collection<Withdrawal>(COLLECTIONS.withdrawals).find({ location_id: locationId, ...(includeRestored ? {} : { active: { $ne: false } }) }).sort({ created_at: 1, story_id: 1 }).toArray();
}
