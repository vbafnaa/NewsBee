import { HttpStatusError } from "../core/http";
/**
 * MongoDB job queue: port of orchestration/jobs.py for serverless execution. Each job is one
 * bounded step (one connector source, one authoring step) that fits one function call.
 * Workers take a slot, so a set number of jobs run at once; job and slot leases are renewed
 * during execution. Quota retries use durable bounded backoff separately from ordinary failed
 * attempts.
 */
import { randomUUID } from "node:crypto";
import type { Db, Filter } from "mongodb";
import { logger } from "../core/log";
import { COLLECTIONS } from "../storage/mongo";
import { ModelRateLimitError } from "../model/runtime";
import { safeError } from "../core/redaction";

export const JOB_KINDS = ["discover", "agent_round", "review_map", "finish_map", "plan_sources", "collect_source", "author_start", "author_rank", "author_story", "image_story", "stock_story", "author_finish"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
/** These can overlap within a run. The rest build on each other, so a run does them one at a time. */
const PARALLEL_KINDS: readonly JobKind[] = ["discover", "collect_source"];
export function isParallelKind(kind: JobKind) { return PARALLEL_KINDS.includes(kind); }
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export const MAX_ATTEMPTS = 3;
export const MAX_RATE_LIMIT_RETRIES = 8;
/** Longer than the longest function call (Vercel maxDuration 300 s) so a live job keeps its lease. */
export const LEASE_SECONDS = 330;

export type Job = {
  _id: string;
  kind: JobKind;
  run_id: string;
  location_id: string;
  /** A run/step identity is retained across retries and editor resumes. */
  dedupe_key: string;
  durable_step?: boolean;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  rate_limit_retries?: number;
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
  /** Cloud mode: last successful hand-off to a source worker function. */
  dispatched_at?: number | null;
  /** Cloud mode: why the latest hand-off to a source worker function failed. */
  dispatch_error?: string | null;
  dispatch_error_at?: number | null;
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
    {
      key: { dedupe_key: 1 },
      unique: true,
      name: "one_durable_step_per_key",
      partialFilterExpression: { durable_step: true },
    },
  ]);
}

