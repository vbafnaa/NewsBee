import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, NextAuthConfig, User } from "next-auth";

const mocks = vi.hoisted(() => ({
  configure: vi.fn((config: NextAuthConfig) => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() })),
  principal: vi.fn(),
  consent: vi.fn(),
  findAccount: vi.fn(),
  database: { collection: vi.fn() },
  authority: {
    _id: "site", phase: "open", epoch: 0, identityGeneration: "0", writers: [],
    owner: { id: "owner-id", email: "owner@example.test", role: "owner" },
  },
}));
vi.mock("next-auth", () => ({ default: mocks.configure }));
vi.mock("mongodb", () => ({
  MongoClient: class {
    async connect() { return this; }
    db() { return mocks.database; }
  },
}));
vi.mock("../../accounts/identity", () => ({ principalForEmail: mocks.principal }));
vi.mock("../../storage/drive-consent", () => ({ saveDriveConsent: mocks.consent }));
vi.mock("../../accounts/password-auth", () => ({ PasswordAuthError: class extends Error {}, verifyPasswordLogin: vi.fn() }));
import "../../../auth";

const callbacks = mocks.configure.mock.calls[0][0].callbacks!;
const google: Account = { provider: "google", type: "oidc", providerAccountId: "google-provider-id" };
const credentials: Account = { provider: "credentials", type: "credentials", providerAccountId: "newsbee-editor" };
const session = () => ({ user: { email: "editor@example.test" }, expires: "2099-01-01T00:00:00.000Z" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MONGODB_URI", "mongodb://fixture.invalid");
  vi.stubEnv("MONGODB_DATABASE", "fixture");
  mocks.principal.mockResolvedValue({ id: "newsbee-editor", email: "editor@example.test", role: "editor" });
  Object.assign(mocks.authority, { phase: "open", epoch: 0, identityGeneration: "0" });
  mocks.database.collection.mockImplementation((name: string) => name === "_newsbee_restore_state"
    ? { updateOne: async () => ({ matchedCount: 1 }), findOne: async () => mocks.authority }
    : { findOne: mocks.findAccount });
  mocks.findAccount.mockResolvedValue({ principalId: "newsbee-editor", enabled: true, sessionVersion: 0 });
});
afterEach(() => vi.unstubAllEnvs());

