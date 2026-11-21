import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { managedRequestDeps, NO_MODEL } from "../../accounts/runtime";
import type { Principal } from "../../accounts/identity";
import { loadSettings } from "../../core/config";
import type { HttpTransport } from "../../core/http";
import { modelBudget, reserveModelAttempt, groundedSearch, startOfDay, usageRecorder } from "../../model/budget";
import { createRuntime, UsageAccountingError } from "../../model/runtime";
import { mongoUsageSink } from "../../model/usage";
import type { OrchestratorDeps } from "../../orchestration/orchestrator";
import type { ArtifactStore } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";
import { fencedDatabase, MaintenanceError, RESTORE_STATE, withSiteWriter } from "../../../../../shared/restore-maintenance";

let server: MongoMemoryServer, client: MongoClient, db: Db;
let dispatched = 0;
const first: Principal = { id: "first", email: "first@example.test", role: "editor" };
const second: Principal = { id: "second", email: "second@example.test", role: "editor" };
const transport: HttpTransport = async (request) => {
  dispatched += 1;
  return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
    candidates: [{ content: { parts: [{ text: "fixture" }] } }],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
  })) };
};
const store: ArtifactStore = {
  kind: "local", ensureFolder: async () => "", saveText: async () => "", saveJson: async () => "",
  readText: async () => "", readJson: async <T>() => ({} as T), list: async () => [], findFolder: async () => null, removeFile: async () => 0,
};
function base(): OrchestratorDeps { return { db, settings: loadSettings({ NEWSBEE_MODE: "cloud" }), model: NO_MODEL, store, transport }; }
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("managed-model-budget"); });
beforeEach(async () => {
  await db.dropDatabase(); dispatched = 0;
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "fixture-not-live");
  vi.stubEnv("NEWSBEE_MODEL_DAILY_CALLS", "2");
  await db.collection("journalist_admins").insertMany([first, second].map((person) => ({ email: person.email, principalId: person.id, role: person.role, enabled: true })));
  await db.collection(COLLECTIONS.outputChannels).insertOne({
    _id: "assigned" as never, owner_id: "owner", enabled: true,
    members: [first, second].map((person) => ({ principal_id: person.id, role: "editor" })),
  });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await client?.close(); await server?.stop(); });

it("atomically shares the final UTC daily slot across initiating journalists", async () => {
  await db.collection(COLLECTIONS.modelUsage).insertOne({ funding: "platform", sponsor_id: "someone-else", role: "writing", created_at: Date.now() / 1000 });
  const [a, b] = await Promise.all([
    managedRequestDeps(base(), first, { runId: "parent", role: "writing" }),
    managedRequestDeps(base(), second, { runId: "child", role: "ranking" }),
  ]);
  const result = await Promise.allSettled([a.discoveryModel.generate("a"), b.discoveryModel.generate("b")]);
  expect(result.filter((row) => row.status === "fulfilled")).toHaveLength(1);
  expect(result.filter((row) => row.status === "rejected")).toHaveLength(1);
  expect(dispatched).toBe(1);
  expect(await modelBudget(db, a.settings)).toMatchObject({ scope: "managed_platform", used: 2, remaining: 0, exhausted: true, reserved_or_unrecorded: 0 });
  expect(await db.collection(COLLECTIONS.modelUsage).countDocuments({ funding_identity: "managed" })).toBe(1);
});

it("counts parent/child, vision and grounded attempts once without charging readiness reads", async () => {
  vi.stubEnv("NEWSBEE_MODEL_DAILY_CALLS", "3");
  const parent = await managedRequestDeps(base(), first, { runId: "parent", role: "writing" });
  const child = await managedRequestDeps(base(), first, { runId: "child", role: "extraction" });
  expect((await modelBudget(db, parent.settings)).used).toBe(0);
  expect(await db.collection("run_budgets").countDocuments()).toBe(0);
  await parent.discoveryModel.generate("parent");
  await child.discoveryModel.generateVisionStructured!("child", [{ id: "image", mimeType: "image/png", data: "YWJj" }], {});
  await groundedSearch(child.settings, "grounded", transport, usageRecorder(db, child.settings, "discovery"));
  expect(dispatched).toBe(3);
  expect(await modelBudget(db, child.settings)).toMatchObject({ used: 3, remaining: 0, unknown_historical_calls: 0 });
  const usage = await db.collection(COLLECTIONS.modelUsage).find().toArray();
  expect(usage).toHaveLength(3);
  for (const row of usage) expect(row).toMatchObject({ funding: "platform", funding_identity: "managed", sponsor_id: first.id, initiator_id: first.id });
  expect(usage.map((row) => row.operation)).toContain("generate_vision_structured");
  await expect(parent.discoveryModel.generate("too many")).rejects.toThrow("allowance exhausted");
  expect(dispatched).toBe(3);
});

