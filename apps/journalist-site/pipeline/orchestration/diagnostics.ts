/**
 * Why an active run is not advancing, and the end-to-end run deadline. Diagnostics are
 * derived from the run's jobs and the scheduler heartbeat; expiry fails runs that outlive
 * the configured timeout so the portal never shows work as pending forever.
 */
import type { Db } from "mongodb";
import { logger } from "../core/log";
import { COLLECTIONS } from "../storage/mongo";
import { cancelRunJobs, MAX_ATTEMPTS, type Job } from "./jobs";
import { ACTIVE_RUN_STATUSES, runs, type PipelineRun } from "./runs";
import { schedulerState, type SchedulerState } from "./scheduler";

export type IssueSeverity = "info" | "warning" | "failed";
export type RunIssue = { code: string; severity: IssueSeverity; message: string };
export type RunDiagnostics = {
  deadline_at: number | null;
  overdue: boolean;
  /** Most severe first. */
  issues: RunIssue[];
};

const log = logger("diagnostics");
const now = () => Date.now() / 1000;
const RANK: Record<IssueSeverity, number> = { failed: 2, warning: 1, info: 0 };

function duration(seconds: number) {
  const value = Math.max(0, Math.round(seconds));
  if (value < 90) return `${value}s`;
  if (value < 5400) return `${Math.round(value / 60)} min`;
  return `${(value / 3600).toFixed(1)} h`;
}

function jobLabel(run: PipelineRun, job: Job) {
  if (job.kind === "collect_source") {
    const source = run.sources.find((item) => item.job_id === job._id)
      ?? run.sources.find((item) => item.source_id === (job.payload?.task as { source_id?: string } | undefined)?.source_id);
    return source ? `source "${source.name}"` : "a source";
  }
  return { author_start: "story ranking", author_story: "story writing", author_finish: "publishing" }[job.kind] ?? job.kind;
}

const ACTIVE_JOB = (job: Job) => job.status === "pending" || job.status === "running";

export function diagnoseRun(run: PipelineRun, jobs: Job[], scheduler: SchedulerState, timeoutSeconds: number | null, current = now()): RunDiagnostics {
  if (!ACTIVE_RUN_STATUSES.includes(run.status)) return { deadline_at: null, overdue: false, issues: [] };
  const deadline = timeoutSeconds ? run.created_at + timeoutSeconds : null;
  const issues: RunIssue[] = [];
  const pending = jobs.filter((job) => job.status === "pending");
  const ready = pending.filter((job) => job.available_at <= current);
  const running = jobs.filter((job) => job.status === "running");

  if (ready.length && scheduler.status === "stale") {
    const since = scheduler.seconds_since_tick === null ? "has never run" : `last ran ${duration(scheduler.seconds_since_tick)} ago`;
    const waiting = Math.max(...ready.map((job) => current - job.available_at));
    issues.push({
      code: "scheduler_not_running",
      severity: waiting > 120 ? "failed" : "warning",
      message: `Scheduler is not running (${since}); ${ready.length} queued job(s) are waiting. Configure Vercel Cron or another scheduler to POST /api/pipeline/tick every minute with Authorization: Bearer CRON_SECRET.`,
    });
  }
  for (const issue of scheduler.issues) {
    if (issue.at < run.created_at) continue;
    issues.push({ code: `scheduler_${issue.channel}_failed`, severity: ready.length ? "failed" : "warning", message: issue.message });
  }
  for (const job of pending) {
    if (job.dispatch_error && (job.dispatch_error_at ?? 0) > (job.dispatched_at ?? 0)) {
      issues.push({ code: "dispatch_failed", severity: "failed", message: `Could not start worker for ${jobLabel(run, job)}: ${job.dispatch_error}` });
    } else if (job.attempts > 0) {
      const next = job.available_at > current ? `retrying in ${duration(job.available_at - current)}` : "waiting to retry";
      issues.push({ code: "job_retrying", severity: "warning", message: `${jobLabel(run, job)} failed attempt ${job.attempts}/${MAX_ATTEMPTS}, ${next}: ${job.error ?? "unknown error"}` });
    }
  }
  for (const job of running) {
    if (job.lease_until !== null && job.lease_until < current) {
      issues.push({ code: "lease_expired", severity: "warning", message: `Worker for ${jobLabel(run, job)} stopped responding ${duration(current - job.lease_until)} ago (likely a function timeout); it is retried on the next scheduler tick.` });
    } else if (job.started_at !== null) {
      issues.push({ code: "job_running", severity: "info", message: `${jobLabel(run, job)} running for ${duration(current - job.started_at)} (attempt ${job.attempts}/${MAX_ATTEMPTS}).` });
    }
  }
  if (!jobs.some(ACTIVE_JOB) && run.status !== "collecting" && current - run.updated_at > 120) {
    issues.push({ code: "no_active_work", severity: "failed", message: `Run is ${run.status} but has no queued or running work; it cannot finish without a restart.` });
  }
  const overdue = deadline !== null && current > deadline;
  if (overdue) {
    issues.push({ code: "overdue", severity: "failed", message: `Run exceeded its ${duration(timeoutSeconds ?? 0)} timeout while ${run.status}.` });
  } else if (deadline !== null && issues.some((issue) => issue.severity !== "info")) {
    issues.push({ code: "deadline", severity: "info", message: `Run will be failed automatically in ${duration(deadline - current)} if it does not finish.` });
  }
  issues.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  return { deadline_at: deadline, overdue, issues };
}

