import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { MongoServerError, type ClientSession, type Db, type WithId } from "mongodb";
import { normalizedEmail, principalForEmail, type Account, type Principal } from "./identity";
import { assertSiteOpen, maintenanceState } from "../../../../shared/restore-maintenance";

const INVITATION_LIFETIME_MS = 72 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 8;
const BCRYPT_ROUNDS = 12;
const RESET_LIFETIME_MS = 60 * 60 * 1000;

type PasswordReset = {
  restore_generation?: string;
  _id: string;
  token_hash: string;
  principal_id: string;
  session_version: number;
  issued_by: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
};

export type PasswordStatus = "setup_required" | "invited" | "expired" | "credentials_set";

type Invitation = {
  restore_generation?: string;
  _id: string;
  token_hash: string;
  principal_id: string;
  email: string;
  invited_by: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
};

type LoginAttempt = {
  _id: string;
  keys: string[];
  failed_at: Date;
  expires_at: Date;
};

export class PasswordAuthError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 404 | 409 | 429 | 503) {
    super(message);
  }
}

const invitationIndexes = new WeakMap<Db, Promise<void>>();
export async function ensurePasswordAuthIndexes(db: Db) {
  let pending = invitationIndexes.get(db);
  if (!pending) {
    pending = Promise.all([
      db.collection<Invitation>("journalist_account_invitations").createIndexes([
        { key: { token_hash: 1 }, unique: true, name: "account_invitation_token" },
        { key: { expires_at: 1 }, expireAfterSeconds: 0, name: "account_invitation_expiry" },
        { key: { principal_id: 1, used_at: 1 }, name: "account_invitation_principal" },
      ]),
      db.collection<Account>("journalist_admins").createIndexes([
        { key: { username: 1 }, unique: true, sparse: true, name: "journalist_account_username" },
      ]),
      db.collection<PasswordReset>("journalist_password_resets").createIndexes([
        { key: { token_hash: 1 }, unique: true, name: "password_reset_token" },
        { key: { expires_at: 1 }, expireAfterSeconds: 0, name: "password_reset_expiry" },
        { key: { principal_id: 1, created_at: -1 }, name: "password_reset_principal" },
        { key: { issued_by: 1, created_at: -1 }, name: "password_reset_issuer" },
      ]),
      db.collection<LoginAttempt>("journalist_login_attempts").createIndexes([
        { key: { keys: 1, failed_at: -1 }, name: "journalist_login_attempt_key" },
        { key: { expires_at: 1 }, expireAfterSeconds: 0, name: "journalist_login_attempt_expiry" },
      ]),
    ]).then(() => undefined).catch((error: unknown) => {
      invitationIndexes.delete(db);
      throw error;
    });
    invitationIndexes.set(db, pending);
  }
  await pending;
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function loginKey(kind: string, value: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new PasswordAuthError("Credential authentication is not configured", 503);
  return createHmac("sha256", secret).update(`${kind}:${value}`).digest("hex");
}

export function normalizedUsername(value: string) {
  return value.trim().toLowerCase();
}

export function validateUsername(value: string) {
  const username = normalizedUsername(value);
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) {
    throw new PasswordAuthError("Username must be 3-64 lowercase letters, numbers, dots, dashes, or underscores", 400);
  }
  return username;
}

export function validatePassword(value: string) {
  if (
    value.length < 12
    || value.length > 128
    || !/[a-z]/.test(value)
    || !/[A-Z]/.test(value)
    || !/[0-9]/.test(value)
    || !/[^A-Za-z0-9]/.test(value)
  ) {
    throw new PasswordAuthError("Password must be 12-128 characters with upper, lower, number, and symbol", 400);
  }
  return value;
}

export async function createInvitation(
  db: Db,
  actor: Principal,
  account: Account & { principalId: string },
  session: ClientSession,
) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await db.collection<Account>("journalist_admins").updateOne(
    { principalId: account.principalId },
    { $set: { passwordSetupExpiresAt: new Date(now.getTime() + INVITATION_LIFETIME_MS) } },
    { session },
  );
  await db.collection("journalist_password_resets").updateMany(
    { principal_id: account.principalId, used_at: null }, { $set: { used_at: now } }, { session },
  );
  await db.collection<Invitation>("journalist_account_invitations").insertOne({
    restore_generation: (await maintenanceState(db)).identityGeneration,
    _id: randomUUID(),
    token_hash: tokenHash(token),
    principal_id: account.principalId,
    email: normalizedEmail(account.email),
    invited_by: actor.id,
    expires_at: new Date(now.getTime() + INVITATION_LIFETIME_MS),
    used_at: null,
    created_at: now,
  }, { session });
  return { token, expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_MS) };
}

