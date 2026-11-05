import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { type Db, MongoClient } from "mongodb";
import { MongoArtifacts } from "../../storage/mongo-artifacts";
import { publishToReader } from "../../orchestration/publish";
import { COLLECTIONS } from "../../storage/mongo";
import { runFolder } from "../../storage/artifacts";
import { readerData } from "../../../../reader-site/src/lib/reader-data";

const location = { id: "seattle-wa", name: "Seattle, WA" };
const edition = {
  id: "edition-seattle-wa", location_id: location.id, location_name: location.name,
  window_start: "2026-10-26", window_end: "2026-11-01", published_at: 1792435200,
  headline: "Seattle this week", intro: "Community news.", items: [],
};

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let store: MongoArtifacts;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await new MongoClient(server.getUri()).connect();
}, 120_000);

beforeEach(() => {
  const name = `test_${Math.random().toString(36).slice(2)}`;
  db = client.db(name);
  store = new MongoArtifacts(async () => db);
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  vi.stubEnv("NEWSBEE_ARTIFACT_STORE", "mongo");
  vi.stubEnv("MONGODB_URI", server.getUri());
  vi.stubEnv("MONGODB_DATABASE", name);
  vi.stubGlobal("newsbeeReaderData", {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await (globalThis as { newsbeeReaderMongo?: { client: MongoClient } }).newsbeeReaderMongo?.client.close();
  await client?.close();
  await server?.stop();
});

describe("MongoDB artifact store", () => {
  it("reuses folders, overwrites files by name and lists only a folder's files", async () => {
    const folder = await store.ensureFolder("root", "channel");
    expect(await store.ensureFolder("root", "channel")).toBe(folder);
    const nested = await store.ensureFolder(folder, "nested");
    const first = await store.saveJson(folder, "a.json", { version: 1 });
    expect(await store.saveJson(folder, "a.json", { version: 2 })).toBe(first);
    await store.saveText(nested, "b.txt", "hidden", "text/plain");
    expect(await store.list(folder)).toEqual([{ id: first, name: "a.json" }]);
    expect(await store.readJson(first)).toEqual({ version: 2 });
    await expect(store.readText(folder)).rejects.toThrow("was not found");
  });

  it("finds folders and removes one file by name, like the Drive store", async () => {
    const folder = await store.ensureFolder("root", "editions");
    expect(await store.findFolder("root", "editions")).toBe(folder);
    expect(await store.findFolder("root", "missing")).toBeNull();
    await store.saveJson(folder, "a.json", { version: 1 });
    expect(await store.removeFile(folder, "a.json")).toBe(1);
    expect(await store.removeFile(folder, "a.json")).toBe(0);
    expect(await store.list(folder)).toEqual([]);
  });

  it("needs no Drive folder for run artifacts", async () => {
    await expect(runFolder(store, "editions", "seattle-wa")).resolves.toMatch(/^[0-9a-f]{32}$/);
  });

  it("lets the reader site read what the pipeline published", async () => {
    const folder = "reader-folder-id";
    await db.collection(COLLECTIONS.locations).insertOne({ _id: location.id as never, ...location, systems: [] });
    await db.collection(COLLECTIONS.editions).insertOne({ location_id: location.id, status: "published" });
    await publishToReader(db, store, edition, folder);
    await expect(readerData(folder)).resolves.toMatchObject({ locations: [location], editions: [edition] });
  });
});
