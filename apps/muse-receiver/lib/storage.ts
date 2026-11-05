import type { Group, ReportInput } from "./validation";
import type { StoredPost, StoredReport } from "./db";
import { database } from "./db";
import { localStorage } from "./local-storage";
import { postKey } from "./validation";

export type Storage = {
  listGroups(): Promise<Group[]>;
  createGroup(group: Group): Promise<void>;
  findGroup(id: string): Promise<Group | null>;
  saveReport(groupId: string, input: ReportInput, report: StoredReport): Promise<boolean>;
  listPosts(groupId: string, page: number): Promise<{ posts: StoredPost[]; hasMore: boolean }>;
  listReports(groupId: string): Promise<StoredReport[]>;
  exportPosts(groupId: string): AsyncIterable<StoredPost>;
};

export function storage(): Storage {
  if (!process.env.MONGODB_URI) {
    if (process.env.NODE_ENV === "production") throw new Error("MONGODB_URI is not configured");
    return localStorage();
  }
  return mongoStorage;
}

const mongoStorage: Storage = {
  async listGroups() {
    return (await database()).collection<Group>("groups").find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(200).toArray();
  },
  async createGroup(group) { await (await database()).collection<Group>("groups").insertOne(group); },
  async findGroup(id) {
    return (await database()).collection<Group>("groups").findOne({ id }, { projection: { _id: 0 } });
  },
  async saveReport(groupId, input, report) {
    const db = await database();
    const posts = db.collection<StoredPost>("posts");
    if (input.posts.length) {
      await posts.bulkWrite(input.posts.map((post) => ({ updateOne: {
        filter: { groupId, key: postKey(post) },
        update: {
          $setOnInsert: { groupId, key: postKey(post), observedAt: post.observedAt },
          $set: {
            id: post.id, text: post.text, permalink: post.permalink, sourceLinks: post.sourceLinks,
            rawTime: post.rawTime, commentCount: post.commentCount, reactions: post.reactions,
            contentVerified: post.contentVerified, truncated: post.truncated, lastSeenAt: input.runTime,
            ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
          },
          $addToSet: { foundIn: { $each: input.scans.filter((scan) => scan.postRefs.includes(post.ref)).map((scan) => scan.sort) } },
        },
        upsert: true,
      } })), { ordered: false });
    }
    const saved = await db.collection<StoredReport>("reports").updateOne(
      { groupId, runTime: input.runTime },
      { $set: report },
      { upsert: true },
    );
    return saved.upsertedCount > 0;
  },
  async listPosts(groupId, page) {
    const matching = await (await database()).collection<StoredPost>("posts")
      .find({ groupId }, { projection: { _id: 0, groupId: 0 } }).sort({ lastSeenAt: -1 }).skip(page * 50).limit(51).toArray();
    return { posts: matching.slice(0, 50), hasMore: matching.length > 50 };
  },
  async listReports(groupId) {
    return (await database()).collection<StoredReport>("reports").find({ groupId }, { projection: { _id: 0, groupId: 0 } }).sort({ runTime: -1 }).limit(20).toArray();
  },
  async *exportPosts(groupId) {
    const cursor = (await database()).collection<StoredPost>("posts")
      .find({ groupId }, { projection: { _id: 0, groupId: 0 } }).sort({ observedAt: -1 });
    try { for await (const post of cursor) yield post; }
    finally { await cursor.close(); }
  },
};