/** Diagnostics for many runs with one jobs query and one heartbeat read. */
export async function diagnoseRuns(db: Db, items: PipelineRun[], timeoutSeconds: number | null, current = now()) {
  const active = items.filter((run) => ACTIVE_RUN_STATUSES.includes(run.status));
  const result = new Map<string, RunDiagnostics>();
  if (!active.length) return result;
  const scheduler = await schedulerState(db, current);
  const jobs = await db.collection<Job>(COLLECTIONS.jobs).find({ run_id: { $in: active.map((run) => run._id) } }).toArray();
  for (const run of active) result.set(run._id, diagnoseRun(run, jobs.filter((job) => job.run_id === run._id), scheduler, timeoutSeconds, current));
  return result;
}

/**
 * Fail active runs older than the timeout and discard their queued work. A publishing run with
 * a live worker lease is left alone: its Drive write may be in progress.
 */
export async function expireOverdueRuns(db: Db, timeoutSeconds: number | null, current = now()) {
  if (!timeoutSeconds) return [];
  const overdue = await runs(db).find({ status: { $in: ACTIVE_RUN_STATUSES }, created_at: { $lt: current - timeoutSeconds } }).toArray();
  if (!overdue.length) return [];
  const diagnostics = await diagnoseRuns(db, overdue, timeoutSeconds, current);
  const expired: PipelineRun[] = [];
  for (const run of overdue) {
    if (run.status === "publishing") {
      const live = await db.collection<Job>(COLLECTIONS.jobs).findOne({ run_id: run._id, status: "running", lease_until: { $gte: current } });
      if (live) continue;
    }
    const cause = diagnostics.get(run._id)?.issues.find((issue) => issue.code !== "overdue" && issue.code !== "deadline" && issue.severity !== "info");
    const error = `Timed out after ${duration(timeoutSeconds)} while ${run.status}.${cause ? ` ${cause.message}` : ""}`;
    const updated = await runs(db).findOneAndUpdate(
      { _id: run._id, status: run.status },
      { $set: { status: "failed", error, completed_at: current, updated_at: current } },
      { returnDocument: "after" },
    );
    if (!updated) continue;
    await cancelRunJobs(db, run._id);
    log.error("run_timed_out", { run_id: run._id, location_id: run.location_id, status: run.status, error });
    expired.push(updated);
  }
  return expired;
}
