import type { Db } from "mongodb";
import type { CachedLinks, LinkCache } from "../connectors/types";
import { COLLECTIONS } from "./mongo";

/** Discovered connector links in MongoDB, one document per (location, source). */
export class MongoLinkCache implements LinkCache {
  constructor(private readonly db: Db) {}

  private get collection() {
    return this.db.collection<CachedLinks>(COLLECTIONS.linkCache);
  }

  async get(locationId: string, sourceId: string) {
    return this.collection.findOne({ location_id: locationId, source_id: sourceId }, { projection: { _id: 0 } });
  }

  async put(entry: Omit<CachedLinks, "discovered_at">) {
    await this.collection.updateOne(
      { location_id: entry.location_id, source_id: entry.source_id },
      { $set: { ...entry, discovered_at: new Date().toISOString() } },
      { upsert: true },
    );
  }

  async invalidate(locationId: string, sourceId?: string) {
    await this.collection.deleteMany(sourceId ? { location_id: locationId, source_id: sourceId } : { location_id: locationId });
  }
}
