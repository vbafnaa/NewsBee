/**
 * Orchestrator: the Stage 1 pipeline flow on a serverless job queue.
 *
 *   trigger -> one collect_source job per selected source (connector + per-source top 5)
 *           -> awaiting_authoring -> editor starts author_start
 *           -> author_story, one story per job (write, validate, retry once, or hold)
 *           -> awaiting_finish -> editor starts author_finish -> publish to output channels
 *
 * Every step is one bounded job, so it fits one function call and survives restarts.
 */
import type { Db } from "mongodb";
import { rankingCandidateLimit, type Settings } from "../core/config";
import { fetchTransport, type HttpTransport } from "../core/http";
import { logger, withLogSink, type LogRecord, type Logger } from "../core/log";
import { ingestWindow, localToday } from "../core/time";
import { Fetcher } from "../connectors/fetcher";
import { CONNECTORS, selectSources } from "../connectors/registry";
import { collectManualLink, manualLinks, manualTask } from "../connectors/manual-links";
import type { CollectedSource, Connector, ConnectorContext, SourceTask, SourceType } from "../connectors/types";
import { getLocation, listLocations } from "../communities/locations";
import { finishAuthoring, authorNextStory, shortlistSource, startAuthoring } from "../editions/authoring";
import type { SourceEvent } from "../editions/stories";
import type { ModelRuntime } from "../model/runtime";
import { ModelRateLimitError } from "../model/runtime";
import { runFolder, type ArtifactStore } from "../storage/artifacts";
import { MongoLinkCache } from "../storage/link-cache";
import { COLLECTIONS } from "../storage/mongo";
import { acquireWorker, releaseWorker, renewWorker, cancelClaimedJob, cancelRunJobs, claim, complete, enqueue, fail, LostLeaseError, recoverExpired, runJobs, setJobLog, type Job, type JobKind } from "./jobs";
import { publishToChannels } from "./publish";
import { expireOverdueRuns } from "./diagnostics";
import { ACTIVE_RUN_STATUSES, PROCESSING_RUN_STATUSES, RunConflict, oldestActiveRun, failRun, getRun, newRun, runs, setRun, awaitAuthoringWhenReady, updateSource, type PipelineRun } from "./runs";

export type OrchestratorDeps = {
  db: Db;
  store: ArtifactStore;
  settings: Settings;
  model: ModelRuntime;
  rankingModel?: ModelRuntime;
  transport?: HttpTransport;
  connectors?: Record<SourceType, Connector>;
  log?: Logger;
};

/** A job error that retrying cannot fix. */
export class PermanentJobError extends Error {}

const log = logger("orchestrator");
const now = () => Date.now() / 1000;

function connectorsOf(deps: OrchestratorDeps) {
  return deps.connectors ?? CONNECTORS;
}

/** Start a run for one location: today and the window come from the location's own timezone. */
export async function startRun(deps: OrchestratorDeps, locationId: string, trigger: PipelineRun["trigger"]) {
  const location = await getLocation(deps.db, locationId);
  await expireOverdueRuns(deps.db, deps.settings.runTimeoutSeconds);
  const existing = await runs(deps.db).findOne({ location_id: location.id, status: { $in: ACTIVE_RUN_STATUSES } });
  if (existing) {
    if (existing.status === "collecting") await resumeRun(deps, existing._id, trigger.by);
    return { run: existing, started: false };
  }
  const today = localToday(location.state);
  const window = ingestWindow(today);
  const additional = await manualLinks(deps.db).find({ location_id: location.id }).sort({ created_at: 1, _id: 1 }).toArray();
  const tasks = [...selectSources(location, deps.settings, connectorsOf(deps)), ...additional.map(manualTask).filter((task) => task.type !== "statenews" || deps.settings.widerSources)];
  const run = newRun(location, trigger, today, window, tasks);
  try {
    await runs(deps.db).insertOne(run);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const raced = await runs(deps.db).findOne({ location_id: location.id, status: { $in: ACTIVE_RUN_STATUSES } });
      if (raced) return { run: raced, started: false };
    }
    throw error;
  }
  for (const task of tasks) {
    const jobId = await enqueue(deps.db, {
      kind: "collect_source",
      run_id: run._id,
      location_id: location.id,
      payload: { task },
      dedupe_key: `collect:${run._id}:${task.source_id}`,
    });
    await updateSource(deps.db, run._id, task.source_id, { job_id: jobId });
    if ((await getRun(deps.db, run._id))?.status === "cancelled") {
      await cancelRunJobs(deps.db, run._id);
      break;
    }
  }
  log.info("run_started", { run_id: run._id, location_id: location.id, sources: tasks.length, trigger: trigger.kind, by: trigger.by, status: "collecting", today });
  if (tasks.length === 0) await advanceToAuthoring(deps, run._id, location.id);
  return { run: (await getRun(deps.db, run._id)) ?? run, started: true };
}

