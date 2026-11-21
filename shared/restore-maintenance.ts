import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";

// These stores are deployment authority, not snapshot data. Never export or import them.
export const RESTORE_STATE = "_newsbee_restore_state";
export const RESTORE_EVIDENCE = "_newsbee_restore_evidence";
export const restoreReserved = (name: string) => name.startsWith("_newsbee_restore_");
export type RestoreOwner = { id: string; email: string; role: string };
export type RestoreEvidence = {
  action: "maintenance_closed" | "reopen_requested" | "restore_started"
    | "restore_completed_maintenance_closed" | "restore_failed_maintenance_closed";
  at: Date;
  owner?: RestoreOwner;
  epoch?: number;
  restoreId?: string;
  archiveHash?: string;
  governanceRollback?: boolean;
  sourceCreatedAt?: string;
  collections?: string[];
  result?: { collections: number; documents: number; artifactFiles: number };
  detail?: string;
};
export type Maintenance = {
  _id: string;
  epoch: number;
  identityGeneration: string;
  phase: "open" | "draining" | "restoring" | "failed" | "restored";
  writers: string[];
  owner?: RestoreOwner;
  restoreId?: string;
  archiveHash?: string;
  error?: string;
};
type Writer = { db: Db; epoch: number; active: boolean; pending: Set<Promise<unknown>> };
const context = new AsyncLocalStorage<Writer>();
const handles = new WeakMap<Db, { raw: Db; epoch: number }>();
const durable = { writeConcern: { w: "majority" as const } };
const sameDatabase = (left: Db, right: Db) => left === right
  || left.databaseName === right.databaseName
    && String(left.client.options.hosts) === String(right.client.options.hosts);

export class MaintenanceError extends Error {
  readonly status = 503;
}

export function restoreDatabase(db: Db): Db {
  return handles.get(db)?.raw ?? db;
}

export async function maintenanceState(db: Db): Promise<Maintenance> {
  const states = restoreDatabase(db).collection<Maintenance>(RESTORE_STATE);
  await states.updateOne({ _id: "site" }, {
    $setOnInsert: { epoch: 0, identityGeneration: "0", phase: "open", writers: [] },
  }, { upsert: true, ...durable });
  const state = await states.findOne({ _id: "site" });
  if (!state) throw new MaintenanceError("Restore authority is unavailable; writes are closed.");
  return state;
}

export async function assertSiteOpen(db: Db) {
  const active = context.getStore();
  const related = active && sameDatabase(active.db, restoreDatabase(db));
  if (related && active.active) return;
  const state = await maintenanceState(db);
  const epoch = related ? active.epoch : handles.get(db)?.epoch ?? state.epoch;
  if (state.phase !== "open" || epoch !== state.epoch) {
    throw new MaintenanceError("Site maintenance is closed. No new work or writes are admitted.");
  }
}

/** The same atomic document serializes writer admission and maintenance acquisition.
 * No lease expiry: a killed/unknown writer must never be assumed drained. */
export async function withSiteWriter<T>(db: Db, work: () => Promise<T>): Promise<T> {
  const raw = restoreDatabase(db);
  const parent = context.getStore();
  const related = parent && sameDatabase(parent.db, raw);
  if (related && parent.active) {
    const pending = Promise.resolve().then(work);
    parent.pending.add(pending);
    try { return await pending; }
    finally { parent.pending.delete(pending); }
  }
  const epoch = related ? parent.epoch : handles.get(db)?.epoch ?? (await maintenanceState(raw)).epoch;
  const token = randomUUID();
  const admitted = await raw.collection<Maintenance>(RESTORE_STATE).updateOne(
    { _id: "site", phase: "open", epoch }, { $push: { writers: token } }, durable,
  );
  if (!admitted.matchedCount) throw new MaintenanceError("Site maintenance is closed or this writer is obsolete.");
  const writer: Writer = { db: raw, epoch, active: true, pending: new Set() };
  try {
    return await context.run(writer, work);
  } finally {
    // Promise.all may reject while sibling I/O is still writing. Keep admission until
    // every admitted child has settled, including children started by those siblings.
    while (writer.pending.size) await Promise.allSettled([...writer.pending]);
    writer.active = false;
    await raw.collection<Maintenance>(RESTORE_STATE).updateOne(
      { _id: "site" }, { $pull: { writers: token } }, durable,
    );
  }
}

export async function requireRestoreOwner(db: Db, owner: RestoreOwner) {
  const email = process.env.NEWSBEE_OWNER_EMAIL?.trim().toLowerCase();
  if (!email || owner.role !== "owner" || owner.email.trim().toLowerCase() !== email) {
    throw new MaintenanceError("Explicit configured-owner action is required.");
  }
  const state = await maintenanceState(db);
  if (state.phase !== "open" && state.owner?.id === owner.id && state.owner.email === email) return;
  if (owner.id === "local-admin" && process.env.NEWSBEE_MODE === "local"
    && !process.env.VERCEL && process.env.NODE_ENV !== "production") return;
  const account = await restoreDatabase(db).collection("journalist_admins")
    .findOne({ principalId: owner.id, email, enabled: true });
  if (!account) throw new MaintenanceError("The configured owner must sign in again.");
}

export async function restoreEvent(db: Db, event: Omit<RestoreEvidence, "at">) {
  await restoreDatabase(db).collection<RestoreEvidence>(RESTORE_EVIDENCE).insertOne(
    { ...event, at: new Date() }, durable,
  );
}