/** Queue a durable step once, including after completion; retries reuse the same job. */
export async function enqueue(
  db: Db,
  job: { kind: JobKind; run_id: string; location_id: string; payload?: Record<string, unknown>; dedupe_key?: string },
): Promise<string> {
  const dedupeKey = job.dedupe_key ?? `${job.kind}:${job.run_id}`;
  const existing = await jobs(db).findOne({ dedupe_key: dedupeKey });
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
      durable_step: true,
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
      const raced = await jobs(db).findOne({ dedupe_key: dedupeKey });
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
export async function claim(db: Db, kinds?: readonly JobKind[], jobId?: string, runId?: string): Promise<Job | null> {
  const current = now();
  const filter: Filter<Job> = { status: "pending", available_at: { $lte: current } };
  if (kinds) filter.kind = { $in: [...kinds] };
  if (jobId) filter._id = jobId;
  if (runId) filter.run_id = runId;
  return jobs(db).findOneAndUpdate(
    filter,
    {
      $set: { status: "running", started_at: current, lease_until: current + LEASE_SECONDS, claim_token: randomUUID(), dispatched_at: current, dispatch_error: null },
      $inc: { attempts: 1 },
    },
    { sort: { created_at: 1, _id: 1 }, returnDocument: "after" },
  );
}

/** Queue many jobs in one write, in order. A job already queued is left alone. */
export async function enqueueMany(db: Db, items: Array<{ _id: string; kind: JobKind; run_id: string; location_id: string; payload: Record<string, unknown>; dedupe_key: string }>) {
  if (!items.length) return;
  const created = now();
  // Oldest is claimed first, so each job keeps its place by a thousandth of a second.
  const docs: Job[] = items.map((item, index) => ({ ...item, durable_step: true, status: "pending", attempts: 0, created_at: created + index / 1000, available_at: created, started_at: null, completed_at: null, lease_until: null, claim_token: null, error: null, result: null, log_file: null, log_error: null }));
  await jobs(db).insertMany(docs, { ordered: false }).catch((error: { code?: number }) => { if (error.code !== 11000) throw error; });
}

/** Take back what hasn't started, for a stage that is out of time. */
export async function cancelPending(db: Db, runId: string, kind: JobKind, reason: string) {
  const waiting = await jobs(db).find({ run_id: runId, kind, status: "pending" }).toArray();
  if (waiting.length) await jobs(db).updateMany({ _id: { $in: waiting.map((job) => job._id) }, status: "pending" }, { $set: { status: "cancelled", completed_at: now(), lease_until: null, claim_token: null, error: reason } });
  return waiting;
}

export const JOB_LOGS = "job_logs";
const JOB_LOG_DAYS = 14;
/** The mark on a job whose log is still in MongoDB rather than a file. */
export const MONGO_LOG = "mongo:";
type JobLog = { _id: string; run_id: string; location_id: string; lines: string[]; archived?: boolean; expires_at: Date };
function jobLogs(db: Db) { return db.collection<JobLog>(JOB_LOGS); }

export async function ensureJobLogIndexes(db: Db) {
  await jobLogs(db).createIndexes([{ key: { run_id: 1 } }, { key: { location_id: 1 } }, { key: { expires_at: 1 }, expireAfterSeconds: 0 }]);
}

/** A job's log lines go to MongoDB as it runs; a stage's lines are saved to one file when it ends. */
export async function appendJobLog(db: Db, job: Job, lines: string[]) {
  await jobLogs(db).updateOne({ _id: job._id }, { $push: { lines: { $each: lines } }, $set: { archived: false, expires_at: new Date(Date.now() + JOB_LOG_DAYS * 86400_000) }, $setOnInsert: { run_id: job.run_id, location_id: job.location_id } }, { upsert: true });
}

export async function readJobLog(db: Db, jobId: string) {
  const log = await jobLogs(db).findOne({ _id: jobId });
  return log ? log.lines.join("\n") : null;
}

export async function unarchivedLogs(db: Db, runId: string) {
  return jobLogs(db).find({ run_id: runId, archived: { $ne: true } }).toArray();
}

export async function markLogsArchived(db: Db, ids: string[]) {
  await jobLogs(db).updateMany({ _id: { $in: ids } }, { $set: { archived: true } });
}

export async function setJobLog(db: Db, jobId: string, file: string | null, error: string | null) {
  await jobs(db).updateOne({ _id: jobId }, { $set: { log_file: file, log_error: error } });
}

export class LostLeaseError extends Error {}

type WorkerLease = { _id: string; token: string; lease_until: number };
const EXCLUSIVE_LEASE = "pipeline-worker";
const SLOT_PREFIX = "worker-slot-";
export type Lease = { id: string; token: string };

async function acquireLease(db: Db, id: string): Promise<Lease | null> {
  const token = randomUUID();
  try {
    const lease = await db.collection<WorkerLease>(COLLECTIONS.heartbeat).findOneAndUpdate(
      { _id: id, lease_until: { $lte: now() } },
      { $set: { token, lease_until: now() + LEASE_SECONDS } },
      { upsert: true, returnDocument: "after" },
    );
    return lease?.token === token ? { id, token } : null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 11000) return null;
    throw error;
  }
}

export async function releaseLease(db: Db, lease: Lease) {
  await db.collection<WorkerLease>(COLLECTIONS.heartbeat).deleteOne({ _id: lease.id, token: lease.token });
}

export async function renewLease(db: Db, lease: Lease) {
  const updated = await db.collection<WorkerLease>(COLLECTIONS.heartbeat).updateOne(
    { _id: lease.id, token: lease.token }, { $set: { lease_until: now() + LEASE_SECONDS } },
  );
  if (!updated.matchedCount) throw new LostLeaseError(`Lost worker lease: ${lease.id}`);
}

