import { createHash, randomBytes } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { credentialProfile, revokeCredentialProfile, saveCredentialProfile } from "../../accounts/credentials";
import { principalById, principalForEmail, type Principal } from "../../accounts/identity";
import { assertBindingCurrent, authorizePaidAction, capabilityReasons, executionModels, infrastructureSettings, normalizedPlan, personalSettings, prepareBinding } from "../../accounts/execution";
import { loadSettings } from "../../core/config";
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
const options = () => resolveRunOptions({ mode: "manual", flow: "current", paid: { gemini: 10, openai_compatible: 10, agent_model: 10 } });
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
beforeAll(async () => { server = await MongoMemoryServer.create({ instance: { launchTimeout: 30_000 } }); client = await MongoClient.connect(server.getUri()); db = client.db("isolated-execution-policy"); }, 45_000);
beforeEach(async () => {
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "owner@example.test");
  vi.stubEnv("NEWSBEE_CREDENTIAL_KEYS", JSON.stringify({ fixture: randomBytes(32).toString("base64") }));
  vi.stubEnv("NEWSBEE_CREDENTIAL_ACTIVE_KEY", "fixture");
  // Left over from when owners could fund editors' runs: set to prove nothing reads them any more.
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

it("runs an owner's loopback Ollama model without an API key or paid budget and still enforces revocation", async () => {
  vi.stubEnv("NEWSBEE_MODE", "local");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "ollama");
  vi.stubEnv("NEWSBEE_OLLAMA_MODEL", "fixture-local-model");
  vi.stubEnv("NEWSBEE_OLLAMA_URL", "http://127.0.0.1:11434");
  const run = await boundRun(resolveRunOptions({ mode: "manual", paid: {} }), owner);
  const transport: HttpTransport = async request => {
    requests.push(request);
    return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ response: "local answer", done: true })) };
  };
  expect(await generate(run, { ...deps, transport })).toBe("local answer");
  expect(requests.map(request => new URL(request.url).hostname)).toEqual(["127.0.0.1"]);
  expect(await db.collection("api_calls").countDocuments({ paid: true })).toBe(0);
  expect(await db.collection("journalist_funding_audit").findOne({ run_id: run._id })).toMatchObject({ provider: "ollama", sponsor_id: owner.id });
  await revokeCredentialProfile(db, owner);
  await expect(generate(run, { ...deps, transport })).rejects.toThrow(/revoked|changed/);
  expect(requests).toHaveLength(1);
});

it.each([
  ["cloud", "http://127.0.0.1:11434", {}],
  ["local", "http://127.0.0.1:11434", { NODE_ENV: "production" }],
  ["local", "http://127.0.0.1:11434", { VERCEL: "1" }],
  ["local", "http://models.example.test:11434", {}],
  ["local", "http://127.0.0.1.example.test:11434", {}],
] as const)("refuses keyless Ollama in %s at %s with %j", (mode, url, env) => {
  const settings = { ...loadSettings({ NODE_ENV: "test", NEWSBEE_MODE: "local", NEWSBEE_MODEL_PROVIDERS: "ollama", NEWSBEE_OLLAMA_MODEL: "fixture", NEWSBEE_OLLAMA_URL: url }), mode };
  expect(executionModels(settings, env)).toEqual([]);
});

it("does not grant a deployed editor access to a keyless local model", async () => {
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "ollama");
  vi.stubEnv("NEWSBEE_OLLAMA_MODEL", "fixture-local-model");
  vi.stubEnv("NEWSBEE_OLLAMA_URL", "http://127.0.0.1:11434");
  await expect(prepareBinding(db, infrastructureSettings(), editor, "one", "edition", resolveRunOptions({ paid: {} }))).rejects.toThrow("personal model API key");
});

