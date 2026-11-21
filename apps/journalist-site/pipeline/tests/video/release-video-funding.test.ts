import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveCredentialProfile } from "../../accounts/credentials";
import { infrastructureSettings } from "../../accounts/execution";
import { desktopVideoCredentials, managedRequestDeps } from "../../accounts/runtime";
import type { Principal } from "../../accounts/identity";
import type { HttpRequest, HttpTransport } from "../../core/http";
import type { OrchestratorDeps } from "../../orchestration/orchestrator";

const owner: Principal = { id: "owner-id", email: "owner@example.test", role: "owner" };
const admin: Principal = { id: "admin-id", email: "admin@example.test", role: "admin" };
const editor: Principal = { id: "editor-id", email: "editor@example.test", role: "editor" };
let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("release-video-funding");
});
beforeEach(async () => {
  await db.dropDatabase();
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", owner.email);
  vi.stubEnv("DESKTOP_VIDEO_API_KEY", "managed-desktop-key");
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "managed-model-key");
  vi.stubEnv("NEWSBEE_GEMINI_MODEL", "managed-model");
  vi.stubEnv("NEWSBEE_GEMINI_LIGHT_MODEL", "managed-light-model");
  vi.stubEnv("NEWSBEE_CREDENTIAL_KEYS", JSON.stringify({
    fixture: Buffer.alloc(32, 4).toString("base64"),
  }));
  vi.stubEnv("NEWSBEE_CREDENTIAL_ACTIVE_KEY", "fixture");
  await db.collection("journalist_admins").insertMany([
    { email: owner.email, principalId: owner.id, enabled: true, role: owner.role },
    { email: admin.email, principalId: admin.id, enabled: true, role: admin.role },
    { email: editor.email, principalId: editor.id, enabled: true, role: editor.role },
  ]);
  await db.collection("output_channels").insertOne({
    _id: "publication" as never, enabled: true, owner_id: owner.id,
    members: [{ principal_id: editor.id, role: "editor" }, { principal_id: admin.id, role: "editor" }],
  });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await client.close();
  await server.stop();
});

const deps = (transport?: HttpTransport): OrchestratorDeps => ({
  db,
  settings: infrastructureSettings(),
  model: {
    provider: "unconfigured",
    model: null,
    health: async () => ({ status: "not_configured", detail: "" }),
    generate: async () => "",
    generateStructured: async () => ({ response: "{}", done: true }),
  },
  store: {} as OrchestratorDeps["store"],
  ...(transport ? { transport } : {}),
});

