import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const routeMocks = vi.hoisted(() => ({ database: vi.fn(), auth: vi.fn() }));
vi.mock("@/auth", () => ({ getMongoDatabase: routeMocks.database, auth: routeMocks.auth }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "workspace.example.test" }),
  cookies: async () => ({ get: () => undefined }),
}));

import {
  createEditorInvitation, renewEditorInvitation, issueAccountPasswordReset, deleteAccessAccount, listAccessPolicy, updateAccessPolicy,
} from "../../accounts/access-policy";
import {
  acceptInvitation,
  invitationDetails,
  PasswordAuthError,
  verifyPasswordLogin,
  resetPassword,
  passwordResetDetails,
  changePassword,
} from "../../accounts/password-auth";
import { principalForEmail, principalForSession, type Principal } from "../../accounts/identity";
import { POST as issueLink, GET as accessSnapshot } from "../../../app/api/admin/access/route";
import { POST as redeemLink } from "../../../app/api/auth/password-reset/route";
import { GET as passwordDetails, POST as updatePassword } from "../../../app/api/account/password/route";
import { enterMaintenance, fencedDatabase, maintenanceState } from "../../../../../shared/restore-maintenance";

let server: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let owner: Principal;

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await MongoClient.connect(server.getUri());
  db = client.db("password-auth-tests");
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

beforeEach(async () => {
  await db.dropDatabase();
  vi.clearAllMocks();
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "owner@example.test");
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret");
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  owner = (await principalForEmail(db, "owner@example.test"))!;
  routeMocks.database.mockResolvedValue(db);
  routeMocks.auth.mockResolvedValue(null);
});

const request = () => new Request("https://workspace.example.test/password", {
  headers: { "x-forwarded-for": "192.0.2.42" },
});
const oldPassword = "Strong-password-123";
const newPassword = "Replacement-password-456";
async function credentialAccount() {
  const created = await createEditorInvitation(db, owner, "editor@example.test");
  await acceptInvitation(db, {
    token: created.invitation.token, email: created.account.email, username: "editor.one", password: oldPassword,
  });
  const account = (await listAccessPolicy(db, owner)).accounts.find((row) => row.principalId === created.account.principalId)!;
  return account;
}
async function recoveryFor(principalId: string, actor = owner) {
  const stored = await db.collection("journalist_admins").findOne({ principalId });
  return issueAccountPasswordReset(db, actor, { targetPrincipalId: principalId, expectedRevision: stored?.revision ?? 0 });
}

