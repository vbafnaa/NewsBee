/**
 * A value shared by every location's run on the same day (a national or state-wide feed
 * read once, not once per location). Failed builds are not cached, so a retry refetches.
 */
import type { Db } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";

export async function dayCached<T>(db: Db, key: string, build: () => Promise<T>): Promise<T> {
  const collection = db.collection<{ key: string; value: T }>(COLLECTIONS.wideCache);
  await collection.createIndex({ key: 1 }, { unique: true });
  const cached = await collection.findOne({ key });
  if (cached) return cached.value;
  const value = await build();
  try { await collection.replaceOne({ key }, { key, value }, { upsert: true }); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && (error as { code: number }).code === 11000)) throw error;
    const winner = await collection.findOne({ key });
    if (winner) return winner.value;
  }
  return value;
}
