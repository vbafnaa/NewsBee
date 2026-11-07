import { randomBytes } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { credentialProfile, revokeCredentialProfile, saveCredentialProfile } from "../../accounts/credentials";
import { principalForEmail, type Principal } from "../../accounts/identity";
import { APPROVALS, assertBindingCurrent, authorizePaidAction, consumeApproval, decideApproval, globalBlocker, infrastructureSettings, personalSettings, prepareBinding, requestApproval } from "../../accounts/execution";
import { NO_MODEL, personalRequestDeps, runtimesForRun } from "../../accounts/runtime";
import { withRunContext, resolveRunOptions } from "../../core/run-options";
import type { HttpRequest, HttpTransport } from "../../core/http";
import { redact, safeError } from "../../core/redaction";
import { ensureRunIndexes, getRun, newRun, runs, type PipelineRun } from "../../orchestration/runs";
import { executeJob, runOne, startMapRun, type OrchestratorDeps } from "../../orchestration/orchestrator";
import { ensureJobIndexes, enqueue, runJobs } from "../../orchestration/jobs";
import { expireOverdueRuns } from "../../orchestration/diagnostics";
import { getArtifacts, type ArtifactStore } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";

let server: MongoMemoryServer, client: MongoClient, db: Db, owner: Principal, editor: Principal, other: Principal, deps: OrchestratorDeps;
const requests: HttpRequest[] = [];
const options = () => resolveRunOptions({ purpose: "test", mode: "manual", flow: "current", paid: { gemini: 10, openai_compatible: 10, agent_model: 10 } });
const location = (id: string) => ({ id, name: `Fixture ${id}`, state: "WA", systems: [], government: null });
const store: ArtifactStore = {
  kind: "local",
  ensureFolder: async () => "fixture", saveText: async () => "fixture", saveJson: async () => "fixture",
  readText: async () => "", readJson: async <T>() => ({} as T), list: async () => [], findFolder: async () => null, removeFile: async () => 0,
};
const mockTransport: HttpTransport = async (request) => {
  requests.push(request);
  const body = request.url.includes("generativelanguage") ? { candidates: [{ content: { parts: [{ text: "personal answer" }] } }] } : { choices: [{ message: { content: "fixed admin answer" }, finish_reason: "stop" }] };
  return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
};
async function seedEditor(id: string): Promise<Principal> {
  const principal: Principal = { id, email: `${id}@example.test`, role: "editor" };
  await db.collection("journalist_admins").insertOne({ email: principal.email, principalId: id, role: "editor", enabled: true });
  return principal;
}
async function save(principal = editor, key: string | null = "fixture-personal-key") {
  return saveCredentialProfile(db, principal, { source: "personal", config: { modelProviders: [{ name: "gemini", kind: "gemini", model: "fixture-model", apiKey: key }] } });
}
async function boundRun(choices = options(), principal = editor) {
  const run = newRun(location("one"), { by: principal.email, kind: "manual" }, "2099-01-01", ["2099-01-01", "2099-01-08"], [], null, null, choices);
  run.admission = "newsroom";
  run.execution = await prepareBinding(db, deps.settings, principal, run.location_id, "edition", choices);
  await runs(db).insertOne(run);
  return run;
}
async function generate(run: PipelineRun, selected = deps) {
  const runtime = await runtimesForRun(selected, run);
  return withRunContext({ db, runId: run._id, locationId: run.location_id, options: run.options!, sponsorId: run.execution?.sponsorId }, () => runtime.model.generate("Fixture prompt only."));
}
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("isolated-execution-policy"); });
beforeEach(async () => {
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "owner@example.test");
  vi.stubEnv("NEWSBEE_CREDENTIAL_KEYS", JSON.stringify({ fixture: randomBytes(32).toString("base64") }));
  vi.stubEnv("NEWSBEE_CREDENTIAL_ACTIVE_KEY", "fixture");
  vi.stubEnv("NEWSBEE_ADMIN_LLM_API_KEY", "fixture-admin-key-never-live");
  vi.stubEnv("NEWSBEE_ADMIN_LLM_BASE_URL", "https://fixed-admin.example.test/v1");
  vi.stubEnv("NEWSBEE_ADMIN_LLM_MODEL", "fixed-owner-model");
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "deployment-key-must-never-be-used");
  await db.dropDatabase(); requests.length = 0;
  owner = (await principalForEmail(db, "owner@example.test"))!;
  editor = await seedEditor("editor"); other = await seedEditor("other");
  await ensureRunIndexes(db); await ensureJobIndexes(db);
  await db.collection(COLLECTIONS.locations).insertMany(["one", "two"].map((id) => ({ ...location(id), _id: id })));
  deps = { db, settings: infrastructureSettings(), store, model: NO_MODEL, transport: mockTransport };
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await client?.close(); await server?.stop(); });

