import { randomBytes } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from "vitest";
import { GET as permissions, POST as reconnect } from "../../../app/api/admin/execution/route";
import { GET as runOptions } from "../../../app/api/admin/run-options/route";
import { GET as generations } from "../../../app/api/admin/publications/[publicationId]/generations/route";
import { GET as generationPreflight } from "../../../app/api/admin/publications/[publicationId]/generation-preflight/route";
import { saveCredentialProfile } from "../../accounts/credentials";
import { principalForEmail, type Principal } from "../../accounts/identity";
import { assertGlobalAdmission, infrastructureSettings, prepareBinding } from "../../accounts/execution";
import { NO_MODEL } from "../../accounts/runtime";
import { resolveRunOptions } from "../../core/run-options";
import { ensureRunIndexes, getRun, newRun, runs } from "../../orchestration/runs";
import { type OrchestratorDeps } from "../../orchestration/orchestrator";
import { COLLECTIONS } from "../../storage/mongo";
import type { ArtifactStore } from "../../storage/artifacts";
import type { LocationProfile } from "../../connectors/types";
import { createOutputChannel } from "../../orchestration/output-channels";

const state = vi.hoisted(() => ({ deps: null as OrchestratorDeps | null, kick: vi.fn() }));
vi.mock("@/lib/admin-api", () => ({
  publicationRoute: async (_request: Request, handler: (deps: OrchestratorDeps) => Promise<unknown>) => {
    try { const result = await handler(state.deps!); return result instanceof Response ? result : Response.json(result); }
    catch (error) { return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 403 }); }
  },
  adminRoute: async (_request: Request, handler: (deps: OrchestratorDeps) => Promise<unknown>) => {
    try { return Response.json(await handler(state.deps!)); }
    catch (error) { return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 403 }); }
  },
  // Operators as before; a journalist's scope is resolved exactly as the real wrapper does.
  newsroomScopedRoute: async (request: Request, handler: (deps: OrchestratorDeps, scope: unknown) => Promise<unknown>) => {
    try {
      const { resolveLocationScope } = await import("@/pipeline/publications/newsroom-scope");
      const scope = await resolveLocationScope(state.deps!.db, state.deps!.principal!, new URL(request.url).searchParams.get("publication"));
      return Response.json(await handler(state.deps!, scope));
    } catch (error) { return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 403 }); }
  },
  jsonBody: (request: Request) => request.json(),
  kickPipeline: state.kick,
}));
let server: MongoMemoryServer, client: MongoClient, db: Db, owner: Principal, editor: Principal;
const choices = () => resolveRunOptions({ mode: "manual", paid: { gemini: 10, openai_compatible: 10 } });
const store: ArtifactStore = {
  kind: "local", ensureFolder: async () => "fixture", saveText: async () => "fixture", saveJson: async () => "fixture",
  readText: async () => "", readJson: async <T>() => ({} as T), list: async () => [], findFolder: async () => null, removeFile: async () => 0,
};
const request = (path: string, value: unknown) => new Request(`https://fixture.example.test/api/admin/${path}`, { method: "POST", body: JSON.stringify(value) });
async function save() {
  await saveCredentialProfile(db, editor, { source: "personal", config: { modelProviders: [{ name: "gemini", kind: "gemini", model: "fixture-model", apiKey: "fixture-not-live" }] } });
}
async function seedRun() {
  const options = choices();
  const run = newRun({ id: "one", name: "Fixture one" }, { kind: "manual", by: editor.email }, "2099-01-01", ["2099-01-01", "2099-01-08"], [], null, null, options);
  run.admission = "newsroom";
  run.execution = await prepareBinding(db, state.deps!.settings, editor, "one", "edition", options);
  await runs(db).insertOne(run);
  return run;
}
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("isolated-execution-routes"); });
beforeEach(async () => {
  vi.stubEnv("NEWSBEE_MODE", "cloud"); vi.stubEnv("NEWSBEE_OWNER_EMAIL", "owner@example.test");
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini"); vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "fixture-managed-model-key");
  vi.stubEnv("NEWSBEE_CREDENTIAL_KEYS", JSON.stringify({ fixture: randomBytes(32).toString("base64") }));
  vi.stubEnv("NEWSBEE_CREDENTIAL_ACTIVE_KEY", "fixture");
  await db.dropDatabase(); state.kick.mockClear();
  owner = (await principalForEmail(db, "owner@example.test"))!;
  await db.collection("journalist_admins").insertOne({ email: "editor@example.test", principalId: "editor", enabled: true, role: "editor" });
  editor = (await principalForEmail(db, "editor@example.test"))!;
  await db.collection<LocationProfile & { _id: string }>(COLLECTIONS.locations).insertOne({ _id: "one", id: "one", name: "Fixture one", state: "WA", systems: [], government: null });
  await ensureRunIndexes(db);
  state.deps = { db, settings: infrastructureSettings(), store, model: NO_MODEL, principal: editor };
  await createOutputChannel(db, owner.id, "assigned", "mongo:assigned", {
    name: "Assigned newsroom", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: ["one"],
  });
  await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: "assigned" as never }, {
    $set: { members: [{ principal_id: editor.id, role: "editor" }] },
  });
  await save();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await client?.close(); await server?.stop(); });

