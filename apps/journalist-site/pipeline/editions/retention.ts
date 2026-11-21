import type { Db } from "mongodb";
import type { CollectedItem } from "./assemble";

export const COLLECTED_ITEM_RETENTION_DAYS = 90;

/** A proposed expiry, not authorization to delete evidence. No TTL index is installed. */
export function collectedItemExpiration(createdAt: number): Date {
  const date = new Date((createdAt + COLLECTED_ITEM_RETENTION_DAYS * 86400) * 1000);
  if (!Number.isFinite(createdAt) || createdAt <= 0 || !Number.isFinite(date.getTime())) throw new Error("Invalid collected-item creation time");
  return date;
}

export type RetentionReferenceReview = {
  complete: boolean;
  retainedItemIds: ReadonlySet<string>;
  retainedRunIds: ReadonlySet<string>;
  retainedStoryIds: ReadonlySet<string>;
};

/** Read-only, bounded inventory. A complete review must cover retained drafts, snapshots and releases. */
export async function dryRunCollectedItemRetention(db: Db, options: {
  afterId?: string;
  limit?: number;
  asOf?: Date;
  review?: RetentionReferenceReview;
} = {}) {
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100) || 100));
  const asOf = options.asOf ?? new Date();
  if (!Number.isFinite(asOf.getTime())) throw new Error("Invalid retention inventory time");
  const items = await db.collection<CollectedItem>("collected_items")
    .find(options.afterId ? { _id: { $gt: options.afterId } } : {}, {
      projection: { _id: 1, run_id: 1, story_id: 1, created_at: 1, retention_expires_at: 1 },
    }).sort({ _id: 1 }).limit(limit).toArray();
  const review = options.review;
  const rows = items.map((item) => {
    let expiresAt: Date;
    try { expiresAt = collectedItemExpiration(item.created_at); }
    catch { return { id: item._id, action: "blocked" as const, reason: "invalid_created_at" as const }; }
    if (review?.retainedItemIds.has(item._id) || review?.retainedRunIds.has(item.run_id) || (item.story_id && review?.retainedStoryIds.has(item.story_id))) {
      return { id: item._id, action: "retain" as const, reason: "retained_reference" as const };
    }
    if (!review?.complete) return { id: item._id, action: "blocked" as const, reason: "reference_review_incomplete" as const };
    const stored = item.retention_expires_at;
    if (stored !== undefined && (!(stored instanceof Date) || stored.getTime() !== expiresAt.getTime())) {
      return { id: item._id, action: "blocked" as const, reason: "expiration_conflict" as const };
    }
    return {
      id: item._id, action: stored ? "unchanged" as const : "propose_backfill" as const,
      expiresAt, overdue: expiresAt <= asOf,
    };
  });
  return { dryRun: true as const, deletionEnabled: false as const, rows, nextAfterId: items.length === limit ? items.at(-1)!._id : null };
}