export async function startAll(deps: OrchestratorDeps, by: string) {
  const started = [];
  for (const location of await listLocations(deps.db)) {
    started.push(await startRun(deps, location.id, { by, kind: "all" }));
  }
  return started;
}

async function advanceToAuthoring(deps: OrchestratorDeps, runId: string, locationId: string) {
  if (await awaitAuthoringWhenReady(deps.db, runId)) {
    log.info("stage_transition", { run_id: runId, location_id: locationId, status: "awaiting_authoring", by: "worker" });
  }
}

export type ManualStage = "authoring" | "finish";

/** A compare-and-set gate; repeated stage clicks resume without recreating completed work. */
export async function triggerStage(deps: OrchestratorDeps, runId: string, stage: ManualStage, by: string) {
  const waiting = stage === "authoring" ? "awaiting_authoring" : "awaiting_finish";
  const status = stage === "authoring" ? "authoring" : "finishing";
  const at = now();
  const changed = await runs(deps.db).findOneAndUpdate(
    { _id: runId, status: waiting },
    { $set: { status, updated_at: at, stage_started_at: at, ...(stage === "authoring" ? { authoring_started_at: at } : {}) },
      $push: { stage_transitions: { status, by, at } } },
    { returnDocument: "after" },
  );
  const run = changed ?? await getRun(deps.db, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  if (run.status !== status && !(stage === "finish" && run.status === "publishing")) {
    throw new RunConflict(`Cannot start ${stage} while run is ${run.status}; expected ${waiting} or an in-progress ${stage} stage`);
  }
  if (changed) log.info("stage_transition", { run_id: runId, location_id: run.location_id, status, by });
  return resumeRun(deps, runId, by);
}

/** Repair interrupted enqueue boundaries using persisted tasks and completed step results. */
export async function resumeRun(deps: OrchestratorDeps, runId: string, by: string) {
  const run = await getRun(deps.db, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  if (!PROCESSING_RUN_STATUSES.includes(run.status)) throw new RunConflict(`Cannot resume run while ${run.status}; start its next stage instead`);
  const jobs = await runJobs(deps.db, runId);
  const queue = (kind: JobKind, payload: Record<string, unknown> = {}, dedupe_key?: string) =>
    enqueue(deps.db, { kind, run_id: runId, location_id: run.location_id, payload, dedupe_key });
  if (run.status === "collecting") {
    for (const task of run.collection_tasks ?? []) {
      const jobId = await queue("collect_source", { task }, `collect:${runId}:${task.source_id}`);
      await updateSource(deps.db, runId, task.source_id, { job_id: jobId });
    }
    await advanceToAuthoring(deps, runId, run.location_id);
  } else if (run.status === "authoring") {
    await queue("author_start");
    const start = jobs.find((job) => job.kind === "author_start" && job.status === "completed");
    if (start && run.draft_id) {
      const stories = jobs.filter((job) => job.kind === "author_story").sort((a, b) => Number(b.payload.step) - Number(a.payload.step));
      const last = stories[0];
      if (last?.status === "completed" && last.result?.more === false) {
        await awaitFinish(deps, runId);
      } else if (!last || last.status === "completed") {
        const step = last ? Number(last.payload.step) + 1 : 0;
        await queue("author_story", { draft_id: run.draft_id, step }, `author_story:${runId}:${step}`);
      }
    }
  } else {
    if (!run.draft_id) throw new RunConflict("Cannot finish a run without an authoring draft");
    await queue("author_finish", { draft_id: run.draft_id });
  }
  if ((await getRun(deps.db, runId))?.status === "cancelled") await cancelRunJobs(deps.db, runId);
  log.info("stage_resumed", { run_id: runId, status: run.status, by });
  return getRun(deps.db, runId);
}

async function awaitFinish(deps: OrchestratorDeps, runId: string) {
  const at = now();
  const changed = await runs(deps.db).updateOne(
    { _id: runId, status: "authoring" },
    { $set: { status: "awaiting_finish", updated_at: at }, $push: { stage_transitions: { status: "awaiting_finish", by: "worker", at } } },
  );
  if (changed.modifiedCount) log.info("stage_transition", { run_id: runId, status: "awaiting_finish", by: "worker" });
}

/** A source that will not be collected (final failure) still releases the authoring barrier. */
async function sourceFailed(deps: OrchestratorDeps, job: Job, error: string) {
  const task = job.payload.task as SourceTask;
  await updateSource(deps.db, job.run_id, task.source_id, { status: "failed", result_status: "failed", detail: error, error });
  await advanceToAuthoring(deps, job.run_id, job.location_id);
}

async function collectSource(deps: OrchestratorDeps, job: Job) {
  const task = job.payload.task as SourceTask;
  const run = await getRun(deps.db, job.run_id);
  if (!run || run.status !== "collecting") return { skipped: true };
  const connector = connectorsOf(deps)[task.type];
  if (!connector) throw new PermanentJobError(`No connector for source type ${task.type}`);
  const location = await getLocation(deps.db, run.location_id);
  const transport = deps.transport ?? fetchTransport;
  const sourceLog = logger(`connector.${task.type}`, { source_id: task.source_id, run_id: run._id, location_id: run.location_id });
  const context: ConnectorContext = {
    location,
    today: run.today,
    window: run.window,
    transport,
    fetcher: new Fetcher(transport),
    settings: deps.settings,
    db: deps.db,
    linkCache: new MongoLinkCache(deps.db),
    model: deps.settings.aiLinkDiscovery ? deps.model : undefined,
    log: sourceLog,
  };
  const manualId = task.params?.manual_link_id;
  const manual = typeof manualId === "string" ? await manualLinks(deps.db).findOne({ _id: manualId, location_id: location.id }) : null;
  if (typeof manualId === "string" && !manual) throw new PermanentJobError("Manual link was removed before collection");
  const collected: CollectedSource = manual ? await collectManualLink(manual, context) : await connector.collect(task, context);
  const events: SourceEvent[] = collected.events.map((facts) => ({ source_id: task.source_id, facts }));
  const { stories, summary } = shortlistSource(events, task.type, rankingCandidateLimit(deps.settings));
  const chosen = new Set(stories.flatMap((story) => story.occurrences.map((item) => `${item.source_id}\u0000${item.source_event_id}`)));
  const kept = events.filter((event) => chosen.has(`${event.source_id}\u0000${event.facts.source_event_id}`));
  const id = `${run._id}:${task.source_id}`;
  const saved = { run_id: run._id, location_id: run.location_id, source_id: task.source_id, type: task.type, created_at: now() };
  await deps.db.collection(COLLECTIONS.sourceResults).replaceOne({ _id: id as never }, { ...saved, result: collected.result, event_count: events.length }, { upsert: true });
  await deps.db.collection(COLLECTIONS.shortlists).replaceOne({ _id: id as never }, { ...saved, events: kept, summary }, { upsert: true });
  await updateSource(deps.db, run._id, task.source_id, {
    status: "completed",
    result_status: collected.result.status,
    detail: collected.result.detail ?? null,
    event_count: events.length,
    shortlisted: stories.length,
    link_discovery: collected.result.link_discovery ?? null,
    error: null,
  });
  await advanceToAuthoring(deps, run._id, run.location_id);
  return { status: collected.result.status, events: events.length, shortlisted: stories.length };
}

function authoringDeps(deps: OrchestratorDeps) {
  return { db: deps.db, model: deps.model, rankingModel: deps.rankingModel, settings: deps.settings, log: deps.log ?? logger("authoring") };
}

async function authorStart(deps: OrchestratorDeps, job: Job) {
  const run = await getRun(deps.db, job.run_id);
  if (!run || run.status !== "authoring") return { skipped: true };
  let draftId = run.draft_id;
  if (!draftId) {
    const shortlists = await deps.db.collection(COLLECTIONS.shortlists).find({ run_id: run._id }).sort({ _id: 1 }).toArray();
    const results = await deps.db.collection(COLLECTIONS.sourceResults).find({ run_id: run._id }).sort({ _id: 1 }).toArray();
    const resultsById = new Map(results.map((doc) => [doc.source_id, doc.result]));
    const sourceResults = run.sources.map((source) => resultsById.get(source.source_id) ?? {
      source_id: source.source_id, name: source.name, status: "failed", detail: source.error ?? "Source was not collected", events: 0,
    });
    draftId = await startAuthoring(authoringDeps(deps), {
      location: { id: run.location_id, name: run.location_name },
      runId: run._id,
      today: run.today,
      window: run.window,
      events: shortlists.flatMap((doc) => doc.events as SourceEvent[]),
      sourceResults,
    });
    await setRun(deps.db, run._id, { draft_id: draftId });
  }
  if ((await getRun(deps.db, run._id))?.status !== "authoring") return { cancelled: true };
  await enqueue(deps.db, { kind: "author_story", run_id: run._id, location_id: run.location_id, payload: { draft_id: draftId, step: 0 }, dedupe_key: `author_story:${run._id}:0` });
  return { draft_id: draftId };
}

async function authorStory(deps: OrchestratorDeps, job: Job) {
  const draftId = String(job.payload.draft_id);
  const step = Number(job.payload.step ?? 0);
  const result = await authorNextStory(authoringDeps(deps), draftId);
  if ((await getRun(deps.db, job.run_id))?.status !== "authoring") return { cancelled: true };
  if (result.more) {
    await enqueue(deps.db, { kind: "author_story", run_id: job.run_id, location_id: job.location_id, payload: { draft_id: draftId, step: step + 1 }, dedupe_key: `author_story:${job.run_id}:${step + 1}` });
  } else {
    await awaitFinish(deps, job.run_id);
  }
  return { step, ...("candidate" in result ? { candidate: result.candidate } : {}), more: result.more };
}

async function authorFinish(deps: OrchestratorDeps, job: Job) {
  // Publication is the commit boundary: cancellation wins before this transition;
  // once publishing begins, cancellation is rejected to avoid a half-published edition.
  const run = await runs(deps.db).findOneAndUpdate(
    { _id: job.run_id, status: { $in: ["finishing", "publishing"] } },
    { $set: { status: "publishing", updated_at: now() } },
    { returnDocument: "after" },
  );
  if (!run) return { skipped: true };
  log.info("stage_transition", { run_id: job.run_id, status: "publishing", by: "worker" });
  const draftId = String(job.payload.draft_id);
  // Gates can wait days, so expire events against the publish date, not the run's start date.
  const publishToday = localToday((await getLocation(deps.db, run.location_id)).state);
  const finished = await finishAuthoring(authoringDeps(deps), draftId, publishToday).catch(async (error: unknown) => {
    // No edition is published on a quota failure; allow durable retries and cancellation.
    if (error instanceof ModelRateLimitError) {
      await runs(deps.db).updateOne(
        { _id: job.run_id, status: "publishing" },
        { $set: { status: "finishing", updated_at: now() } },
      );
    }
    throw error;
  });
  if (!("edition" in finished) || !finished.edition) throw new Error("Authoring has unwritten stories");
  const { edition, emailPreview, summary } = finished as { edition: { id: string; location_id: string; items: unknown[] }; emailPreview: { subject: string; text: string; html: string }; summary: Record<string, unknown> };
  const channels = await publishToChannels(deps.db, deps.store, edition);
  const previews = await runFolder(deps.store, "email-previews", run.location_id);
  const editions = await runFolder(deps.store, "editions", run.location_id);
  const sources = await runFolder(deps.store, "sources", run.location_id);
  const artifacts = {
    email_html: await deps.store.saveText(previews, `${edition.id}.html`, emailPreview.html, "text/html"),
    email_text: await deps.store.saveText(previews, `${edition.id}.txt`, `Subject: ${emailPreview.subject}\n\n${emailPreview.text}`, "text/plain"),
    edition: await deps.store.saveJson(editions, `${edition.id}.json`, { edition, summary }),
    sources: await deps.store.saveJson(sources, `${run._id}.json`, { run_id: run._id, sources: run.sources }),
  };
  const held = Number(summary.held ?? 0);
  await setRun(deps.db, run._id, {
    status: "published",
    edition_id: edition.id,
    completed_at: now(),
    published: {
      items: edition.items.length,
      held,
      held_reasons: (summary.held_reasons as Record<string, number>) ?? {},
      channels,
      artifacts,
    },
  });
  log.info("run_published", { run_id: run._id, location_id: run.location_id, status: "published", by: "worker", edition_id: edition.id, items: edition.items.length, held, channels: channels.length });
  return { edition_id: edition.id, items: edition.items.length, held, channels };
}

export async function executeJob(deps: OrchestratorDeps, job: Job): Promise<Record<string, unknown>> {
  const run = await getRun(deps.db, job.run_id);
  if (!run || !stageKinds(run).includes(job.kind)) return { skipped: true };
  switch (job.kind) {
    case "collect_source": return collectSource(deps, job);
    case "author_start": return authorStart(deps, job);
    case "author_story": return authorStory(deps, job);
    case "author_finish": return authorFinish(deps, job);
  }
}

async function finalFailure(deps: OrchestratorDeps, job: Job, error: string) {
  const run = await getRun(deps.db, job.run_id);
  if (!run || !stageKinds(run).includes(job.kind)) return;
  if (job.kind === "collect_source") await sourceFailed(deps, job, error);
  else await failRun(deps.db, job.run_id, `${job.kind} failed: ${error}`);
}

function stageKinds(run: PipelineRun): JobKind[] {
  if (run.status === "collecting") return ["collect_source"];
  if (run.status === "authoring") return ["author_start", "author_story"];
  if (run.status === "finishing" || run.status === "publishing") return ["author_finish"];
  return [];
}

/** Claim and run one job; returns false when the queue is empty. */
export async function runOne(deps: OrchestratorDeps, options: { jobId?: string; kinds?: readonly JobKind[] } = {}): Promise<boolean> {
  const token = await acquireWorker(deps.db);
  if (!token) return false;
  try {
    for (const expired of await recoverExpired(deps.db)) await finalFailure(deps, expired, expired.error ?? "Worker lease expired");
    const active = await oldestActiveRun(deps.db);
    if (!active) return false;
    const kinds = stageKinds(active).filter((kind) => !options.kinds || options.kinds.includes(kind));
    const job = await claim(deps.db, kinds, options.jobId, active._id);
    if (!job) return false;
    let renewal: Promise<void> = Promise.resolve();
    let leaseError: unknown;
    const heartbeat = setInterval(() => {
      renewal = renewal.then(() => renewWorker(deps.db, token, job)).catch((error: unknown) => {
        leaseError = error;
        log.error("worker_lease_renewal_failed", { job_id: job._id, error: String(error) });
      });
    }, 60_000);
    try {
      return await runClaimedJob(deps, job, () => { if (leaseError) throw leaseError; });
    } finally {
      clearInterval(heartbeat);
      await renewal;
    }
  } finally {
    await releaseWorker(deps.db, token);
  }
}

async function runClaimedJob(deps: OrchestratorDeps, job: Job, checkLease: () => void) {
  const run = await getRun(deps.db, job.run_id);
  if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) {
    await cancelRunJobs(deps.db, job.run_id);
    await cancelClaimedJob(deps.db, job);
    return true;
  }
  const started = Date.now();
  const records: LogRecord[] = [];
  let executionFailed = false;
  let executionError: unknown;
  try {
    await withLogSink((record) => records.push(record), async () => {
      logger("job").info("job_started", { kind: job.kind, job_id: job._id, run_id: job.run_id, attempt: job.attempts });
      try {
        const result = await executeJob(deps, job);
        checkLease();
        if ((await getRun(deps.db, job.run_id))?.status === "cancelled") {
          await cancelRunJobs(deps.db, job.run_id);
          await cancelClaimedJob(deps.db, job);
          logger("job").info("job_cancelled", { kind: job.kind, job_id: job._id, run_id: job.run_id });
          return;
        }
        await complete(deps.db, job, result);
        log.info("job_completed", { kind: job.kind, job_id: job._id, run_id: job.run_id, duration_ms: Date.now() - started });
      } catch (error) {
        if (error instanceof LostLeaseError) {
          log.warn("job_lease_lost", { kind: job.kind, job_id: job._id });
          return;
        }
        if ((await getRun(deps.db, job.run_id))?.status === "cancelled") {
          await cancelRunJobs(deps.db, job.run_id);
          await cancelClaimedJob(deps.db, job);
          logger("job").info("job_cancelled", { kind: job.kind, job_id: job._id, run_id: job.run_id });
          return;
        }
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        log.error("job_execution_failed", { kind: job.kind, job_id: job._id, run_id: job.run_id, error: detail });
        const outcome = await fail(deps.db, job, error, !(error instanceof PermanentJobError));
        if ((await getRun(deps.db, job.run_id))?.status === "cancelled") {
          await cancelRunJobs(deps.db, job.run_id);
        }
        if (outcome === "failed") await finalFailure(deps, job, error instanceof Error ? error.message : String(error));
      }
    });
  } catch (error) {
    executionFailed = true;
    executionError = error;
  }
  try {
    const folder = await runFolder(deps.store, "logs", job.run_id);
    const previous = job.log_file ? await deps.store.readText(job.log_file) : "";
    const attemptLog = records.map((record) => JSON.stringify(record)).join("\n");
    const content = [previous.trimEnd(), attemptLog].filter(Boolean).join("\n");
    const file = await deps.store.saveText(
      folder,
      `${job._id}.jsonl`,
      `${content}\n`,
      "application/x-ndjson",
    );
    await setJobLog(deps.db, job._id, file, null);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log.error("job_log_upload_failed", { kind: job.kind, job_id: job._id, run_id: job.run_id, error: detail });
    await setJobLog(deps.db, job._id, job.log_file, detail);
  }
  if (executionFailed) throw executionError;
  return true;
}

/**
 * One scheduler tick (Vercel Cron, or the local poller): record a heartbeat, recover
 * interrupted jobs, then run one location at a time until the queue is empty or the start
 * budget is spent. Jobs already started run to completion.
 */
export async function tick(deps: OrchestratorDeps, options: { budgetMs?: number; concurrency?: number; kinds?: readonly JobKind[] } = {}) {
  const budgetMs = options.budgetMs ?? 30_000;
  const deadline = Date.now() + budgetMs;
  await deps.db.collection(COLLECTIONS.heartbeat).updateOne({ _id: "scheduler" as never }, { $set: { last_tick_at: now() } }, { upsert: true });
  await expireOverdueRuns(deps.db, deps.settings.runTimeoutSeconds);
  let executed = 0;
  const worker = async () => {
    while (Date.now() < deadline && (await runOne(deps, { kinds: options.kinds }))) executed += 1;
  };
  await worker();
  await deps.db.collection(COLLECTIONS.heartbeat).updateOne({ _id: "scheduler" as never }, { $set: { last_tick_finished_at: now(), last_tick_executed: executed } });
  return { executed };
}
