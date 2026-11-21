import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const routeMocks = vi.hoisted(() => ({
  database: vi.fn(),
  guard: vi.fn(),
  principal: vi.fn(),
  auth: vi.fn(),
}));
vi.mock("@/auth", () => ({ getMongoDatabase: routeMocks.database, auth: routeMocks.auth }));
vi.mock("@/lib/admin-session", () => ({
  currentPrincipal: routeMocks.principal,
  operatorGuard: routeMocks.guard,
}));

import {
  accessPolicyAuditIsIntact,
  AccessPolicyError,
  createEditorAccount,
  deleteAccessAccount,
  listAccessPolicy,
  updateAccessPolicy,
  type AccessPolicyAuditEvent,
} from "../../accounts/access-policy";
import { principalForEmail, type Principal } from "../../accounts/identity";
import { listOutputChannels } from "../../orchestration/output-channels";
import { COLLECTIONS } from "../../storage/mongo";
import { PATCH as patchAccess } from "../../../app/api/admin/access/route";
import { enterMaintenance, fencedDatabase } from "../../../../../shared/restore-maintenance";

let server: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let owner: Principal;
let admin: Principal;

const publicationA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const publicationB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const patch = (body: unknown) => new Request("https://workspace.example.test/api/admin/access", {
  method: "PATCH",
  headers: { origin: "https://workspace.example.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await MongoClient.connect(server.getUri());
  db = client.db("access-policy-tests");
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  vi.clearAllMocks();
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "owner@example.test");
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  owner = (await principalForEmail(db, "owner@example.test"))!;
  await db.collection("journalist_admins").insertOne({
    email: "admin@example.test",
    principalId: "admin-principal",
    role: "admin",
    enabled: true,
    revision: 0,
  });
  admin = (await principalForEmail(db, "admin@example.test"))!;
  await db.collection(COLLECTIONS.outputChannels).insertMany([
    {
      _id: publicationA,
      owner_id: owner.id,
      name: "Alpha publication",
      enabled: true,
      members: [],
    },
    {
      _id: publicationB,
      owner_id: owner.id,
      name: "Beta publication",
      enabled: true,
      members: [],
    },
  ]);
  routeMocks.database.mockResolvedValue(db);
  routeMocks.guard.mockResolvedValue(null);
  routeMocks.principal.mockResolvedValue(owner);
});

