import type { Db } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";

/** These states retain the newsroom slot, including deliberately paused work. */
export const ACTIVE_PUBLICATION_GENERATION_STATUSES = [
  "starting", "running", "combining", "blocked", "paused", "cancelling",
] as const;
export const EXECUTABLE_PUBLICATION_GENERATION_STATUSES = ["starting", "running", "combining"] as const;
export type PublicationGenerationStatus = typeof ACTIVE_PUBLICATION_GENERATION_STATUSES[number] | "ready" | "failed" | "cancelled";

/** Never create a window in which newly blocked parents no longer own admission. */
export async function ensurePublicationGenerationAdmissionIndex(db: Db) {
  const collection = db.collection(COLLECTIONS.publicationGenerations);
  await collection.createIndex({ admission: 1 }, {
    name: "one_active_publication_generation_v2", unique: true,
    partialFilterExpression: { admission: "newsroom", status: { $in: [...ACTIVE_PUBLICATION_GENERATION_STATUSES] } },
  });
  await collection.dropIndex("one_active_publication_generation").catch((error: { code?: number }) => {
    if (error.code !== 27) throw error;
  });
}

