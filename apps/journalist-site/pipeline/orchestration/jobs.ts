/**
 * MongoDB job queue: port of orchestration/jobs.py for serverless execution. Each job is one
 * bounded step (one connector source, one authoring step) that fits one function call.
 * Same states, attempts and backoff as Stage 1; the lease covers a whole function call
 * instead of being renewed by a long-lived worker.
 */
import { randomUUID } from "node:crypto";
import type { Db, Filter } from "mongodb";
import { logger } from "../core/log";
import { COLLECTIONS } from "../storage/mongo";

export const JOB_KINDS = ["collect_source", "author_start", "author_story", "author_finish"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export const MAX_ATTEMPTS = 3;
/** Longer than the longest function call (Vercel maxDuration 300 s) so a live job keeps its lease. */
export const LEASE_SECONDS = 330;

export type Job = {
  _id: string;
  kind: JobKind;
  run_id: string;
  location_id: string;
  /** Jobs with the same dedupe key are never pending or running at the same time. */
  dedupe_key: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  created_at: number;
  available_at: number;
  started_at: number | null;
  completed_at: number | null;
  lease_until: number | null;
  claim_token: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  log_file: string | null;
  log_error: string | null;
};

const log = logger("jobs");
const now = () => Date.now() / 1000;

function jobs(db: Db) {
  return db.collection<Job>(COLLECTIONS.jobs);
}

export async function ensureJobIndexes(db: Db) {
  await jobs(db).createIndexes([
    { key: { status: 1, available_at: 1, created_at: 1 } },
    { key: { run_id: 1, kind: 1 } },
    { key: { location_id: 1, created_at: -1 } },
    {
      key: { dedupe_key: 1 },
      unique: true,
      name: "one_active_job_per_key",
      partialFilterExpression: { status: { $in: ["pending", "running"] } },
    },
  ]);
}

/** Queue a job unless one with the same dedupe key is pending or running; returns its id. */
export async function enqueue(
  db: Db,
  job: { kind: JobKind; run_id: string; location_id: string; payload?: Record<string, unknown>; dedupe_key?: string },
): Promise<string> {
  const dedupeKey = job.dedupe_key ?? `${job.kind}:${job.run_id}`;
  const existing = await jobs(db).findOne({ dedupe_key: dedupeKey, status: { $in: ["pending", "running"] } });
  if (existing) return existing._id;
  const identity = randomUUID();
  const created = now();
  try {
    await jobs(db).insertOne({
      _id: identity,
      kind: job.kind,
      run_id: job.run_id,
      location_id: job.location_id,
      dedupe_key: dedupeKey,
      payload: job.payload ?? {},
      status: "pending",
      attempts: 0,
      created_at: created,
      available_at: created,
      started_at: null,
      completed_at: null,
      lease_until: null,
      claim_token: null,
      error: null,
      result: null,
      log_file: null,
      log_error: null,
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const raced = await jobs(db).findOne({ dedupe_key: dedupeKey, status: { $in: ["pending", "running"] } });
      if (raced) return raced._id;
    }
    throw error;
  }
  log.info("job_enqueued", { kind: job.kind, job_id: identity, run_id: job.run_id, location_id: job.location_id });
  return identity;
}

/** Return expired leases to the queue (or fail them after MAX_ATTEMPTS). */
export async function recoverExpired(db: Db) {
  const current = now();
  const expired = await jobs(db).find({ status: "running", lease_until: { $lt: current } }).toArray();
  for (const job of expired) {
    const exhausted = job.attempts >= MAX_ATTEMPTS;
    const updated = await jobs(db).updateOne(
      { _id: job._id, status: "running", claim_token: job.claim_token },
      {
        $set: {
          status: exhausted ? "failed" : "pending",
          completed_at: exhausted ? current : null,
          error: "Worker lease expired; previous attempt interrupted",
          lease_until: null,
          claim_token: null,
        },
      },
    );
    if (updated.modifiedCount) log.warn("lease_expired", { kind: job.kind, job_id: job._id, failed: exhausted });
  }
  return expired.filter((job) => job.attempts >= MAX_ATTEMPTS);
}

/** Atomically claim the oldest available job. */
export async function claim(db: Db, kinds?: readonly JobKind[], jobId?: string): Promise<Job | null> {
  const current = now();
  const filter: Filter<Job> = { status: "pending", available_at: { $lte: current } };
  if (kinds) filter.kind = { $in: [...kinds] };
  if (jobId) filter._id = jobId;
  return jobs(db).findOneAndUpdate(
    filter,
    {
      $set: { status: "running", started_at: current, lease_until: current + LEASE_SECONDS, claim_token: randomUUID() },
      $inc: { attempts: 1 },
    },
    { sort: { created_at: 1, _id: 1 }, returnDocument: "after" },
  );
}

export async function pendingJobs(db: Db, kind: JobKind, limit = 50) {
  return jobs(db)
    .find({ kind, status: "pending", available_at: { $lte: now() } })
    .sort({ created_at: 1, _id: 1 })
    .limit(limit)
    .toArray();
}

export async function nextPendingJob(db: Db) {
  return jobs(db)
    .findOne({ status: "pending" }, { projection: { available_at: 1 }, sort: { available_at: 1 } })
    .then((job) => job ? { available_at: job.available_at } : null);
}

export async function setJobLog(db: Db, jobId: string, file: string | null, error: string | null) {
  await jobs(db).updateOne({ _id: jobId }, { $set: { log_file: file, log_error: error } });
}

export class LostLeaseError extends Error {}

export async function complete(db: Db, job: Job, result: Record<string, unknown>) {
  const updated = await jobs(db).updateOne(
    { _id: job._id, claim_token: job.claim_token, status: "running" },
    { $set: { status: "completed", completed_at: now(), result, error: null, claim_token: null, lease_until: null } },
  );
  if (updated.modifiedCount !== 1) throw new LostLeaseError(`Lost job lease: ${job._id}`);
}

/** Retry with 2^attempts seconds backoff when retryable and attempts remain; else fail. */
export async function fail(db: Db, job: Job, error: unknown, retryable: boolean): Promise<"retry" | "failed"> {
  const retry = retryable && job.attempts < MAX_ATTEMPTS;
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const current = now();
  const updated = await jobs(db).updateOne(
    { _id: job._id, claim_token: job.claim_token, status: "running" },
    {
      $set: {
        status: retry ? "pending" : "failed",
        error: detail,
        available_at: current + 2 ** job.attempts,
        completed_at: retry ? null : current,
        lease_until: null,
        claim_token: null,
      },
    },
  );
  if (updated.modifiedCount !== 1) throw new LostLeaseError(`Cannot record failure after lost lease: ${job._id}`);
  log.error(retry ? "job_retry_scheduled" : "job_failed", { kind: job.kind, job_id: job._id, run_id: job.run_id, error: detail });
  return retry ? "retry" : "failed";
}

export async function runJobs(db: Db, runId: string) {
  return jobs(db).find({ run_id: runId }).sort({ created_at: 1, _id: 1 }).toArray();
}

/** Discard queued work; in-flight work retains its lease until the worker exits. */
export async function cancelRunJobs(db: Db, runId: string) {
  return jobs(db).updateMany(
    { run_id: runId, status: "pending" },
    { $set: { status: "cancelled", completed_at: now(), lease_until: null, claim_token: null, error: "Run cancelled" } },
  );
}

export async function cancelClaimedJob(db: Db, job: Job) {
  await jobs(db).updateOne(
    { _id: job._id, status: "running", claim_token: job.claim_token },
    { $set: { status: "cancelled", completed_at: now(), lease_until: null, claim_token: null, error: "Run cancelled" } },
  );
}

export async function recentJobs(db: Db, limit = 50, locationId?: string) {
  return jobs(db)
    .find(locationId ? { location_id: locationId } : {}, { projection: { payload: 0 } })
    .sort({ created_at: -1, _id: -1 })
    .limit(limit)
    .toArray();
}