describe("global access policy mutations", () => {
  it("distinguishes archived destinations from paused newsrooms in the safe People projection", async () => {
    await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationA }, { $set: { enabled: false } });
    await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationB }, { $set: { enabled: false, archived_at: 123 } });
    const snapshot = await listAccessPolicy(db, owner);
    expect(snapshot.publications).toEqual([
      { id: publicationA, name: "Alpha publication", enabled: false, archivedAt: null },
      { id: publicationB, name: "Beta publication", enabled: false, archivedAt: 123 },
    ]);
  });

  it("preserves maintenance refusal as 503 without changing the target account", async () => {
    const fenced = await fencedDatabase(db);
    routeMocks.database.mockResolvedValue(fenced);
    const before = await db.collection("journalist_admins").findOne({ principalId: admin.id });
    await enterMaintenance(db, owner);
    const response = await patchAccess(patch({
      targetPrincipalId: admin.id, expectedRevision: before!.revision, enabled: false,
    }));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await db.collection("journalist_admins").findOne({ principalId: admin.id })).toEqual(before);
  });

  it("keeps the configured owner immutable and always enabled", async () => {
    const snapshot = await listAccessPolicy(db, owner);
    const account = snapshot.accounts.find(({ role }) => role === "owner")!;
    expect(account).toMatchObject({ email: owner.email, enabled: true, role: "owner" });
    await expect(updateAccessPolicy(db, owner, {
      targetPrincipalId: account.principalId,
      expectedRevision: account.revision,
      role: "editor",
    })).rejects.toMatchObject({ status: 403 });
    await expect(updateAccessPolicy(db, owner, {
      targetPrincipalId: account.principalId,
      expectedRevision: account.revision,
      enabled: false,
    })).rejects.toMatchObject({ status: 403 });
    expect(await principalForEmail(db, owner.email)).toMatchObject({ role: "owner" });
  });

  it("allows only the owner to promote and demote global admins", async () => {
    const editor = await createEditorAccount(db, owner, "editor@example.test");
    const assigned = await updateAccessPolicy(db, owner, {
      targetPrincipalId: editor.principalId,
      expectedRevision: editor.revision,
      publicationIds: [publicationA],
    });
    await expect(updateAccessPolicy(db, admin, {
      targetPrincipalId: editor.principalId,
      expectedRevision: assigned.revision,
      role: "admin",
    })).rejects.toMatchObject({ status: 403 });
    const promoted = await updateAccessPolicy(db, owner, {
      targetPrincipalId: editor.principalId,
      expectedRevision: assigned.revision,
      role: "admin",
    });
    expect(promoted.role).toBe("admin");
    expect(promoted.publicationIds).toEqual([]);
    expect(await db.collection(COLLECTIONS.outputChannels).countDocuments({
      "members.principal_id": editor.principalId,
    })).toBe(0);
    expect(await principalForEmail(db, editor.email)).toMatchObject({ role: "admin" });
    const demoted = await updateAccessPolicy(db, owner, {
      targetPrincipalId: editor.principalId,
      expectedRevision: promoted.revision,
      role: "editor",
    });
    expect(demoted.role).toBe("editor");
  });

  it("lets admins manage editors but not the owner or other admins", async () => {
    const editor = await createEditorAccount(db, admin, "editor@example.test");
    const assigned = await updateAccessPolicy(db, admin, {
      targetPrincipalId: editor.principalId,
      expectedRevision: editor.revision,
      publicationIds: [publicationA],
    });
    expect(assigned.publicationIds).toEqual([publicationA]);
    const disabled = await updateAccessPolicy(db, admin, {
      targetPrincipalId: editor.principalId,
      expectedRevision: assigned.revision,
      enabled: false,
    });
    expect(disabled.enabled).toBe(false);
    await expect(updateAccessPolicy(db, admin, {
      targetPrincipalId: admin.id,
      expectedRevision: 0,
      enabled: false,
    })).rejects.toMatchObject({ status: 403 });
    await expect(updateAccessPolicy(db, admin, {
      targetPrincipalId: owner.id,
      expectedRevision: 0,
      enabled: false,
    })).rejects.toMatchObject({ status: 403 });
    await db.collection("journalist_admins").insertOne({
      email: "peer@example.test",
      principalId: "peer-admin",
      role: "admin",
      enabled: true,
      revision: 0,
    });
    await expect(updateAccessPolicy(db, admin, {
      targetPrincipalId: "peer-admin",
      expectedRevision: 0,
      enabled: false,
    })).rejects.toMatchObject({ status: 403 });
    expect(await db.collection("journalist_admins").countDocuments({
      principalId: { $in: [owner.id, admin.id, "peer-admin"] },
      enabled: true,
    })).toBe(3);
  });

  it("suspends and reactivates admins without changing identity, ownership, memberships or blocked work", async () => {
    const { currentPrincipal, operatorGuard } = await vi.importActual<typeof import("../../../lib/admin-session")>(
      "../../../lib/admin-session",
    );
    routeMocks.auth.mockResolvedValue({ user: { newsbeePrincipalId: admin.id, email: admin.email } });
    await db.collection(COLLECTIONS.outputChannels).updateOne(
      { _id: publicationA },
      { $set: { owner_id: admin.id, members: [{ principal_id: admin.id, role: "admin" }] } },
    );
    await db.collection(COLLECTIONS.outputChannels).updateOne(
      { _id: publicationB },
      { $set: { members: [{ principal_id: admin.id, role: "editor" }] } },
    );
    const publications = await db.collection(COLLECTIONS.outputChannels).find({}).sort({ _id: 1 }).toArray();
    await db.collection("pipeline_runs").insertOne({
      _id: "admin-sponsored",
      status: "authoring",
      execution: { sponsorId: admin.id, source: "personal", credentialVersion: 1 },
    });
    const runBefore = await db.collection("pipeline_runs").findOne({ _id: "admin-sponsored" });
    expect(await currentPrincipal()).toEqual(admin);
    const disabled = await updateAccessPolicy(db, owner, {
      targetPrincipalId: admin.id,
      expectedRevision: 0,
      enabled: false,
    });
    expect(disabled).toMatchObject({
      principalId: admin.id, role: "admin", enabled: false, revision: 1,
      publicationIds: [publicationA, publicationB],
    });
    expect(await currentPrincipal()).toBeNull();
    expect((await operatorGuard(new Request("https://workspace.example.test/api/admin/access")))?.status).toBe(401);
    const blockedRun = await db.collection("pipeline_runs").findOne({ _id: "admin-sponsored" });
    expect(blockedRun).toEqual({
      ...runBefore,
      execution_blocked: { reason: expect.stringContaining("disabled"), at: expect.any(Number) },
    });

    const stale = await patchAccess(patch({
      targetPrincipalId: admin.id,
      expectedRevision: 0,
      enabled: true,
    }));
    expect(stale.status).toBe(409);
    expect(await currentPrincipal()).toBeNull();
    const enabled = await updateAccessPolicy(db, owner, {
      targetPrincipalId: admin.id,
      expectedRevision: disabled.revision,
      enabled: true,
    });
    expect(enabled).toMatchObject({
      principalId: admin.id, role: "admin", enabled: true, revision: 2,
      publicationIds: [publicationA, publicationB],
    });
    expect(await currentPrincipal()).toEqual(admin);
    expect(await operatorGuard(new Request("https://workspace.example.test/api/admin/access"))).toBeNull();
    expect(await db.collection(COLLECTIONS.outputChannels).find({}).sort({ _id: 1 }).toArray()).toEqual(publications);
    expect(await db.collection("pipeline_runs").findOne({ _id: "admin-sponsored" })).toEqual(blockedRun);
    const events = await db.collection<AccessPolicyAuditEvent>(COLLECTIONS.accessPolicyAudit)
      .find({ target_principal_id: admin.id }).sort({ "after.revision": 1 }).toArray();
    const adminState = { role: "admin", publicationIds: [publicationA, publicationB] };
    expect(events).toMatchObject([
      {
        action: "status_changed",
        before: { ...adminState, enabled: true, revision: 0 },
        after: { ...adminState, enabled: false, revision: 1 },
      },
      {
        action: "status_changed",
        before: { ...adminState, enabled: false, revision: 1 },
        after: { ...adminState, enabled: true, revision: 2 },
      },
    ]);
    expect(events.every(accessPolicyAuditIsIntact)).toBe(true);
  });

  it("keeps role changes separate and refuses promotion of disabled editors", async () => {
    const editor = await createEditorAccount(db, owner, "editor@example.test");
    const disabled = await updateAccessPolicy(db, owner, {
      targetPrincipalId: editor.principalId, expectedRevision: editor.revision, enabled: false,
    });
    await expect(updateAccessPolicy(db, owner, {
      targetPrincipalId: editor.principalId, expectedRevision: disabled.revision, role: "admin",
    })).rejects.toMatchObject({ status: 409 });
    await expect(updateAccessPolicy(db, owner, {
      targetPrincipalId: admin.id, expectedRevision: 0, role: "editor", enabled: false,
    })).rejects.toMatchObject({ status: 400 });
    await expect(updateAccessPolicy(db, owner, {
      targetPrincipalId: admin.id, expectedRevision: 0, role: "editor", publicationIds: [publicationA],
    })).rejects.toMatchObject({ status: 400 });
    const assignedAdmin = await updateAccessPolicy(db, owner, {
      targetPrincipalId: admin.id, expectedRevision: 0, publicationIds: [publicationA],
    });
    expect(assignedAdmin.publicationIds).toEqual([publicationA]);
    expect(await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationA }))
      .toMatchObject({ members: [{ principal_id: admin.id, role: "editor" }], lifecycle_revision: 1 });
  });

  it("isolates editor publications and revokes disabled access immediately without erasing assignments", async () => {
    const editor = await createEditorAccount(db, owner, "editor@example.test");
    const assigned = await updateAccessPolicy(db, admin, {
      targetPrincipalId: editor.principalId,
      expectedRevision: editor.revision,
      publicationIds: [publicationA],
    });
    expect((await listOutputChannels(db, editor.principalId)).map(({ id }) => id)).toEqual([publicationA]);
    expect(await db.collection(COLLECTIONS.outputChannels).findOne({
      _id: publicationB,
      "members.principal_id": editor.principalId,
    })).toBeNull();

    const disabled = await updateAccessPolicy(db, admin, {
      targetPrincipalId: editor.principalId,
      expectedRevision: assigned.revision,
      enabled: false,
    });
    expect(await principalForEmail(db, editor.email)).toBeNull();
    expect(await db.collection(COLLECTIONS.outputChannels).countDocuments({
      "members.principal_id": editor.principalId,
    })).toBe(1);
    await expect(updateAccessPolicy(db, admin, {
      targetPrincipalId: editor.principalId,
      expectedRevision: disabled.revision,
      publicationIds: [publicationA, publicationB],
    })).rejects.toMatchObject({ status: 409 });

    const enabled = await updateAccessPolicy(db, admin, {
      targetPrincipalId: editor.principalId,
      expectedRevision: disabled.revision,
      enabled: true,
    });
    expect(enabled.publicationIds).toEqual([publicationA]);
    expect(await principalForEmail(db, editor.email)).toMatchObject({ id: editor.principalId, role: "editor" });
  });

  it("returns an HTTP 409 for stale concurrent updates", async () => {
    const editor = await createEditorAccount(db, owner, "editor@example.test");
    await updateAccessPolicy(db, admin, {
      targetPrincipalId: editor.principalId,
      expectedRevision: editor.revision,
      enabled: false,
    });
    const response = await patchAccess(patch({
      targetPrincipalId: editor.principalId,
      expectedRevision: editor.revision,
      enabled: true,
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ detail: expect.stringContaining("changed since") });
  });

  it("rolls back the account mutation when the append-only audit insert fails", async () => {
    const editor = await createEditorAccount(db, owner, "editor@example.test");
    const disabled = await updateAccessPolicy(db, admin, {
      targetPrincipalId: editor.principalId,
      expectedRevision: editor.revision,
      enabled: false,
    });
    await db.collection(COLLECTIONS.accessPolicyAudit).createIndex({ action: 1 }, { unique: true });
    await expect(updateAccessPolicy(db, admin, {
      targetPrincipalId: editor.principalId,
      expectedRevision: disabled.revision,
      enabled: true,
    })).rejects.toThrow();
    expect(await db.collection("journalist_admins").findOne({ principalId: editor.principalId }))
      .toMatchObject({ enabled: false, revision: disabled.revision });
  });

  it("writes intact hashed audit events for role, status and assignment changes", async () => {
    const editor = await createEditorAccount(db, owner, "editor@example.test");
    const assigned = await updateAccessPolicy(db, admin, {
      targetPrincipalId: editor.principalId,
      expectedRevision: editor.revision,
      publicationIds: [publicationB],
    });
    await updateAccessPolicy(db, admin, {
      targetPrincipalId: editor.principalId,
      expectedRevision: assigned.revision,
      enabled: false,
    });
    const events = await db.collection<AccessPolicyAuditEvent>(COLLECTIONS.accessPolicyAudit)
      .find({ target_principal_id: editor.principalId })
      .toArray();
    expect(events.map(({ action }) => action)).toEqual(expect.arrayContaining([
      "account_created",
      "publication_assignments_changed",
      "status_changed",
    ]));
    expect(events.every(accessPolicyAuditIsIntact)).toBe(true);
    expect(new AccessPolicyError("stale", 409).status).toBe(409);
  });

  it("permanently deletes editors with identity-owned state and preserves immutable audit history", async () => {
    const editor = await createEditorAccount(db, owner, "editor@example.test");
    const assigned = await updateAccessPolicy(db, admin, {
      targetPrincipalId: editor.principalId,
      expectedRevision: editor.revision,
      publicationIds: [publicationA],
    });
    await db.collection("journalist_credentials").insertOne({ _id: editor.principalId, version: 1 });
    await db.collection("google_drive_consents").insertOne({ _id: editor.email, credential: "encrypted" });
    await db.collection(COLLECTIONS.videoUploadSessions).insertOne({
      _id: "upload-1",
      owner_id: editor.principalId,
    });
    await db.collection(COLLECTIONS.videoUploadChunks).insertOne({ _id: "upload-1:0", data: "chunk" });
    await db.collection(COLLECTIONS.videoJobs).insertOne({
      _id: "video-job-1",
      requested_by: editor.principalId,
      status: "queued",
    });

    await deleteAccessAccount(db, admin, {
      targetPrincipalId: editor.principalId,
      expectedRevision: assigned.revision,
    });
    expect(await db.collection("journalist_admins").findOne({ principalId: editor.principalId })).toBeNull();
    expect(await db.collection(COLLECTIONS.outputChannels).countDocuments({
      "members.principal_id": editor.principalId,
    })).toBe(0);
    expect(await db.collection("journalist_credentials").findOne({ _id: editor.principalId })).toBeNull();
    expect(await db.collection("google_drive_consents").findOne({ _id: editor.email })).toBeNull();
    expect(await db.collection(COLLECTIONS.videoUploadChunks).findOne({ _id: "upload-1:0" })).toBeNull();
    expect(await db.collection(COLLECTIONS.videoJobs).findOne({ _id: "video-job-1" }))
      .toMatchObject({ status: "failed", error: expect.stringContaining("permanently deleted") });
    const deletion = await db.collection<AccessPolicyAuditEvent>(COLLECTIONS.accessPolicyAudit)
      .findOne({ target_principal_id: editor.principalId, action: "account_deleted" });
    expect(deletion && accessPolicyAuditIsIntact(deletion)).toBe(true);
    expect(deletion?.after).toBeNull();
  });

  it("enforces deletion authority and rejects publication owners instead of transferring ownership", async () => {
    await expect(deleteAccessAccount(db, admin, {
      targetPrincipalId: owner.id,
      expectedRevision: 0,
    })).rejects.toMatchObject({ status: 403 });
    await expect(deleteAccessAccount(db, admin, {
      targetPrincipalId: admin.id,
      expectedRevision: 0,
    })).rejects.toMatchObject({ status: 403 });

    const editor = await createEditorAccount(db, owner, "owner-editor@example.test");
    await db.collection(COLLECTIONS.outputChannels).updateOne(
      { _id: publicationA },
      { $set: { owner_id: editor.principalId } },
    );
    await expect(deleteAccessAccount(db, owner, {
      targetPrincipalId: editor.principalId,
      expectedRevision: editor.revision,
    })).rejects.toMatchObject({ status: 409 });
    expect(await db.collection("journalist_admins").findOne({ principalId: editor.principalId })).not.toBeNull();
  });
});
