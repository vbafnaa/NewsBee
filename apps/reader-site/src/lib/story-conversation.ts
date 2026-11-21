import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { withSiteWriter } from "../../../../shared/restore-maintenance";

export type StoryReference = { location_id: string; edition_id: string; story_id: string }
  | { publication_id: string; release_id: string; story_id: string };
export type StoryComment = StoryReference & { _id: string; name: string; message: string; created_at: string; dedupe_key: string; status: "published" | "hidden" };
type Feedback = StoryReference & { _id: string; useful: boolean; updated_at: string };
type RateBucket = { _id: string; count: number; expires_at: Date };
export class StoryConversationError extends Error {
  constructor(message: string, public status = 422) { super(message); }
}
const COMMENTS = "reader_story_comments", FEEDBACK = "reader_story_feedback", LIMITS = "reader_conversation_limits";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const key = (story: StoryReference) => "publication_id" in story
  ? `publication:${JSON.stringify([story.publication_id, story.release_id, story.story_id])}`
  : `${story.location_id}:${story.edition_id}:${story.story_id}`;

export function storyReference(input: Record<string, unknown>): StoryReference {
  const publication = "publication_id" in input || "release_id" in input;
  const legacy = "location_id" in input || "edition_id" in input;
  if (publication === legacy || ["draft_id", "draft", "revision", "preview"].some((field) => field in input)) {
    throw new StoryConversationError("Choose a published story.");
  }
  if (publication) {
    if (![input.publication_id, input.release_id, input.story_id].every((value) => typeof value === "string"
      && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value))) {
      throw new StoryConversationError("Choose a published story.");
    }
    return { publication_id: input.publication_id as string, release_id: input.release_id as string, story_id: input.story_id as string };
  }
  const id = /^[A-Za-z0-9:_-]{1,100}$/;
  if (![input.location_id, input.edition_id, input.story_id].every((value) => typeof value === "string" && id.test(value))) throw new StoryConversationError("Choose a published story.");
  return { location_id: input.location_id as string, edition_id: input.edition_id as string, story_id: input.story_id as string };
}

export function commentInput(input: Record<string, unknown>) {
  const message = typeof input.message === "string" ? input.message.trim().replace(/\r\n?/g, "\n") : "";
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (message.length < 3 || message.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(message)) {
    throw new StoryConversationError("Write a comment between 3 and 2,000 characters.");
  }
  if (name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new StoryConversationError("Keep your name within 80 characters.");
  return { message, name: name || "A neighbor" };
}

async function indexes(db: Db) {
  await Promise.all([
    db.collection(COMMENTS).createIndex({ location_id: 1, edition_id: 1, story_id: 1, status: 1, created_at: -1 }),
    db.collection(COMMENTS).createIndex({ publication_id: 1, release_id: 1, story_id: 1, status: 1, created_at: -1 }),
    db.collection(COMMENTS).createIndex({ dedupe_key: 1 }, { unique: true }),
    db.collection(LIMITS).createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

async function rateLimit(db: Db, address: string, action: "comment" | "feedback", now: Date) {
  // Keep only an hourly digest for abuse prevention; never store a raw IP address.
  const bucket = `${action}:${hash(`${address}:${now.toISOString().slice(0, 13)}`)}`;
  try {
    await db.collection<RateBucket>(LIMITS).findOneAndUpdate(
      { _id: bucket, count: { $lt: action === "comment" ? 10 : 60 } },
      { $inc: { count: 1 }, $setOnInsert: { expires_at: new Date(now.getTime() + 2 * 3600_000) } },
      { upsert: true },
    );
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new StoryConversationError("You have sent several responses recently. Please try again in an hour.", 429);
    throw error;
  }
}

export async function readStoryConversation(db: Db, story: StoryReference, visitor: string) {
  const collection = db.collection<StoryComment>(COMMENTS);
  const filter = { ...story, status: "published" as const };
  const [comments, total, feedback] = await Promise.all([
    collection.find(filter, { projection: { _id: 1, name: 1, message: 1, created_at: 1 } }).sort({ created_at: -1, _id: -1 }).limit(50).toArray(),
    collection.countDocuments(filter),
    db.collection<Feedback>(FEEDBACK).findOne({ _id: hash(`${key(story)}:${visitor}`) }),
  ]);
  return { comments, total, feedback: feedback?.useful ?? null };
}

export async function saveStoryComment(db: Db, story: StoryReference, input: ReturnType<typeof commentInput>, visitor: string, address: string, now = new Date()) {
  return withSiteWriter(db, async () => {
    await indexes(db);
    const collection = db.collection<StoryComment>(COMMENTS);
    const dedupe_key = hash(`${key(story)}:${visitor}:${input.name}:${input.message}:${now.toISOString().slice(0, 10)}`);
    if (await collection.findOne({ dedupe_key }, { projection: { _id: 1 } })) return;
    await rateLimit(db, address, "comment", now);
    try {
      await collection.insertOne({ ...story, ...input, _id: randomUUID(), dedupe_key, status: "published", created_at: now.toISOString() });
    } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  });
}

export async function saveStoryFeedback(db: Db, story: StoryReference, useful: boolean, visitor: string, address: string, now = new Date()) {
  return withSiteWriter(db, async () => {
    await indexes(db);
    await rateLimit(db, address, "feedback", now);
    await db.collection<Feedback>(FEEDBACK).updateOne({ _id: hash(`${key(story)}:${visitor}`) }, {
      $set: { ...story, useful, updated_at: now.toISOString() },
    }, { upsert: true });
  });
}
