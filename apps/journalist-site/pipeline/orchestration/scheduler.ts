/**
 * Scheduler visibility: ticks, admin "kick" calls, source-worker dispatch and follow-up ticks
 * record their latest success and failure on the heartbeat document, and dispatch failures are
 * also stamped on the job, so the portal can say why queued work is not advancing.
 */
import type { Db } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import type { Job } from "./jobs";

/** While work is in progress, this much tick silence merits a Resume diagnostic. */
export const STALE_TICK_SECONDS = 180;

export const SCHEDULER_CHANNELS = ["tick", "kick", "dispatch", "followup"] as const;
export type SchedulerChannel = (typeof SCHEDULER_CHANNELS)[number];

const LABELS: Record<SchedulerChannel, string> = {
  tick: "Scheduler tick failed",
  kick: "Queueing the first job after a portal action failed",
  dispatch: "Pipeline worker dispatch failed",
  followup: "Queueing the next pipeline job failed",
};

export type SchedulerIssue = { channel: SchedulerChannel; at: number; message: string };
export type SchedulerState = {
  last_tick_at: number | null;
  last_tick_finished_at: number | null;
  seconds_since_tick: number | null;
  status: "ok" | "stale";
  /** Latest failure per channel that has not been followed by a success. */
  issues: SchedulerIssue[];
};

const now = () => Date.now() / 1000;

function heartbeat(db: Db) {
  return db.collection<Record<string, unknown>>(COLLECTIONS.heartbeat);
}

export async function recordScheduler(db: Db, channel: SchedulerChannel, error: string | null, at = now()) {
  const set = error === null ? { [`${channel}_ok_at`]: at } : { [`${channel}_error`]: error.slice(0, 500), [`${channel}_error_at`]: at };
  await heartbeat(db).updateOne({ _id: "scheduler" as never }, { $set: set }, { upsert: true });
}

/** Never throws: visibility must not mask the failure being recorded. */
export async function recordSchedulerSafely(db: Db | null, channel: SchedulerChannel, error: string | null) {
  if (!db) return;
  try {
    await recordScheduler(db, channel, error);
  } catch {
    // The original failure is already logged by the caller.
  }
}

export async function markDispatch(db: Db, jobId: string, error: string | null, at = now()) {
  await db.collection<Job>(COLLECTIONS.jobs).updateOne(
    { _id: jobId },
    { $set: error === null ? { dispatched_at: at, dispatch_error: null } : { dispatch_error: error.slice(0, 500), dispatch_error_at: at } },
  );
}

/** Turn a failed internal call into an actionable message. */
export function describeInternalFailure(target: string, status: number, body: string) {
  const excerpt = body.replace(/\s+/g, " ").trim().slice(0, 200);
  if (status === 401 && /"detail"\s*:\s*"Unauthorized"/.test(body)) {
    return `${target} rejected the request (401): ${target === "Pipeline job" ? "AUTH_SECRET" : "CRON_SECRET"} does not match this deployment.`;
  }
  if (status === 401 || status === 403) {
    return `${target} was blocked before reaching the app (${status}); Vercel Deployment Protection may require a Protection Bypass for Automation. ${excerpt}`;
  }
  if (status === 504 || status === 524) return `${target} timed out (${status}); the function exceeded its maximum duration.`;
  return `${target} returned ${status}: ${excerpt}`;
}

export async function schedulerState(db: Db, current = now()): Promise<SchedulerState> {
  const doc = await heartbeat(db).findOne({ _id: "scheduler" as never });
  const number = (value: unknown) => typeof value === "number" ? value : null;
  const lastTick = number(doc?.last_tick_at);
  const age = lastTick === null ? null : Math.max(0, Math.round(current - lastTick));
  const issues: SchedulerIssue[] = [];
  for (const channel of SCHEDULER_CHANNELS) {
    const errorAt = number(doc?.[`${channel}_error_at`]);
    const okAt = number(doc?.[`${channel}_ok_at`]) ?? (channel === "tick" ? number(doc?.last_tick_finished_at) : null);
    if (errorAt !== null && (okAt === null || errorAt > okAt)) {
      issues.push({ channel, at: errorAt, message: `${LABELS[channel]}: ${String(doc?.[`${channel}_error`] ?? "unknown error")}` });
    }
  }
  return {
    last_tick_at: lastTick,
    last_tick_finished_at: number(doc?.last_tick_finished_at),
    seconds_since_tick: age,
    status: age !== null && age <= STALE_TICK_SECONDS ? "ok" : "stale",
    issues: issues.sort((a, b) => b.at - a.at),
  };
}
