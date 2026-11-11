import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { GET } from "../../../app/api/admin/current-runs/route";
import { currentRuns, newRun, runs, type PipelineRun, type RunStatus } from "../../orchestration/runs";

const state = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock("@/lib/admin-api", () => ({ adminRoute: async (_request: Request, handler: (deps: { db: Db; settings: { runTimeoutSeconds: number } }) => Promise<unknown>) =>
  Response.json(await handler({ db: state.db!, settings: { runTimeoutSeconds: 86_400 } })) }));

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("current-runs");
  state.db = db;
});
afterAll(async () => { await client?.close(); await server?.stop(); });

it("lists every active run across locations, including older waiting runs, but no finished runs", async () => {
  const baseline = newRun({ id: "north", name: "North" }, { kind: "manual", by: "editor" }, "2099-01-01", ["2099-01-01", "2099-01-08"], []);
  const timestamp = Date.now() / 1000;
  const fixture = (id: string, location: string, status: RunStatus, offset: number, kind?: PipelineRun["kind"]): PipelineRun => ({
    ...baseline, _id: id, location_id: location, location_name: location, status, kind, created_at: timestamp + offset,
  });
  await runs(db).insertMany([
    fixture("waiting", "north", "awaiting_authoring", -60),
    fixture("mapped", "north", "mapped", -50, "map"),
    fixture("newer", "north", "collecting", -40, "map"),
    fixture("finishing", "south", "awaiting_finish", -30),
    fixture("paused", "west", "mapping", -20, "map"),
    fixture("published", "south", "published", -10),
    fixture("failed", "west", "failed", 0),
  ]);
  await runs(db).updateOne({ _id: "paused" }, { $set: { execution_blocked: { reason: "credentials", at: timestamp } } });

  const found = await currentRuns(db);
  expect(found.map((run) => run._id)).toEqual(["paused", "finishing", "newer", "waiting"]);
  expect(found[0].execution_blocked?.reason).toBe("credentials");
  expect(found[0]).not.toHaveProperty("sources");
  const response = await GET(new Request("https://fixture.example.test/api/admin/current-runs"));
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.runs.map((run: { _id: string }) => run._id)).toEqual(found.map((run) => run._id));
});
