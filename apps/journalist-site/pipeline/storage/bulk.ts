import type { AnyBulkWriteOperation, Collection, Document } from "mongodb";

/** Ordered bounded batches retain Mongo's per-operation failure details and stop on failure. */
export async function boundedBulkWrite<T extends Document>(collection: Collection<T>, operations: AnyBulkWriteOperation<T>[]) {
  for (let offset = 0; offset < operations.length; offset += 100) {
    await collection.bulkWrite(operations.slice(offset, offset + 100), { ordered: true });
  }
}
