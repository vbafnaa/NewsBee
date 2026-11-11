import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { ArtifactStore } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";
import { createOutputChannel } from "../../orchestration/output-channels";
import { readerData } from "../../../../reader-site/src/lib/reader-data";
import { mongoChannelFolderId } from "../../../../../shared/reader-folder";
import { GET, POST } from "../../../app/api/admin/output-channels/[channelId]/editions/route";

const state = vi.hoisted(() => ({ db: null as Db | null, store: null as ArtifactStore | null, owner: "journalist-1" }));
vi.mock("@/lib/admin-api", () => ({
  adminRoute: async (_request: Request, handler: (deps: unknown) => Promise<unknown>) => {
    try {
      const result = await handler({ db: state.db!, store: state.store!, principal: { id: state.owner } });
      return result instanceof Response ? result : Response.json(result);
    } catch (error) {
      return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },
  jsonBody: (request: Request) => request.json(),
}));

const folder = "channel-folder";
const channelId = "a".repeat(32);
const locationId = "town-wa";
const context = { params: Promise.resolve({ channelId }) };
const url = `https://fixture.example.test/api/admin/output-channels/${channelId}/editions`;
const request = (storyId: string) => new Request(url, {
  method: "POST", body: JSON.stringify({
    title: `Story ${storyId}`,
    stories: [{ locationId, storyId, editionId: "source-edition" }],
    outputModes: ["reader"], videoStories: [],
  }),
});
let server: MongoMemoryServer, client: MongoClient, db: Db;
let files: Map<string, unknown>;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("channel-story-routes");
});
beforeEach(async () => {
  await db.dropDatabase();
  files = new Map();
  state.db = db;
  state.owner = "journalist-1";
  state.store = {
    kind: "local", ensureFolder: async () => folder,
    saveText: async () => "", readText: async () => "",
    saveJson: async (parent, name, value) => { files.set(`${parent}/${name}`, value); return `${parent}/${name}`; },
    readJson: async <T>(fileId: string) => files.get(fileId) as T,
    list: async (parent) => [...files.keys()].filter((key) => key.startsWith(`${parent}/`))
      .map((id) => ({ id, name: id.slice(parent.length + 1) })),
    findFolder: async () => null,
    removeFile: async (parent, name) => Number(files.delete(`${parent}/${name}`)),
  };
  await db.collection(COLLECTIONS.locations).insertOne({ _id: locationId, id: locationId, name: "Town, WA", state: "WA", systems: [] });
  await createOutputChannel(db, state.owner, channelId, folder, {
    name: "Town channel", destinations: [{ type: "reader", url: "" }, { type: "video", url: "" }],
    enabled: true, selectedLocationIds: [locationId],
  });
  await db.collection(COLLECTIONS.editions).insertOne({
    id: "source-edition", location_id: locationId, location_name: "Town, WA", status: "published", published_at: 100,
    window_start: "2026-11-01", window_end: "2026-11-08",
    published: { items: [
      { story_id: "story-1", headline: "First story", blurb: "First summary", event_date: "2026-11-08" },
      { story_id: "story-2", headline: "Second story", blurb: "Second summary", event_date: "2026-11-08" },
    ] },
  });
});
afterAll(async () => { await client?.close(); await server?.stop(); });

it("publishes one story at a time without hiding previously published channel stories", async () => {
  const initial = await (await GET(new Request(url), context)).json();
  expect(initial.stories).toMatchObject([{ storyId: "story-1", published: false }, { storyId: "story-2", published: false }]);
  expect(files.size).toBe(0);

  expect((await POST(request("story-1"), context)).status).toBe(201);
  const first = await (await GET(new Request(url), context)).json();
  expect(first.stories.map((story: { published: boolean }) => story.published)).toEqual([true, false]);
  expect((await POST(request("story-1"), context)).status).toBe(409);
  expect((await POST(request("story-2"), context)).status).toBe(201);
  const second = await (await GET(new Request(url), context)).json();
  expect(second.stories.map((story: { published: boolean }) => story.published)).toEqual([true, true]);
  const editions = [...files.values()].filter((file): file is { items: Array<{ story_id: string }> } =>
    typeof file === "object" && file !== null && "items" in file);
  expect(editions.at(-1)?.items.map((item) => item.story_id)).toEqual(["story-1", "story-2"]);
  expect(files.get(`${folder}/locations.json`)).toMatchObject({ locations: [{ id: locationId }] });
});

it("retains both manually published stories in a MongoDB fallback channel feed", async () => {
  const mongoFolder = mongoChannelFolderId(channelId);
  await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: channelId }, { $set: { drive_folder_id: mongoFolder } });
  state.store = { ...state.store!, saveJson: async () => { throw new Error("Drive/local storage must not be used"); } };
  expect((await POST(request("story-1"), context)).status).toBe(201);
  expect((await POST(request("story-2"), context)).status).toBe(201);
  vi.stubEnv("MONGODB_URI", server.getUri());
  vi.stubEnv("MONGODB_DATABASE", "channel-story-routes");
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  try {
    const feed = await readerData(mongoFolder);
    expect(feed.locations).toMatchObject([{ id: locationId }]);
    expect(feed.editions.find((edition) => edition.items.length === 2)?.items.map((item) => item.story_id)).toEqual(["story-1", "story-2"]);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("rejects stale and unassigned story selections", async () => {
  const stale = new Request(url, { method: "POST", body: JSON.stringify({
    title: "Stale", stories: [{ locationId, storyId: "story-1", editionId: "old-edition" }],
    outputModes: ["reader"], videoStories: [],
  }) });
  expect((await POST(stale, context)).status).toBe(409);
  await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: channelId }, { $set: { selected_location_ids: [] } });
  expect((await POST(request("story-1"), context)).status).toBe(422);
  expect(files.size).toBe(0);
});
