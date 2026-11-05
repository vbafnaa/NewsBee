import { MongoClient, type Db } from "mongodb";
import type { Group } from "./validation";

export type StoredPost = {
  groupId: string; key: string; id: string | null; text: string; permalink: string | null;
  sourceLinks: string[]; publishedAt?: string | null; rawTime: string | null; observedAt: string;
  commentCount: number | null; reactions: { total: number | null; kinds: string[]; counts: Record<string, number> };
  contentVerified: boolean; truncated: boolean; foundIn: string[]; lastSeenAt: string;
};
export type StoredReport = {
  id: string; groupId: string; runTime: string; windowStart: string; windowEnd: string;
  status: string; chronologicalStatus: string; recentActivityStatus: string; issues: string[];
  lastHour: string[]; recentActivityTop10: string[]; unknownPublicationTime: string[]; createdAt: string;
};

declare global {
  var museReceiverDb: Promise<Db> | undefined;
}

export function database(): Promise<Db> {
  if (!globalThis.museReceiverDb) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not configured");
    const client = new MongoClient(uri);
    globalThis.museReceiverDb = client.connect().then(async () => {
      const db = client.db(process.env.MONGODB_DATABASE || "muse_receiver");
      await Promise.all([
        db.collection<Group>("groups").createIndex({ url: 1 }, { unique: true }),
        db.collection<StoredPost>("posts").createIndex({ groupId: 1, key: 1 }, { unique: true }),
        db.collection<StoredReport>("reports").createIndex({ groupId: 1, runTime: 1 }, { unique: true }),
      ]);
      return db;
    }).catch(async (error) => {
      globalThis.museReceiverDb = undefined;
      await client.close();
      throw error;
    });
  }
  return globalThis.museReceiverDb;
}