it("keeps all deployment model/search keys out of unconfigured editor infrastructure", async () => {
  vi.stubEnv("NEWSBEE_SERPAPI_API_KEY", "deployment-search-never-used");
  const settings = personalSettings(infrastructureSettings(), editor, null);
  expect(settings.modelProviders).toEqual([]);
  expect(settings.integrations.serpapiKey).toBeNull();
  for (const purpose of ["test", "training", "final"]) await expect(prepareBinding(db, deps.settings, editor, "one", "edition", { ...options(), purpose })).rejects.toThrow("personal model");
  expect(requests).toHaveLength(0);
});
it("does not accept a model name without a personal key for unapproved work", async () => {
  await save(editor, null);
  await expect(boundRun()).rejects.toThrow("personal model");
});
it.each(["test", "training", "final"] as const)("uses automatic owner deployment credentials for a mock %s run without saving, never Admin backup", async (purpose) => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "fixture-owner-deployment-key");
  const run = await boundRun({ ...options(), purpose }, owner);
  expect(run.execution).toMatchObject({ source: "environment", credentialVersion: 0, sponsorId: owner.id, purpose, approvalId: null });
  expect(await credentialProfile(db, owner)).toBeNull();
  expect(await generate(run)).toBe("personal answer");
  expect(requests).toHaveLength(1);
  expect(requests[0].headers?.["x-goog-api-key"]).toBe("fixture-owner-deployment-key");
  expect(requests[0].url).not.toContain("fixed-admin");
  await db.collection("journalist_run_approvals").deleteMany({});
  await expect(prepareBinding(db, deps.settings, owner, "one", "edition", { ...options(), purpose, admin_approval_id: "not-approved" })).rejects.toThrow(purpose === "final" ? "approval" : "Test/training");
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "replacement@example.test");
  await expect(generate(run)).rejects.toThrow("changed");
  expect(requests).toHaveLength(1);
});
it("preserves explicit owner personal overrides and revocation without deployment fallback", async () => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  await save(owner, "fixture-owner-personal-key");
  const run = await boundRun(options(), owner);
  expect(run.execution).toMatchObject({ source: "personal", credentialVersion: 1 });
  expect(await generate(run)).toBe("personal answer");
  expect(requests[0].headers?.["x-goog-api-key"]).toBe("fixture-owner-personal-key");
  await revokeCredentialProfile(db, owner);
  await expect(prepareBinding(db, deps.settings, owner, "two", "edition", options())).rejects.toThrow("revoked");
  await expect(generate(run)).rejects.toThrow("revoked");
  expect(requests).toHaveLength(1);
});
it("rechecks automatic owner identity and versions on retained worker and one-off transports", async () => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  const run = await boundRun(options(), owner);
  const worker = await runtimesForRun(deps, run);
  const oneOff = await personalRequestDeps(deps, owner, options());
  expect(oneOff.credentialVersion).toBe(0);
  expect(oneOff.settings.modelProviders[0].apiKey).toBe("deployment-key-must-never-be-used");
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "replacement@example.test");
  await expect(worker.model.generate("mock")).rejects.toThrow("changed");
  await expect(oneOff.transport({ url: "https://fixture.example.test" })).rejects.toThrow("changed");
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", owner.email);
  await saveCredentialProfile(db, owner, { source: "environment" });
  await expect(worker.model.generate("mock")).rejects.toThrow("changed");
  await expect(oneOff.transport({ url: "https://fixture.example.test" })).rejects.toThrow("changed");
  await db.collection("journalist_admins").updateOne({ principalId: owner.id }, { $set: { enabled: false } });
  await expect(worker.model.generate("mock")).rejects.toThrow("disabled");
  await expect(personalRequestDeps(deps, owner)).rejects.toThrow("disabled");
  expect(requests).toHaveLength(0);
});
it("uses the automatic owner's configured deployment key for guarded one-off model calls", async () => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  const oneOff = await personalRequestDeps(deps, owner, options());
  expect(await oneOff.discoveryModel.generate("mock only")).toBe("personal answer");
  expect(requests[0].headers?.["x-goog-api-key"]).toBe("deployment-key-must-never-be-used");
  expect(await credentialProfile(db, owner)).toBeNull();
  await revokeCredentialProfile(db, owner);
  await expect(oneOff.discoveryModel.generate("mock only")).rejects.toThrow("changed");
  expect(requests).toHaveLength(1);
});
it("executes a mock personal provider with its own key, never Admin tokens", async () => {
  await save();
  const run = await boundRun();
  expect(await generate(run)).toBe("personal answer");
  expect(requests).toHaveLength(1);
  expect(requests[0].headers?.["x-goog-api-key"]).toBe("fixture-personal-key");
  const audit = await db.collection("journalist_funding_audit").findOne({ run_id: run._id });
  expect(audit?.funding).toBe("personal");
});
it("reserves no slot for an approval request and uses only the fixed owner endpoint/model when approved", async () => {
  const final = { ...options(), purpose: "final" as const };
  const approval = await requestApproval(db, editor, "one", "map", final);
  expect(await globalBlocker(db)).toBeNull();
  await decideApproval(db, owner, approval._id, "approved");
  const result = await startMapRun({ ...deps, principal: editor }, "one", { by: editor.email, kind: "manual" }, { ...final, admin_approval_id: approval._id });
  expect(result.started).toBe(true);
  expect(await generate(result.run)).toBe("fixed admin answer");
  expect(requests[0].url).toBe("https://fixed-admin.example.test/v1/chat/completions");
  expect(JSON.parse(requests[0].body!).model).toBe("fixed-owner-model");
  expect(requests[0].headers?.Authorization).toBe("Bearer fixture-admin-key-never-live");
  expect((await db.collection("journalist_funding_audit").findOne({ run_id: result.run._id }))?.funding).toBe("admin");
});
it("tries personal credentials first, and sanitizes provider echoes before approved backup", async () => {
  await save();
  const final = { ...options(), purpose: "final" as const };
  const approval = await requestApproval(db, editor, "one", "map", final);
  await decideApproval(db, owner, approval._id, "approved");
  const { run } = await startMapRun({ ...deps, principal: editor }, "one", { by: editor.email, kind: "manual" }, { ...final, admin_approval_id: approval._id });
  const failing: HttpTransport = async (request) => {
    if (request.url.includes("generativelanguage")) { requests.push(request); return { url: request.url, status: 503, headers: {}, body: new TextEncoder().encode("echo fixture-personal-key fixture-admin-key-never-live") }; }
    return mockTransport(request);
  };
  expect(await generate(run, { ...deps, transport: failing })).toBe("fixed admin answer");
  expect(requests.map((request) => new URL(request.url).hostname)).toEqual(["generativelanguage.googleapis.com", "fixed-admin.example.test"]);
  const audit = await db.collection("journalist_funding_audit").find({ run_id: run._id }).toArray();
  expect(JSON.stringify(audit)).not.toContain("fixture-personal-key");
  expect(JSON.stringify(audit)).not.toContain("fixture-admin-key-never-live");
});
it("rejects foreign, changed-plan, test and reused approvals without provider calls", async () => {
  const final = { ...options(), purpose: "final" as const };
  const approval = await requestApproval(db, editor, "one", "map", final);
  await decideApproval(db, owner, approval._id, "approved");
  const chosen = { ...final, admin_approval_id: approval._id };
  await expect(prepareBinding(db, deps.settings, other, "one", "map", chosen)).rejects.toThrow("approval");
  await expect(prepareBinding(db, deps.settings, editor, "two", "map", chosen)).rejects.toThrow("approval");
  await expect(prepareBinding(db, deps.settings, editor, "one", "map", { ...chosen, purpose: "test" })).rejects.toThrow("Test/training");
  const { run } = await startMapRun({ ...deps, principal: editor }, "one", { by: editor.email, kind: "manual" }, chosen);
  await runs(db).updateOne({ _id: run._id }, { $set: { status: "failed" } });
  await expect(prepareBinding(db, deps.settings, editor, "one", "map", chosen)).rejects.toThrow("consumed");
  expect(requests).toHaveLength(0);
});
it("rejects editor approval decisions", async () => {
  const approval = await requestApproval(db, editor, "one", "map", { ...options(), purpose: "final" });
  await expect(decideApproval(db, other, approval._id, "approved")).rejects.toThrow("Only the owner");
});
it("blocks cross-editor additional spend even for the owner", async () => {
  await save(); const run = await boundRun();
  await expect(authorizePaidAction(db, run._id, other)).rejects.toThrow("original sponsoring");
  await expect(authorizePaidAction(db, run._id, owner)).rejects.toThrow("original sponsoring");
  expect(requests).toHaveLength(0);
});
it("rechecks credentials on already constructed runtimes after replacement or revocation", async () => {
  await save(); const run = await boundRun();
  const runtime = await runtimesForRun(deps, run);
  await save(editor, "fixture-replacement");
  await expect(runtime.model.generate("mock")).rejects.toThrow("changed");
  expect((await getRun(db, run._id))?.execution_blocked).toBeTruthy();
  await revokeCredentialProfile(db, editor);
  await expect(runtime.model.generate("mock")).rejects.toThrow("revoked");
  expect(requests).toHaveLength(0);
});
it("rechecks account disable and Admin approval revocation before further provider calls", async () => {
  const final = { ...options(), purpose: "final" as const };
  const approval = await requestApproval(db, editor, "one", "map", final);
  await decideApproval(db, owner, approval._id, "approved");
  const { run } = await startMapRun({ ...deps, principal: editor }, "one", { by: editor.email, kind: "manual" }, { ...final, admin_approval_id: approval._id });
  const runtime = await runtimesForRun(deps, run);
  await decideApproval(db, owner, approval._id, "revoked");
  await expect(runtime.model.generate("mock")).rejects.toThrow("approval");
  await db.collection("journalist_admins").updateOne({ principalId: editor.id }, { $set: { enabled: false } });
  await expect(assertBindingCurrent(db, run)).rejects.toThrow("disabled");
  expect(requests).toHaveLength(0);
});
it("atomically admits only one concurrent map/edition across locations and users", async () => {
  await save(); await save(other);
  const results = await Promise.allSettled(["one", "two"].map((id, index) => startMapRun({ ...deps, principal: index ? other : editor }, id, { by: "fixture", kind: "manual" }, options())));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await runs(db).countDocuments({ admission: "newsroom", status: "mapping" })).toBe(1);
});
it.each(["awaiting_authoring", "awaiting_finish", "collecting"] as const)("retains admission while %s, including credential pauses", async (status) => {
  await save(); const run = await boundRun();
  await runs(db).updateOne({ _id: run._id }, { $set: { status, execution_blocked: { reason: "fixture pause", at: 1 }, created_at: 1 } });
  expect(await expireOverdueRuns(db, 1)).toEqual([]);
  await expect(startMapRun({ ...deps, principal: editor }, "two", { by: editor.email, kind: "manual" }, options())).rejects.toThrow("Newsroom busy");
});
it.each(["mapped", "published", "failed", "cancelled"] as const)("releases the slot at terminal status %s", async (status) => {
  await save(); const run = await boundRun();
  await runs(db).updateOne({ _id: run._id }, { $set: { status } });
  expect((await startMapRun({ ...deps, principal: editor }, "two", { by: editor.email, kind: "manual" }, options())).started).toBe(true);
});
it("pauses an unbound legacy job without calls or consuming retry attempts", async () => {
  const run = newRun(location("one"), { by: "admin", kind: "manual" }, "2099-01-01", ["2099-01-01", "2099-01-08"], []);
  await runs(db).insertOne(run);
  await enqueue(db, { kind: "plan_sources", run_id: run._id, location_id: run.location_id });
  deps.runtimeForRun = (run) => runtimesForRun(deps, run);
  expect(await runOne(deps)).toBe(true);
  expect((await getRun(db, run._id))?.execution_blocked?.reason).toContain("Legacy");
  expect((await runJobs(db, run._id))[0].attempts).toBe(0);
  expect(await runOne(deps)).toBe(false);
  expect(requests).toHaveLength(0);
});
it("leaves multiple historical active runs intact and visibly paused", async () => {
  await runs(db).insertMany(["one", "two"].map((id) => newRun(location(id), { by: "legacy", kind: "manual" }, "2099-01-01", ["2099-01-01", "2099-01-08"], [])));
  await ensureRunIndexes(db);
  const historical = await runs(db).find({}).toArray();
  expect(historical.every((run) => run.status === "collecting" && run.execution_blocked)).toBe(true);
});
it("does not include key-bearing URL parameters or provider echo bodies in errors", () => {
  expect(safeError(new Error("HTTP 403 https://provider.example.test/v1?api_key=fixture-secret"))).not.toContain("fixture-secret");
});
it("rechecks final approval at fallback activation after the personal request was sent", async () => {
  await save();
  const final = { ...options(), purpose: "final" as const };
  const approval = await requestApproval(db, editor, "one", "map", final);
  await decideApproval(db, owner, approval._id, "approved");
  const { run } = await startMapRun({ ...deps, principal: editor }, "one", { by: editor.email, kind: "manual" }, { ...final, admin_approval_id: approval._id });
  const revokingTransport: HttpTransport = async (request) => {
    requests.push(request);
    await decideApproval(db, owner, approval._id, "revoked");
    return { url: request.url, status: 503, headers: {}, body: new Uint8Array() };
  };
  await expect(generate(run, { ...deps, transport: revokingTransport })).rejects.toThrow("approval");
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toContain("generativelanguage");
});
it("sanitizes personal provider echoes in successful output and thrown transport errors", async () => {
  await save(); const run = await boundRun();
  const echo: HttpTransport = async (request) => ({
    url: request.url, status: 200, headers: {},
    body: new TextEncoder().encode(JSON.stringify({ candidates: [{ content: { parts: [{ text: "echo fixture-personal-key" }] } }] })),
  });
  expect(await generate(run, { ...deps, transport: echo })).toBe("echo [redacted]");
  const fail: HttpTransport = async () => { throw new Error("Unlabelled provider echo fixture-personal-key"); };
  await expect(generate(run, { ...deps, transport: fail })).rejects.toThrow("Unlabelled provider echo [redacted]");
  expect(JSON.stringify(await db.collection("journalist_funding_audit").find({}).toArray())).not.toContain("fixture-personal-key");
});
it("rechecks disabled accounts on one-off personal discovery transports", async () => {
  await save();
  const runtime = await personalRequestDeps(deps, editor);
  await db.collection("journalist_admins").updateOne({ principalId: editor.id }, { $set: { enabled: false } });
  await expect(runtime.discoveryModel.generate("mock")).rejects.toThrow("disabled");
  await expect(runtime.transport({ url: "https://provider.example.test" })).rejects.toThrow("disabled");
  expect(requests).toHaveLength(0);
});
it("requires a fresh target-specific approval after replacing credentials and never broadens it", async () => {
  await save();
  const final = { ...options(), purpose: "final" as const };
  const original = await requestApproval(db, editor, "one", "map", final);
  await decideApproval(db, owner, original._id, "approved");
  const { run } = await startMapRun({ ...deps, principal: editor }, "one", { by: editor.email, kind: "manual" }, { ...final, admin_approval_id: original._id });
  await save(editor, "fixture-new-personal-key");
  await expect(assertBindingCurrent(db, run)).rejects.toThrow("changed");
  await expect(prepareBinding(db, deps.settings, editor, "one", "map", { ...run.options, admin_approval_id: original._id }, run._id)).rejects.toThrow("approval");
  const fresh = await requestApproval(db, editor, "one", "map", run.options, run._id);
  await decideApproval(db, owner, fresh._id, "approved");
  const choices = { ...run.options, admin_approval_id: fresh._id };
  await expect(prepareBinding(db, deps.settings, editor, "one", "map", choices)).rejects.toThrow("approval");
  const binding = await prepareBinding(db, deps.settings, editor, "one", "map", choices, run._id);
  await runs(db).updateOne({ _id: run._id }, { $set: { execution: binding, options: choices }, $unset: { execution_blocked: "" } });
  const reconnected = (await getRun(db, run._id))!;
  await consumeApproval(db, reconnected);
  expect(await generate(reconnected)).toBe("personal answer");
  expect(requests).toHaveLength(1);
  await expect(consumeApproval(db, reconnected)).rejects.toThrow("already been used");
});
it("allows requests and approvals while busy but rechecks admission before consuming them", async () => {
  await save(); await boundRun();
  const final = { ...options(), purpose: "final" as const };
  const approval = await requestApproval(db, other, "two", "map", final);
  await decideApproval(db, owner, approval._id, "approved");
  await expect(startMapRun({ ...deps, principal: other }, "two", { by: other.email, kind: "manual" }, { ...final, admin_approval_id: approval._id })).rejects.toThrow("Newsroom busy");
  expect((await db.collection(APPROVALS).findOne({ _id: approval._id }))?.runId).toBeNull();
  expect(requests).toHaveLength(0);
});
it("does not use approved Admin backup to bypass a personal provider's safety refusal", async () => {
  await save();
  const final = { ...options(), purpose: "final" as const };
  const approval = await requestApproval(db, editor, "one", "map", final);
  await decideApproval(db, owner, approval._id, "approved");
  const { run } = await startMapRun({ ...deps, principal: editor }, "one", { by: editor.email, kind: "manual" }, { ...final, admin_approval_id: approval._id });
  const refusing: HttpTransport = async (request) => {
    requests.push(request);
    return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] })) };
  };
  await expect(generate(run, { ...deps, transport: refusing })).rejects.toThrow("content policy");
  expect(requests).toHaveLength(1);
});
it("preserves shared editorial configuration without inheriting owner provider settings", () => {
  vi.stubEnv("NEWSBEE_AI_LINK_DISCOVERY", "true");
  vi.stubEnv("NEWSBEE_WIDER_SOURCES", "false");
  vi.stubEnv("NEWSBEE_LLM_DISCOVERY", "false");
  vi.stubEnv("NEWSBEE_NEWS_SEARCH", "off");
  const settings = infrastructureSettings();
  expect(settings).toMatchObject({ aiLinkDiscovery: true, widerSources: false, llmDiscovery: false, newsSearch: [] });
  expect(settings.modelProviders.every((provider) => !provider.apiKey)).toBe(true);
});
it("allows keyless free discovery with a guarded transport but no model funding capability", async () => {
  const runtime = await personalRequestDeps(deps, editor, undefined, false, false);
  expect(runtime.discoveryModel).toBe(NO_MODEL);
  await expect(runtime.discoveryModel.generate("mock")).rejects.toThrow("No execution identity");
  expect(requests).toHaveLength(0);
});
it("constructs storage and infrastructure independently of an unconfigured owner model", () => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "openai");
  vi.stubEnv("NEWSBEE_LLM_OPENAI_MODEL", "");
  expect(getArtifacts().kind).toBe("drive");
  expect(infrastructureSettings().mode).toBe("cloud");
});
it("redacts credential-bearing content URLs without stripping ordinary source query parameters", () => {
  expect(redact({ url: "https://provider.example.test/feed?api_key=fixture-secret&page=2" })).toEqual({ url: "https://provider.example.test/feed?page=2" });
  expect(redact({ url: "https://source.example.test/article?page=2" })).toEqual({ url: "https://source.example.test/article?page=2" });
});
it("never spends Admin credentials on provider probes, even inside an approved final runtime", async () => {
  const final = { ...options(), purpose: "final" as const };
  const approval = await requestApproval(db, editor, "one", "map", final);
  await decideApproval(db, owner, approval._id, "approved");
  const { run } = await startMapRun({ ...deps, principal: editor }, "one", { by: editor.email, kind: "manual" }, { ...final, admin_approval_id: approval._id });
  const runtime = await runtimesForRun(deps, run);
  expect((await runtime.model.health()).detail).toContain("never used for provider checks");
  expect(requests).toHaveLength(0);
});