describe("stable principal JWT binding", () => {
  it.each([
    ["/", "https://newsbee.test/"],
    ["/reader?edition=latest#story", "https://newsbee.test/reader?edition=latest#story"],
    ["https://newsbee.test/newsroom/assigned?draft=one#editions", "https://newsbee.test/newsroom/assigned?draft=one#editions"],
    ["https://elsewhere.test/newsroom", "https://newsbee.test/"],
    ["//elsewhere.test", "https://newsbee.test/"],
    ["/api/auth/callback/google", "https://newsbee.test/"],
    ["/login", "https://newsbee.test/login"],
  ])("constrains the actual OAuth/password redirect callback %s", async (url, destination) => {
    expect(await callbacks.redirect!({ url, baseUrl: "https://newsbee.test" })).toBe(destination);
  });

  it.each([google, credentials])("binds a fresh admitted $provider sign-in to the Newsbee ID", async (account) => {
    const user: User = { id: account.providerAccountId, email: "editor@example.test", newsbeeSessionVersion: 0, newsbeeRestoreGeneration: "0" };
    expect(await callbacks.signIn!({ user, account, profile: { email_verified: true } })).toBe(true);
    const token = await callbacks.jwt!({ token: { sub: user.id }, user, account });
    expect(token?.newsbeePrincipalId).toBe("newsbee-editor");
    expect(token?.newsbeeSessionVersion).toBe(0);
    expect(token?.newsbeeRestoreGeneration).toBe("0");
    expect(mocks.principal).toHaveBeenCalledWith(expect.anything(), "editor@example.test");
    expect(await callbacks.session!({ session: session(), token }))
      .toMatchObject({ user: { newsbeePrincipalId: "newsbee-editor" } });
  });

  it("rejects an old-password login verified before a reset, and never upgrades its generation during JWT issuance", async () => {
    const user: User = { id: "newsbee-editor", email: "editor@example.test", newsbeeSessionVersion: 0, newsbeeRestoreGeneration: "0" };
    mocks.findAccount.mockResolvedValueOnce({ principalId: "newsbee-editor", enabled: true, sessionVersion: 1 });
    expect(await callbacks.signIn!({ user, account: credentials })).toBe(false);
    expect(user.newsbeePrincipalId).toBeUndefined();
    expect(user.newsbeeSessionVersion).toBeUndefined();

    user.newsbeeSessionVersion = 0;
    user.newsbeeRestoreGeneration = "0";
    expect(await callbacks.signIn!({ user, account: credentials })).toBe(true);
    mocks.findAccount.mockResolvedValue({ sessionVersion: 1 });
    const token = await callbacks.jwt!({ token: {}, user, account: credentials });
    expect(token?.newsbeeSessionVersion).toBe(0);
    const refreshed = await callbacks.jwt!({
      token, user: {}, account: null, trigger: "update", session: { newsbeeSessionVersion: 1 },
    });
    expect(refreshed?.newsbeeSessionVersion).toBe(0);
  });

  it("rejects unverified Google email and a credentials principal replaced after authorize", async () => {
    const user: User = { id: "deleted-principal", email: "editor@example.test" };
    expect(await callbacks.signIn!({ user, account: google, profile: { email_verified: false } })).toBe(false);
    expect(mocks.principal).not.toHaveBeenCalled();
    expect(await callbacks.signIn!({ user, account: credentials })).toBe(false);
    expect(user.newsbeePrincipalId).toBeUndefined();
  });

  it("never upgrades legacy email-only JWTs, including client session-update payloads", async () => {
    const token = await callbacks.jwt!({
      token: { email: "editor@example.test", sub: "google-provider-id" },
      user: {},
      account: null,
      trigger: "update",
      session: { user: { newsbeePrincipalId: "newsbee-editor" }, newsbeePrincipalId: "newsbee-editor" },
    });
    expect(token).not.toHaveProperty("newsbeePrincipalId");
    expect(await callbacks.session!({ session: session(), token })).not.toHaveProperty("user.newsbeePrincipalId");
    expect(mocks.principal).not.toHaveBeenCalled();
  });

  it("does not mistake a provider user ID for an admitted Newsbee principal claim", async () => {
    const token = await callbacks.jwt!({
      token: { newsbeePrincipalId: "stale-principal" },
      user: { id: "google-provider-id", email: "editor@example.test" },
      account: google,
    });
    expect(token).not.toHaveProperty("newsbeePrincipalId");
    expect(mocks.principal).not.toHaveBeenCalled();
  });

  it("preserves the original binding on refresh without consulting email or client-supplied identity", async () => {
    const token = await callbacks.jwt!({
      token: { email: "editor@example.test", newsbeePrincipalId: "deleted-principal" },
      user: {},
      account: null,
      trigger: "update",
      session: { newsbeePrincipalId: "replacement-principal" },
    });
    expect(token?.newsbeePrincipalId).toBe("deleted-principal");
    expect(mocks.principal).not.toHaveBeenCalled();
  });

  it("retains Google consent processing without exposing refresh tokens in the client session", async () => {
    const user: User = { id: "google-provider-id", email: "editor@example.test" };
    await callbacks.signIn!({ user, account: google, profile: { email_verified: true } });
    const token = await callbacks.jwt!({
      token: {},
      user,
      account: {
        ...google, refresh_token: "fixture-refresh-token",
        scope: "https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/drive",
      },
    });
    expect(token).toMatchObject({
      youtubeRefreshToken: "fixture-refresh-token", googleDriveRefreshToken: "fixture-refresh-token",
      newsbeePrincipalId: "newsbee-editor",
    });
    expect(mocks.consent).toHaveBeenCalledWith(expect.anything(), user.email, "fixture-refresh-token");
    const exposed = await callbacks.session!({ session: session(), token });
    expect(exposed).toEqual({ ...session(), user: { ...session().user, newsbeePrincipalId: "newsbee-editor", newsbeeSessionVersion: 0, newsbeeRestoreGeneration: "0" } });
    expect(JSON.stringify(exposed)).not.toContain("fixture-refresh-token");
  });

  it("does not bless a credential verification from before a restore with the new independent generation", async () => {
    mocks.authority.identityGeneration = "new-independent-restore-generation";
    const user: User = {
      id: "newsbee-editor", email: "editor@example.test", newsbeeSessionVersion: 0, newsbeeRestoreGeneration: "0",
    };
    expect(await callbacks.signIn!({ user, account: credentials })).toBe(false);
    expect(user.newsbeeRestoreGeneration).toBeUndefined();
    const token = await callbacks.jwt!({
      token: { newsbeePrincipalId: "newsbee-editor", newsbeeRestoreGeneration: "0" },
      user: {}, account: null, trigger: "update", session: { newsbeeRestoreGeneration: mocks.authority.identityGeneration },
    });
    expect(token?.newsbeeRestoreGeneration).toBe("0");
  });

  it("preserves only verified configured-owner Google recovery during a partial restore", async () => {
    vi.stubEnv("NEWSBEE_OWNER_EMAIL", "owner@example.test");
    Object.assign(mocks.authority, { phase: "failed", identityGeneration: "restore-recovery" });
    mocks.findAccount.mockResolvedValue(null);
    mocks.principal.mockResolvedValue(null);
    const user: User = { id: "google-id", email: "owner@example.test" };
    expect(await callbacks.signIn!({ user, account: google, profile: { email_verified: true } })).toBe(true);
    expect(user).toMatchObject({ newsbeePrincipalId: "owner-id", newsbeeRestoreGeneration: "restore-recovery" });
    expect(await callbacks.signIn!({
      user: { id: "editor-id", email: "editor@example.test" }, account: google, profile: { email_verified: true },
    })).toBe(false);
    expect(await callbacks.signIn!({ user: { id: "owner-id", email: user.email }, account: credentials })).toBe(false);
    expect(await callbacks.signIn!({ user, account: google, profile: { email_verified: false } })).toBe(false);
    expect(mocks.principal).not.toHaveBeenCalled();
  });
});
