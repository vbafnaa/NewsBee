import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { commentInput, readStoryConversation, saveStoryComment, saveStoryFeedback, storyReference } from "../../../../reader-site/src/lib/story-conversation";
import { enterMaintenance, fencedDatabase, MaintenanceError } from "../../../../../shared/restore-maintenance";
let server: MongoMemoryServer, client: MongoClient, db: Db, readerDb: Db;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("story-conversation"); });
beforeEach(async () => { await db.dropDatabase(); readerDb = await fencedDatabase(db); });
afterAll(async () => { await client?.close(); await server?.stop(); });
const story = { location_id: "town-wa", edition_id: "edition-1", story_id: "story-1" };
const publicationStory = { publication_id: "town-wa", release_id: "edition-1", story_id: "story-1" };
const now = new Date("2026-11-19T18:00:00Z");
it("persists comments, deduplicates retries, and returns only public fields in the right conversation", async () => {
  const input = commentInput({ message: "This library list is useful.", name: " Alex " });
  await saveStoryComment(readerDb, story, input, "visitor-1", "address-1", now);
  await saveStoryComment(readerDb, story, input, "visitor-1", "address-1", now);
  await saveStoryComment(readerDb, { ...story, story_id: "other-story" }, input, "visitor-1", "address-1", now);
  const result = await readStoryConversation(db, story, "visitor-1");
  expect(result.total).toBe(1); expect(result.comments).toHaveLength(1);
  expect(result.comments[0]).toMatchObject({ name: "Alex", message: input.message, created_at: now.toISOString() });
  expect(result.comments[0]).not.toHaveProperty("dedupe_key"); expect(result.comments[0]).not.toHaveProperty("status");
  await db.collection("reader_story_comments").updateMany({}, { $set: { status: "hidden" } });
  expect((await readStoryConversation(db, story, "visitor-1")).total).toBe(0);
});
it("upserts a reader's helpfulness choice without exposing another reader's feedback", async () => {
  await saveStoryFeedback(readerDb, story, true, "visitor-1", "address-1", now);
  await saveStoryFeedback(readerDb, story, false, "visitor-1", "address-1", now);
  expect(await db.collection("reader_story_feedback").countDocuments()).toBe(1);
  expect((await readStoryConversation(db, story, "visitor-1")).feedback).toBe(false);
  expect((await readStoryConversation(db, story, "visitor-2")).feedback).toBeNull();
});
it("keeps publication conversations separate from legacy editions, other releases, and delimiter collisions", async () => {
  const references = [
    { location_id: "publication:town-wa", edition_id: "edition-1", story_id: "story-1" },
    publicationStory,
    { ...publicationStory, release_id: "edition-2" },
    { ...publicationStory, publication_id: "town-wa:edition-1", release_id: "extra" },
    { ...publicationStory, release_id: "edition-1:extra" },
  ];
  const input = commentInput({ message: "This exact story was useful." });
  for (let index = 0; index < references.length; index++) {
    const reference = references[index];
    await saveStoryComment(readerDb, reference, input, "visitor-1", "address-1", now);
    await saveStoryFeedback(readerDb, reference, index % 2 === 0, "visitor-1", "address-1", now);
  }
  expect(await db.collection("reader_story_comments").countDocuments()).toBe(references.length);
  expect(await db.collection("reader_story_feedback").countDocuments()).toBe(references.length);
  for (let index = 0; index < references.length; index++) {
    const conversation = await readStoryConversation(readerDb, references[index], "visitor-1");
    expect(conversation.total).toBe(1);
    expect(conversation.feedback).toBe(index % 2 === 0);
  }
});
it("accepts exactly one complete published target and rejects mixed or private-preview references", () => {
  expect(storyReference(story)).toEqual(story);
  expect(storyReference(publicationStory)).toEqual(publicationStory);
  expect(storyReference({ ...publicationStory, story_id: "An original item:1" })).toEqual({ ...publicationStory, story_id: "An original item:1" });
  for (const input of [
    { ...story, ...publicationStory }, { ...story, release_id: "release" },
    { publication_id: "paper", story_id: "story" }, { release_id: "release", story_id: "story" },
    { ...publicationStory, draft_id: "private-draft" }, { ...publicationStory, revision: 3 },
    { ...publicationStory, release_id: "" }, { ...publicationStory, story_id: "invalid\nitem" },
  ]) expect(() => storyReference(input)).toThrow("Choose a published story.");
});
it("enforces the hourly comment limit across stories and stores no raw address", async () => {
  for (let i = 0; i < 10; i++) await saveStoryComment(readerDb, { ...story, story_id: `story-${i}` }, commentInput({ message: `Thoughtful comment ${i}` }), "visitor-1", "private-address", now);
  await expect(saveStoryComment(readerDb, story, commentInput({ message: "An extra comment" }), "visitor-2", "private-address", now)).rejects.toMatchObject({ status: 429 });
  const buckets = await db.collection("reader_conversation_limits").find().toArray();
  expect(JSON.stringify(buckets)).not.toContain("private-address"); expect(buckets[0]).toHaveProperty("expires_at");
  await expect(saveStoryComment(readerDb, story, commentInput({ message: "An extra comment" }), "visitor-2", "private-address", new Date("2026-11-19T19:00:00Z"))).resolves.toBeUndefined();
});
it("refuses both conversation writes during maintenance before indexes, rate buckets or content are created", async () => {
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "owner@example.test");
  try {
    const owner = { id: "owner-id", email: "owner@example.test", role: "owner" };
    await db.collection("journalist_admins").insertOne({ principalId: owner.id, email: owner.email, enabled: true });
    await enterMaintenance(db, owner);
    await expect(saveStoryComment(readerDb, story, commentInput({ message: "A thoughtful comment" }), "visitor-1", "address-1", now)).rejects.toBeInstanceOf(MaintenanceError);
    await expect(saveStoryFeedback(readerDb, story, true, "visitor-1", "address-1", now)).rejects.toBeInstanceOf(MaintenanceError);
    await expect(saveStoryComment(readerDb, publicationStory, commentInput({ message: "A thoughtful comment" }), "visitor-1", "address-1", now)).rejects.toBeInstanceOf(MaintenanceError);
    await expect(saveStoryFeedback(readerDb, publicationStory, true, "visitor-1", "address-1", now)).rejects.toBeInstanceOf(MaintenanceError);
    const names = (await db.listCollections().toArray()).map(({ name }) => name);
    expect(names).not.toContain("reader_story_comments");
    expect(names).not.toContain("reader_story_feedback");
    expect(names).not.toContain("reader_conversation_limits");
  } finally { vi.unstubAllEnvs(); }
});