export async function invitationDetails(db: Db, token: string) {
  await ensurePasswordAuthIndexes(db);
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new PasswordAuthError("Invitation link is invalid or expired", 404);
  const invitation = await db.collection<Invitation>("journalist_account_invitations").findOne({
    token_hash: tokenHash(token),
    used_at: null,
    expires_at: { $gt: new Date() },
  });
  await assertSiteOpen(db);
  if (!invitation || (invitation.restore_generation ?? "0") !== (await maintenanceState(db)).identityGeneration) {
    throw new PasswordAuthError("Invitation link is invalid or expired", 404);
  }
  const account = await db.collection<Account>("journalist_admins").findOne({
    principalId: invitation.principal_id,
    email: invitation.email,
    enabled: true,
  });
  if (!account) throw new PasswordAuthError("Invitation link is invalid or expired", 404);
  return { email: invitation.email, expiresAt: invitation.expires_at };
}

export async function acceptInvitation(
  db: Db,
  input: { token: string; email: string; username: string; password: string },
) {
  await ensurePasswordAuthIndexes(db);
  const email = normalizedEmail(input.email);
  const username = validateUsername(input.username);
  const password = validatePassword(input.password);
  await invitationDetails(db, input.token);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const session = db.client.startSession();
  try {
    return await session.withTransaction(async () => {
      const invitations = db.collection<Invitation>("journalist_account_invitations");
      const invitation = await invitations.findOne({
        token_hash: tokenHash(input.token),
        used_at: null,
        expires_at: { $gt: new Date() },
      }, { session });
      if (!invitation || invitation.email !== email) {
        throw new PasswordAuthError("Invitation link is invalid, expired, or does not match this email", 404);
      }
      if ((invitation.restore_generation ?? "0") !== (await maintenanceState(db)).identityGeneration) {
        throw new PasswordAuthError("Invitation link predates the site restore", 404);
      }
      const account = await db.collection<Account>("journalist_admins").findOne({
        principalId: invitation.principal_id,
        email,
        enabled: true,
      }, { session });
      if (!account) throw new PasswordAuthError("Invitation account no longer exists", 404);
      if (account.username || account.passwordHash) {
        throw new PasswordAuthError("This invitation has already been used", 409);
      }
      const duplicate = await db.collection<Account>("journalist_admins").findOne({ username }, { session });
      if (duplicate) throw new PasswordAuthError("That username is unavailable", 409);

      const usedAt = new Date();
      const invitationResult = await invitations.updateOne(
        { _id: invitation._id, used_at: null },
        { $set: { used_at: usedAt } },
        { session },
      );
      if (invitationResult.modifiedCount !== 1) throw new PasswordAuthError("This invitation has already been used", 409);
      const accountResult = await db.collection<Account>("journalist_admins").updateOne(
        { _id: account._id, username: { $exists: false }, passwordHash: { $exists: false } },
        {
          $set: { username, passwordHash, passwordUpdatedAt: usedAt, updatedAt: usedAt },
          $inc: { sessionVersion: 1, revision: 1 },
          $unset: { passwordSetupExpiresAt: "" },
        },
        { session },
      );
      if (accountResult.modifiedCount !== 1) throw new PasswordAuthError("This invitation has already been used", 409);
      return { email, username };
    }) as { email: string; username: string };
  } finally {
    await session.endSession();
  }
}

const fakePasswordHash = bcrypt.hash("__newsbee_invalid_password__", BCRYPT_ROUNDS);

function requestIp(request: Request) {
  return (request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "unknown").trim();
}