describe("manual password recovery", () => {
  it("holds the writer fence through a real transaction's commit while maintenance drains", async () => {
    const handle = await fencedDatabase(db);
    const session = handle.client.startSession();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const draining = new Promise<void>((resolve) => { release = resolve; });
    try {
      const transaction = session.withTransaction(async () => {
        await handle.collection("restore_transaction_probe").insertOne({ value: "committed" }, { session });
        entered();
        await draining;
      });
      await started;
      await enterMaintenance(db, owner);
      expect((await maintenanceState(db)).writers).toHaveLength(1);
      await expect(handle.collection("restore_transaction_probe").insertOne({ value: "not admitted" }))
        .rejects.toThrow("maintenance");
      release();
      await transaction;
      expect((await maintenanceState(db)).writers).toHaveLength(0);
      expect(await db.collection("restore_transaction_probe").countDocuments()).toBe(1);
    } finally {
      release?.();
      await session.endSession();
    }
  });

  it("consumes a reset once under concurrent redemption, revokes sessions and preserves identity, access and content", async () => {
    const account = await credentialAccount();
    await db.collection("test_content").insertOne({ author_id: account.principalId, text: "preserved" });
    await db.collection("output_channels").insertOne({ members: [{ principal_id: account.principalId, role: "editor" }] });
    const original = await db.collection("journalist_admins").findOne({ principalId: account.principalId });
    const issued = await recoveryFor(account.principalId);
    expect(JSON.stringify(await db.collection("journalist_password_resets").findOne({}))).not.toContain(issued.recovery.token);
    expect(await principalForSession(db, account.principalId, 1)).toMatchObject({ id: account.principalId });
    const outcomes = await Promise.allSettled([1, 2].map(() => resetPassword(db, {
      token: issued.recovery.token, password: newPassword,
    }, request())));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await principalForSession(db, account.principalId, 1)).toBeNull();
    expect(await principalForSession(db, account.principalId, undefined)).toBeNull();
    expect(await principalForSession(db, account.principalId, 2)).toMatchObject({ id: account.principalId });
    const stored = await db.collection("journalist_admins").findOne({ principalId: account.principalId });
    expect(stored).toMatchObject({ _id: original!._id, principalId: account.principalId, role: "editor", enabled: true, username: "editor.one" });
    expect(await db.collection("test_content").findOne({ author_id: account.principalId })).toMatchObject({ text: "preserved" });
    expect(await db.collection("output_channels").findOne({ "members.principal_id": account.principalId })).toMatchObject({ members: [{ principal_id: account.principalId, role: "editor" }] });
    await expect(verifyPasswordLogin(db, "editor.one", oldPassword, request())).rejects.toMatchObject({ status: 401 });
    await expect(verifyPasswordLogin(db, "editor.one", newPassword, request())).resolves.toMatchObject({ sessionVersion: 2 });
    await expect(resetPassword(db, { token: issued.recovery.token, password: oldPassword }, request())).rejects.toMatchObject({ status: 404 });
  });

  it("projects setup, invitation, expired and credentials-set states without leaking credential or token fields", async () => {
    await db.collection("journalist_admins").insertOne({ principalId: "unconfigured", email: "new@example.test", enabled: true });
    let rows = (await listAccessPolicy(db, owner)).accounts;
    expect(rows.find((row) => row.principalId === "unconfigured")?.passwordStatus).toBe("setup_required");
    const created = await createEditorInvitation(db, owner, "editor@example.test");
    rows = (await listAccessPolicy(db, owner)).accounts;
    expect(rows.find((row) => row.principalId === created.account.principalId)?.passwordStatus).toBe("invited");
    await db.collection("journalist_admins").updateOne({ principalId: created.account.principalId }, {
      $set: { passwordSetupExpiresAt: new Date(0) },
    });
    await db.collection("journalist_account_invitations").deleteMany({});
    rows = (await listAccessPolicy(db, owner)).accounts;
    expect(rows.find((row) => row.principalId === created.account.principalId)?.passwordStatus).toBe("expired");
    const issued = await recoveryFor(created.account.principalId);
    await resetPassword(db, { token: issued.recovery.token, username: "editor.setup", password: newPassword }, request());
    const snapshot = await listAccessPolicy(db, owner);
    expect(snapshot.accounts.find((row) => row.principalId === created.account.principalId)?.passwordStatus).toBe("credentials_set");
    expect(JSON.stringify(snapshot)).not.toMatch(/passwordHash|token_hash|sessionVersion|Strong-password|Replacement-password/);
    expect(JSON.stringify(snapshot)).not.toContain(issued.recovery.token);
  });

  it("rejects expiry without relying on TTL and supersedes old recovery links", async () => {
    const account = await credentialAccount();
    const first = await recoveryFor(account.principalId);
    const second = await recoveryFor(account.principalId);
    await expect(passwordResetDetails(db, first.recovery.token, request())).rejects.toMatchObject({ status: 404 });
    await db.collection("journalist_password_resets").updateOne({ used_at: null }, { $set: { expires_at: new Date(0) } });
    await expect(resetPassword(db, { token: second.recovery.token, password: newPassword }, request())).rejects.toMatchObject({ status: 404 });
    await expect(verifyPasswordLogin(db, "editor.one", oldPassword, request())).resolves.toMatchObject({ id: account.principalId });
  });

  it("enforces hierarchy, revisions, disabled targets and disabled issuers", async () => {
    const account = await credentialAccount();
    await db.collection("journalist_admins").insertOne({
      email: "admin@example.test", principalId: "admin", role: "admin", enabled: true, revision: 0,
    });
    const admin = (await principalForEmail(db, "admin@example.test"))!;
    await expect(recoveryFor(owner.id, admin)).rejects.toMatchObject({ status: 403 });
    await expect(recoveryFor(admin.id, admin)).rejects.toMatchObject({ status: 403 });
    await expect(recoveryFor(admin.id, { id: account.principalId, email: account.email, role: "editor" })).rejects.toMatchObject({ status: 403 });
    await expect(issueAccountPasswordReset(db, owner, { targetPrincipalId: account.principalId, expectedRevision: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(issueAccountPasswordReset(db, owner, { targetPrincipalId: account.principalId, expectedRevision: 0 })).rejects.toMatchObject({ status: 409 });
    const issued = await recoveryFor(account.principalId, admin);
    await updateAccessPolicy(db, owner, { targetPrincipalId: admin.id, expectedRevision: 0, enabled: false });
    await expect(recoveryFor(account.principalId, admin)).rejects.toMatchObject({ status: 403 });
    await db.collection("journalist_admins").updateOne({ principalId: account.principalId }, { $set: { enabled: false } });
    await expect(resetPassword(db, { token: issued.recovery.token, password: newPassword }, request())).rejects.toMatchObject({ status: 404 });
    await expect(recoveryFor(account.principalId)).rejects.toMatchObject({ status: 409 });
  });

  it("throttles issuance and redemption with no plaintext identifiers or tokens in attempt storage", async () => {
    const account = await credentialAccount();
    for (let index = 0; index < 5; index++) await recoveryFor(account.principalId);
    await expect(recoveryFor(account.principalId)).rejects.toMatchObject({ status: 429 });
    const token = "x".repeat(43);
    for (let index = 0; index < 8; index++) {
      await expect(passwordResetDetails(db, token, request())).rejects.toMatchObject({ status: 404 });
    }
    await expect(passwordResetDetails(db, token, request())).rejects.toMatchObject({ status: 429 });
    const attempts = JSON.stringify(await db.collection("journalist_login_attempts").find({}).toArray());
    expect(attempts).not.toContain(token);
    expect(attempts).not.toContain("192.0.2.42");
    expect(attempts).not.toContain(account.principalId);
  });

  it("cleans up reset records on deletion and never binds an old link to a recreated email", async () => {
    const account = await credentialAccount();
    const issued = await recoveryFor(account.principalId);
    const stored = await db.collection("journalist_admins").findOne({ principalId: account.principalId });
    await deleteAccessAccount(db, owner, { targetPrincipalId: account.principalId, expectedRevision: stored!.revision });
    expect(await db.collection("journalist_password_resets").countDocuments({ principal_id: account.principalId })).toBe(0);
    const recreated = await createEditorInvitation(db, owner, account.email);
    expect(recreated.account.principalId).not.toBe(account.principalId);
    await expect(resetPassword(db, { token: issued.recovery.token, password: newPassword }, request())).rejects.toMatchObject({ status: 404 });
    const replacementLink = await recoveryFor(recreated.account.principalId);
    // Even an orphaned record cannot be rebound through an email lookup.
    await db.collection("journalist_admins").deleteOne({ principalId: recreated.account.principalId });
    await createEditorInvitation(db, owner, account.email);
    await expect(resetPassword(db, { token: replacementLink.recovery.token, password: newPassword }, request())).rejects.toMatchObject({ status: 404 });
  });

  it("requires the current password and session generation, and invalidates outstanding links after a change", async () => {
    const account = await credentialAccount();
    const principal = (await principalForEmail(db, account.email))!;
    const issued = await recoveryFor(account.principalId);
    await expect(changePassword(db, principal, 1, { currentPassword: "wrong", password: newPassword }, request())).rejects.toMatchObject({ status: 401 });
    await expect(changePassword(db, principal, 0, { currentPassword: oldPassword, password: newPassword }, request())).rejects.toMatchObject({ status: 401 });
    await changePassword(db, principal, 1, { currentPassword: oldPassword, password: newPassword }, request());
    expect(await principalForSession(db, account.principalId, 1)).toBeNull();
    await expect(resetPassword(db, { token: issued.recovery.token, password: oldPassword }, request())).rejects.toMatchObject({ status: 404 });
    await expect(changePassword(db, principal, 1, { currentPassword: newPassword, password: oldPassword }, request())).rejects.toMatchObject({ status: 401 });
  });

  it("does not authenticate an old password reset during bcrypt verification", async () => {
    const account = await credentialAccount();
    const issued = await recoveryFor(account.principalId);
    vi.spyOn(bcrypt, "compare").mockImplementationOnce(async () => {
      await resetPassword(db, { token: issued.recovery.token, password: newPassword }, request());
      return true;
    });
    await expect(verifyPasswordLogin(db, "editor.one", oldPassword, request())).rejects.toMatchObject({ status: 401 });
  });

  it("allows owner-issued Admin setup and self-service setup while invalidating older setup links on role changes", async () => {
    const created = await createEditorInvitation(db, owner, "editor@example.test");
    const promoted = await updateAccessPolicy(db, owner, {
      targetPrincipalId: created.account.principalId, expectedRevision: created.account.revision, role: "admin",
    });
    await expect(invitationDetails(db, created.invitation.token)).rejects.toMatchObject({ status: 404 });
    const setup = await recoveryFor(promoted.principalId);
    await resetPassword(db, { token: setup.recovery.token, username: "admin.one", password: oldPassword }, request());
    await expect(verifyPasswordLogin(db, "admin.one", oldPassword, request())).resolves.toMatchObject({ role: "admin", sessionVersion: 1 });
    await changePassword(db, owner, 0, { currentPassword: "", username: "owner.one", password: newPassword }, request());
    expect(await principalForSession(db, owner.id, undefined)).toBeNull();
    await expect(verifyPasswordLogin(db, "owner.one", newPassword, request())).resolves.toMatchObject({ id: owner.id, role: "owner" });
  });
});

const apiRequest = (path: string, method: string, body?: unknown, origin = "https://workspace.example.test") =>
  new Request(`https://workspace.example.test${path}`, {
    method, headers: { origin, "content-type": "application/json", "x-forwarded-for": "192.0.2.42" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const asSession = (principal: Pick<Principal, "id" | "email">, version = 0) => {
  routeMocks.auth.mockResolvedValue({ user: {
    email: principal.email, newsbeePrincipalId: principal.id, newsbeeSessionVersion: version,
  } });
};

describe("recovery HTTP boundaries", () => {
  it("returns a fragment link only to an authorized issuer, with no-store responses and safe later projections", async () => {
    const account = await credentialAccount();
    const input = { action: "password-reset", targetPrincipalId: account.principalId, expectedRevision: account.revision };
    expect((await issueLink(apiRequest("/api/admin/access", "POST", input))).status).toBe(401);
    asSession({ id: account.principalId, email: account.email }, 1);
    expect((await issueLink(apiRequest("/api/admin/access", "POST", input))).status).toBe(403);
    asSession(owner);
    expect((await issueLink(apiRequest("/api/admin/access", "POST", input, "https://elsewhere.test"))).status).toBe(403);
    const response = await issueLink(apiRequest("/api/admin/access", "POST", input));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    const url = new URL(body.recovery.resetUrl);
    expect(url.pathname).toBe("/reset-password");
    expect(url.search).toBe("");
    const token = url.hash.slice(1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const snapshot = await accessSnapshot(apiRequest("/api/admin/access", "GET"));
    expect(await snapshot.text()).not.toContain(token);
  });

  it("keeps a recovery link usable after failed input and rejects cross-origin requests and replay", async () => {
    const account = await credentialAccount();
    const { recovery } = await recoveryFor(account.principalId);
    const input = { token: recovery.token, password: newPassword };
    expect((await redeemLink(apiRequest("/api/auth/password-reset", "POST", input, "https://elsewhere.test"))).status).toBe(403);
    const inspected = await redeemLink(apiRequest("/api/auth/password-reset", "POST", { token: recovery.token, action: "inspect" }));
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({ email: account.email, username: "editor.one" });
    expect((await redeemLink(apiRequest("/api/auth/password-reset", "POST", { ...input, password: "weak" }))).status).toBe(400);
    expect((await redeemLink(apiRequest("/api/auth/password-reset", "POST", input))).status).toBe(200);
    expect((await redeemLink(apiRequest("/api/auth/password-reset", "POST", input))).status).toBe(404);
  });

  it("allows an editor to change only their own password and denies their revoked session on the next request", async () => {
    const account = await credentialAccount();
    asSession({ id: account.principalId, email: account.email }, 1);
    const metadata = await passwordDetails(apiRequest("/api/account/password", "GET"));
    expect(await metadata.json()).toEqual({ username: "editor.one", credentialsSet: true });
    const input = { currentPassword: oldPassword, password: newPassword, targetPrincipalId: owner.id };
    expect((await updatePassword(apiRequest("/api/account/password", "POST", input, "https://elsewhere.test"))).status).toBe(403);
    expect((await updatePassword(apiRequest("/api/account/password", "POST", input))).status).toBe(200);
    expect((await passwordDetails(apiRequest("/api/account/password", "GET"))).status).toBe(401);
    expect(await principalForSession(db, owner.id, 0)).toMatchObject({ id: owner.id });
  });
});

describe("invitation-only editor credentials", () => {
  it("rejects an account recreated with the same email while its predecessor's password is being checked", async () => {
    await db.collection("journalist_admins").insertOne({
      email: "editor@example.test", principalId: "original-editor", enabled: true,
      username: "editor.one", passwordHash: "original-password-hash",
    });
    const compare = vi.spyOn(bcrypt, "compare").mockImplementationOnce(async () => {
      await db.collection("journalist_admins").deleteOne({ principalId: "original-editor" });
      await db.collection("journalist_admins").insertOne({
        email: "editor@example.test", principalId: "replacement-editor", enabled: true,
        username: "editor.one", passwordHash: "replacement-password-hash",
      });
      return true;
    });
    await expect(verifyPasswordLogin(db, "editor.one", "old-password", new Request("https://workspace.example.test/login")))
      .rejects.toEqual(new PasswordAuthError("Invalid username or password", 401));
    expect(compare).toHaveBeenCalledWith("old-password", "original-password-hash");
  });
  it("stores only a token hash and consumes the invitation once", async () => {
    const created = await createEditorInvitation(db, owner, "editor@example.test");
    const invitation = await db.collection("journalist_account_invitations").findOne({
      principal_id: created.account.principalId,
    });
    expect(invitation).toMatchObject({ email: "editor@example.test", used_at: null });
    expect(JSON.stringify(invitation)).not.toContain(created.invitation.token);
    await expect(invitationDetails(db, created.invitation.token)).resolves.toMatchObject({
      email: "editor@example.test",
    });

    await acceptInvitation(db, {
      token: created.invitation.token,
      email: "editor@example.test",
      username: "editor.one",
      password: "Strong-password-123",
    });
    const stored = await db.collection("journalist_admins").findOne({ principalId: created.account.principalId });
    expect(stored?.username).toBe("editor.one");
    expect(stored?.passwordHash).not.toBe("Strong-password-123");
    await expect(acceptInvitation(db, {
      token: created.invitation.token,
      email: "editor@example.test",
      username: "editor.two",
      password: "Strong-password-456",
    })).rejects.toMatchObject({ status: 404 });
  });

  it("authenticates enabled accounts and rejects disabled accounts without exposing which check failed", async () => {
    const created = await createEditorInvitation(db, owner, "editor@example.test");
    await acceptInvitation(db, {
      token: created.invitation.token,
      email: "editor@example.test",
      username: "editor.one",
      password: "Strong-password-123",
    });
    const request = new Request("https://workspace.example.test/login", {
      headers: { "x-forwarded-for": "192.0.2.1" },
    });
    await expect(verifyPasswordLogin(db, "EDITOR.ONE", "Strong-password-123", request))
      .resolves.toMatchObject({ id: created.account.principalId, role: "editor" });
    await db.collection("journalist_admins").updateOne(
      { principalId: created.account.principalId },
      { $set: { enabled: false } },
    );
    await expect(verifyPasswordLogin(db, "editor.one", "Strong-password-123", request))
      .rejects.toEqual(new PasswordAuthError("Invalid username or password", 401));
  });

  it("requires the invitation email and strong credential values", async () => {
    const created = await createEditorInvitation(db, owner, "editor@example.test");
    await expect(acceptInvitation(db, {
      token: created.invitation.token,
      email: "other@example.test",
      username: "Editor One",
      password: "short",
    })).rejects.toMatchObject({ status: 400 });
  });

  it("reissues unused editor invitations while invalidating the previous token", async () => {
    const created = await createEditorInvitation(db, owner, "editor@example.test");
    const renewed = await renewEditorInvitation(db, owner, {
      targetPrincipalId: created.account.principalId,
      expectedRevision: created.account.revision,
    });
    expect(renewed.invitation.token).not.toBe(created.invitation.token);
    await expect(invitationDetails(db, created.invitation.token)).rejects.toMatchObject({ status: 404 });
    await expect(invitationDetails(db, renewed.invitation.token)).resolves.toMatchObject({
      email: "editor@example.test",
    });
  });
});
