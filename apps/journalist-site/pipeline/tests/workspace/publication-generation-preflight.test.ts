import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { GET as preflight } from "../../../app/api/admin/publications/[publicationId]/generation-preflight/route";
import { POST as start } from "../../../app/api/admin/publications/[publicationId]/generations/route";
import { infrastructureSettings, SHARED_GENERATION_BUSY_DETAIL, sharedGenerationAvailability } from "../../accounts/execution";
import * as execution from "../../accounts/execution";
import { NO_MODEL } from "../../accounts/runtime";
import { resolveRunOptions } from "../../core/run-options";
import { statusFor } from "../../../lib/admin-error-status";
import { acquireAdmissionLease, releaseLease } from "../../orchestration/jobs";
import { createOutputChannel } from "../../orchestration/output-channels";
import type { OrchestratorDeps } from "../../orchestration/orchestrator";
import { ACTIVE_RUN_STATUSES } from "../../orchestration/runs";
import { ACTIVE_PUBLICATION_GENERATION_STATUSES } from "../../publications/generation-status";
import { COLLECTIONS } from "../../storage/mongo";
import type { ArtifactStore } from "../../storage/artifacts";

const state = vi.hoisted(() => ({ deps: null as OrchestratorDeps | null, kick: vi.fn() }));
vi.mock("@/lib/admin-api", () => ({
  publicationRoute: async (_request: Request, handler: (deps: OrchestratorDeps) => Promise<unknown>) => {
    try {
      const result = await handler(state.deps!);
      return result instanceof Response ? result : Response.json(result);
    } catch (error) {
      return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: statusFor(error) });
    }
  },
  jsonBody: (request: Request) => request.json(),
  kickPipeline: state.kick,
}));

let server: MongoMemoryServer, client: MongoClient, db: Db;
const context = { params: Promise.resolve({ publicationId: "assigned" }) };
const options = resolveRunOptions({ mode: "autopilot", paid: { model: 200 } });
const preflightRequest = () => new Request(`https://fixture.test/api/admin/publications/assigned/generation-preflight?options=${encodeURIComponent(JSON.stringify(options))}`);
const store: ArtifactStore = {
  kind: "local", ensureFolder: async () => "fixture", saveText: async () => "fixture", saveJson: async () => "fixture",
  readText: async () => "", readJson: async <T>() => ({} as T), list: async () => [], findFolder: async () => null, removeFile: async () => 0,
};
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("generation-preflight");
});
beforeEach(async () => {
  await db.dropDatabase();
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "fixture-not-live");
  vi.stubEnv("NEWSBEE_GEMINI_MODEL", "fixture-model");
  state.kick.mockClear();
  const principal = { id: "journalist", email: "journalist@example.test", role: "editor" as const };
  await db.collection("journalist_admins").insertOne({
    principalId: principal.id, email: principal.email, role: principal.role, enabled: true,
  });
  state.deps = { db, settings: infrastructureSettings(), store, model: NO_MODEL, principal };
  await createOutputChannel(db, "owner", "assigned", "mongo:assigned", {
    name: "Assigned newsroom", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: ["one"],
  });
  await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: "assigned" as never }, {
    $set: { members: [{ principal_id: principal.id, role: "editor" }] },
  });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await client?.close(); await server?.stop(); });

it.each(ACTIVE_PUBLICATION_GENERATION_STATUSES)("reports another newsroom's %s parent as busy without exposing or changing its state", async (status) => {
  const foreign = {
    _id: "private-generation", publication_id: "unassigned-newsroom", publication_name: "Private newsroom title",
    initiated_by: "private-actor", initiated_by_email: "private@example.test", admission: "newsroom", status, created_at: 1,
    execution_blocked: { reason: "Private provider and job diagnostic" },
  };
  await db.collection(COLLECTIONS.publicationGenerations).insertOne(foreign);
  const expiredWorker = {
    _id: "private-job-execution", run_id: "private-child", token: "private-token", execution_active: true, lease_until: 1,
  };
  await db.collection(COLLECTIONS.heartbeat).insertOne(expiredWorker);
  const response = await preflight(preflightRequest(), context);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    reasons: [], exhausted: false, source: "platform",
    admission: { available: false, detail: SHARED_GENERATION_BUSY_DETAIL },
  });
  for (const secret of ["private-generation", "unassigned-newsroom", "Private newsroom title", "private-actor", "private@example.test", "diagnostic", "private-child", "private-token"]) {
    expect(JSON.stringify(body)).not.toContain(secret);
  }
  expect(await db.collection(COLLECTIONS.publicationGenerations).findOne({ _id: foreign._id })).toEqual(foreign);
  expect(await db.collection(COLLECTIONS.heartbeat).find().toArray()).toEqual([expiredWorker]);
  expect(await db.collection(COLLECTIONS.runs).countDocuments()).toBe(0);
  expect(await db.collection(COLLECTIONS.jobs).countDocuments()).toBe(0);
});

