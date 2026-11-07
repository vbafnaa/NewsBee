/**
 * Orchestrator: the pipeline flow on a serverless job queue.
 *
 * A map run writes the source map, and stops there:
 *
 *   trigger -> discover, one job per discovery method -> agent_round, when the agent maps
 *           -> finish_map: each source's working address is saved -> mapped
 *
 * An edition run only reads the map. Its link to a map run is the saved map, nothing else: a
 * saved address that fails is flagged for the next map run rather than searched for again.
 *
 *   trigger -> plan_sources: the location's source map becomes this run's collection tasks
 *           -> collect_source, one job per source (every item kept, with what was left out)
 *           -> awaiting_authoring -> editor starts author_start (assemble: locality,
 *              merging, ledger, sections) -> author_rank, one job per section
 *           -> author_story, one story per job (details, floor, write, validate, retry once, or hold)
 *           -> awaiting_finish -> editor starts author_finish -> publish to the reader folder
 *
 * Every step is one bounded job, so it fits one function call and survives restarts. Sources
 * and discovery methods run side by side, up to the worker slots; each source has a time budget
 * and so does collection, which then moves on to writing with what it has.
 *
 * Under autopilot (the default run mode) the two "awaiting" stops advance on their own, so an
 * edition goes from one click to print. On a map run, the agentic flow adds the `dork` method and
 * agent_round jobs. On an edition run, it adds topic sweeps during collection; everything from
 * author_start onward is the same code for both flows.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { Settings } from "../core/config";
import { fetchTransport, type HttpTransport } from "../core/http";
import { logger, withLogSink, type LogRecord, type Logger } from "../core/log";
import { currentOptions, resolveRunOptions, runContext, withRunContext, LEGACY_OPTIONS } from "../core/run-options";
import { ingestWindow, localToday, lookupRanges } from "../core/time";
import { agentRound } from "../agent/map-sources";
import { publicOnlyTransport, publicSourceTransport } from "../connectors/public-http";
import { logSourceCollected, logSourceMap } from "./source-log";
import { sweepTasks } from "../connectors/sweep";
import { recordDecision, recordDecisions } from "../trace/decisions";
import { externalTransport } from "../trace/gateway";
import { Fetcher } from "../connectors/fetcher";
import { sourceResult } from "../connectors/types";
import { CONNECTORS, windowOf } from "../connectors/registry";
import { collectManualLink, manualLinks, migrateManualLinks } from "../connectors/manual-links";
import { locationHealth, recordSourceHealth } from "./source-health";
import type { CollectedSource, Connector, ConnectorContext, SourceTask, SourceType } from "../connectors/types";
import { getLocation, listLocations } from "../communities/locations";
import { finishAuthoring, authorNextStory, rankSection, startAuthoring } from "../editions/authoring";
import { collectedItems, type CollectedItem } from "../editions/assemble";
import { writeEditionMap } from "../editions/edition-map";
import { categoryCoverage, collectableSources, hostOf, recordSourceRun, sourceMap, taskFor } from "../sourcemap/store";
import { dueMethods, runMethod } from "../discovery/run";
import { METHODS } from "../discovery/methods";
import type { ModelRuntime } from "../model/runtime";
import { ModelRateLimitError, withModelUsageContext } from "../model/runtime";
import { runFolder, type ArtifactStore } from "../storage/artifacts";
import { MongoLinkCache } from "../storage/link-cache";
import { COLLECTIONS } from "../storage/mongo";
import { acquireRunLease, acquireSlot, appendJobLog, cancelClaimedJob, cancelPending, cancelRunJobs, claim, complete, enqueue, enqueueMany, fail, isParallelKind, LostLeaseError, markLogsArchived, MONGO_LOG, recoverExpired, releaseLease, renewJob, runJobs, setJobLog, unarchivedLogs, type Job, type JobKind, type Lease } from "./jobs";
import { publishToReader } from "./publish";
import { recordPublished } from "../editions/ledger";
import { expireOverdueRuns } from "./diagnostics";
import { ACTIVE_RUN_STATUSES, PROCESSING_RUN_STATUSES, collectionCandidateCount, RunConflict, failRun, getRun, markNotReached, newRun, lastEditionDay, planRun, runs, setRun, stageKinds, awaitAuthoringWhenReady, updateSource, workableRuns, type PipelineRun } from "./runs";
import type { Principal } from "../accounts/identity";
import { assertGlobalAdmission, assertSponsor, authorizePaidAction, blockExecution, consumeApproval, prepareBinding } from "../accounts/execution";
import { ExecutionBlocked } from "../core/execution-errors";
import { safeError } from "../core/redaction";

export type OrchestratorDeps = {
  principal?: Principal;
  runtimeForRun?: (run: PipelineRun) => Promise<OrchestratorDeps>;
  db: Db;
  store: ArtifactStore;
  settings: Settings;
  model: ModelRuntime;
  rankingModel?: ModelRuntime;
  /** Flash-Lite first: detail extraction. */
  lightModel?: ModelRuntime;
  /** Flash-Lite first: LLM source discovery. */
  discoveryModel?: ModelRuntime;
  /** The mapping agent's planner. */
  agentModel?: ModelRuntime;
  /** Flash-Lite first: reading pages during collection. */
  agentLightModel?: ModelRuntime;
  transport?: HttpTransport;
  connectors?: Record<SourceType, Connector>;
  log?: Logger;
};

/** A job error that retrying cannot fix. */
export class PermanentJobError extends Error {}

