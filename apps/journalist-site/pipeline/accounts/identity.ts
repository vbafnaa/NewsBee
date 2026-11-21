import { randomUUID } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import type { PublicationCapability } from "../publications/permissions";
import { maintenanceState } from "../../../../shared/restore-maintenance";

export type GlobalRole = "owner" | "admin" | "editor";

export type Principal = {
  id: string;
  email: string;
  role: GlobalRole;
  capabilities?: PublicationCapability[];
};
export type Account = {
  email: string;
  enabled: boolean;
  principalId?: string;
  username?: string;
  passwordHash?: string;
  passwordUpdatedAt?: Date;
  sessionVersion?: number;
  passwordSetupExpiresAt?: Date;
  role?: GlobalRole;
  revision?: number;
  capabilities?: PublicationCapability[];
  createdAt?: Date;
  updatedAt?: Date;
};
export const normalizedEmail = (email: string) => email.trim().toLowerCase();
export const ownerEmail = () => normalizedEmail(process.env.NEWSBEE_OWNER_EMAIL ?? "");
export const isOwner = (principal: Principal) => principal.role === "owner";
export const isOperator = (principal: Principal) => principal.role === "owner" || principal.role === "admin";
export const isConfiguredOwner = (principal: Principal) => isOwner(principal) && Boolean(ownerEmail()) && normalizedEmail(principal.email) === ownerEmail();
export function resolvedAccountRole(account: Pick<Account, "email" | "role">): GlobalRole {
  if (normalizedEmail(account.email) === ownerEmail() && Boolean(ownerEmail())) return "owner";
  return account.role === "admin" ? "admin" : "editor";
}

export async function blockSponsoredRuns(
  db: Db,
  principalId: string,
  reason: string,
  credentialsOnly = false,
  session?: ClientSession,
): Promise<void> {
  await db.collection("pipeline_runs").updateMany({
    "execution.sponsorId": principalId,
    ...(credentialsOnly ? { "execution.source": { $ne: "platform" } } : {}),
    status: { $in: ["mapping", "collecting", "awaiting_authoring", "authoring", "awaiting_finish", "finishing", "publishing"] },
  }, { $set: { execution_blocked: { reason, at: Date.now() / 1000 } } }, session ? { session } : undefined);
}

export async function disableAccount(db: Db, email: string) {
  email = normalizedEmail(email);
  if (email === ownerEmail()) throw new Error("The configured owner cannot be disabled");
  const accounts = db.collection<Account>("journalist_admins");
  const account = await accounts.findOneAndUpdate({ email }, { $set: { enabled: false } }, { returnDocument: "after" });
  if (account?.principalId) await blockSponsoredRuns(db, account.principalId, "The sponsoring account was disabled. Reenabling access does not reconnect this run.");
  return { email, enabled: false };
}

export async function principalForEmail(db: Db, email: string): Promise<Principal | null> {
  email = normalizedEmail(email);
  if (!email) return null;
  const accounts = db.collection<Account>("journalist_admins");
  const authority = await maintenanceState(db);
  if (authority.phase !== "open") {
    return email === ownerEmail() && authority.owner?.email === email
      ? { id: authority.owner.id, email, role: "owner" } : null;
  }
  await accounts.createIndex({ email: 1 }, { unique: true });
  if (email === ownerEmail()) {
    await accounts.updateOne({ email }, {
      $set: { enabled: true, role: "owner", updatedAt: new Date() },
      $setOnInsert: { email, principalId: randomUUID(), revision: 0, createdAt: new Date() },
    }, { upsert: true });
  }
  const account = await accounts.findOne({ email, enabled: true });
  if (!account) return null;
  if (!account.principalId) {
    await accounts.updateOne({ _id: account._id, principalId: { $exists: false } }, { $set: { principalId: randomUUID() } });
  }
  const current = await accounts.findOne({ _id: account._id, enabled: true });
  if (!current?.principalId) return null;
  const role = resolvedAccountRole(current);
  const capabilities = current.capabilities?.filter((capability) => role === "admin" || capability !== "publication:inspect");
  return {
    id: current.principalId,
    email,
    role,
    ...(capabilities?.length ? { capabilities } : {}),
  };
}

export async function principalById(db: Db, id: string): Promise<Principal | null> {
  if (id === "local-admin") {
    return process.env.NEWSBEE_MODE === "local" && !process.env.VERCEL && process.env.NODE_ENV !== "production"
      ? { id, email: ownerEmail() || "local-admin@localhost", role: "owner" } : null;
  }
  const account = await db.collection<Account>("journalist_admins").findOne({ principalId: id, enabled: true });
  const principal = account ? await principalForEmail(db, account.email) : null;
  return principal?.id === id ? principal : null;
}

export async function principalForSession(db: Db, id: string, version: unknown, restoreGeneration?: unknown): Promise<Principal | null> {
  const authority = await maintenanceState(db);
  if ((restoreGeneration ?? "0") !== authority.identityGeneration) return null;
  if (authority.phase !== "open") {
    return authority.owner?.id === id && authority.owner.email === ownerEmail()
      ? { id, email: authority.owner.email, role: "owner" } : null;
  }
  // Principal-bound sessions issued before versioning are generation zero.
  const expected = version === undefined ? 0 : version;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) return null;
  const principal = await principalById(db, id);
  if (!principal) return null;
  const account = await db.collection<Account>("journalist_admins").findOne({ principalId: id, enabled: true });
  return account && (account.sessionVersion ?? 0) === expected ? principal : null;
}