it.each(["owner", "editor"] as const)("preserves image-input support for the %s and checks revocation before sending an image", async (role) => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "openai");
  vi.stubEnv("NEWSBEE_LLM_OPENAI_MODEL", "fixture-vision");
  vi.stubEnv("NEWSBEE_LLM_OPENAI_BASE_URL", "https://vision.example.test/v1");
  vi.stubEnv("NEWSBEE_LLM_OPENAI_API_KEY", "fixture-owner-vision-key");
  vi.stubEnv("NEWSBEE_LLM_OPENAI_VISION", "true");
  const principal = role === "owner" ? owner : editor;
  if (role === "editor") await saveCredentialProfile(db, editor, { source: "personal", config: {
    modelProviders: [{ name: "openai", kind: "openai", model: "fixture-personal-vision", baseUrl: "https://personal-vision.example.test/v1", apiKey: "fixture-personal-vision-key", vision: true }],
  } });
  const run = await boundRun(resolveRunOptions({ mode: "manual", paid: { model: 2 } }), principal);
  const transport: HttpTransport = async request => {
    requests.push(request);
    return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: '{"approved":true}' }, finish_reason: "stop" }] })) };
  };
  const runtime = await runtimesForRun({ ...deps, transport }, run);
  expect(runtime.model.supportsVision).toBe(true);
  const image = { id: "fixture", mimeType: "image/png" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" };
  const schema = { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"], additionalProperties: false };
  const generateVision = () => withRunContext({ db, runId: run._id, locationId: run.location_id, options: run.options!, sponsorId: principal.id }, () => runtime.model.generateVisionStructured!("Review the image", [image], schema));
  expect((await generateVision()).response).toContain('"approved":true');
  expect(String(requests[0].body)).toContain("data:image/png;base64,");
  if (role === "editor") {
    expect(requests[0].url).toContain("personal-vision.example.test");
    expect(requests[0].headers?.Authorization).toBe("Bearer fixture-personal-vision-key");
    expect(await db.collection("journalist_funding_audit").findOne({ run_id: run._id })).toMatchObject({ funding: "personal" });
  }
  await revokeCredentialProfile(db, principal);
  await expect(generateVision()).rejects.toThrow(/revoked|changed/);
  expect(requests).toHaveLength(1);
});

