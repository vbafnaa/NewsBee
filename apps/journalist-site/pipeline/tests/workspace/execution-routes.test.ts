import { randomBytes } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from "vitest";
import { GET as permissions, POST as reconnect } from "../../../app/api/admin/execution/route";
import { GET as runOptions } from "../../../app/api/admin/run-options/route";
import { GET as approvalStatuses, POST as approvals } from "../../../app/api/admin/approvals/route";
import { saveCredentialProfile } from "../../accounts/credentials";
import { principalForEmail, type Principal } from "../../accounts/identity";
import { APPROVALS, consumeApproval, globalBlocker, infrastructureSettings, prepareBinding } from "../../accounts/execution";
import { NO_MODEL } from "../../accounts/runtime";
import { resolveRunOptions, type RunOptions } from "../../core/run-options";
import { ensureRunIndexes, getRun, newRun, runs } from "../../orchestration/runs";
import { type OrchestratorDeps } from "../../orchestration/orchestrator";
import { COLLECTIONS } from "../../storage/mongo";
import type { ArtifactStore } from "../../storage/artifacts";
import type { LocationProfile } from "../../connectors/types";

const state = vi.hoisted(() => ({ deps: null as OrchestratorDeps | null, kick: vi.fn() }));
vi.mock("@/lib/admin-api", () => ({
  adminRoute: async (_request: Request, handler: (deps: OrchestratorDeps) => Promise<unknown>) => {
    try { return Response.json(await handler(state.deps!)); }
    catch (error) { return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 403 }); }
  },
  jsonBody: (request: Request) => request.json(),
  kickPipeline: state.kick,
}));
let server: MongoMemoryServer, client: MongoClient, db: Db, owner: Principal, editor: Principal;
const choices = () => resolveRunOptions({ mode: "manual", purpose: "test", paid: { gemini: 10, openai_compatible: 10 } });
const store: ArtifactStore = {
  kind: "local", ensureFolder: async () => "fixture", saveText: async () => "fixture", saveJson: async () => "fixture",
  readText: async () => "", readJson: async <T>() => ({} as T), list: async () => [], findFolder: async () => null, removeFile: async () => 0,
};
const request = (path: string, value: unknown) => new Request(`https://fixture.example.test/api/admin/${path}`, { method: "POST", body: JSON.stringify(value) });
const approvalQuery = (options: RunOptions = { ...choices(), purpose: "final" }) => new Request(`https://fixture.example.test/api/admin/approvals?${new URLSearchParams({ mine: "1", locationId: "one", kind: "edition", options: JSON.stringify(options) })}`);
async function save() {
  await saveCredentialProfile(db, editor, { source: "personal", config: { modelProviders: [{ name: "gemini", kind: "gemini", model: "fixture-model", apiKey: "fixture-not-live" }] } });
}
async function seedRun(purpose: "test" | "final" = "test") {
  const options = { ...choices(), purpose };
  const run = newRun({ id: "one", name: "Fixture one" }, { kind: "manual", by: editor.email }, "2099-01-01", ["2099-01-01", "2099-01-08"], [], null, null, options);
  run.admission = "newsroom";
  run.execution = await prepareBinding(db, state.deps!.settings, editor, "one", "edition", options);
  await runs(db).insertOne(run);
  return run;
}
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("isolated-execution-routes"); });
beforeEach(async () => {
  vi.stubEnv("NEWSBEE_MODE", "cloud"); vi.stubEnv("NEWSBEE_OWNER_EMAIL", "owner@example.test");
  vi.stubEnv("NEWSBEE_CREDENTIAL_KEYS", JSON.stringify({ fixture: randomBytes(32).toString("base64") }));
  vi.stubEnv("NEWSBEE_CREDENTIAL_ACTIVE_KEY", "fixture");
  vi.stubEnv("NEWSBEE_ADMIN_LLM_MODEL", "fixed-fixture"); vi.stubEnv("NEWSBEE_ADMIN_LLM_API_KEY", "fixture-admin-never-live");
  await db.dropDatabase(); state.kick.mockClear();
  owner = (await principalForEmail(db, "owner@example.test"))!;
  await db.collection("journalist_admins").insertOne({ email: "editor@example.test", principalId: "editor", enabled: true, role: "editor" });
  editor = (await principalForEmail(db, "editor@example.test"))!;
  await db.collection<LocationProfile & { _id: string }>(COLLECTIONS.locations).insertOne({ _id: "one", id: "one", name: "Fixture one", state: "WA", systems: [], government: null });
  await ensureRunIndexes(db);
  state.deps = { db, settings: infrastructureSettings(), store, model: NO_MODEL, principal: editor };
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
it("automatically enables configured owner defaults without a saved profile, and never enables an unconfigured editor", async () => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "fixture-deployment-never-live");
  state.deps!.principal = owner;
  const url = new Request("https://fixture.example.test/api/admin/execution");
  const data = await (await permissions(url)).json();
  expect(data).toMatchObject({ canStart: true, canStartEdition: true, canStartMap: true, reasons: [] });
  const info = await (await runOptions(url)).json();
  expect(info).toMatchObject({ credentialSource: "environment", configured: { gemini: true }, defaults: { paid: { gemini: 200 } } });
  expect(JSON.stringify(info)).not.toContain("fixture-deployment-never-live");
  expect(await db.collection("journalist_credentials").countDocuments({ _id: owner.id })).toBe(0);
  await db.collection("journalist_admins").insertOne({ principalId: "other", email: "other@example.test", enabled: true });
  state.deps!.principal = { id: "other", email: "other@example.test", role: "editor" };
  expect(await (await permissions(url)).json()).toMatchObject({ canStart: false, reasons: [expect.stringContaining("personal model")] });
});
it("does not claim automatic readiness when deployment credentials, provider configuration or paid budgets are missing", async () => {
  state.deps!.principal = owner;
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", ""); vi.stubEnv("GOOGLE_AI_STUDIO_API_KEY", "");
  const url = new Request("https://fixture.example.test/api/admin/execution");
  expect(await (await permissions(url)).json()).toMatchObject({ canStart: false, reasons: [expect.stringContaining("Deployment defaults have no model")] });
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "fixture-not-live");
  const noBudget = new Request(`${url.url}?options=${encodeURIComponent(JSON.stringify({ ...choices(), paid: {} }))}`);
  expect(await (await permissions(noBudget)).json()).toMatchObject({ canStartEdition: false, editionReasons: [expect.stringContaining("paid-call budget")] });
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "openai"); vi.stubEnv("NEWSBEE_LLM_OPENAI_MODEL", "");
  expect(await (await permissions(url)).json()).toMatchObject({ canStart: false, reasons: [expect.stringContaining("NEWSBEE_LLM_OPENAI_MODEL")] });
  expect(state.kick).not.toHaveBeenCalled();
});
it("claims legacy work with automatic owner defaults and requires reconnect after saving a versioned override", async () => {
  state.deps!.principal = owner;
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini"); vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "fixture-owner-not-live");
  const run = newRun({ id: "one", name: "Fixture one" }, { kind: "manual", by: "legacy" }, "2099-01-01", ["2099-01-01", "2099-01-08"], [], null, null, choices());
  await runs(db).insertOne(run);
  expect((await reconnect(request("execution", { action: "claim", runId: run._id }))).status).toBe(200);
  expect((await getRun(db, run._id))?.execution).toMatchObject({ sponsorId: owner.id, source: "environment", credentialVersion: 0, approvalId: null });
  expect(await db.collection("journalist_credentials").countDocuments({ _id: owner.id })).toBe(0);
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
it("reflects revoked or mismatched approvals in per-run spend reasons without calling providers", async () => {
  const run = await seedRun("final");
  await runs(db).updateOne({ _id: run._id }, { $set: { "execution.approvalId": "missing-approval" } });
  const data = await (await permissions(new Request("https://fixture.example.test/api/admin/execution"))).json();
  expect(data.permissions[run._id]).toMatchObject({ canSpend: false, reason: expect.stringContaining("approval") });
  expect(state.kick).not.toHaveBeenCalled();
});
it("never offers or accepts Admin reconnect approval for a test run", async () => {
  const run = await seedRun(); await save();
  const response = await permissions(new Request("https://fixture.example.test/api/admin/execution"));
  expect((await response.json()).permissions[run._id]).toMatchObject({ canSpend: false, canReconnect: true, canRequestBackup: false });
  const denied = await approvals(request("approvals", { action: "request", runId: run._id, options: { ...choices(), purpose: "final" } }));
  expect(denied.status).toBe(403);
  expect((await denied.json()).detail).toContain("cannot be converted");
  await expect(prepareBinding(db, state.deps!.settings, editor, "one", "edition", { ...choices(), purpose: "final" }, run._id)).rejects.toThrow("original sponsor and run purpose");
  expect(state.kick).not.toHaveBeenCalled();
});
it("explicitly reconnects the original sponsor's paused run to the current personal version", async () => {
  const run = await seedRun(); await save();
  const response = await reconnect(request("execution", { action: "reconnect", runId: run._id }));
  expect(response.status).toBe(200);
  const current = (await getRun(db, run._id))!;
  expect(current.execution?.credentialVersion).toBe(2);
  expect(current.execution?.sponsorId).toBe(editor.id);
  expect(current.execution?.purpose).toBe("test");
  expect(current.execution_blocked).toBeUndefined();
  expect(state.kick).toHaveBeenCalledOnce();
});
it("restricts legacy claims to the owner and never infers funding from trigger text", async () => {
  const run = newRun({ id: "one", name: "Fixture one" }, { kind: "manual", by: "admin" }, "2099-01-01", ["2099-01-01", "2099-01-08"], []);
  await runs(db).insertOne(run);
  expect((await reconnect(request("execution", { action: "claim", runId: run._id }))).status).toBe(403);
  expect((await getRun(db, run._id))?.execution).toBeUndefined();
  state.deps!.principal = owner;
  await saveCredentialProfile(db, owner, { source: "personal", config: { modelProviders: [{ name: "gemini", kind: "gemini", model: "fixture-owner", apiKey: "fixture-owner-not-live" }] } });
  expect((await reconnect(request("execution", { action: "claim", runId: run._id }))).status).toBe(200);
  expect((await getRun(db, run._id))?.execution).toMatchObject({ sponsorId: owner.id, source: "personal", purpose: "test" });
});

it("keeps requester statuses private and allows only an explicit original-requester start of the exact approved plan", async () => {
  const options = { ...choices(), purpose: "final" as const };
  const response = await approvals(request("approvals", { action: "request", locationId: "one", kind: "edition", options }));
  const { approval } = await response.json();
  expect(response.status).toBe(200);
  expect(await globalBlocker(db)).toBeNull();
  expect(await db.collection(COLLECTIONS.jobs).countDocuments()).toBe(0);
  let data = await (await approvalStatuses(approvalQuery())).json();
  expect(data.approvals[0]).toMatchObject({ status: "requested", matchesPlan: true, staleReason: null, canStart: false });
  state.deps!.principal = owner;
  expect((await approvals(request("approvals", { id: approval._id, action: "approved" }))).status).toBe(200);
  expect(state.kick).not.toHaveBeenCalled();
  expect(await runs(db).countDocuments()).toBe(0);
  expect((await (await approvalStatuses(new Request("https://fixture.example.test/api/admin/approvals"))).json()).approvals[0]).toMatchObject({ canStart: false, blockedReason: expect.stringContaining("original requester") });
  state.deps!.principal = { id: "other", email: "other@example.test", role: "editor" };
  expect((await (await approvalStatuses(new Request(`https://fixture.example.test/api/admin/approvals?mine=0&sponsorId=${editor.id}`))).json()).approvals).toEqual([]);
  expect((await approvals(request("approvals", { id: approval._id, action: "revoked" }))).status).toBe(403);
  state.deps!.principal = editor;
  data = await (await approvalStatuses(approvalQuery())).json();
  expect(data.approvals[0]).toMatchObject({ canStart: true, matchesPlan: true, staleReason: null });
  const changed = { ...options, paid: { openai_compatible: 5 } };
  data = await (await approvalStatuses(approvalQuery(changed))).json();
  expect(data.approvals[0]).toMatchObject({ canStart: false, matchesPlan: false, blockedReason: expect.stringContaining("Run options changed") });
  await expect(prepareBinding(db, state.deps!.settings, editor, "one", "edition", { ...changed, admin_approval_id: approval._id })).rejects.toThrow("no longer matches");
  expect(state.kick).not.toHaveBeenCalled();
});
it("shows stale versions and refuses approval after credential replacement, including an old owner v0 request", async () => {
  const options = { ...choices(), purpose: "final" as const };
  state.deps!.principal = owner;
  const { approval } = await (await approvals(request("approvals", { action: "request", locationId: "one", kind: "edition", options }))).json();
  expect(approval.plan.credentialVersion).toBe(0);
  await saveCredentialProfile(db, owner, { source: "environment" });
  const data = await (await approvalStatuses(approvalQuery())).json();
  expect(data.approvals[0]).toMatchObject({ canStart: false, staleReason: expect.stringContaining("credential version"), matchesPlan: false });
  expect((await approvals(request("approvals", { id: approval._id, action: "approved" }))).status).toBe(403);
  expect((await db.collection(APPROVALS).findOne({ _id: approval._id }))?.status).toBe("requested");
  expect(state.kick).not.toHaveBeenCalled();
});
it("marks already-approved owner v0 requests stale after saving v1 and invalidates backup-key rotation", async () => {
  const options = { ...choices(), purpose: "final" as const };
  state.deps!.principal = owner;
  const create = async () => (await (await approvals(request("approvals", { action: "request", locationId: "one", kind: "edition", options }))).json()).approval;
  const old = await create();
  await approvals(request("approvals", { id: old._id, action: "approved" }));
  await saveCredentialProfile(db, owner, { source: "personal", config: {} });
  let data = await (await approvalStatuses(approvalQuery())).json();
  expect(data.approvals[0]).toMatchObject({ status: "approved", staleReason: expect.stringContaining("credential version"), canStart: false });
  const current = await create();
  await approvals(request("approvals", { id: current._id, action: "approved" }));
  vi.stubEnv("NEWSBEE_ADMIN_LLM_API_KEY", "fixture-rotated-admin-never-live");
  data = await (await approvalStatuses(approvalQuery())).json();
  expect(data.approvals.find((row: { _id: string }) => row._id === current._id)).toMatchObject({ status: "approved", staleReason: expect.stringContaining("Admin backup configuration changed"), canStart: false });
  await expect(prepareBinding(db, state.deps!.settings, owner, "one", "edition", { ...options, admin_approval_id: current._id })).rejects.toThrow("no longer matches");
  expect(JSON.stringify(data)).not.toContain("fixture-rotated-admin-never-live");
  expect(state.kick).not.toHaveBeenCalled();
});
it("reflects reject and revoke inline and permits a fresh request without starting work", async () => {
  const options = { ...choices(), purpose: "final" as const };
  const create = async () => (await (await approvals(request("approvals", { action: "request", locationId: "one", kind: "edition", options }))).json()).approval;
  const first = await create();
  state.deps!.principal = owner;
  expect((await approvals(request("approvals", { id: first._id, action: "rejected" }))).status).toBe(200);
  state.deps!.principal = editor;
  expect((await (await approvalStatuses(approvalQuery())).json()).approvals[0]).toMatchObject({ status: "rejected", canStart: false });
  const second = await create();
  state.deps!.principal = owner;
  await approvals(request("approvals", { id: second._id, action: "approved" }));
  await approvals(request("approvals", { id: second._id, action: "revoked" }));
  state.deps!.principal = editor;
  const data = await (await approvalStatuses(approvalQuery())).json();
  expect(data.approvals.find((row: { _id: string }) => row._id === second._id)).toMatchObject({ status: "revoked", canStart: false });
  expect(data.canRequest).toBe(true);
  await expect(prepareBinding(db, state.deps!.settings, editor, "one", "edition", { ...options, admin_approval_id: second._id })).rejects.toThrow("revoked");
  expect(await runs(db).countDocuments()).toBe(0);
  expect(state.kick).not.toHaveBeenCalled();
});
it("allows requests while busy but reports admission and single-use consumption before an approved start", async () => {
  const active = await seedRun();
  const options = { ...choices(), purpose: "final" as const };
  const { approval } = await (await approvals(request("approvals", { action: "request", locationId: "one", kind: "edition", options }))).json();
  state.deps!.principal = owner;
  await approvals(request("approvals", { id: approval._id, action: "approved" }));
  state.deps!.principal = editor;
  let data = await (await approvalStatuses(approvalQuery())).json();
  expect(data.approvals[0]).toMatchObject({ canStart: false, blockedReason: expect.stringContaining("Newsroom busy") });
  await runs(db).updateOne({ _id: active._id }, { $set: { status: "cancelled" } });
  data = await (await approvalStatuses(approvalQuery())).json();
  expect(data.approvals[0].canStart).toBe(true);
  const binding = await prepareBinding(db, state.deps!.settings, editor, "one", "edition", { ...options, admin_approval_id: approval._id });
  const next = newRun({ id: "one", name: "Fixture one" }, { kind: "manual", by: editor.email }, "2099-01-01", ["2099-01-01", "2099-01-08"], [], null, null, options);
  next.execution = binding;
  await runs(db).insertOne(next); await consumeApproval(db, next);
  data = await (await approvalStatuses(approvalQuery())).json();
  expect(data.approvals[0]).toMatchObject({ canStart: false, runId: next._id, blockedReason: expect.stringContaining("already connected") });
  expect(await db.collection(COLLECTIONS.jobs).countDocuments()).toBe(0);
  expect(state.kick).not.toHaveBeenCalled();
});
it("keeps targeted reconnect requests inline, final-only, sponsor-specific and tied to the persisted run plan", async () => {
  const run = await seedRun("final");
  await save();
  const { approval } = await (await approvals(request("approvals", { action: "request", runId: run._id, options: { purpose: "test" }, locationId: "forged" }))).json();
  expect(approval).toMatchObject({ targetRunId: run._id, plan: { locationId: "one", credentialVersion: 2, options: { purpose: "final" } } });
  state.deps!.principal = owner;
  await approvals(request("approvals", { id: approval._id, action: "approved" }));
  state.deps!.principal = editor;
  const query = new Request(`https://fixture.example.test/api/admin/approvals?mine=1&runId=${run._id}`);
  expect((await (await approvalStatuses(query)).json()).approvals[0]).toMatchObject({ canStart: true, matchesPlan: true });
  await expect(prepareBinding(db, state.deps!.settings, editor, "one", "edition", { ...run.options, admin_approval_id: approval._id })).rejects.toThrow("no longer matches");
  expect((await reconnect(request("execution", { action: "reconnect", runId: run._id, approvalId: approval._id }))).status).toBe(200);
  expect((await getRun(db, run._id))?.execution).toMatchObject({ credentialVersion: 2, approvalId: approval._id, purpose: "final" });
  expect((await (await approvalStatuses(query)).json()).approvals[0].canStart).toBe(false);
  state.deps!.principal = owner;
  expect((await approvalStatuses(query)).status).toBe(403);
  expect(await db.collection(COLLECTIONS.jobs).countDocuments()).toBe(0);
});
it("never offers or creates requests without final purpose, backup budget, or required search configuration", async () => {
  const cases: RunOptions[] = [choices(), { ...choices(), purpose: "training" }, { ...choices(), purpose: "final", paid: {} }, { ...choices(), purpose: "final", flow: "agentic" }];
  for (const options of cases) {
    const data = await (await approvalStatuses(approvalQuery(options))).json();
    expect(data.canRequest).toBe(false);
    expect(data.requestReason).toBeTruthy();
    expect((await approvals(request("approvals", { action: "request", locationId: "one", kind: "edition", options }))).status).toBe(403);
  }
  expect(await db.collection(APPROVALS).countDocuments()).toBe(0);
  expect(state.kick).not.toHaveBeenCalled();
});
