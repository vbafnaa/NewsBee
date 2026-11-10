/**
 * Keeping the worker chain going. Each queue delivery runs one job, then asks here how many more
 * workers to start: one for each free slot with work ready. A delayed wake-up covers jobs in
 * backoff and a worker that stopped without handing off. Extra deliveries find no slot and exit.
 */
import type { Db } from "mongodb";
import type { Settings } from "../core/config";
import { COLLECTIONS } from "../storage/mongo";
import { isParallelKind, type Job } from "./jobs";
import { expireOverdueRuns } from "./diagnostics";
import { openRunIds, stageKinds, workableRuns } from "./runs";

const now = () => Date.now() / 1000;
/** Housekeeping runs at most this often, however many jobs are moving. */
const MAINTENANCE_SECONDS = 60;
const RETRY_WAKE_SECONDS = 5;
/** The longest a queue message is delayed; a longer wait wakes up and asks again. */
const MAX_WAKE_SECONDS = 3600;

function heartbeat(db: Db) { return db.collection<{ _id: string; wake_at?: number; maintained_at?: number; last_tick_at?: number }>(COLLECTIONS.heartbeat); }

/** How many workers to start now, and when to look again. */
export async function dispatchPlan(db: Db, slots: number, current = now()) {
  const active = await workableRuns(db);
  if (!active.length) return { send: 0, wakeIn: null };
  const jobs = await db.collection<Job>(COLLECTIONS.jobs).find(
    { run_id: { $in: active.map((run) => run._id) }, status: { $in: ["pending", "running"] } },
    { projection: { kind: 1, run_id: 1, status: 1, available_at: 1, lease_until: 1 } },
  ).toArray();
  let ready = 0, running = 0;
  const times: number[] = [];
  for (const run of active) {
    const inStage = jobs.filter((job) => job.run_id === run._id && stageKinds(run).includes(job.kind));
    const live = inStage.filter((job) => job.status === "running");
    running += live.filter((job) => (job.lease_until ?? 0) >= current).length;
    const waiting = inStage.filter((job) => job.status === "pending");
    const due = waiting.filter((job) => job.available_at <= current);
    ready += due.filter((job) => isParallelKind(job.kind)).length;
    // A run's serial jobs go one at a time.
    if (due.some((job) => !isParallelKind(job.kind)) && !live.some((job) => !isParallelKind(job.kind))) ready += 1;
    times.push(...waiting.filter((job) => job.available_at > current).map((job) => job.available_at), ...live.map((job) => (job.lease_until ?? current) + 1));
  }
  return {
    send: Math.min(Math.max(0, slots - running), ready),
    wakeIn: times.length ? Math.min(MAX_WAKE_SECONDS, Math.max(1, Math.ceil(Math.min(...times) - current))) : null,
  };
}

/** Only one delayed wake-up is outstanding at a time, unless a new one is due sooner. */
async function claimWake(db: Db, at: number, current = now()) {
  await heartbeat(db).updateOne({ _id: "scheduler" }, { $setOnInsert: { wake_at: 0 } }, { upsert: true }).catch(() => undefined);
  const claimed = await heartbeat(db).updateOne(
    { _id: "scheduler", $or: [{ wake_at: { $exists: false } }, { wake_at: { $lte: current } }, { wake_at: { $gt: at } }] },
    { $set: { wake_at: at } },
  );
  return claimed.modifiedCount === 1;
}

/** Start the next workers. A worker that found nothing it could claim only ever leaves a delayed wake-up. */
export async function continueQueue(deps: { db: Db; settings: Settings }, executed: boolean, queue: (delaySeconds?: number) => Promise<void>) {
  const plan = await dispatchPlan(deps.db, deps.settings.collectConcurrency);
  if (executed) for (let index = 0; index < plan.send; index += 1) await queue();
  const wake = !executed && plan.send > 0 ? Math.min(plan.wakeIn ?? RETRY_WAKE_SECONDS, RETRY_WAKE_SECONDS) : plan.wakeIn;
  if (wake !== null && await claimWake(deps.db, now() + wake)) await queue(wake);
}

/** The heartbeat and run deadlines, once a minute rather than on every job. Returns whether it ran. */
export async function maintain(deps: { db: Db; settings: Settings }, current = now()) {
  try {
    const due = await heartbeat(deps.db).updateOne(
      { _id: "scheduler", $or: [{ maintained_at: { $exists: false } }, { maintained_at: { $lt: current - MAINTENANCE_SECONDS } }] },
      { $set: { maintained_at: current, last_tick_at: current } },
      { upsert: true },
    );
    if (!due.modifiedCount && !due.upsertedCount) return false;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return false;
    throw error;
  }
  await expireOverdueRuns(deps.db, deps.settings.runTimeoutSeconds);
  await cancelLeftoverJobs(deps.db, current);
  return true;
}

/** Jobs left waiting by a run that has ended will never run; left alone, they look like stalled work. */
export async function cancelLeftoverJobs(db: Db, current = now()) {
  const waiting: string[] = await db.collection<Job>(COLLECTIONS.jobs).distinct("run_id", { status: "pending" });
  if (!waiting.length) return 0;
  const open = new Set(await openRunIds(db));
  const ended = waiting.filter((runId) => !open.has(runId));
  if (!ended.length) return 0;
  return (await db.collection<Job>(COLLECTIONS.jobs).updateMany({ run_id: { $in: ended }, status: "pending" }, { $set: { status: "cancelled", completed_at: current, error: "The run had already ended" } })).modifiedCount;
}