describe("managed release video funding", () => {
  it("uses only personal model keys for an assigned Admin's release-package request", async () => {
    const requests: HttpRequest[] = [];
    const transport: HttpTransport = async (request) => {
      requests.push(request);
      return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "personal package" }] } }],
      })) };
    };
    const context = { runId: "admin-package", role: "release-video-package", publicationId: "publication" };
    await expect(managedRequestDeps(deps(transport), admin, context)).rejects.toThrow("personal model API key");
    expect(requests).toHaveLength(0);
    await saveCredentialProfile(db, admin, { source: "personal", config: {
      modelProviders: [{ name: "gemini", kind: "gemini", model: "personal-model", apiKey: "admin-model-key" }],
    } });
    const personal = await managedRequestDeps(deps(transport), admin, context);
    expect(await personal.discoveryModel.generate("Package")).toBe("personal package");
    expect(requests[0].headers?.["x-goog-api-key"]).toBe("admin-model-key");
    expect(await db.collection("model_usage").findOne({ sponsor_id: admin.id })).toMatchObject({
      funding: "personal", funding_identity: "personal", run_id: "admin-package", role: "release-video-package",
    });
  });

  it("uses managed Desktop for assigned editors and the explicit Owner exception, never for Admins", async () => {
    await saveCredentialProfile(db, editor, {
      source: "personal",
      config: { integrations: { desktopVideoKey: "editor-personal-key" } },
    });
    const editorCredentials = await desktopVideoCredentials(deps(), editor);
    expect(editorCredentials.selected).toMatchObject({
      fundingIdentity: "managed",
      credentialVersion: 0,
      key: "managed-desktop-key",
    });

    expect((await desktopVideoCredentials(deps(), owner)).selected).toMatchObject({
      fundingIdentity: "managed", credentialVersion: 0, key: "managed-desktop-key",
    });
    const ownerProfile = await saveCredentialProfile(db, owner, {
      source: "personal",
      config: { integrations: { desktopVideoKey: "owner-personal-key" } },
    });
    const personal = await desktopVideoCredentials(deps(), owner);
    expect(personal.selected).toMatchObject({
      fundingIdentity: "personal",
      credentialOwnerId: owner.id,
      credentialVersion: ownerProfile.version,
      key: "owner-personal-key",
    });
    expect(personal.forJob({
      requested_by: owner.id,
      funding_identity: "personal",
      credential_owner_id: owner.id,
      credential_version: ownerProfile.version,
    })).toMatchObject({ key: "owner-personal-key" });

    await saveCredentialProfile(db, owner, {
      source: "personal",
      config: { integrations: { desktopVideoKey: null } },
    });
    const fallback = await desktopVideoCredentials(deps(), owner);
    expect(fallback.selected).toMatchObject({
      fundingIdentity: "managed",
      credentialVersion: 0,
      key: "managed-desktop-key",
    });
    expect(fallback.forJob({
      requested_by: owner.id,
      funding_identity: "personal",
      credential_owner_id: owner.id,
      credential_version: ownerProfile.version,
    })).toBeNull();

    const adminProfile = await saveCredentialProfile(db, admin, {
      source: "personal",
      config: { integrations: { desktopVideoKey: "admin-personal-key" } },
    });
    expect((await desktopVideoCredentials(deps(), admin)).selected).toMatchObject({
      fundingIdentity: "personal",
      credentialOwnerId: admin.id,
      credentialVersion: adminProfile.version,
      key: "admin-personal-key",
    });
    await saveCredentialProfile(db, admin, {
      source: "personal",
      config: { integrations: { desktopVideoKey: null } },
    });
    expect((await desktopVideoCredentials(deps(), admin)).selected).toBeNull();
    expect((await desktopVideoCredentials(deps(), admin)).forJob({
      requested_by: admin.id, funding_identity: "managed", credential_version: 0,
    })).toBeNull();

    vi.stubEnv("NEWSBEE_CREDENTIAL_KEYS", "{}");
    const unreadable = await desktopVideoCredentials(deps(), owner);
    expect(unreadable).toMatchObject({ selected: null, selectionUnavailable: true });
    expect(unreadable.forJob({
      requested_by: owner.id,
      funding_identity: "managed",
      credential_version: 0,
    })).toMatchObject({ key: "managed-desktop-key", fundingIdentity: "managed" });
    expect(unreadable.forJob({
      requested_by: owner.id,
      funding_identity: "personal",
      credential_owner_id: owner.id,
      credential_version: ownerProfile.version,
    })).toBeNull();
  });

  it("generates one-off release packages on managed models with principal rechecks and no secret persistence", async () => {
    const requests: HttpRequest[] = [];
    const transport: HttpTransport = async (request) => {
      requests.push(request);
      return {
        url: request.url,
        status: 200,
        headers: {},
        body: new TextEncoder().encode(JSON.stringify({
          candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        })),
      };
    };
    const managed = await managedRequestDeps(deps(transport), editor, {
      runId: "release-video-package:publication:release:story",
      role: "release-video-package",
      publicationId: "publication",
    });
    await managed.discoveryModel.generateStructured("Prepare package", {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].headers?.["x-goog-api-key"]).toBe("managed-model-key");
    expect(await db.collection("journalist_funding_audit").findOne({
      run_id: "release-video-package:publication:release:story",
    })).toMatchObject({
      sponsor_id: editor.id,
      credential_version: 0,
      funding: "platform",
      funding_identity: "managed",
      role: "release-video-package",
    });
    const persisted = JSON.stringify({
      usage: await db.collection("model_usage").find({}).toArray(),
      audit: await db.collection("journalist_funding_audit").find({}).toArray(),
    });
    expect(persisted).not.toContain("managed-model-key");

    await db.collection("journalist_admins").updateOne(
      { principalId: editor.id },
      { $set: { enabled: false } },
    );
    await expect(managed.discoveryModel.generateStructured("Retry", {
      type: "object",
      properties: { ok: { type: "boolean" } },
    })).rejects.toThrow("disabled");
    expect(requests).toHaveLength(1);
  });
});