const log = logger("orchestrator");
const now = () => Date.now() / 1000;
/** A source stops starting new requests after this, and returns what it has. */
export const SOURCE_BUDGET_MS = 60_000;
/** A reader that didn't stop by itself is left behind after this. */
const SOURCE_HARD_STOP_MS = 75_000;
/** finish_map hands off to a new job after this, to stay inside one function call. */
const FINISH_MAP_MS = 200_000;
/** Assumed for a source with no history. */
const TYPICAL_SOURCE_SECONDS = 20;
const LINK_READERS: SourceType[] = ["meetings", "library"];

function connectorsOf(deps: OrchestratorDeps) {
  return deps.connectors ?? CONNECTORS;
}

/** Start an edition for one location: today and the window come from the location's own timezone. */
export async function startRun(deps: OrchestratorDeps, locationId: string, trigger: PipelineRun["trigger"], choices?: unknown) {
  const location = await getLocation(deps.db, locationId);
  const options = resolveRunOptions(choices);
  await expireOverdueRuns(deps.db, deps.settings.runTimeoutSeconds);
  const existing = await runs(deps.db).findOne({ location_id: location.id, status: { $in: ACTIVE_RUN_STATUSES } });
  if (existing) {
    if (deps.principal) await authorizePaidAction(deps.db, existing._id, deps.principal);
    if (existing.status === "collecting") await resumeRun(deps, existing._id, trigger.by);
    return { run: existing, started: false };
  }
  if (!await sourceMap(deps.db).countDocuments({ location_id: location.id, status: { $ne: "rejected" } }, { limit: 1 })) {
    throw new RunConflict("Build the source map first: this location has no sources to read.");
  }
  const today = localToday(location.state);
  const window = ingestWindow(today);
  await migrateManualLinks(deps.db, location.id);
  const run = newRun(location, trigger, today, window, [], await lastEditionDay(deps.db, location.id, today), [], options);
  if (deps.principal) run.execution = await prepareBinding(deps.db, deps.settings, deps.principal, locationId, "edition", choices);
  run.map_version = location.source_map_version ?? null;
  const inserted = await insertRun(deps, run, locationId);
  if (inserted) return { run: inserted, started: false };
  await enqueue(deps.db, { kind: "plan_sources", run_id: run._id, location_id: run.location_id, dedupe_key: `plan:${run._id}` });
  log.info("run_started", { run_id: run._id, location_id: location.id, kind: "edition", trigger: trigger.kind, by: trigger.by, status: "collecting", today });
  return { run: (await getRun(deps.db, run._id)) ?? run, started: true };
}

/** Refresh a location's source map: the methods that are due, or all of them on a rebuild. Never starts an edition. */
export async function startMapRun(deps: OrchestratorDeps, locationId: string, trigger: PipelineRun["trigger"], choices?: unknown, rebuild = false) {
  const location = await getLocation(deps.db, locationId);
  const mapChoices = { ...(choices && typeof choices === "object" ? choices : {}), rebuild };
  const chosen = resolveRunOptions(mapChoices);
  const options = { ...chosen, flow: chosen.map_flow ?? chosen.flow };
  await expireOverdueRuns(deps.db, deps.settings.runTimeoutSeconds);
  const existing = await runs(deps.db).findOne({ location_id: location.id, status: { $in: ACTIVE_RUN_STATUSES } });
  if (existing) {
    if (deps.principal) await authorizePaidAction(deps.db, existing._id, deps.principal);
    return { run: existing, started: false };
  }
  const today = localToday(location.state);
  // The dork method belongs to the agentic flow. Results are cached by query, so a repeat doesn't pay twice.
  const due = rebuild ? METHODS.map((definition) => definition.method) : await dueMethods(deps.db, location.id);
  const methods = [...new Set([...due, ...(options.flow === "agentic" ? ["dork"] : [])])].filter((method) => method !== "dork" || options.flow === "agentic");
  const run: PipelineRun = { ...newRun(location, trigger, today, ingestWindow(today), [], null, methods, options), kind: "map", status: "mapping" };
  if (deps.principal) run.execution = await prepareBinding(deps.db, deps.settings, deps.principal, locationId, "map", mapChoices);
  run.stage_transitions = [{ status: "mapping", by: trigger.by, at: run.created_at }];
  const inserted = await insertRun(deps, run, locationId);
  if (inserted) return { run: inserted, started: false };
  await queueDiscovery(deps, run);
  log.info("run_started", { run_id: run._id, location_id: location.id, kind: "map", discovery: methods, trigger: trigger.kind, by: trigger.by, status: "mapping", today });
  return { run: (await getRun(deps.db, run._id)) ?? run, started: true };
}

/** Save a new run; returns the run already open for the location, if one got there first. */
async function insertRun(deps: OrchestratorDeps, run: PipelineRun, locationId: string) {
  await assertGlobalAdmission(deps.db);
  run.admission = "newsroom";
  try {
    await runs(deps.db).insertOne(run);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw new RunConflict("Another unfinished run was admitted first. Reload the newsroom and wait for its completion.");
    }
    throw error;
  }
  try {
    await consumeApproval(deps.db, run);
    // Removal may have started while this request was preparing the run.
    await getLocation(deps.db, locationId);
  } catch (error) {
    await runs(deps.db).deleteOne({ _id: run._id, status: run.status });
    throw error;
  }
  return null;
}

/** Discovery jobs for the methods chosen, or straight on when there are none. */
async function queueDiscovery(deps: OrchestratorDeps, run: PipelineRun) {
  const methods = run.discovery ?? [];
  for (const method of methods) {
    await enqueue(deps.db, { kind: "discover", run_id: run._id, location_id: run.location_id, payload: { method }, dedupe_key: `discover:${run._id}:${method}` });
  }
  if (!methods.length) await afterDiscovery(deps, run);
}