export async function verifyPasswordLogin(
  db: Db,
  rawUsername: string,
  password: string,
  request: Request,
) {
  await assertSiteOpen(db);
  const restoreGeneration = (await maintenanceState(db)).identityGeneration;
  await ensurePasswordAuthIndexes(db);
  const username = normalizedUsername(rawUsername);
  const keys = [loginKey("username", username), loginKey("ip", requestIp(request))];
  const cutoff = new Date(Date.now() - LOGIN_WINDOW_MS);
  const attempts = db.collection<LoginAttempt>("journalist_login_attempts");
  if (await attempts.countDocuments({ keys: { $in: keys }, failed_at: { $gte: cutoff } }) >= LOGIN_ATTEMPT_LIMIT) {
    throw new PasswordAuthError("Too many sign-in attempts. Try again in 15 minutes.", 429);
  }

  const accounts = db.collection<Account>("journalist_admins");
  const account = await accounts.findOne({ username });
  const valid = await bcrypt.compare(password, account?.passwordHash ?? await fakePasswordHash);
  let principal: (Principal & { sessionVersion: number; restoreGeneration: string }) | null = null;
  if (valid && account?.enabled === true) {
    const resolved = await principalForEmail(db, account.email);
    // The password belongs to this exact account, not a replacement with the same email.
    if (resolved && await accounts.findOne({
      _id: account._id, principalId: resolved.id, enabled: true, passwordHash: account.passwordHash,
      ...sessionVersionFilter(account.sessionVersion ?? 0),
    })) {
      principal = { ...resolved, sessionVersion: account.sessionVersion ?? 0, restoreGeneration };
    }
  }
  if (!principal) {
    const now = new Date();
    await attempts.insertOne({
      _id: randomUUID(),
      keys,
      failed_at: now,
      expires_at: new Date(now.getTime() + LOGIN_WINDOW_MS),
    });
    throw new PasswordAuthError("Invalid username or password", 401);
  }
  await attempts.deleteMany({ keys: { $in: keys } });
  return principal;
}

function sessionVersionFilter(version: number) {
  return version === 0
    ? { $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }] }
    : { sessionVersion: version };
}

export async function passwordSetupStatus(db: Db, account: Account & { principalId: string }): Promise<{
  passwordStatus: PasswordStatus;
  recoveryStatus: "pending" | "expired" | null;
}> {
  const generation = (await maintenanceState(db)).identityGeneration;
  const currentGeneration = generation === "0"
    ? { $or: [{ restore_generation: "0" }, { restore_generation: { $exists: false } }] }
    : { restore_generation: generation };
  const reset = await db.collection<PasswordReset>("journalist_password_resets")
    .findOne({
      principal_id: account.principalId, used_at: null, session_version: account.sessionVersion ?? 0,
      ...currentGeneration,
    }, { sort: { created_at: -1 } });
  const invitation = await db.collection<Invitation>("journalist_account_invitations")
    .findOne({ principal_id: account.principalId, used_at: null, ...currentGeneration }, { sort: { created_at: -1 } });
  const expires = Math.max(reset?.expires_at.getTime() ?? 0, invitation?.expires_at.getTime() ?? 0);
  return {
    passwordStatus: account.username && account.passwordHash ? "credentials_set"
      : expires > Date.now() ? "invited"
        : expires || account.passwordSetupExpiresAt ? "expired" : "setup_required",
    recoveryStatus: reset ? (reset.expires_at.getTime() > Date.now() ? "pending" : "expired") : null,
  };
}

export async function createPasswordReset(
  db: Db,
  actor: Principal,
  account: Account & { principalId: string },
  session: ClientSession,
) {
  const resets = db.collection<PasswordReset>("journalist_password_resets");
  const now = new Date();
  const count = await resets.countDocuments({
    $or: [{ principal_id: account.principalId }, { issued_by: actor.id }],
    created_at: { $gte: new Date(now.getTime() - LOGIN_WINDOW_MS) },
  }, { session });
  if (count >= 5) throw new PasswordAuthError("Too many recovery links. Try again in 15 minutes.", 429);
  await resets.updateMany({ principal_id: account.principalId, used_at: null }, { $set: { used_at: now } }, { session });
  await db.collection("journalist_account_invitations").deleteMany({ principal_id: account.principalId }, { session });
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + RESET_LIFETIME_MS);
  await resets.insertOne({
    restore_generation: (await maintenanceState(db)).identityGeneration,
    _id: randomUUID(), token_hash: tokenHash(token), principal_id: account.principalId,
    session_version: account.sessionVersion ?? 0, issued_by: actor.id,
    created_at: now, expires_at: expiresAt, used_at: null,
  }, { session });
  return { token, expiresAt };
}

async function passwordAttempt(db: Db, request: Request, identity: string) {
  await ensurePasswordAuthIndexes(db);
  const keys = [loginKey("password-ip", requestIp(request)), loginKey("password-action", identity)];
  const attempts = db.collection<LoginAttempt>("journalist_login_attempts");
  const now = new Date();
  // Count successful and failed submissions; only HMAC identifiers persist.
  await attempts.insertOne({
    _id: randomUUID(), keys, failed_at: now, expires_at: new Date(now.getTime() + LOGIN_WINDOW_MS),
  });
  if (await attempts.countDocuments({
    keys: { $in: keys }, failed_at: { $gte: new Date(now.getTime() - LOGIN_WINDOW_MS) },
  }) > LOGIN_ATTEMPT_LIMIT) {
    throw new PasswordAuthError("Too many password attempts. Try again in 15 minutes.", 429);
  }
}