/** One of the worker slots, or null when they're all busy or a location is being removed. */
export async function acquireSlot(db: Db, slots: number): Promise<Lease | null> {
  if (await db.collection<WorkerLease>(COLLECTIONS.heartbeat).findOne({ _id: EXCLUSIVE_LEASE, lease_until: { $gt: now() } })) return null;
  for (let slot = 0; slot < slots; slot += 1) {
    const lease = await acquireLease(db, `${SLOT_PREFIX}${slot}`);
    if (lease) return lease;
  }
  return null;
}

/** A run's serial jobs share this, so they stay in order while other work overlaps. */
export function acquireRunLease(db: Db, runId: string) { return acquireLease(db, `run-serial:${runId}`); }

/** Everything stopped, for removing a location: no slot may be in use. */
export async function acquireWorker(db: Db) {
  const busy = await db.collection<WorkerLease>(COLLECTIONS.heartbeat).findOne({ _id: { $regex: `^${SLOT_PREFIX}` }, lease_until: { $gt: now() } });
  if (busy) return null;
  return (await acquireLease(db, EXCLUSIVE_LEASE))?.token ?? null;
}

export async function releaseWorker(db: Db, token: string) {
  await releaseLease(db, { id: EXCLUSIVE_LEASE, token });
}

export async function renewWorkerLease(db: Db, token: string) {
  await renewLease(db, { id: EXCLUSIVE_LEASE, token });
}

export async function renewJob(db: Db, leases: Lease[], job: Job) {
  for (const lease of leases) await renewLease(db, lease);
  const updated = await jobs(db).updateOne(
    { _id: job._id, claim_token: job.claim_token, status: "running" },
    { $set: { lease_until: now() + LEASE_SECONDS } },
  );
  if (!updated.matchedCount) throw new LostLeaseError(`Lost job lease: ${job._id}`);
}

export async function complete(db: Db, job: Job, result: Record<string, unknown>) {
  const updated = await jobs(db).updateOne(
    { _id: job._id, claim_token: job.claim_token, status: "running" },
    { $set: { status: "completed", completed_at: now(), result, error: null, claim_token: null, lease_until: null } },
  );
  if (updated.modifiedCount !== 1) throw new LostLeaseError(`Lost job lease: ${job._id}`);
}

/** Retry with 2^attempts seconds backoff when retryable and attempts remain; else fail. */
export async function fail(db: Db, job: Job, error: unknown, retryable: boolean): Promise<"retry" | "failed"> {
  const limited = error instanceof ModelRateLimitError || (error instanceof HttpStatusError && error.status === 429);
  const retryAfter = limited ? error.retryAfterSeconds ?? 60 : 0;
  const limitRetries = job.rate_limit_retries ?? 0;
  const supplementary = job.kind === "collect_source" && (job.payload?.task as { type?: string } | undefined)?.type === "newssearch";
  const retryLimit = supplementary ? 1 : MAX_RATE_LIMIT_RETRIES;
  const retry = retryable && (limited
    ? limitRetries < retryLimit && retryAfter <= 3600
    : job.attempts < MAX_ATTEMPTS);
  const delay = limited
    ? Math.max(Math.min(15 * 2 ** limitRetries, 300), retryAfter)
    : 2 ** job.attempts;
  const detail = safeError(error);
  const current = now();
  const updated = await jobs(db).updateOne(
    { _id: job._id, claim_token: job.claim_token, status: "running" },
    {
      $set: {
        status: retry ? "pending" : "failed",
        error: detail,
        available_at: current + delay,
        ...(limited ? { rate_limit_retries: limitRetries + 1, attempts: retry ? job.attempts - 1 : job.attempts } : {}),
        completed_at: retry ? null : current,
        lease_until: null,
        claim_token: null,
      },
    },
  );
  if (updated.modifiedCount !== 1) throw new LostLeaseError(`Cannot record failure after lost lease: ${job._id}`);
  log.error(retry ? "job_retry_scheduled" : "job_failed", { kind: job.kind, job_id: job._id, run_id: job.run_id, error: detail, retry_in_seconds: retry ? delay : null, rate_limit_retries: limited ? limitRetries + 1 : null });
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