it("keeps API calls unavailable when no deployment or personal keys are configured", async () => {
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "");
  vi.stubEnv("NEWSBEE_SERPAPI_API_KEY", "");
  const settings = personalSettings(infrastructureSettings(), editor, null);
  expect(settings.modelProviders.every((provider) => !provider.apiKey)).toBe(true);
  expect(settings.integrations.serpapiKey).toBeNull();
  await expect(prepareBinding(db, deps.settings, editor, "one", "edition", options())).rejects.toThrow("Environment & API settings");
  // An old run's "final" purpose and approval id no longer unlock anyone else's keys.
  await expect(prepareBinding(db, deps.settings, editor, "one", "edition", { ...options(), purpose: "final", admin_approval_id: "old-approval" })).rejects.toThrow("Environment & API settings");
  expect(requests).toHaveLength(0);
});
it("does not accept a model name without a personal key", async () => {
  await save(editor, null);
  await expect(boundRun()).rejects.toThrow("Environment & API settings");
});
it("blocks an editor without personal credentials despite configured deployment keys", async () => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  await expect(boundRun(options(), editor)).rejects.toThrow("personal model API key");
  await expect(personalRequestDeps(deps, editor)).rejects.toThrow("personal model API key");
  expect(requests).toHaveLength(0);
  await save(editor, "fixture-editor-override-key");
  const overrideRun = await boundRun(options(), editor);
  await generate(overrideRun);
  expect(requests.at(-1)?.headers?.["x-goog-api-key"]).toBe("fixture-editor-override-key");
  expect(await db.collection("journalist_funding_audit").findOne({ run_id: overrideRun._id })).toMatchObject({ funding: "personal" });
});
it("preserves automatic deployment defaults for the configured owner only", async () => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "fixture-owner-deployment-key");
  const run = await boundRun(options(), owner);
  expect(run.execution).toMatchObject({ source: "environment", credentialVersion: 0, sponsorId: owner.id });
  expect(await credentialProfile(db, owner)).toBeNull();
  expect(await generate(run)).toBe("personal answer");
  expect(requests[0].headers?.["x-goog-api-key"]).toBe("fixture-owner-deployment-key");
  expect(await db.collection("journalist_funding_audit").findOne({ run_id: run._id })).toMatchObject({ funding: "environment" });
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "replacement@example.test");
  await expect(generate(run)).rejects.toThrow("owner-only");
  expect(requests).toHaveLength(1);
});
it("blocks historical editor environment bindings even with a current personal profile", async () => {
  await save();
  const run = await boundRun();
  run.execution!.source = "environment";
  await runs(db).updateOne({ _id: run._id }, { $set: { execution: run.execution } });
  await expect(authorizePaidAction(db, run._id, editor)).rejects.toThrow("owner-only");
  await expect(generate(run)).rejects.toThrow("owner-only");
  expect(requests).toHaveLength(0);
});
it("blocks persisted editor environment profiles and matching unfinished bindings until personal replacement and reconnection", async () => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "fixture-server-key");
  await expect(boundRun(options(), editor)).rejects.toThrow("personal model API key");
  const profile = { userId: editor.id, source: "environment" as const, version: 1, config: null, revoked: false };
  await db.collection("journalist_credentials").insertOne({ _id: editor.id, source: "environment", version: 1, revoked: false } as never);
  expect(() => personalSettings(deps.settings, editor, profile)).toThrow("restricted to the exact");
  await expect(boundRun(options(), editor)).rejects.toThrow("revoked");
  await expect(personalRequestDeps(deps, editor)).rejects.toThrow("revoked");
  const run = newRun(location("one"), { by: editor.email, kind: "manual" }, "2099-01-01", ["2099-01-01", "2099-01-08"], [], null, null, options());
  run.admission = "newsroom";
  run.execution = {
    sponsorId: editor.id, initiatedBy: editor.id, source: "environment", credentialVersion: 1,
    planHash: createHash("sha256").update(JSON.stringify(normalizedPlan("one", "edition", options(), profile))).digest("hex"),
  };
  await runs(db).insertOne(run);
  await expect(authorizePaidAction(db, run._id, editor)).rejects.toThrow("owner-only");
  await expect(generate(run)).rejects.toThrow("owner-only");
  expect((await getRun(db, run._id))?.execution_blocked?.reason).toContain("owner-only");
  expect(requests).toHaveLength(0);
  await save(editor, "fixture-own-key");
  await expect(generate(run)).rejects.toThrow("owner-only");
  const binding = await prepareBinding(db, deps.settings, editor, "one", "edition", run.options, run._id);
  await runs(db).updateOne({ _id: run._id }, { $set: { execution: binding }, $unset: { execution_blocked: "" } });
  expect(await generate((await getRun(db, run._id))!)).toBe("personal answer");
  expect(requests).toHaveLength(1);
  expect(requests[0].headers?.["x-goog-api-key"]).toBe("fixture-own-key");
  expect(await db.collection("journalist_funding_audit").distinct("funding")).toEqual(["personal"]);
});
it("never inherits a same-name model key or adds deployment providers for an editor", async () => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini,other");
  vi.stubEnv("NEWSBEE_LLM_OTHER_BASE_URL", "https://deployment.example.test/v1");
  vi.stubEnv("NEWSBEE_LLM_OTHER_MODEL", "environment-model");
  vi.stubEnv("NEWSBEE_LLM_OTHER_API_KEY", "environment-other-key");
  await save(editor, null);
  const settings = personalSettings(deps.settings, editor, await credentialProfile(db, editor));
  expect(settings.modelProviders).toHaveLength(1);
  expect(settings.modelProviders[0].apiKey).toBeNull();
  await expect(boundRun()).rejects.toThrow("personal model API key");
});
it("blocks old personal bindings admitted using deployment fallback before resume, retries or worker calls", async () => {
  const profile = await save(editor, null);
  const run = newRun(location("one"), { by: editor.email, kind: "manual" }, "2099-01-01", ["2099-01-01", "2099-01-08"], [], null, null, options());
  run.execution = {
    sponsorId: editor.id, initiatedBy: editor.id, source: "personal", credentialVersion: profile.version,
    planHash: createHash("sha256").update(JSON.stringify(normalizedPlan("one", "edition", options(), profile))).digest("hex"),
  };
  await runs(db).insertOne(run);
  await expect(authorizePaidAction(db, run._id, editor)).rejects.toThrow("personal model API key");
  await expect(generate(run)).rejects.toThrow("personal model API key");
  expect(requests).toHaveLength(0);
});
it("requires only selected personal search and enabled integration credentials, even when deployment has them", async () => {
  vi.stubEnv("NEWSBEE_SERPAPI_API_KEY", "environment-search-key");
  vi.stubEnv("NEWSBEE_SCRAPINGBEE_API_KEY", "environment-scraper-key");
  await save();
  await expect(prepareBinding(db, deps.settings, editor, "one", "map", { ...options(), map_flow: "agentic", paid: { ...options().paid, serpapi: 5 } })).rejects.toThrow("your own serpapi");
  await expect(prepareBinding(db, deps.settings, editor, "one", "edition", { ...options(), paid: { ...options().paid, scrapingbee: 5 } })).rejects.toThrow("scrapingbee is enabled but has no personal key");
  await expect(prepareBinding(db, deps.settings, editor, "one", "edition", options())).resolves.toMatchObject({ source: "personal" });
  expect(requests).toHaveLength(0);
});
it("preserves owner fallback but rejects retained owner transports after owner designation changes", async () => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  await save(owner, null);
  const run = await boundRun(options(), owner);
  const worker = await runtimesForRun(deps, run);
  const oneOff = await personalRequestDeps(deps, owner, options());
  expect(oneOff.settings.modelProviders[0].apiKey).toBe("deployment-key-must-never-be-used");
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "replacement@example.test");
  await expect(worker.model.generate("mock")).rejects.toThrow("Owner designation changed");
  await expect(oneOff.transport({ url: "https://fixture.example.test" })).rejects.toThrow("Owner designation changed");
  expect(requests).toHaveLength(0);
  await expect(personalRequestDeps(deps, (await principalById(db, owner.id))!, options())).rejects.toThrow("personal model API key");
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
it("rechecks owner personal credential versions on retained worker and one-off transports", async () => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  await save(owner);
  const run = await boundRun(options(), owner);
  const worker = await runtimesForRun(deps, run);
  const oneOff = await personalRequestDeps(deps, owner, options());
  expect(oneOff.credentialVersion).toBe(1);
  expect(oneOff.settings.modelProviders[0].apiKey).toBe("fixture-personal-key");
  await save(owner, "fixture-owner-replacement");
  await expect(worker.model.generate("mock")).rejects.toThrow("changed");
  await expect(oneOff.transport({ url: "https://fixture.example.test" })).rejects.toThrow("changed");
  await db.collection("journalist_admins").updateOne({ principalId: owner.id }, { $set: { enabled: false } });
  await expect(worker.model.generate("mock")).rejects.toThrow("disabled");
  await expect(personalRequestDeps(deps, owner)).rejects.toThrow("disabled");
  expect(requests).toHaveLength(0);
});
it("uses the owner's personal key for guarded one-off model calls", async () => {
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  await save(owner, "fixture-owner-personal-key");
  const oneOff = await personalRequestDeps(deps, owner, options());
  expect(await oneOff.discoveryModel.generate("mock only")).toBe("personal answer");
  expect(requests[0].headers?.["x-goog-api-key"]).toBe("fixture-owner-personal-key");
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
it("attributes personal light-model calls to personal funding, not environment fallback", async () => {
  await save();
  const run = await boundRun();
  const runtime = await runtimesForRun(deps, run);
  await withRunContext({ db, runId: run._id, locationId: run.location_id, options: run.options!, sponsorId: editor.id }, () => runtime.lightModel!.generate("Fixture extraction."));
  expect(requests[0].headers?.["x-goog-api-key"]).toBe("fixture-personal-key");
  expect(await db.collection("journalist_funding_audit").findOne({ run_id: run._id })).toMatchObject({ role: "extraction", funding: "personal" });
});
it("blocks cross-editor additional spend even for the owner", async () => {
  await save(); const run = await boundRun();
  await expect(authorizePaidAction(db, run._id, other)).rejects.toThrow("started this run");
  await expect(authorizePaidAction(db, run._id, owner)).rejects.toThrow("started this run");
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
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "");
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
it("lets a signed-in editor run a map end to end on their own keys, with nothing from the owner", async () => {
  await save();
  const result = await startMapRun({ ...deps, principal: editor }, "one", { by: editor.email, kind: "manual" }, options());
  expect(result.started).toBe(true);
  expect(result.run.execution).toMatchObject({ sponsorId: editor.id, source: "personal", credentialVersion: 1 });
  expect(await generate(result.run)).toBe("personal answer");
  expect(requests.map((request) => request.headers?.["x-goog-api-key"])).toEqual(["fixture-personal-key"]);
  expect(JSON.stringify(requests)).not.toContain("fixed-admin");
  expect(await db.collection("journalist_funding_audit").distinct("funding")).toEqual(["personal"]);
});
it("admits the free local fixture search for an agentic map run, with no search key or budget, and refuses it deployed", async () => {
  await save();
  const settings = { modelProviders: [{ name: "gemini", kind: "gemini", model: "m", apiKey: "k" }], integrations: {} } as never;
  const fixture = () => resolveRunOptions({ mode: "manual", flow: "agentic", map_flow: "agentic", search_provider: "fixture", paid: { model: 10, agent_model: 10 } });
  // Local: the fixture needs no search key or budget, and the app's start path admits it, as the README's free local test runs it.
  vi.stubEnv("NEWSBEE_MODE", "local");
  const local = fixture();
  expect(capabilityReasons(settings, local, true)).toEqual([]);
  const result = await startMapRun({ ...deps, principal: editor }, "one", { by: editor.email, kind: "manual" }, local);
  expect(result.started).toBe(true);
  expect(result.run.options).toMatchObject({ search_provider: "fixture", map_flow: "agentic" });
  // Deployed: refused at admission, and by the run options themselves.
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  expect(capabilityReasons(settings, local, true)).toContain("Fixture search cannot be used for admitted newsroom runs.");
  expect(fixture).toThrow("The fixture search provider is local only.");
});
it("never falls back to anyone else's keys when the editor's own provider fails", async () => {
  await save(); const run = await boundRun();
  const failing: HttpTransport = async (request) => { requests.push(request); return { url: request.url, status: 503, headers: {}, body: new TextEncoder().encode("echo fixture-personal-key") }; };
  await expect(generate(run, { ...deps, transport: failing })).rejects.toThrow();
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((request) => request.url.includes("generativelanguage"))).toBe(true);
  expect(JSON.stringify(await db.collection("journalist_funding_audit").find({}).toArray())).not.toContain("fixture-personal-key");
});
it("keeps an unfinished run started with an old purpose and approval running on its starter's keys", async () => {
  await save();
  const legacy = { ...options(), purpose: "final", admin_approval_id: "old-approval" } as ReturnType<typeof options>;
  const run = await boundRun(legacy);
  await runs(db).updateOne({ _id: run._id }, { $set: { "execution.purpose": "final", "execution.approvalId": "old-approval" } });
  const stored = (await getRun(db, run._id))!;
  await expect(assertBindingCurrent(db, stored)).resolves.toBeTruthy();
  expect(await generate(stored)).toBe("personal answer");
  expect(requests).toHaveLength(1);
  expect(requests[0].headers?.["x-goog-api-key"]).toBe("fixture-personal-key");
});
it("runs an editor's map end to end on a non-Gemini model, and records which provider and model served it", async () => {
  await saveCredentialProfile(db, editor, { source: "personal", config: { modelProviders: [{ name: "openai", kind: "openai", model: "editor-model", baseUrl: "https://llm.example.test/v1", apiKey: "fixture-openai-key" }] } });
  const result = await startMapRun({ ...deps, principal: editor }, "one", { by: editor.email, kind: "manual" }, resolveRunOptions({ mode: "manual", flow: "current", paid: { model: 10 } }));
  expect(result.run.execution).toMatchObject({ sponsorId: editor.id, source: "personal" });
  expect(await generate(result.run)).toBe("fixed admin answer");
  expect(requests.map((request) => new URL(request.url).hostname)).toEqual(["llm.example.test"]);
  expect(JSON.stringify(requests)).not.toContain("generativelanguage");
  expect(await db.collection("api_calls").findOne({ run_id: result.run._id, outcome: "ok" })).toMatchObject({ service: "model", provider: "openai", model: "editor-model" });
  expect(await db.collection("journalist_funding_audit").findOne({ run_id: result.run._id })).toMatchObject({ provider: "openai", model: "editor-model", sponsor_id: editor.id, funding: "personal" });
});
it("keeps an unfinished run saved with the old Gemini and OpenAI-compatible budgets running under the one model budget", async () => {
  await save();
  const legacy = { ...options(), paid: { gemini: 10, openai_compatible: 5, agent_model: 10 } } as unknown as ReturnType<typeof options>;
  const run = await boundRun(legacy);
  const stored = (await getRun(db, run._id))!;
  expect(stored.options?.paid).toMatchObject({ gemini: 10 });
  await expect(assertBindingCurrent(db, stored)).resolves.toBeTruthy();
  expect(await generate(stored)).toBe("personal answer");
  expect(requests).toHaveLength(1);
});