it("reports separate edition/map capabilities without requiring paid search for standard editions", async () => {
  const options = { ...choices(), flow: "current", map_flow: "agentic" };
  const response = await permissions(new Request(`https://fixture.example.test/api/admin/execution?options=${encodeURIComponent(JSON.stringify(options))}`));
  const data = await response.json();
  expect(data.canStartEdition).toBe(true);
  expect(data.canStartMap).toBe(false);
  expect(data.editionReasons).toEqual([]);
  expect(data.mapReasons.join(" ")).toContain("serpapi");
  expect(data.reasons.join(" ")).toContain("Source map:");
});
it("includes one explicitly selected old personal run before resolving legacy policy, without widening history or authority", async () => {
  const old = await seedRun();
  await runs(db).insertMany(Array.from({ length: 205 }, (_, index) => ({
    ...old, _id: `newer-${index}`, created_at: old.created_at + index + 1, status: "failed" as const, execution: undefined,
  })));
  const url = "https://fixture.example.test/api/admin/execution";
  const recent = await (await permissions(new Request(url))).json();
  expect(Object.keys(recent.permissions)).toHaveLength(200);
  expect(recent.permissions[old._id]).toBeUndefined();
  const selected = () => permissions(new Request(`${url}?run=${old._id}`)).then((response) => response.json());
  const current = await selected();
  expect(Object.keys(current.permissions)).toHaveLength(201);
  expect(current.permissions[old._id]).toMatchObject({ canSpend: true, canReconnect: false, canClaim: false });
  await save();
  expect((await selected()).permissions[old._id]).toMatchObject({ canSpend: false, canReconnect: true });
  state.deps!.principal = owner;
  expect((await selected()).permissions[old._id]).toMatchObject({ canSpend: false, canReconnect: false, canClaim: false });
  const missing = await (await permissions(new Request(`${url}?run=missing`))).json();
  expect(Object.keys(missing.permissions)).toHaveLength(200);
  expect(missing.permissions.missing).toBeUndefined();
});
it("routes parent and child blockers to real publication context, and standalone source runs to collect-sources", async () => {
  const url = new Request("https://fixture.example.test/api/admin/execution");
  await db.collection(COLLECTIONS.publicationGenerations).insertOne({
    _id: "combined", publication_id: "real-publication", publication_name: "Combined draft", status: "running", created_at: 1,
  });
  expect((await (await permissions(url)).json()).blocker).toMatchObject({
    id: "combined", kind: "publication_generation", publicationGenerationId: "combined", href: "/newsroom/real-publication?generation=combined",
  });
  const child = await seedRun();
  await runs(db).updateOne({ _id: child._id }, { $set: { admission: "publication", publication_generation_id: "combined" } });
  expect((await (await permissions(url)).json()).blocker).toMatchObject({
    id: child._id, kind: "publication_child", publicationGenerationId: "combined", href: "/newsroom/real-publication?generation=combined",
  });
  await expect(assertGlobalAdmission(db)).rejects.toThrow("Open /newsroom/real-publication");
  await db.collection(COLLECTIONS.publicationGenerations).deleteOne({ _id: "combined" });
  expect((await (await permissions(url)).json()).blocker).toMatchObject({ kind: "publication_child", href: null });
  await expect(assertGlobalAdmission(db)).rejects.toThrow("Combined draft context is unavailable");
  await runs(db).updateOne({ _id: child._id }, {
    $unset: { publication_generation_id: "" }, $set: { admission: "newsroom", kind: "map" },
  });
  expect((await (await permissions(url)).json()).blocker).toMatchObject({
    kind: "run", publicationGenerationId: null, href: `/locations/one?tab=collect-sources&run=${child._id}`,
  });
  await expect(assertGlobalAdmission(db)).rejects.toThrow(`Open /locations/one?tab=collect-sources&run=${child._id}`);
  await runs(db).updateOne({ _id: child._id }, { $set: { kind: "edition" } });
  expect((await (await permissions(url)).json()).blocker.href).toBe(`/locations/one?tab=edition&run=${child._id}`);
});
it("reports managed deployment readiness to owners and profile-less editors", async () => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "fixture-deployment-never-live");
  state.deps!.principal = owner;
  const url = new Request("https://fixture.example.test/api/admin/execution");
  const data = await (await permissions(url)).json();
  expect(data).toMatchObject({ canStart: true, canStartEdition: true, canStartMap: true, reasons: [] });
  const info = await (await runOptions(url)).json();
  expect(info).toMatchObject({ credentialSource: "environment", configured: { model: true }, defaults: { paid: { model: 200 } } });
  expect(JSON.stringify(info)).not.toContain("fixture-deployment-never-live");
  expect(await db.collection("journalist_credentials").countDocuments({ _id: owner.id })).toBe(0);
  await db.collection("journalist_admins").insertOne({ principalId: "other", email: "other@example.test", enabled: true });
  state.deps!.principal = { id: "other", email: "other@example.test", role: "editor" };
  expect(await (await permissions(url)).json()).toMatchObject({ canStart: false, reasons: [expect.stringContaining("assigned newsroom")] });
  await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: "assigned" as never }, {
    $push: { members: { principal_id: "other", role: "editor" } },
  });
  expect(await (await permissions(url)).json()).toMatchObject({ credentialSource: "platform", canStart: true, reasons: [] });
  expect(await db.collection("journalist_credentials").countDocuments({ _id: "other" })).toBe(0);
});