/** Discovery is done: an agentic map run starts the agent, and other map runs finish. */
async function afterDiscovery(deps: OrchestratorDeps, run: PipelineRun) {
  if (run.kind === "map" && run.options?.flow === "agentic") await enqueue(deps.db, { kind: "agent_round", run_id: run._id, location_id: run.location_id, payload: { round: 0 }, dedupe_key: `agent:${run._id}:0` });
  else await afterMapping(deps, run);
}

/** A map run saves its addresses; a run from before the split goes on to collect. */
async function afterMapping(deps: OrchestratorDeps, run: PipelineRun) {
  if (run.kind === "map") await enqueue(deps.db, { kind: "finish_map", run_id: run._id, location_id: run.location_id, payload: { step: 0 }, dedupe_key: `finish_map:${run._id}:0` });
  else await enqueue(deps.db, { kind: "plan_sources", run_id: run._id, location_id: run.location_id, dedupe_key: `plan:${run._id}` });
}

/** Save a finished stage's job logs as one file. A failure leaves them in MongoDB. */
async function archiveStageLogs(deps: OrchestratorDeps, runId: string, stage: string) {
  try {
    const logs = await unarchivedLogs(deps.db, runId);
    if (!logs.length) return;
    const folder = await runFolder(deps.store, "logs", runId);
    const content = logs.flatMap((entry) => entry.lines.map((line) => JSON.stringify({ job_id: entry._id, record: JSON.parse(line) as unknown }))).join("\n");
    await deps.store.saveText(folder, `${stage}.jsonl`, `${content}\n`, "application/x-ndjson");
    await markLogsArchived(deps.db, logs.map((entry) => entry._id));
  } catch (error) {
    log.warn("stage_log_archive_failed", { run_id: runId, stage, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function startAll(deps: OrchestratorDeps, by: string, choices?: unknown) {
  void deps; void by; void choices;
  throw new RunConflict("Batch runs are disabled: the newsroom admits one unfinished source-map or edition run. Start a single location.");
}

/** The autopilot actor's name in stage transitions. */
const AUTOPILOT = "autopilot";

async function advanceToAuthoring(deps: OrchestratorDeps, runId: string, locationId: string) {
  if (await awaitAuthoringWhenReady(deps.db, runId)) {
    log.info("stage_transition", { run_id: runId, location_id: locationId, status: "awaiting_authoring", by: "worker" });
    await archiveStageLogs(deps, runId, "collecting");
    const run = await getRun(deps.db, runId);
    if (run?.options?.mode !== "autopilot") return;
    if (await collectionCandidateCount(deps.db, runId) === 0) {
      await failRun(deps.db, runId, "No usable items were collected, so there is nothing to write. Review the source map funnel for why.");
      return;
    }
    await triggerStage(deps, runId, "authoring", AUTOPILOT);
  }
}

export type ManualStage = "authoring" | "finish";

/** A compare-and-set gate; repeated stage clicks resume without recreating completed work. */
export async function triggerStage(deps: OrchestratorDeps, runId: string, stage: ManualStage, by: string) {
  if (deps.principal) await assertSponsor(deps.db, runId, deps.principal);
  const existing = await getRun(deps.db, runId);
  if (!existing) throw new Error(`Unknown run: ${runId}`);
  await getLocation(deps.db, existing.location_id);
  if (stage === "authoring" && existing.status === "awaiting_authoring" && await collectionCandidateCount(deps.db, runId) === 0) {
    throw new RunConflict("Cannot start authoring: no usable items were collected. Review sources and retry collection.");
  }
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
  if (deps.principal) await assertSponsor(deps.db, runId, deps.principal);
  const run = await getRun(deps.db, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  await getLocation(deps.db, run.location_id);
  if (!PROCESSING_RUN_STATUSES.includes(run.status)) throw new RunConflict(`Cannot resume run while ${run.status}; start its next stage instead`);
  const jobs = await runJobs(deps.db, runId);
  const queue = (kind: JobKind, payload: Record<string, unknown> = {}, dedupe_key?: string) =>
    enqueue(deps.db, { kind, run_id: runId, location_id: run.location_id, payload, dedupe_key });
  const finished = (job: Job) => ["completed", "failed", "cancelled"].includes(job.status);
  if (run.status === "mapping") {
    const finishing = jobs.filter((job) => job.kind === "finish_map").sort((a, b) => Number(b.payload.step) - Number(a.payload.step))[0];
    const agentJobs = jobs.filter((job) => job.kind === "agent_round").sort((a, b) => Number(b.payload.round) - Number(a.payload.round));
    if (finishing) {
      if (finishing.status === "completed" && finishing.result?.more) await queue("finish_map", { step: Number(finishing.payload.step) + 1 }, `finish_map:${runId}:${Number(finishing.payload.step) + 1}`);
    } else if (agentJobs.length) {
      if (finished(agentJobs[0])) await afterMapping(deps, run);
    } else {
      const discoverJobs = jobs.filter((job) => job.kind === "discover");
      if (discoverJobs.length && discoverJobs.every(finished)) await afterDiscovery(deps, run);
      else await queueDiscovery(deps, run);
    }
  } else if (run.status === "collecting") {
    if (run.planned === false) {
      await queue("plan_sources", {}, `plan:${runId}`);
    } else {
      for (const task of run.collection_tasks ?? []) {
        const jobId = await queue("collect_source", { task }, `collect:${runId}:${task.source_id}`);
        await updateSource(deps.db, runId, task.source_id, { job_id: jobId });
      }
      await advanceToAuthoring(deps, runId, run.location_id);
    }
  } else if (run.status === "authoring") {
    await queue("author_start");
    const start = jobs.find((job) => job.kind === "author_start" && job.status === "completed");
    const draft = run.draft_id ? await deps.db.collection(COLLECTIONS.editions).findOne({ id: run.draft_id }) as { status: string; pool_sections?: Array<{ id: string }>; section_rankings?: Record<string, unknown> } | null : null;
    if (start && draft?.status === "ranking") {
      for (const section of draft.pool_sections ?? []) if (!draft.section_rankings?.[section.id]) await queue("author_rank", { draft_id: run.draft_id, section: section.id }, `author_rank:${runId}:${section.id}`);
    } else if (start && run.draft_id) {
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
  if (changed.modifiedCount) {
    log.info("stage_transition", { run_id: runId, status: "awaiting_finish", by: "worker" });
    await archiveStageLogs(deps, runId, "authoring");
    if ((await getRun(deps.db, runId))?.options?.mode === "autopilot") await triggerStage(deps, runId, "finish", AUTOPILOT);
  }
}

/** A source that will not be collected (final failure) still releases the authoring barrier. */
async function sourceFailed(deps: OrchestratorDeps, job: Job, error: string) {
  const task = job.payload.task as SourceTask;
  await updateSource(deps.db, job.run_id, task.source_id, { status: "failed", result_status: "failed", detail: error, error });
  await advanceToAuthoring(deps, job.run_id, job.location_id);
}

async function discoverJob(deps: OrchestratorDeps, job: Job) {
  const run = await getRun(deps.db, job.run_id);
  if (!run || !["mapping", "collecting"].includes(run.status)) return { skipped: true };
  const location = await getLocation(deps.db, run.location_id);
  const transport = externalTransport(deps.transport ?? publicOnlyTransport(fetchTransport));
  const method = String(job.payload.method);
  const state = await runMethod({
    db: deps.db, settings: deps.settings, transport, fetcher: new Fetcher(transport), location, today: run.today,
    log: logger(`discovery.${method}`, { run_id: run._id, location_id: run.location_id }), model: deps.discoveryModel ?? deps.lightModel ?? null,
  }, method);
  await recordDecision({ stage: "source", actor: "rule", subject: `method:${method}`, decision: state.ok ? "ran" : "failed", reason: state.detail, evidence: { found: state.found, added: state.added } });
  return { method, ok: state.ok, found: state.found, added: state.added, detail: state.detail };
}

/** After the last discovery job has ended, move on. Methods overlap, so this runs once each has completed. */
async function planWhenDiscovered(deps: OrchestratorDeps, job: Job) {
  const others = (await runJobs(deps.db, job.run_id)).filter((other) => other.kind === "discover" && other._id !== job._id && ["pending", "running"].includes(other.status));
  if (others.length) return;
  const run = await getRun(deps.db, job.run_id);
  if (run) await afterDiscovery(deps, run);
}

/** One round of the mapping agent; the job queue is its checkpoint, so it survives the function limit. */
async function agentRoundJob(deps: OrchestratorDeps, job: Job) {
  const run = await getRun(deps.db, job.run_id);
  if (!run || !["mapping", "collecting"].includes(run.status)) return { skipped: true };
  const location = await getLocation(deps.db, run.location_id);
  const transport = externalTransport(deps.transport ?? publicOnlyTransport(fetchTransport));
  const round = Number(job.payload.round ?? 0);
  const result = await agentRound({
    db: deps.db, settings: deps.settings, transport, fetcher: new Fetcher(publicSourceTransport(transport)), location, today: run.today,
    log: logger("agent", { run_id: run._id, location_id: run.location_id }), model: deps.agentModel ?? deps.discoveryModel ?? null,
  }, round);
  if (result.next) await enqueue(deps.db, { kind: "agent_round", run_id: run._id, location_id: run.location_id, payload: { round: round + 1 }, dedupe_key: `agent:${run._id}:${round + 1}` });
  else await afterMapping(deps, run);
  return { round, ...result };
}

/**
 * The end of a map run: each source that finds its own address (meeting platforms, library
 * feeds) resolves it now and saves it, so editions only read. What it collects is thrown away.
 */
async function finishMap(deps: OrchestratorDeps, job: Job) {
  const run = await getRun(deps.db, job.run_id);
  if (!run || run.status !== "mapping") return { skipped: true };
  const location = await getLocation(deps.db, run.location_id);
  const transport = externalTransport(deps.transport ?? publicOnlyTransport(fetchTransport));
  const records = await collectableSources(deps.db, run.location_id, run.today, currentOptions().flow);
  const tasks = records.map(taskFor).filter((task) => LINK_READERS.includes(task.type) && connectorsOf(deps)[task.type]);
  const step = Number(job.payload.step ?? 0);
  const deadline = Date.now() + FINISH_MAP_MS;
  let index = step;
  for (; index < tasks.length && Date.now() < deadline; index += 1) {
    const task = tasks[index];
    const connector = connectorsOf(deps)[task.type];
    try {
      await connector.collect(task, {
        location, today: run.today, window: run.window, range: lookupRanges(windowOf(connector, task), run.today, null), transport, fetcher: new Fetcher(transport), settings: deps.settings, db: deps.db,
        linkCache: new MongoLinkCache(deps.db), model: deps.settings.aiLinkDiscovery ? deps.model : undefined, log: logger(`connector.${task.type}`, { source_id: task.source_id, run_id: run._id, location_id: run.location_id }),
      });
    } catch (error) {
      log.warn("map_address_failed", { run_id: run._id, source_id: task.source_id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (index < tasks.length) {
    await enqueue(deps.db, { kind: "finish_map", run_id: run._id, location_id: run.location_id, payload: { step: index }, dedupe_key: `finish_map:${run._id}:${index}` });
    return { more: true, checked: index - step };
  }
  await deps.db.collection(COLLECTIONS.locations).updateOne({ _id: location.id as never }, { $set: { source_map_at: now() }, $inc: { source_map_version: 1 } });
  const at = now();
  const categories = await categoryCoverage(deps.db, location.id);
  for (const row of categories.filter((category) => category.empty)) await recordDecision({ stage: "topic", actor: "rule", subject: `category:${row.category}`, decision: "empty", reason: `No source found for ${row.label}${row.built_in ? ` beyond ${row.built_in} national readers` : ""}` });
  await runs(deps.db).updateOne({ _id: run._id, status: "mapping" }, { $set: { status: "mapped", completed_at: at, updated_at: at, category_coverage: categories }, $push: { stage_transitions: { status: "mapped", by: "worker", at } } });
  await archiveStageLogs(deps, run._id, "mapping");
  log.info("run_mapped", { run_id: run._id, location_id: run.location_id, addresses: tasks.length, empty_categories: categories.filter((row) => row.empty).map((row) => row.category) });
  return { more: false, checked: index - step };
}

async function planSources(deps: OrchestratorDeps, job: Job) {
  const run = await getRun(deps.db, job.run_id);
  if (!run || run.status !== "collecting") return { skipped: true };
  if (run.planned !== false) return { already_planned: true };
  const flow = currentOptions().flow;
  const records = await collectableSources(deps.db, run.location_id, run.today, flow);
  const allowed = records.map(taskFor).filter((task) => connectorsOf(deps)[task.type] && (deps.settings.widerSources || !["hazards", "trending"].includes(task.type)));
  // The fastest and most useful first, so collection's time budget cuts the slow, quiet tail.
  const health = new Map((await locationHealth(deps.db, run.location_id)).map((row) => [row.source_id, row]));
  const order = (task: SourceTask) => { const row = health.get(task.source_id); return [row?.consecutive_empty ?? 0, row?.median_seconds ?? TYPICAL_SOURCE_SECONDS]; };
  const planned = [...allowed].sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]);
  // A sweep skips sites this run already reads. Topic sweeps run early; tracing needs the items, so it's last.
  const readHosts = [...new Set(planned.map((task) => hostOf(String(task.params?.url ?? ""))).filter(Boolean))];
  const sweeps = flow === "agentic" ? sweepTasks(currentOptions().topics, readHosts) : [];
  const tasks: SourceTask[] = [...sweeps.filter((task) => !task.params?.trace), ...planned, ...sweeps.filter((task) => task.params?.trace)];
  const collected = new Set(planned.map((task) => task.source_id));
  const all = await sourceMap(deps.db).find({ location_id: run.location_id }).toArray();
  const snapshot = all.map((record) => ({
    source_id: record.source_id, name: record.name, url: record.url, reader: record.reader, status: record.status, section: record.section, found_by: record.found_by.method, detail: record.found_by.detail,
    tier: record.source_tier ?? null, topics: record.topics ?? [], collected: collected.has(record.source_id),
    skip_reason: collected.has(record.source_id) ? null : record.link_only ? "link only: listed, never collected" : record.status === "proposed" ? "proposed: only agentic runs read it" : record.status === "dormant" ? `dormant until ${record.dormant_until ?? "retry"}` : record.status,
  }));
  const jobIds = new Map(tasks.map((task) => [task.source_id, randomUUID()]));
  if (!(await planRun(deps.db, run._id, tasks, jobIds))) return { already_planned: true };
  await setRun(deps.db, run._id, { source_snapshot: snapshot });
  logSourceMap(run.location_name, run._id, snapshot);
  await recordDecisions(snapshot.filter((item) => !item.collected).map((entry) => ({ stage: "plan" as const, actor: "rule" as const, subject: entry.url ?? entry.source_id, decision: "not_read", reason: entry.skip_reason, evidence: { name: entry.name } })));
  await enqueueMany(deps.db, tasks.map((task) => ({ _id: jobIds.get(task.source_id)!, kind: "collect_source" as const, run_id: run._id, location_id: run.location_id, payload: { task }, dedupe_key: `collect:${run._id}:${task.source_id}` })));
  if ((await getRun(deps.db, run._id))?.status === "cancelled") await cancelRunJobs(deps.db, run._id);
  log.info("run_planned", { run_id: run._id, location_id: run.location_id, sources: tasks.length });
  if (!tasks.length) await advanceToAuthoring(deps, run._id, run.location_id);
  return { sources: tasks.length };
}

/** A reader that keeps going past its budget is left behind, so one slow site can't hold a slot. */
async function withinSourceBudget(task: SourceTask, context: ConnectorContext, read: () => Promise<CollectedSource>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<CollectedSource>((resolve) => {
    timer = setTimeout(() => {
      context.fetcher.stop();
      resolve({ result: sourceResult(task.source_id, task.name, "partial", `Stopped after ${SOURCE_HARD_STOP_MS / 1000} s: the source took too long this run`), events: [] });
    }, SOURCE_HARD_STOP_MS);
  });
  const reading = read();
  reading.catch(() => undefined);
  try { return await Promise.race([reading, stopped]); }
  finally { clearTimeout(timer); }
}

async function collectSource(deps: OrchestratorDeps, job: Job) {
  const task = job.payload.task as SourceTask;
  const run = await getRun(deps.db, job.run_id);
  if (!run || run.status !== "collecting") return { skipped: true };
  const connector = connectorsOf(deps)[task.type];
  if (!connector) throw new PermanentJobError(`No reader for source type ${task.type}`);
  const location = await getLocation(deps.db, run.location_id);
  const transport = externalTransport(deps.transport ?? publicOnlyTransport(fetchTransport));
  const sourceLog = logger(`connector.${task.type}`, { source_id: task.source_id, run_id: run._id, location_id: run.location_id });
  const context: ConnectorContext = {
    location,
    today: run.today,
    window: run.window,
    range: lookupRanges(windowOf(connector, task), run.today, run.last_edition_day ?? null),
    transport,
    fetcher: new Fetcher(transport),
    settings: deps.settings,
    db: deps.db,
    linkCache: new MongoLinkCache(deps.db),
    readOnly: true,
    deadline: Date.now() + SOURCE_BUDGET_MS,
    agentModel: currentOptions().flow === "agentic" ? deps.agentLightModel ?? deps.agentModel ?? deps.lightModel ?? null : null,
    log: sourceLog,
  };
  const startedAt = Date.now();
  const manualId = task.params?.manual_link_id;
  const manual = typeof manualId === "string" ? await manualLinks(deps.db).findOne({ _id: manualId, location_id: location.id }) : null;
  if (typeof manualId === "string" && !manual) throw new PermanentJobError("Source link was removed before collection");
  const collected: CollectedSource = await withinSourceBudget(task, context, () => manual ? collectManualLink(manual, context) : connector.collect(task, context));
  logSourceCollected(location.name, run.source_snapshot?.find((source) => source.source_id === task.source_id)?.section ?? null, task, collected.result, collected.events.length, collected.dropped?.length ?? 0);
  const created = now();
  const base = { run_id: run._id, location_id: run.location_id, source_id: task.source_id, source_name: task.name, created_at: created };
  const skipped = [...(runContext()?.overrides ?? [])];
  const tier = task.params?.source_tier;
  const docs: CollectedItem[] = [
    ...collected.events.map((facts) => ({ ...base, _id: `${run._id}:${task.source_id}:${facts.source_event_id}`, title: facts.title, url: facts.source_url ?? null, event_date: facts.event_date ?? null,
      status: "collected" as const, reason: null, step: "reader", ...(skipped.length ? { access_overrides: skipped } : {}),
      facts: { ...facts, source_name: (facts.source_name as string | undefined) ?? task.name, ...(tier && !facts.source_tier ? { source_tier: tier } : {}) } })),
    ...(collected.dropped ?? []).map((item) => ({ ...base, _id: `${run._id}:${task.source_id}:x:${item.source_event_id}`, title: item.title, url: item.url, event_date: item.event_date ?? null,
      status: "dropped" as const, reason: item.reason.replace(/_/g, " "), step: "reader", facts: null })),
  ];
  // Readers that only count what they skip (older connectors) appear as counts.
  for (const [reason, count] of Object.entries(collected.result.skipped_unusable ?? {})) {
    if (count > 0 && !(collected.dropped ?? []).length) docs.push({ ...base, _id: `${run._id}:${task.source_id}:skip:${reason}`, title: `${count} item${count === 1 ? "" : "s"}`, url: null, event_date: null, status: "dropped", reason: reason.replace(/_/g, " "), step: "reader", facts: null });
  }
  await collectedItems(deps.db).deleteMany({ run_id: run._id, source_id: task.source_id });
  if (docs.length) await collectedItems(deps.db).insertMany(docs, { ordered: false }).catch((error: { code?: number }) => { if (error.code !== 11000) throw error; });
  const id = `${run._id}:${task.source_id}`;
  await deps.db.collection(COLLECTIONS.sourceResults).replaceOne({ _id: id as never }, { run_id: run._id, location_id: run.location_id, source_id: task.source_id, type: task.type, created_at: created, result: collected.result, event_count: collected.events.length }, { upsert: true });
  const health = await recordSourceHealth(deps.db, run.location_id, task.source_id, collected.result.status, collected.events.length, run.today, (Date.now() - startedAt) / 1000);
  const newest = collected.events.map((event) => String(event.event_date ?? "")).filter((day) => day && day <= run.today).sort().at(-1) ?? null;
  await recordSourceRun(deps.db, run.location_id, task.source_id, { status: collected.result.status, detail: collected.result.detail ?? null, found: collected.events.length + (collected.dropped?.length ?? 0), local: collected.events.filter((event) => !event.needs_locality).length, newestDay: newest, today: run.today });
  await updateSource(deps.db, run._id, task.source_id, {
    status: "completed",
    health: health.flag,
    result_status: collected.result.status,
    detail: collected.result.detail ?? null,
    event_count: collected.events.length,
    shortlisted: collected.events.length,
    link_discovery: collected.result.link_discovery ?? null,
    error: null,
  });
  await advanceToAuthoring(deps, run._id, run.location_id);
  return { status: collected.result.status, events: collected.events.length, dropped: collected.dropped?.length ?? 0 };
}

function authoringDeps(deps: OrchestratorDeps) {
  return { db: deps.db, model: deps.model, rankingModel: deps.rankingModel, lightModel: deps.lightModel, settings: deps.settings, log: deps.log ?? logger("authoring"), transport: deps.transport };
}

async function authorStart(deps: OrchestratorDeps, job: Job) {
  const run = await getRun(deps.db, job.run_id);
  if (!run || run.status !== "authoring") return { skipped: true };
  const results = await deps.db.collection(COLLECTIONS.sourceResults).find({ run_id: run._id }).sort({ _id: 1 }).toArray();
  const resultsById = new Map(results.map((doc) => [doc.source_id, doc.result]));
  const sourceResults = run.sources.map((source) => resultsById.get(source.source_id) ?? {
    source_id: source.source_id, name: source.name, status: source.result_status ?? "failed", detail: source.detail ?? source.error ?? "Source was not collected", events: 0,
  });
  const location = await getLocation(deps.db, run.location_id);
  const started = await startAuthoring(authoringDeps(deps), { location, runId: run._id, today: run.today, window: run.window, sourceResults, overrides: run.overrides });
  if (!run.draft_id) await setRun(deps.db, run._id, { draft_id: started.id });
  if ((await getRun(deps.db, run._id))?.status !== "authoring") return { cancelled: true };
  if (started.sections.length) {
    for (const section of started.sections) await enqueue(deps.db, { kind: "author_rank", run_id: run._id, location_id: run.location_id, payload: { draft_id: started.id, section }, dedupe_key: `author_rank:${run._id}:${section}` });
  } else {
    await enqueue(deps.db, { kind: "author_story", run_id: run._id, location_id: run.location_id, payload: { draft_id: started.id, step: 0 }, dedupe_key: `author_story:${run._id}:0` });
  }
  return { draft_id: started.id, sections: started.sections };
}

async function authorRank(deps: OrchestratorDeps, job: Job) {
  const draftId = String(job.payload.draft_id);
  const result = await rankSection(authoringDeps(deps), draftId, String(job.payload.section));
  if ((await getRun(deps.db, job.run_id))?.status !== "authoring") return { cancelled: true };
  if (result.ready) await enqueue(deps.db, { kind: "author_story", run_id: job.run_id, location_id: job.location_id, payload: { draft_id: draftId, step: 0 }, dedupe_key: `author_story:${job.run_id}:0` });
  return { section: job.payload.section, ready: result.ready };
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
  const finished = await finishAuthoring(authoringDeps(deps), draftId).catch(async (error: unknown) => {
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
  const readerFolder = await publishToReader(deps.db, deps.store, edition);
  // Comparison and exploration runs print, but leave the no-repeat ledger alone.
  if (currentOptions().count_history) await recordPublished(deps.db, run.today, edition, new Map(Object.entries((finished as { tokens?: Record<string, string[]> }).tokens ?? {})));
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
      reader_folder: readerFolder,
      artifacts,
    },
  });
  await archiveStageLogs(deps, run._id, "finishing");
  await writeEditionMap(deps.db, run._id).catch((error) => log.warn("edition_map_failed", { run_id: run._id, error: String(error) }));
  log.info("run_published", { run_id: run._id, location_id: run.location_id, status: "published", by: "worker", edition_id: edition.id, items: edition.items.length, held, reader_folder: readerFolder });
  return { edition_id: edition.id, items: edition.items.length, held, reader_folder: readerFolder };
}

export async function executeJob(deps: OrchestratorDeps, job: Job): Promise<Record<string, unknown>> {
  const run = await getRun(deps.db, job.run_id);
  if (!run || !stageKinds(run).includes(job.kind)) return { skipped: true };
  if (deps.runtimeForRun) deps = await deps.runtimeForRun(run);
  return withRunContext({ db: deps.db, runId: run._id, locationId: run.location_id, sponsorId: run.execution?.sponsorId, credentialVersion: run.execution?.credentialVersion, options: run.options ?? LEGACY_OPTIONS }, () => withModelUsageContext({ location_id: run.location_id, run_id: run._id, sponsor_id: run.execution?.sponsorId, credential_version: run.execution?.credentialVersion }, () => {
    switch (job.kind) {
      case "discover": return discoverJob(deps, job);
      case "agent_round": return agentRoundJob(deps, job);
      case "finish_map": return finishMap(deps, job);
      case "plan_sources": return planSources(deps, job);
      case "collect_source": return collectSource(deps, job);
      case "author_start": return authorStart(deps, job);
      case "author_rank": return authorRank(deps, job);
      case "author_story": return authorStory(deps, job);
      case "author_finish": return authorFinish(deps, job);
    }
  }));
}

async function finalFailure(deps: OrchestratorDeps, job: Job, error: string) {
  const run = await getRun(deps.db, job.run_id);
  if (!run || !stageKinds(run).includes(job.kind)) return;
  if (job.kind === "collect_source") await sourceFailed(deps, job, error);
  // A failed discovery method keeps the sources it found before; planning goes ahead.
  else if (job.kind === "discover") await planWhenDiscovered(deps, job);
  // A failed agent round keeps what it found; the run goes ahead.
  else if (job.kind === "agent_round") await afterMapping(deps, run);
  else await failRun(deps.db, job.run_id, `${job.kind} failed: ${error}`);
}

/** Past collection's budget: sources not yet started are marked not reached, and writing starts with what's in. */
async function closeCollectionWhenOutOfTime(deps: OrchestratorDeps, run: PipelineRun) {
  const budget = deps.settings.collectBudgetSeconds;
  if (!budget || run.status !== "collecting" || !run.collect_started_at || now() < run.collect_started_at + budget) return false;
  const reason = `Collection reached its ${Math.round(budget / 60)} minute budget before this source's turn`;
  const waiting = await cancelPending(deps.db, run._id, "collect_source", reason);
  await markNotReached(deps.db, run._id, waiting.map((job) => (job.payload.task as SourceTask).source_id), reason);
  log.info("collection_out_of_time", { run_id: run._id, location_id: run.location_id, not_reached: waiting.length });
  await advanceToAuthoring(deps, run._id, run.location_id);
  return true;
}

/** Claim one job from the oldest run with work; overlap within a run is up to the job's kind. */
async function claimNext(deps: OrchestratorDeps, options: { jobId?: string; kinds?: readonly JobKind[] }): Promise<{ job: Job; runLease: Lease | null } | null> {
  for (const run of await workableRuns(deps.db)) {
    if (await closeCollectionWhenOutOfTime(deps, run)) continue;
    const kinds = stageKinds(run).filter((kind) => !options.kinds || options.kinds.includes(kind));
    const parallel = kinds.filter(isParallelKind), serial = kinds.filter((kind) => !isParallelKind(kind));
    const job = parallel.length ? await claim(deps.db, parallel, options.jobId, run._id) : null;
    if (job) {
      if (job.kind === "collect_source" && !run.collect_started_at) await runs(deps.db).updateOne({ _id: run._id, collect_started_at: { $exists: false } }, { $set: { collect_started_at: now() } });
      return { job, runLease: null };
    }
    if (!serial.length) continue;
    const runLease = await acquireRunLease(deps.db, run._id);
    if (!runLease) continue;
    const next = await claim(deps.db, serial, options.jobId, run._id);
    if (next) return { job: next, runLease };
    await releaseLease(deps.db, runLease);
  }
  return null;
}

/** Take a worker slot, then claim and run one job; returns false when there's nothing to do or no free slot. */
export async function runOne(deps: OrchestratorDeps, options: { jobId?: string; kinds?: readonly JobKind[] } = {}): Promise<boolean> {
  const slot = await acquireSlot(deps.db, deps.settings.collectConcurrency);
  if (!slot) return false;
  try {
    for (const expired of await recoverExpired(deps.db)) await finalFailure(deps, expired, expired.error ?? "Worker lease expired");
    const claimed = await claimNext(deps, options);
    if (!claimed) return false;
    const { job, runLease } = claimed;
    const leases = runLease ? [slot, runLease] : [slot];
    let renewal: Promise<void> = Promise.resolve();
    let leaseError: unknown;
    const heartbeat = setInterval(() => {
      renewal = renewal.then(() => renewJob(deps.db, leases, job)).catch((error: unknown) => {
        leaseError = error;
        log.error("worker_lease_renewal_failed", { job_id: job._id, error: String(error) });
      });
    }, 60_000);
    try {
      return await runClaimedJob(deps, job, () => { if (leaseError) throw leaseError; });
    } finally {
      clearInterval(heartbeat);
      await renewal;
      if (runLease) await releaseLease(deps.db, runLease);
    }
  } finally {
    await releaseLease(deps.db, slot);
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
        if (job.kind === "discover") await planWhenDiscovered(deps, job);
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
        if (error instanceof ExecutionBlocked) {
          await blockExecution(deps.db, job.run_id, safeError(error));
          await deps.db.collection<Job>(COLLECTIONS.jobs).updateOne(
            { _id: job._id, claim_token: job.claim_token },
            { $set: { status: "pending", lease_until: null, claim_token: null, error: safeError(error) }, $inc: { attempts: -1 } },
          );
          log.warn("run_credentials_paused", { run_id: job.run_id, reason: safeError(error) });
          return;
        }
        const detail = safeError(error);
        log.error("job_execution_failed", { kind: job.kind, job_id: job._id, run_id: job.run_id, error: detail });
        const outcome = await fail(deps.db, job, error, !(error instanceof PermanentJobError));
        if ((await getRun(deps.db, job.run_id))?.status === "cancelled") {
          await cancelRunJobs(deps.db, job.run_id);
        }
        if (outcome === "failed") await finalFailure(deps, job, safeError(error));
      }
    });
  } catch (error) {
    executionFailed = true;
    executionError = error;
  }
  try {
    await appendJobLog(deps.db, job, records.map((record) => JSON.stringify(record)));
    if (!job.log_file) await setJobLog(deps.db, job._id, `${MONGO_LOG}${job._id}`, null);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log.error("job_log_upload_failed", { kind: job.kind, job_id: job._id, run_id: job.run_id, error: detail });
    await setJobLog(deps.db, job._id, job.log_file, detail);
  }
  if (executionFailed) throw executionError;
  return true;
}

/**
 * One scheduler tick (the local poller): record a heartbeat, recover interrupted jobs, then fill
 * the worker slots until the queue is empty or the start budget is spent. Jobs already started
 * run to completion.
 */
export async function tick(deps: OrchestratorDeps, options: { budgetMs?: number; kinds?: readonly JobKind[] } = {}) {
  const budgetMs = options.budgetMs ?? 30_000;
  const deadline = Date.now() + budgetMs;
  await deps.db.collection(COLLECTIONS.heartbeat).updateOne({ _id: "scheduler" as never }, { $set: { last_tick_at: now() } }, { upsert: true });
  await expireOverdueRuns(deps.db, deps.settings.runTimeoutSeconds);
  let executed = 0;
  const worker = async () => {
    while (Date.now() < deadline && (await runOne(deps, { kinds: options.kinds }))) executed += 1;
  };
  await Promise.all(Array.from({ length: deps.settings.collectConcurrency }, worker));
  await deps.db.collection(COLLECTIONS.heartbeat).updateOne({ _id: "scheduler" as never }, { $set: { last_tick_finished_at: now(), last_tick_executed: executed } });
  return { executed };
}