async function resetAccount(db: Db, token: string, session?: ClientSession) {
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new PasswordAuthError("Recovery link is invalid or expired", 404);
  const reset = await db.collection<PasswordReset>("journalist_password_resets").findOne({
    token_hash: tokenHash(token), used_at: null, expires_at: { $gt: new Date() },
  }, { session });
  const account = reset && await db.collection<Account>("journalist_admins").findOne({
    principalId: reset.principal_id, enabled: true, ...sessionVersionFilter(reset.session_version),
  }, { session });
  await assertSiteOpen(db);
  if (!reset || !account || (reset.restore_generation ?? "0") !== (await maintenanceState(db)).identityGeneration) {
    throw new PasswordAuthError("Recovery link is invalid or expired", 404);
  }
  return { reset, account };
}

export async function passwordResetDetails(db: Db, token: string, request: Request) {
  await passwordAttempt(db, request, token);
  const { account, reset } = await resetAccount(db, token);
  return { email: account.email, username: account.username ?? null, expiresAt: reset.expires_at };
}

async function storePassword(
  db: Db,
  account: WithId<Account>,
  passwordHash: string,
  username: string,
  session: ClientSession,
) {
  const now = new Date();
  const duplicate = await db.collection<Account>("journalist_admins").findOne({
    username, principalId: { $ne: account.principalId },
  }, { session });
  if (duplicate) throw new PasswordAuthError("That username is unavailable", 409);
  const changed = await db.collection<Account>("journalist_admins").updateOne({
    _id: account._id, principalId: account.principalId, enabled: true,
    ...sessionVersionFilter(account.sessionVersion ?? 0),
    passwordHash: account.passwordHash ?? { $exists: false },
  }, {
    $set: { username, passwordHash, passwordUpdatedAt: now, updatedAt: now },
    $inc: { sessionVersion: 1, revision: 1 },
    $unset: { passwordSetupExpiresAt: "" },
  }, { session });
  if (changed.modifiedCount !== 1) throw new PasswordAuthError("Account credentials changed; sign in again and retry", 409);
  await db.collection("journalist_password_resets").updateMany(
    { principal_id: account.principalId, used_at: null }, { $set: { used_at: now } }, { session },
  );
  await db.collection("journalist_account_invitations").deleteMany({ principal_id: account.principalId }, { session });
}

export async function resetPassword(
  db: Db,
  input: { token: string; password: string; username?: string },
  request: Request,
) {
  await passwordAttempt(db, request, input.token);
  const { account } = await resetAccount(db, input.token);
  const username = account.username ?? validateUsername(input.username ?? "");
  const passwordHash = await bcrypt.hash(validatePassword(input.password), BCRYPT_ROUNDS);
  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await resetAccount(db, input.token, session);
      if ((current.account.sessionVersion ?? 0) !== (account.sessionVersion ?? 0)) {
        throw new PasswordAuthError("Account credentials changed; request a new recovery link", 409);
      }
      await storePassword(db, current.account, passwordHash, username, session);
    });
    return { username };
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) throw new PasswordAuthError("That username is unavailable", 409);
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function changePassword(
  db: Db,
  principal: Principal,
  sessionVersion: number,
  input: { currentPassword: string; password: string; username?: string },
  request: Request,
) {
  await passwordAttempt(db, request, principal.id);
  const account = await db.collection<Account>("journalist_admins").findOne({
    principalId: principal.id, enabled: true, ...sessionVersionFilter(sessionVersion),
  });
  if (!account) throw new PasswordAuthError("Sign in again before changing your password", 401);
  if (account.passwordHash && !await bcrypt.compare(input.currentPassword, account.passwordHash)) {
    throw new PasswordAuthError("Current password is incorrect", 401);
  }
  const username = account.username ?? validateUsername(input.username ?? "");
  const passwordHash = await bcrypt.hash(validatePassword(input.password), BCRYPT_ROUNDS);
  const session = db.client.startSession();
  try {
    await session.withTransaction(() => storePassword(db, account, passwordHash, username, session));
    return { username };
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) throw new PasswordAuthError("That username is unavailable", 409);
    throw error;
  } finally {
    await session.endSession();
  }
}
