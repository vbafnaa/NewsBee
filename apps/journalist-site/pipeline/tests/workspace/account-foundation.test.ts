import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { disableAccount, principalById, principalForEmail, type Principal } from "../../accounts/identity";
import { credentialProfile, effectiveCredentialProfile, emptyPersonalConfig, revokeCredentialProfile, safeProfile, saveCredentialProfile } from "../../accounts/credentials";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), headers: vi.fn(), database: vi.fn(), list: vi.fn(), enable: vi.fn(), disable: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth, getMongoDatabase: mocks.database, listAdminAccounts: mocks.list, enableAdminAccount: mocks.enable, disableAdminAccount: mocks.disable }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
import { adminGuard, currentPrincipal, localAdminAllowed, ownerGuard } from "../../../lib/admin-session";
import { GET, PUT, DELETE } from "../../../app/api/account/settings/route";
import { GET as users, POST as updateUser } from "../../../app/api/journalist-admins/route";
import { GET as clearPreview, POST as clearData } from "../../../app/api/admin/usage-map/clear/route";
import type { NextRequest } from "next/server";
import ApprovalsPage from "../../../app/approvals/page";

let server: MongoMemoryServer, client: MongoClient, db: Db;
const owner: Principal = { id: "owner-fixture", email: "owner@example.test", role: "owner" };
const editor: Principal = { id: "editor-fixture", email: "editor@example.test", role: "editor" };
const testKey = "fixture-value-not-a-live-secret";
const provider = { name: "fixture", kind: "openai" as const, model: "fixture-model", apiKey: testKey, baseUrl: "https://provider.example.test/v1" };
const personal = { source: "personal" as const, config: { modelProviders: [provider] } };
const unfinished = ["mapping", "collecting", "awaiting_authoring", "authoring", "awaiting_finish", "finishing", "publishing"];
type FixtureRun = { _id: string; status: string; execution?: { sponsorId: string }; execution_blocked?: { reason: string; at: number } };
async function seedSponsoredRuns() {
  const rows: FixtureRun[] = [
    ...unfinished.map((status) => ({ _id: status, status, execution: { sponsorId: editor.id } })),
    ...["published", "failed", "cancelled"].map((status) => ({ _id: status, status, execution: { sponsorId: editor.id } })),
    { _id: "other-editor", status: "authoring", execution: { sponsorId: owner.id } },
    { _id: "legacy", status: "collecting" },
  ];
  await db.collection<FixtureRun>("pipeline_runs").insertMany(rows);
  return db.collection<FixtureRun>("pipeline_runs");
}
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri()); db = client.db("account-foundation");
});
afterAll(async () => { await client?.close(); await server?.stop(); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  await db.dropDatabase(); vi.clearAllMocks();
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", owner.email);
  vi.stubEnv("NEWSBEE_MODE", "cloud"); vi.stubEnv("VERCEL", ""); vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NEWSBEE_CREDENTIAL_KEYS", JSON.stringify({ fixture: randomBytes(32).toString("base64") }));
  vi.stubEnv("NEWSBEE_CREDENTIAL_ACTIVE_KEY", "fixture");
  mocks.auth.mockResolvedValue(null); mocks.database.mockResolvedValue(db);
  mocks.headers.mockResolvedValue(new Headers({ host: "workspace.example.test" }));
});
async function signedIn(principal = editor) {
  await db.collection("journalist_admins").insertOne({ email: principal.email, principalId: principal.id, enabled: true });
  mocks.auth.mockResolvedValue({ user: { email: principal.email } });
}
const request = (method: string, input?: unknown, origin = "https://workspace.example.test") => new Request("https://workspace.example.test/api/account/settings", {
  method, headers: { origin, "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }),
});

describe("approved stable identities", () => {
  it("never promotes the first or oldest user and bootstraps only the configured owner", async () => {
    await db.collection("journalist_admins").insertOne({ email: editor.email, enabled: true, createdAt: new Date(0) });
    expect(await principalForEmail(db, editor.email)).toMatchObject({ role: "editor" });
    expect(await principalForEmail(db, " OWNER@EXAMPLE.TEST ")).toMatchObject({ email: owner.email, role: "owner" });
    expect(await principalForEmail(db, "unknown@example.test")).toBeNull();
    vi.stubEnv("NEWSBEE_OWNER_EMAIL", "");
    expect(await principalForEmail(db, owner.email)).toMatchObject({ role: "editor" });
  });
  it("persists one stable string id across concurrent access and rechecks disablement", async () => {
    await db.collection("journalist_admins").insertOne({ email: editor.email, enabled: true });
    const principals = await Promise.all(Array.from({ length: 5 }, () => principalForEmail(db, editor.email)));
    const id = principals[0]!.id;
    expect(new Set(principals.map((p) => p?.id)).size).toBe(1);
    await db.collection("journalist_admins").updateOne({ email: editor.email }, { $set: { enabled: false } });
    expect(await principalById(db, id)).toBeNull();
    expect(await principalForEmail(db, editor.email)).toBeNull();
  });
  it("allows local identity only with explicit local mode, localhost, and nondeployed nonproduction runtime", async () => {
    mocks.headers.mockResolvedValue(new Headers({ host: "127.0.0.1:3000" }));
    expect(await localAdminAllowed()).toBe(false);
    vi.stubEnv("NEWSBEE_MODE", "local");
    expect(await currentPrincipal()).toMatchObject({ id: "local-admin", role: "owner" });
    expect(await principalById(db, "local-admin")).toMatchObject({ role: "owner" });
    vi.stubEnv("NODE_ENV", "production");
    expect(await localAdminAllowed()).toBe(false);
    expect(await principalById(db, "local-admin")).toBeNull();
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VERCEL", "1");
    expect(await localAdminAllowed()).toBe(false);
    expect(await principalById(db, "local-admin")).toBeNull();
    vi.stubEnv("VERCEL", "");
    mocks.headers.mockResolvedValue(new Headers({ host: "remote.example.test" }));
    expect(await localAdminAllowed()).toBe(false);
  });
  it("rechecks membership and owner role for guards, with same-origin writes", async () => {
    await signedIn();
    expect(await adminGuard(request("GET"))).toBeNull();
    expect((await ownerGuard(request("DELETE")))?.status).toBe(403);
    mocks.auth.mockResolvedValue({ user: { email: owner.email } });
    expect(await ownerGuard(request("DELETE"))).toBeNull();
    expect((await ownerGuard(request("DELETE", undefined, "https://evil.example.test")))?.status).toBe(403);
    mocks.auth.mockResolvedValue({ user: { email: editor.email } });
    await db.collection("journalist_admins").updateOne({ email: editor.email }, { $set: { enabled: false } });
    expect(await currentPrincipal()).toBeNull();
  });
  it("blocks disabled accounts' unfinished sponsored runs without changing status or unpausing on reenable", async () => {
    await signedIn();
    const runs = await seedSponsoredRuns();
    await disableAccount(db, ` ${editor.email.toUpperCase()} `);
    expect(await principalById(db, editor.id)).toBeNull();
    for (const status of unfinished) {
      expect(await runs.findOne({ _id: status })).toMatchObject({
        status, execution_blocked: { reason: expect.stringContaining("disabled"), at: expect.any(Number) },
      });
    }
    for (const id of ["published", "failed", "cancelled", "other-editor", "legacy"]) {
      expect(await runs.findOne({ _id: id })).not.toHaveProperty("execution_blocked");
    }
    await db.collection("journalist_admins").updateOne({ email: editor.email }, { $set: { enabled: true, role: "editor" } });
    expect(await principalForEmail(db, editor.email)).toMatchObject({ id: editor.id });
    expect(await runs.findOne({ _id: "collecting" })).toHaveProperty("execution_blocked");
  });
  it("does not disable or block the configured owner", async () => {
    await principalForEmail(db, owner.email);
    const runs = await seedSponsoredRuns();
    await expect(disableAccount(db, owner.email)).rejects.toThrow("cannot be disabled");
    expect(await principalForEmail(db, owner.email)).toMatchObject({ role: "owner" });
    expect(await runs.findOne({ _id: "other-editor" })).not.toHaveProperty("execution_blocked");
  });
});

describe("encrypted versioned personal profiles", () => {
  it("stores no implicit profile and keeps personal override values separate from deployment defaults", async () => {
    vi.stubEnv("NEWSBEE_TAVILY_API_KEY", testKey);
    vi.stubEnv("NEWSBEE_SERPAPI_API_KEY", testKey);
    expect(await credentialProfile(db, owner)).toBeNull();
    const profile = await saveCredentialProfile(db, editor, { source: "personal", config: {} });
    expect(profile.config).toEqual(emptyPersonalConfig());
    expect(profile.config?.tavilySearchApiKey).toBeNull();
  });
  it("encrypts at rest and exposes masked metadata and ready provider list only", async () => {
    const profile = await saveCredentialProfile(db, editor, personal);
    const stored = await db.collection("journalist_credentials").findOne({});
    expect(JSON.stringify(stored)).not.toContain(testKey);
    expect(stored).not.toHaveProperty("config");
    expect((await credentialProfile(db, editor))?.config?.modelProviders[0].apiKey).toBe(testKey);
    const safe = safeProfile(profile);
    expect(JSON.stringify(safe)).not.toContain(testKey);
    expect(safe?.capabilities.readyProviders).toEqual([{ name: "fixture", kind: "openai", model: "fixture-model" }]);
  });
  it("preserves blank/omitted keys and explicitly removes null keys", async () => {
    await saveCredentialProfile(db, editor, { source: "personal", config: { modelProviders: [provider], tavilySearchApiKey: testKey, integrations: { exaKey: testKey } } });
    const kept = await saveCredentialProfile(db, editor, { source: "personal", config: { modelProviders: [{ ...provider, apiKey: "" }], tavilySearchApiKey: "" } });
    expect(kept.version).toBe(2); expect(kept.config?.modelProviders[0].apiKey).toBe(testKey);
    expect(kept.config?.integrations.exaKey).toBe(testKey);
    const removed = await saveCredentialProfile(db, editor, { source: "personal", config: { tavilySearchApiKey: null, integrations: { exaKey: null } } });
    expect(removed.config?.tavilySearchApiKey).toBeNull(); expect(removed.config?.integrations.exaKey).toBeNull();
  });
  it("preserves explicit personal image-input capability and rejects invalid flags", async () => {
    await saveCredentialProfile(db, editor, { source: "personal", config: { modelProviders: [{ ...provider, vision: true }] } });
    const saved = await saveCredentialProfile(db, editor, personal);
    expect(saved.config?.modelProviders[0].vision).toBe(true);
    const disabled = await saveCredentialProfile(db, editor, { source: "personal", config: { modelProviders: [{ ...provider, vision: false }] } });
    expect(disabled.config?.modelProviders[0].vision).toBe(false);
    await expect(saveCredentialProfile(db, editor, { source: "personal", config: { modelProviders: [{ ...provider, vision: "true" as never }] } })).rejects.toThrow("image-input capability");
  });
  it("increments replacement/revocation versions atomically under concurrency", async () => {
    const values = await Promise.all(Array.from({ length: 8 }, () => saveCredentialProfile(db, editor, personal)));
    expect(values.map((p) => p.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await revokeCredentialProfile(db, editor);
    expect(await credentialProfile(db, editor)).toMatchObject({ version: 9, revoked: true, config: null });
    expect((await db.collection("journalist_credentials").findOne({}))?.ciphertext).toBeUndefined();
    const replaced = await saveCredentialProfile(db, editor, { source: "personal", config: {} });
    expect(replaced.version).toBe(10); expect(replaced.config?.modelProviders).toEqual([]);
  });
  it("authenticates principal and version, and supports provisioned key rotation", async () => {
    await saveCredentialProfile(db, editor, personal);
    const stored = await db.collection("journalist_credentials").findOne({});
    await db.collection("journalist_credentials").updateOne({}, { $set: { version: 2 } });
    await expect(credentialProfile(db, editor)).rejects.toThrow();
    await db.collection("journalist_credentials").updateOne({}, { $set: { version: 1 } });
    await db.collection("journalist_credentials").insertOne({ ...stored, _id: owner.id } as never);
    await expect(credentialProfile(db, owner)).rejects.toThrow();
    const keys = JSON.parse(process.env.NEWSBEE_CREDENTIAL_KEYS!);
    keys.rotated = randomBytes(32).toString("base64");
    vi.stubEnv("NEWSBEE_CREDENTIAL_KEYS", JSON.stringify(keys)); vi.stubEnv("NEWSBEE_CREDENTIAL_ACTIVE_KEY", "rotated");
    expect((await credentialProfile(db, editor))?.version).toBe(1);
    await saveCredentialProfile(db, editor, personal);
    expect((await db.collection("journalist_credentials").findOne({ _id: editor.id } as never))?.keyId).toBe("rotated");
  });
  it("fails closed for missing provisioning, but supports revoke without decryption", async () => {
    await saveCredentialProfile(db, editor, personal);
    vi.stubEnv("NEWSBEE_CREDENTIAL_KEYS", "{}");
    await expect(credentialProfile(db, editor)).rejects.toThrow();
    await revokeCredentialProfile(db, editor);
    expect(await credentialProfile(db, editor)).toMatchObject({ revoked: true, version: 2 });
  });
  it("allows environment source only as an explicit owner choice, never inherited by editors", async () => {
    await expect(saveCredentialProfile(db, editor, { source: "environment" })).rejects.toThrow("Only the owner");
    expect(await saveCredentialProfile(db, owner, { source: "environment" })).toMatchObject({ source: "environment", config: null, revoked: false });
    expect(await credentialProfile(db, editor)).toBeNull();
    expect(await credentialProfile(db, { ...owner, role: "editor" })).toMatchObject({ revoked: true });
  });
  it("validates structurally without performing provider calls", async () => {
    await expect(saveCredentialProfile(db, editor, { source: "personal", config: { modelDailyCalls: -1 } })).rejects.toThrow();
    await expect(saveCredentialProfile(db, editor, { source: "personal", config: { modelProviders: [{ ...provider, baseUrl: "https://user:password@example.test" }] } })).rejects.toThrow();
    await expect(saveCredentialProfile(db, editor, { source: "personal", config: { modelProviders: [provider, provider] } })).rejects.toThrow();
    expect(await db.collection("journalist_credentials").countDocuments()).toBe(0);
  });
  it("blocks only matching unfinished runs after initial save, replacement and revoke while preserving statuses", async () => {
    const runs = await seedSponsoredRuns();
    const before = Date.now() / 1000;
    await saveCredentialProfile(db, editor, personal);
    for (const status of unfinished) {
      const run = await runs.findOne({ _id: status });
      expect(run).toMatchObject({ status, execution_blocked: { reason: expect.stringContaining("changed"), at: expect.any(Number) } });
      expect(run!.execution_blocked!.at).toBeGreaterThanOrEqual(before);
    }
    for (const id of ["published", "failed", "cancelled", "other-editor", "legacy"]) {
      expect(await runs.findOne({ _id: id })).not.toHaveProperty("execution_blocked");
    }
    await revokeCredentialProfile(db, editor);
    expect(await runs.findOne({ _id: "mapping" })).toMatchObject({ status: "mapping", execution_blocked: { reason: expect.stringContaining("revoked") } });
    await saveCredentialProfile(db, editor, personal);
    expect(await runs.findOne({ _id: "mapping" })).toMatchObject({ status: "mapping", execution_blocked: { reason: expect.stringContaining("changed") } });
    expect((await credentialProfile(db, editor))?.version).toBe(3);
  });
  it("does not block runs when configuration validation fails", async () => {
    const runs = await seedSponsoredRuns();
    await expect(saveCredentialProfile(db, editor, { source: "personal", config: { modelDailyCalls: -1 } })).rejects.toThrow();
    expect(await runs.countDocuments({ execution_blocked: { $exists: true } })).toBe(0);
  });
});

describe("settings API", () => {
  it("does not expose deployment defaults or report inherited capabilities to editors", async () => {
    await signedIn();
    vi.stubEnv("NEWSBEE_GEMINI_API_KEY", testKey);
    vi.stubEnv("NEWSBEE_SERPAPI_API_KEY", testKey);
    expect(await (await GET(request("GET"))).json()).toMatchObject({ profile: null });
    await saveCredentialProfile(db, editor, { source: "personal", config: {} });
    const data = await (await GET(request("GET"))).json();
    expect(data).not.toHaveProperty("environmentDefaults");
    expect(data.profile.capabilities).toMatchObject({ model: false, paidSearch: false, readyProviders: [], integrations: [] });
    expect(JSON.stringify(data)).not.toContain(testKey);
    vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "openai");
    vi.stubEnv("NEWSBEE_LLM_OPENAI_MODEL", "");
    expect((await GET(request("GET"))).status).toBe(200);
  });
  it("sends old approval-inbox links to the workspace while editors keep their settings access", async () => {
    expect(() => ApprovalsPage()).toThrow("redirect:/locations");
    await signedIn();
    expect((await GET(request("GET"))).status).toBe(200);
    mocks.auth.mockResolvedValue({ user: { email: owner.email } });
    expect(() => ApprovalsPage()).toThrow("redirect:/locations");
  });
  it("persists an explicit owner deployment selection across PUT/GET without an encryption keyring and returns only real masked readiness", async () => {
    await signedIn(owner);
    vi.stubEnv("NEWSBEE_CREDENTIAL_KEYS", "{}"); vi.stubEnv("NEWSBEE_CREDENTIAL_ACTIVE_KEY", "");
    vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "fixture");
    vi.stubEnv("NEWSBEE_LLM_FIXTURE_BASE_URL", "https://provider.example.test/v1");
    vi.stubEnv("NEWSBEE_LLM_FIXTURE_MODEL", "fixture-deployment-model");
    vi.stubEnv("NEWSBEE_LLM_FIXTURE_API_KEY", testKey);
    vi.stubEnv("NEWSBEE_SERPAPI_API_KEY", testKey);
    const automatic = (await (await GET(request("GET"))).json()).profile;
    expect(automatic).toMatchObject({ source: "environment", version: 0, automatic: true, config: null, capabilities: { model: true, paidSearch: true } });
    expect(JSON.stringify(automatic)).not.toContain(testKey);
    expect(await credentialProfile(db, owner)).toBeNull();
    const saved = await PUT(request("PUT", { source: "environment" }));
    expect(saved.status).toBe(200);
    const metadata = await saved.json();
    expect(metadata.profile).toMatchObject({
      source: "environment", version: 1, revoked: false, automatic: false, config: null, configurationError: null,
      capabilities: { model: true, paidSearch: true, readyProviders: [{ name: "fixture", kind: "openai", model: "fixture-deployment-model" }] },
    });
    expect(JSON.stringify(metadata)).not.toContain(testKey);
    expect((await (await GET(request("GET"))).json()).profile).toEqual(metadata.profile);
    expect(await credentialProfile(db, owner)).toMatchObject({ source: "environment", version: 1, config: null });
  });
  it("keeps automatic defaults read-only and lets an explicit revoke stop them permanently until replacement", async () => {
    await signedIn(owner);
    expect(await effectiveCredentialProfile(db, owner)).toMatchObject({ source: "environment", version: 0, automatic: true });
    expect(await db.collection("journalist_credentials").countDocuments()).toBe(0);
    const revoked = await DELETE(request("DELETE"));
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).profile).toMatchObject({ source: "environment", version: 1, revoked: true, automatic: false, capabilities: { model: false } });
    expect(await effectiveCredentialProfile(db, owner)).toMatchObject({ version: 1, revoked: true });
    await PUT(request("PUT", { source: "personal", config: {} }));
    expect(await effectiveCredentialProfile(db, owner)).toMatchObject({ source: "personal", version: 2, revoked: false });
    vi.stubEnv("NEWSBEE_OWNER_EMAIL", "replacement@example.test");
    expect(await effectiveCredentialProfile(db, owner)).toMatchObject({ source: "personal", version: 2 });
  });
  it("keeps a saved deployment source visible when provider configuration is missing or invalid", async () => {
    await signedIn(owner);
    vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
    vi.stubEnv("NEWSBEE_GEMINI_API_KEY", ""); vi.stubEnv("GOOGLE_AI_STUDIO_API_KEY", "");
    const saved = await PUT(request("PUT", { source: "environment" }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).profile).toMatchObject({ source: "environment", capabilities: { model: false } });
    vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "openai"); vi.stubEnv("NEWSBEE_LLM_OPENAI_MODEL", "");
    const read = await GET(request("GET"));
    expect(read.status).toBe(200);
    expect((await read.json()).profile).toMatchObject({
      source: "environment", version: 1, capabilities: { model: false },
      configurationError: expect.stringContaining("NEWSBEE_LLM_OPENAI_MODEL"),
    });
    expect((await DELETE(request("DELETE"))).status).toBe(200);
  });
  it("reports missing owner configuration without elevating an existing editor or preventing settings reads", async () => {
    await signedIn();
    vi.stubEnv("NEWSBEE_OWNER_EMAIL", "");
    const read = await GET(request("GET"));
    expect(await read.json()).toMatchObject({ principal: { role: "editor" }, ownerConfigured: false, profile: null });
    expect((await PUT(request("PUT", { source: "environment" }))).status).toBe(403);
  });
  it("permits unconfigured browsing and prevents cross-account/environment access", async () => {
    expect((await GET(request("GET"))).status).toBe(401);
    await signedIn();
    expect((await (await GET(request("GET"))).json()).profile).toBeNull();
    expect((await PUT(request("PUT", { source: "environment" }))).status).toBe(403);
    expect((await PUT(request("PUT", personal, "https://evil.example.test"))).status).toBe(403);
    const response = await PUT(request("PUT", { ...personal, userId: owner.id }));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(testKey);
    expect(await credentialProfile(db, owner)).toBeNull();
    expect((await DELETE(request("DELETE"))).status).toBe(200);
    expect(await credentialProfile(db, editor)).toMatchObject({ revoked: true, version: 2 });
  });
  it("keeps Users owner-only, normalizes editors and protects the configured owner", async () => {
    await signedIn();
    expect((await users(request("GET"))).status).toBe(403);
    expect((await updateUser(request("POST", { email: "new@example.test" }) as NextRequest)).status).toBe(403);
    mocks.auth.mockResolvedValue({ user: { email: owner.email } });
    mocks.enable.mockResolvedValue({ email: "new@example.test", enabled: true });
    expect((await updateUser(request("POST", { email: " NEW@EXAMPLE.TEST " }) as NextRequest)).status).toBe(201);
    expect(mocks.enable).toHaveBeenCalledWith("new@example.test");
    expect((await updateUser(request("POST", { email: owner.email, enabled: false }) as NextRequest)).status).toBe(403);
    expect(mocks.disable).not.toHaveBeenCalled();
    mocks.disable.mockResolvedValue({ email: editor.email, enabled: false });
    expect((await updateUser(request("POST", { email: editor.email, enabled: false }) as NextRequest)).status).toBe(201);
    expect(mocks.disable).toHaveBeenCalledWith(editor.email);
  });
  it("denies reader-data preview and deletion to editors before pipeline access", async () => {
    await signedIn();
    expect((await clearPreview(request("GET"))).status).toBe(403);
    expect((await clearData(request("POST", { location_id: "fixture" }))).status).toBe(403);
  });
});
