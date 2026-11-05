import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { approvedStoryImage, approvedReaderStory, saveReaderStory } from "../../../../reader-site/src/lib/reader-data";
import { GET as publicImage } from "../../../../reader-site/src/pages/api/locations/[location_id]/stories/[story_id]/image";
import { decideReaderStory, listReaderStories, storyFacts, storyImageUrl } from "../../connectors/neighbours";
import { READER_STORIES_COLLECTION, type ReaderStory, type ReaderStoryImage } from "../../../../../shared/reader-stories";

let server: MongoMemoryServer, client: MongoClient, db: Db, id: string;
const image: ReaderStoryImage = { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), mime_type: "image/jpeg", caption: "Garden volunteers", credit: "A neighbour", permission_confirmed_at: "2026-10-29T18:00:00Z" };
const location = { id: "fixture-wa", name: "Fixture, WA" };
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("story-image-approval");
  vi.stubEnv("MONGODB_URI", server.getUri());
  vi.stubEnv("MONGODB_DATABASE", db.databaseName);
  id = await saveReaderStory(location, {
    headline: "Neighbours plant a garden", story: "Neighbours planted a garden by the town hall.", topic: "people",
    link: null, event_date: null, submitter_name: "Private Full Name", submitter_email: "private@example.test", credit: "anonymous",
  }, image);
});
afterAll(async () => {
  const cached = globalThis as typeof globalThis & { newsbeeReaderMongo?: { client: MongoClient } };
  await cached.newsbeeReaderMongo?.client.close();
  delete cached.newsbeeReaderMongo;
  await client?.close(); await server?.stop(); vi.unstubAllEnvs();
});
const read = (location_id = location.id) => publicImage({ params: { location_id, story_id: id } } as Parameters<typeof publicImage>[0]);

it("keeps pending photos private, publishes only approval-scoped images, and withdraws access on rejection", async () => {
  expect((await db.collection(READER_STORIES_COLLECTION).findOne({ _id: id as never }))?.status).toBe("pending");
  expect(await approvedReaderStory(location.id, id)).toBeNull();
  expect(await approvedStoryImage(location.id, id)).toBeNull();
  expect((await read()).status).toBe(404);
  const review = await listReaderStories(db);
  expect(review[0].image).toMatchObject({ caption: image.caption, credit: image.credit });
  expect(review[0].image).not.toHaveProperty("data");
  await decideReaderStory(db, id, "approved", "editor@example.test");
  expect(await approvedStoryImage("other-wa", id)).toBeNull();
  expect((await read("other-wa")).status).toBe(404);
  const response = await read();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...Buffer.from(image.data, "base64")]);
  const shared = await approvedReaderStory(location.id, id);
  expect(shared?.image).toEqual({ caption: image.caption, credit: image.credit });
  expect(JSON.stringify(shared)).not.toContain("private@example.test");
  expect(JSON.stringify(shared)).not.toContain("Private Full Name");
  const approved = (await db.collection<ReaderStory>(READER_STORIES_COLLECTION).findOne({ _id: id }))!;
  const facts = storyFacts(approved, "Fixture");
  expect(facts.details).toMatchObject({ image: storyImageUrl(approved) });
  expect(facts.image_credit).toBe(image.credit);
  await decideReaderStory(db, id, "rejected", "editor@example.test");
  expect((await read()).status).toBe(404);
  expect(await approvedReaderStory(location.id, id)).toBeNull();
});