it.each(ACTIVE_RUN_STATUSES)("uses the same global standalone-run %s blocker rules", async (status) => {
  await db.collection(COLLECTIONS.runs).insertOne({ _id: "foreign-run", location_name: "Private location", status, created_at: 1 });
  expect(await sharedGenerationAvailability(db)).toEqual({ available: false, detail: SHARED_GENERATION_BUSY_DETAIL });
});

it("observes the real admission lease without reserving it and recovers after release or expiry", async () => {
  const lease = await acquireAdmissionLease(db);
  expect(lease).not.toBeNull();
  const before = await db.collection(COLLECTIONS.heartbeat).find().toArray();
  expect((await (await preflight(preflightRequest(), context)).json()).admission.available).toBe(false);
  expect(await db.collection(COLLECTIONS.heartbeat).find().toArray()).toEqual(before);
  await releaseLease(db, lease!);
  expect((await (await preflight(preflightRequest(), context)).json()).admission).toEqual({ available: true, detail: null });
  await db.collection(COLLECTIONS.heartbeat).insertOne({ _id: "run-admission", token: "expired", lease_until: 1 });
  expect((await sharedGenerationAvailability(db)).available).toBe(true);
  expect(await db.collection(COLLECTIONS.heartbeat).findOne({ _id: "run-admission" })).toMatchObject({ token: "expired", lease_until: 1 });
  await db.collection(COLLECTIONS.heartbeat).updateOne({ _id: "run-admission" as never }, { $unset: { lease_until: "" } });
  expect((await sharedGenerationAvailability(db)).available).toBe(false);
  expect(await acquireAdmissionLease(db)).toBeNull();
});

it("blocks an authoritative submit race with a generic conflict and creates no second generation or jobs", async () => {
  expect((await (await preflight(preflightRequest(), context)).json()).admission.available).toBe(true);
  await db.collection(COLLECTIONS.publicationGenerations).insertOne({
    _id: "private-generation", publication_id: "private-publication", publication_name: "Private title",
    admission: "newsroom", status: "running", created_at: 1,
  });
  const response = await start(new Request("https://fixture.test/api/admin/publications/assigned/generations", {
    method: "POST", body: JSON.stringify({
      locationIds: ["one"], window: ["2099-11-02", "2099-11-08"], options, idempotencyKey: "race-fixture",
    }),
  }), context);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: "generation_busy", detail: SHARED_GENERATION_BUSY_DETAIL });
  expect(await db.collection(COLLECTIONS.publicationGenerations).countDocuments()).toBe(1);
  expect(await db.collection(COLLECTIONS.runs).countDocuments()).toBe(0);
  expect(await db.collection(COLLECTIONS.jobs).countDocuments()).toBe(0);
  expect(state.kick).not.toHaveBeenCalled();
  await db.collection(COLLECTIONS.publicationGenerations).updateOne({ _id: "private-generation" as never }, { $set: { status: "ready" } });
  expect((await (await preflight(preflightRequest(), context)).json()).admission.available).toBe(true);
});

it("keeps unavailable admission reads and unassigned access explicit, rather than reporting available", async () => {
  const read = vi.spyOn(execution, "sharedGenerationAvailability").mockRejectedValueOnce(new Error("Fixture admission read unavailable"));
  const failed = await preflight(preflightRequest(), context);
  expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({ detail: "Fixture admission read unavailable" });
  read.mockRestore();
  await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: "assigned" as never }, { $set: { members: [] } });
  const response = await preflight(preflightRequest(), context);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ detail: "Publication was not found." });
});