it("opens provider-free newsroom inspection and writing setup with broken Admin credentials while generation remains blocked", async () => {
  const admin: Principal = { id: "admin", email: "admin@example.test", role: "admin" };
  await db.collection("journalist_admins").insertOne({ email: admin.email, principalId: admin.id, enabled: true, role: "admin" });
  await db.collection("journalist_credentials").insertOne({
    _id: admin.id as never, source: "personal", version: 1, revoked: false,
    keyId: "unavailable", iv: "invalid", tag: "invalid", ciphertext: "invalid",
  });
  state.deps!.principal = admin;
  const context = { params: Promise.resolve({ publicationId: "assigned" }) };
  const url = "https://fixture.example.test/api/admin/publications/assigned/generations";
  const inspected = await generations(new Request(url), context);
  expect(inspected.status).toBe(200);
  expect(await inspected.json()).toMatchObject({
    publication: { canWrite: false }, execution: { funding: "personal" }, draft: null, generations: [],
  });
  await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: "assigned" as never }, {
    $push: { members: { principal_id: admin.id, role: "editor" } },
  });
  const writable = await generations(new Request(url), context);
  expect(writable.status).toBe(200);
  expect(await writable.json()).toMatchObject({ publication: { canWrite: true }, defaultOptions: { paid: { model: 200 } } });
  const preflight = await generationPreflight(new Request(`${url}-preflight`), context);
  expect(preflight.status).toBe(403);
  expect(await db.collection("run_budgets").countDocuments()).toBe(0);
  expect(await runs(db).countDocuments()).toBe(0);
  expect(state.kick).not.toHaveBeenCalled();
});
it("reports deployment integrations as managed run options without exposing their values", async () => {
  await db.collection("journalist_credentials").deleteOne({ _id: editor.id });
  vi.stubEnv("NEWSBEE_BRIGHTDATA_API_KEY", "fixture-brightdata-key");
  vi.stubEnv("NEWSBEE_BRIGHTDATA_ZONE", "fixture-serp-zone");
  vi.stubEnv("NEWSBEE_BRIGHTDATA_UNLOCKER_ZONE", "fixture-unlocker-zone");
  vi.stubEnv("NEWSBEE_EXA_API_KEY", "fixture-exa-key");
  vi.stubEnv("NEWSBEE_TAVILY_API_KEY", "fixture-tavily-key");

  // Journalists read run options from the newsroom they work in.
  const response = await runOptions(new Request("https://fixture.example.test/api/admin/run-options?publication=assigned"));
  const info = await response.json();
  expect(info).toMatchObject({ credentialSource: "platform", configured: { brightdata: true, brightdata_open: true, exa: true, tavily: true } });
  expect(JSON.stringify(info)).not.toContain("fixture-brightdata-key");
  expect(JSON.stringify(info)).not.toContain("fixture-serp-zone");
  expect(JSON.stringify(info)).not.toContain("fixture-exa-key");
  expect(JSON.stringify(info)).not.toContain("fixture-tavily-key");
});
it("blocks an editor's old environment selection and reconnects only after personal replacement", async () => {
  const run = await seedRun();
  await db.collection("journalist_credentials").replaceOne({ _id: editor.id }, { _id: editor.id, source: "environment", version: 1, revoked: false } as never);
  await runs(db).updateOne({ _id: run._id }, { $set: { "execution.source": "environment" } });
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "fixture-server-not-live");
  const url = new Request("https://fixture.example.test/api/admin/execution");
  const data = await (await permissions(url)).json();
  expect(data).toMatchObject({ canStart: false, editionReasons: [], blocker: { id: run._id } });
  expect(data.permissions[run._id]).toMatchObject({ canSpend: false, canReconnect: true });
  const info = await (await runOptions(new Request("https://fixture.example.test/api/admin/run-options?publication=assigned"))).json();
  expect(info).toMatchObject({ credentialSource: "platform", configured: { model: true, agent_model: true, serpapi: false } });
  expect(JSON.stringify(info)).not.toContain("fixture-server-not-live");
  expect((await reconnect(request("execution", { action: "reconnect", runId: run._id }))).status).toBe(403);
  expect(state.kick).not.toHaveBeenCalled();
  expect((await getRun(db, run._id))?.execution?.source).toBe("environment");
  await save();
  const before = await (await permissions(url)).json();
  expect(before.permissions[run._id].canSpend).toBe(false);
  expect((await reconnect(request("execution", { action: "reconnect", runId: run._id }))).status).toBe(200);
  expect((await getRun(db, run._id))?.execution).toMatchObject({ sponsorId: editor.id, source: "personal", credentialVersion: 2 });
  const after = await (await permissions(url)).json();
  expect(after.permissions[run._id].canSpend).toBe(true);
  expect(state.kick).toHaveBeenCalledOnce();
});
it("checks missing owner deployment configuration and personal budgets", async () => {
  state.deps!.principal = owner;
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", ""); vi.stubEnv("GOOGLE_AI_STUDIO_API_KEY", "");
  const url = new Request("https://fixture.example.test/api/admin/execution");
  expect(await (await permissions(url)).json()).toMatchObject({ canStart: false, reasons: [expect.stringContaining("Deployment defaults have no model")] });
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "fixture-not-live");
  await saveCredentialProfile(db, owner, { source: "personal", config: { modelProviders: [{ name: "gemini", kind: "gemini", model: "fixture-owner", apiKey: "fixture-personal" }] } });
  const noBudget = new Request(`${url.url}?options=${encodeURIComponent(JSON.stringify({ ...choices(), paid: {} }))}`);
  expect(await (await permissions(noBudget)).json()).toMatchObject({ canStartEdition: false, editionReasons: [expect.stringContaining("paid-call budget")] });
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "openai"); vi.stubEnv("NEWSBEE_LLM_OPENAI_MODEL", "");
  expect(await (await permissions(url)).json()).toMatchObject({ canStart: false, reasons: [expect.stringContaining("NEWSBEE_LLM_OPENAI_MODEL")] });
  expect(state.kick).not.toHaveBeenCalled();
});
it("allows only the owner to claim legacy work with deployment defaults and reconnect after replacement", async () => {
  state.deps!.principal = owner;
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini"); vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "fixture-owner-not-live");
  const run = newRun({ id: "one", name: "Fixture one" }, { kind: "manual", by: "legacy" }, "2099-01-01", ["2099-01-01", "2099-01-08"], [], null, null, choices());
  await runs(db).insertOne(run);
  expect((await reconnect(request("execution", { action: "claim", runId: run._id }))).status).toBe(200);
  expect((await getRun(db, run._id))?.execution).toMatchObject({ sponsorId: owner.id, source: "environment", credentialVersion: 0 });
  await saveCredentialProfile(db, owner, { source: "environment" });
  const data = await (await permissions(new Request("https://fixture.example.test/api/admin/execution"))).json();
  expect(data.permissions[run._id]).toMatchObject({ canSpend: false, canReconnect: true });
  expect((await reconnect(request("execution", { action: "reconnect", runId: run._id }))).status).toBe(200);
  expect((await getRun(db, run._id))?.execution).toMatchObject({ source: "environment", credentialVersion: 1 });
});
it("checks restart against the old run's kind and saved choices, not combined new-run panel readiness", async () => {
  const options = { ...choices(), flow: "current" as const, map_flow: "agentic" as const };
  const edition = newRun({ id: "one", name: "Fixture one" }, { kind: "manual", by: "legacy" }, "2099-01-01", ["2099-01-01", "2099-01-08"], [], null, null, options);
  edition.status = "failed";
  const map = { ...edition, _id: "legacy-map", kind: "map" as const };
  await runs(db).insertMany([edition, map]);
  const panel = { ...options, flow: "agentic" };
  const data = await (await permissions(new Request(`https://fixture.example.test/api/admin/execution?options=${encodeURIComponent(JSON.stringify(panel))}`))).json();
  expect(data.canStart).toBe(false);
  expect(data.permissions[edition._id]).toMatchObject({ canSpend: false, canClaim: false, canReconnect: false, canRestart: true, restartReason: null, reason: expect.stringContaining("Legacy history") });
  expect(data.permissions[map._id]).toMatchObject({ canSpend: false, canRestart: false, restartReason: expect.stringContaining("serpapi") });
});
it("does not enable restart or spending through paused global slots or historical conflicts", async () => {
  const old = await seedRun();
  await runs(db).updateOne({ _id: old._id }, { $set: { status: "failed" } });
  const active = await seedRun();
  await runs(db).updateOne({ _id: active._id }, { $set: { execution_blocked: { reason: "Fixture sponsor settings changed", at: 1 } } });
  const url = new Request("https://fixture.example.test/api/admin/execution");
  let data = await (await permissions(url)).json();
  expect(data.canStart).toBe(false);
  expect(data.permissions[old._id]).toMatchObject({ canSpend: false, canRestart: false, reason: expect.stringContaining("Newsroom slot"), restartReason: expect.stringContaining("Newsroom slot") });
  expect(data.permissions[active._id]).toMatchObject({ canSpend: false, canReconnect: true, reason: "Fixture sponsor settings changed" });
  await runs(db).updateOne({ _id: active._id }, { $unset: { execution: "", execution_blocked: "" } });
  data = await (await permissions(url)).json();
  expect(data.permissions[active._id]).toMatchObject({ canSpend: false, canClaim: false, reason: expect.stringContaining("Legacy run") });
  state.deps!.principal = owner;
  data = await (await permissions(url)).json();
  expect(data.permissions[active._id]).toMatchObject({ canSpend: false, canClaim: true });
  expect(data.permissions[old._id].canRestart).toBe(false);
});
it("reconnects only for the person who started the run, on their own keys", async () => {
  const run = await seedRun(); await save();
  const data = await (await permissions(new Request("https://fixture.example.test/api/admin/execution"))).json();
  expect(data.permissions[run._id]).toMatchObject({ canSpend: false, canReconnect: true });
  expect(data.permissions[run._id]).not.toHaveProperty("canRequestBackup");
  state.deps!.principal = owner;
  const denied = await reconnect(request("execution", { action: "reconnect", runId: run._id }));
  expect(denied.status).toBe(403);
  expect((await denied.json()).detail).toContain("started this run");
  expect(state.kick).not.toHaveBeenCalled();
});
it("explicitly reconnects the original sponsor's paused run to the current personal version", async () => {
  const run = await seedRun(); await save();
  const response = await reconnect(request("execution", { action: "reconnect", runId: run._id }));
  expect(response.status).toBe(200);
  const current = (await getRun(db, run._id))!;
  expect(current.execution?.credentialVersion).toBe(2);
  expect(current.execution?.sponsorId).toBe(editor.id);
  expect(current.execution).not.toHaveProperty("purpose");
  expect(current.options).not.toHaveProperty("purpose");
  expect(current.execution_blocked).toBeUndefined();
  expect(state.kick).toHaveBeenCalledOnce();
});
it("refuses publication-child recovery through the global execution route", async () => {
  const run = await seedRun();
  const generationId = "publication-generation-fixture";
  await db.collection(COLLECTIONS.publicationGenerations).insertOne({
    _id: generationId,
    publication_id: "publication-fixture",
    publication_name: "Fixture publication",
    status: "running",
    created_at: Date.now() / 1000,
  });
  await runs(db).updateOne(
    { _id: run._id },
    {
      $set: {
        admission: "publication",
        publication_generation_id: generationId,
        publication_id: "publication-fixture",
        execution_blocked: { reason: "Fixture reconnect", at: 1 },
      },
    },
  );

  const response = await reconnect(request("execution", { action: "reconnect", runId: run._id }));
  expect(response.status).toBe(403);
  expect((await response.json()).detail).toContain("publication recovery controls");
  expect(await getRun(db, run._id)).toMatchObject({
    admission: "publication",
    publication_generation_id: generationId,
    publication_id: "publication-fixture",
    execution_blocked: { reason: "Fixture reconnect" },
  });
  expect(state.kick).not.toHaveBeenCalled();
});
it("restricts legacy claims to the owner and never infers funding from trigger text", async () => {
  const run = newRun({ id: "one", name: "Fixture one" }, { kind: "manual", by: "admin" }, "2099-01-01", ["2099-01-01", "2099-01-08"], []);
  await runs(db).insertOne(run);
  expect((await reconnect(request("execution", { action: "claim", runId: run._id }))).status).toBe(403);
  expect((await getRun(db, run._id))?.execution).toBeUndefined();
  state.deps!.principal = owner;
  await saveCredentialProfile(db, owner, { source: "personal", config: { modelProviders: [{ name: "gemini", kind: "gemini", model: "fixture-owner", apiKey: "fixture-owner-not-live" }] } });
  expect((await reconnect(request("execution", { action: "claim", runId: run._id }))).status).toBe(200);
  expect((await getRun(db, run._id))?.execution).toMatchObject({ sponsorId: owner.id, source: "personal" });
});
