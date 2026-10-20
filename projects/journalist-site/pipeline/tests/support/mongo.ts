/** Real MongoDB semantics in tests: one in-memory server per test file. */
import { MongoMemoryServer } from "mongodb-memory-server";
import { type Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { useDatabase } from "../../storage/mongo";

export function withMongo() {
  let server: MongoMemoryServer;
  let client: MongoClient;
  const handle: { db: Db } = { db: undefined as unknown as Db };
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await new MongoClient(server.getUri()).connect();
  }, 120_000);
  beforeEach(async () => {
    handle.db = client.db(`test_${Math.random().toString(36).slice(2)}`);
    useDatabase(handle.db);
  });
  afterAll(async () => {
    useDatabase(null);
    await client?.close();
    await server?.stop();
  });
  return handle;
}