/** Owner-authorized callers only. Dates are BSON Date / ISO-8601 JSON, not epoch seconds. */
export async function readRestoreEvidence(db: Db): Promise<RestoreEvidence[]> {
  return restoreDatabase(db).collection<RestoreEvidence>(RESTORE_EVIDENCE).find({}, {
    projection: {
      _id: 0, action: 1, at: 1, owner: 1, epoch: 1, restoreId: 1, archiveHash: 1,
      governanceRollback: 1, sourceCreatedAt: 1, collections: 1, result: 1, detail: 1,
    },
  }).sort({ at: -1, _id: -1 }).limit(20).toArray();
}

export async function enterMaintenance(db: Db, owner: RestoreOwner) {
  await requireRestoreOwner(db, owner);
  owner = { ...owner, email: owner.email.trim().toLowerCase() };
  const state = await restoreDatabase(db).collection<Maintenance>(RESTORE_STATE).findOneAndUpdate(
    { _id: "site", phase: "open" },
    // Revoke old owner sessions too: maintenance recovery must not bypass a prior
    // password/session revocation merely because account data may be unavailable.
    { $set: { phase: "draining", owner, identityGeneration: randomUUID() }, $inc: { epoch: 1 } },
    { returnDocument: "after", ...durable },
  );
  if (!state) throw new MaintenanceError("Maintenance is already owned; inspect its recovery state.");
  await restoreEvent(db, { action: "maintenance_closed", owner, epoch: state.epoch });
  return state;
}

export async function reopenMaintenance(db: Db, owner: RestoreOwner) {
  await requireRestoreOwner(db, owner);
  // A failed/interrupted restore cannot be waived open. Complete a known-good restore first.
  await restoreEvent(db, { action: "reopen_requested", owner });
  const result = await restoreDatabase(db).collection<Maintenance>(RESTORE_STATE).updateOne(
    { _id: "site", phase: { $in: ["draining", "restored"] }, writers: { $size: 0 } },
    { $set: { phase: "open" }, $inc: { epoch: 1 }, $unset: { error: "" } }, durable,
  );
  if (!result.matchedCount) throw new MaintenanceError("Cannot reopen: writers remain, or restore is failed/in progress.");
}

const readMethods = new Set([
  "find", "findOne", "countDocuments", "estimatedDocumentCount", "distinct",
  "listIndexes", "indexes", "indexExists", "indexInformation", "options", "isCapped",
  "listCollections", "stats",
]);

/** Pin handles to the observed epoch, so old requests cannot write after reopening.
 * Transactions hold admission through commit/abort, not just individual Mongo writes. */
export async function fencedDatabase(input: Db): Promise<Db> {
  if (handles.has(input)) return input;
  const raw = restoreDatabase(input);
  const state = await maintenanceState(raw);
  const parent = context.getStore();
  const epoch = parent && sameDatabase(parent.db, raw) ? parent.epoch : state.epoch;
  let db: Db;
  function guarded<T extends object>(target: T, collection = false): T {
    return new Proxy(target, {
      get(object, property) {
        const value: unknown = Reflect.get(object, property, object);
        if (typeof value !== "function") return value;
        if (collection && property === "aggregate") return (pipeline: Record<string, unknown>[] = [], ...args: unknown[]) => {
          if (pipeline.some((stage) => "$out" in stage || "$merge" in stage)) {
            throw new MaintenanceError("Write aggregation must use an admitted writer, not a read cursor.");
          }
          return Reflect.apply(value, object, [pipeline, ...args]);
        };
        if (readMethods.has(String(property))) return value.bind(object);
        return (...args: unknown[]) => withSiteWriter(db, async () => Reflect.apply(value, object, args));
      },
    });
  }
  db = new Proxy(raw, {
    get(target, property) {
      if (property === "collection") return (name: string, ...args: unknown[]) => {
        if (restoreReserved(name)) throw new MaintenanceError("Restore authority is not application data.");
        return guarded(Reflect.apply(target.collection, target, [name, ...args]), true);
      };
      if (property === "client") return new Proxy(target.client, {
        get(client, key) {
          if (key === "startSession") return (...args: unknown[]) => {
            const session = Reflect.apply(client.startSession, client, args);
            return new Proxy(session, {
              get(sessionTarget, method) {
                if (method === "withTransaction") return (...transactionArgs: unknown[]) =>
                  withSiteWriter(db, async () => Reflect.apply(sessionTarget.withTransaction, sessionTarget, transactionArgs));
                if (method === "startTransaction") return () => { throw new MaintenanceError("Use admitted withTransaction."); };
                const member: unknown = Reflect.get(sessionTarget, method, sessionTarget);
                return typeof member === "function" ? member.bind(sessionTarget) : member;
              },
            });
          };
          if (key === "db") return () => { throw new MaintenanceError("Use the fenced database entry point."); };
          const member: unknown = Reflect.get(client, key, client);
          return typeof member === "function" ? member.bind(client) : member;
        },
      });
      if (property === "command" || property === "dropDatabase") return () => {
        throw new MaintenanceError("Raw database commands are not admitted application writes.");
      };
      return Reflect.get(guarded(target), property);
    },
  });
  handles.set(db, { raw, epoch });
  return db;
}
