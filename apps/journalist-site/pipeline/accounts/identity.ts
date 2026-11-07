import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";

export type Principal = { id: string; email: string; role: "owner" | "editor" };
export type Account = { email: string; enabled: boolean; principalId?: string; role?: Principal["role"]; createdAt?: Date };
export const normalizedEmail = (email: string) => email.trim().toLowerCase();
export const ownerEmail = () => normalizedEmail(process.env.NEWSBEE_OWNER_EMAIL ?? "");
export const isOwner = (principal: Principal) => principal.role === "owner";
export const isConfiguredOwner = (principal: Principal) => isOwner(principal) && Boolean(ownerEmail()) && normalizedEmail(principal.email) === ownerEmail();

export async function blockSponsoredRuns(db: Db, principalId: string, reason: string): Promise<void> {
  await db.collection("pipeline_runs").updateMany({
    "execution.sponsorId": principalId,
    status: { $in: ["mapping", "collecting", "awaiting_authoring", "authoring", "awaiting_finish", "finishing", "publishing"] },
  }, { $set: { execution_blocked: { reason, at: Date.now() / 1000 } } });
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
  await accounts.createIndex({ email: 1 }, { unique: true });
  if (email === ownerEmail()) {
    await accounts.updateOne({ email }, {
      $set: { enabled: true, role: "owner" },
      $setOnInsert: { email, principalId: randomUUID(), createdAt: new Date() },
    }, { upsert: true });
  }
  const account = await accounts.findOne({ email, enabled: true });
  if (!account) return null;
  if (!account.principalId) {
    await accounts.updateOne({ _id: account._id, principalId: { $exists: false } }, { $set: { principalId: randomUUID() } });
  }
  const current = await accounts.findOne({ _id: account._id, enabled: true });
  if (!current?.principalId) return null;
  return { id: current.principalId, email, role: email === ownerEmail() ? "owner" : "editor" };
}

export async function principalById(db: Db, id: string): Promise<Principal | null> {
  if (id === "local-admin") {
    return process.env.NEWSBEE_MODE === "local" && !process.env.VERCEL && process.env.NODE_ENV !== "production"
      ? { id, email: "local-admin@localhost", role: "owner" } : null;
  }
  const account = await db.collection<Account>("journalist_admins").findOne({ principalId: id, enabled: true });
  return account ? principalForEmail(db, account.email) : null;
}