it("seeds existing unknown usage conservatively without relabeling it or pooling personal/environment history", async () => {
  const at = Date.now() / 1000;
  await db.collection(COLLECTIONS.modelUsage).insertMany([
    { role: "writing", created_at: at }, { funding: "personal", sponsor_id: first.id, role: "writing", created_at: at },
    { funding: "environment", sponsor_id: second.id, role: "writing", created_at: at },
    { funding: "platform", role: "writing", created_at: startOfDay() - 1 },
  ]);
  const managed = await managedRequestDeps(base(), second, { runId: "new", role: "writing" });
  await managed.discoveryModel.generate("new");
  expect(await modelBudget(db, managed.settings)).toMatchObject({ used: 2, unknown_historical_calls: 1 });
  expect(await db.collection(COLLECTIONS.modelUsage).countDocuments({ funding: { $exists: false } })).toBe(1);
  await expect(managed.discoveryModel.generate("full")).rejects.toThrow("allowance exhausted");
  const tomorrow = Date.now() + 86400_000;
  await reserveModelAttempt(db, managed.settings, { funding: "platform" }, tomorrow);
  expect((await modelBudget(db, managed.settings)).used).toBe(2);
});

it("records and reserves each compatibility retry, not each wrapper check", async () => {
  const settings = loadSettings({ NEWSBEE_MODE: "cloud", NEWSBEE_MODEL_PROVIDERS: "example",
    NEWSBEE_LLM_EXAMPLE_BASE_URL: "https://fixture.test/v1", NEWSBEE_LLM_EXAMPLE_MODEL: "writer", NEWSBEE_LLM_EXAMPLE_API_KEY: "fixture", NEWSBEE_MODEL_DAILY_CALLS: "2" });
  const retryTransport: HttpTransport = async (request) => {
    dispatched += 1;
    return { url: request.url, status: dispatched === 1 ? 400 : 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(dispatched === 1
      ? { error: "temperature unsupported" } : { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } })) };
  };
  const sink = mongoUsageSink(db);
  const model = createRuntime(settings, retryTransport, undefined, {
    role: "writing", beforeDispatch: () => reserveModelAttempt(db, settings, { funding: "platform" }),
    sink: (call) => sink({ ...call, funding: "platform", funding_identity: "managed" }),
  });
  expect(await model.generate("fixture")).toBe("ok");
  expect(dispatched).toBe(2);
  expect(await db.collection(COLLECTIONS.modelUsage).countDocuments()).toBe(2);
  expect(await modelBudget(db, settings)).toMatchObject({ used: 2, reserved_or_unrecorded: 0 });
});

it("surfaces accounting failure without retrying a completed provider call or fallback", async () => {
  const settings = loadSettings({ NEWSBEE_MODE: "cloud", NEWSBEE_MODEL_PROVIDERS: "gemini,example", NEWSBEE_GEMINI_API_KEY: "fixture",
    NEWSBEE_LLM_EXAMPLE_BASE_URL: "https://fixture.test/v1", NEWSBEE_LLM_EXAMPLE_MODEL: "writer", NEWSBEE_LLM_EXAMPLE_API_KEY: "fixture" });
  const runtime = createRuntime(settings, transport, undefined, { role: "writing", sink: async () => { throw new Error("accounting unavailable"); } });
  await expect(runtime.generate("fixture")).rejects.toBeInstanceOf(UsageAccountingError);
  expect(dispatched).toBe(1);
  const recorder = usageRecorder(db, settings, "discovery");
  await client.close();
  await expect(recorder(true, null, { provider: "gemini", model: "fixture" })).rejects.toBeInstanceOf(UsageAccountingError);
  client = await MongoClient.connect(server.getUri()); db = client.db("managed-model-budget");
});

it("retains Restore07 admission through provider completion and usage, preserving maintenance 503", async () => {
  const fenced = await fencedDatabase(db);
  const heldTransport: HttpTransport = async (request) => {
    const state = await db.collection(RESTORE_STATE).findOne({ _id: "site" as never });
    expect(state?.writers).toHaveLength(1);
    await db.collection(RESTORE_STATE).updateOne({ _id: "site" as never }, { $set: { phase: "draining" }, $inc: { epoch: 1 } });
    return transport(request);
  };
  const managed = await managedRequestDeps({ ...base(), db: fenced, transport: heldTransport }, first, { runId: "admitted", role: "writing" });
  await expect(withSiteWriter(fenced, () => managed.discoveryModel.generate("admitted"))).resolves.toBe("fixture");
  expect(await db.collection(COLLECTIONS.modelUsage).findOne({ run_id: "admitted" })).toMatchObject({ funding: "platform", ok: true });
  expect((await db.collection(RESTORE_STATE).findOne({ _id: "site" as never }))?.writers).toEqual([]);
  await expect(reserveModelAttempt(fenced, managed.settings)).rejects.toBeInstanceOf(MaintenanceError);
  await expect(withSiteWriter(fenced, () => managed.discoveryModel.generate("closed"))).rejects.toMatchObject({ status: 503 });
  expect(dispatched).toBe(1);
});
