import type { Db, Document, Filter } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import { authorizedPublicationFilter, type PublicationContext } from "./access";

type GovernanceDocument = {
  _id: string;
  selected_location_ids?: string[];
  allowed_location_ids?: string[];
  lifecycle_revision?: number;
};

export class PublicationLifecycleConflict extends Error {
  readonly status = 409;
  constructor() {
    super("This publication changed. Your edits have been preserved; reload saved settings before trying again.");
  }
}

/** Legacy scope is only the current selection, never publication history or the Ready catalog. */
export async function ensurePublicationGovernance(db: Db, id: string) {
  await db.collection<GovernanceDocument>(COLLECTIONS.outputChannels).updateOne(
    { _id: id },
    [{ $set: {
      allowed_location_ids: { $ifNull: ["$allowed_location_ids", { $ifNull: ["$selected_location_ids", []] }] },
      lifecycle_revision: { $ifNull: ["$lifecycle_revision", 0] },
    } }],
  );
}

export function publicationLifecycleFilter<T extends Document = Document>(
  context: PublicationContext,
  expectedRevision: number,
): Filter<T> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new PublicationLifecycleConflict();
  return { $and: [
    authorizedPublicationFilter(context),
    expectedRevision === 0
      ? { $or: [{ lifecycle_revision: 0 }, { lifecycle_revision: { $exists: false } }] }
      : { lifecycle_revision: expectedRevision },
  ] } as Filter<T>;
}

export async function claimPublicationLifecycle(db: Db, context: PublicationContext, expectedRevision: number) {
  const result = await db.collection<GovernanceDocument>(COLLECTIONS.outputChannels).updateOne(
    publicationLifecycleFilter(context, expectedRevision),
    { $inc: { lifecycle_revision: 1 } },
  );
  if (!result.matchedCount) throw new PublicationLifecycleConflict();
  return expectedRevision + 1;
}
