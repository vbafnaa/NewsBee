import type { Db } from "mongodb";
import { logger } from "../core/log";
import { COLLECTIONS } from "../storage/mongo";
import { runJobs, type Job } from "./jobs";
import { getRun, RunConflict, runs, updateSource, type RunStatus } from "./runs";
import { getLocation } from "../communities/locations";
import { mapJobIsPast } from "./map-stage-availability";

const stageFor = (job: Job, mapRun: boolean): RunStatus => mapRun ? "mapping" : ["discover", "plan_sources", "collect_source"].includes(job.kind) ? "collecting"
  : job.kind === "author_finish" ? "finishing" : "authoring";
const log = logger("retry-step");

/** Reopen only the selected failed step; completed jobs and authored work remain in this run. */
export async function retryFailedStep(db: Db, runId: string, jobId: string, by: string) {
  const run = await getRun(db, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  await getLocation(db, run.location_id);
  const jobs = await runJobs(db, runId);
  const job = jobs.find((item) => item._id === jobId);
  if (!job || !["failed", "cancelled"].includes(job.status)) {
    throw new RunConflict("Only a failed or interrupted step can be retried");
  }
  const stage = stageFor(job, run.kind === "map");
  if (run.kind === "map" && mapJobIsPast(job.kind, jobs)) {
    throw new RunConflict("This source-map run has moved past that step; restart to repeat discovery or review");
  }
  if (["image_story", "stock_story"].includes(job.kind) && run.draft_id) {
    const draft = await db.collection(COLLECTIONS.editions).findOne({ id: run.draft_id });
    if (Number(draft?.image_revision ?? 0) !== Number(job.payload.revision ?? 0)) throw new RunConflict("This image step belongs to an earlier draft; resume the current image stage instead");
  }
  const lastProcessingStage = run.stage_transitions?.filter((transition) =>
    ["mapping", "collecting", "authoring", "finishing", "publishing"].includes(transition.status)).at(-1)?.status;
  if (run.status === "failed") {
    if ((lastProcessingStage === "publishing" ? "finishing" : lastProcessingStage) !== stage) {
      throw new RunConflict("This step belongs to an earlier stage; start a new run instead");
    }
  } else if (!(run.status === stage && (stage !== "collecting" || !run.draft_id)) &&
    !(stage === "collecting" && !run.draft_id && run.status === "awaiting_authoring") &&
    !(["image_story", "stock_story"].includes(job.kind) && run.status === "awaiting_finish")) {
    throw new RunConflict("This run has moved past that step; start a new run instead");
  }
  if ((await db.collection<Job>(COLLECTIONS.jobs).countDocuments({ run_id: runId, status: "running" })) > 0) {
    throw new RunConflict("Wait for the current job to finish before retrying a failed step");
  }
  const source = job.kind === "collect_source" ? run.sources.find((item) => item.job_id === jobId) : undefined;
  if (job.kind === "collect_source" && !source) throw new RunConflict("The failed source no longer belongs to this run");
  if (stage === "finishing" && !run.draft_id) throw new RunConflict("The authoring draft is missing; start a new run instead");
  if (run.status === "failed") {
    const other = await runs(db).findOne({ location_id: run.location_id, _id: { $ne: runId }, status: { $in: [
      "mapping", "collecting", "awaiting_authoring", "authoring", "awaiting_finish", "finishing", "publishing",
    ] } });
    if (other) throw new RunConflict("Another run is already active for this location");
  }
  const timestamp = Date.now() / 1000;
  if (run.status !== stage) {
    const changed = await runs(db).updateOne(
      { _id: runId, status: run.status },
      { $set: { status: stage, error: null, completed_at: null, updated_at: timestamp, stage_started_at: timestamp },
        $push: { stage_transitions: { status: stage, by, at: timestamp } } },
    );
    if (changed.modifiedCount !== 1) throw new RunConflict("The run changed while retrying; reload and try again");
  }
  if (source) await updateSource(db, runId, source.source_id, {
    status: "pending", result_status: null, detail: null, error: null, event_count: 0, shortlisted: 0,
  });
  const updated = await db.collection<Job>(COLLECTIONS.jobs).updateOne(
    { _id: jobId, run_id: runId, status: job.status },
    { $set: { status: "pending", attempts: 0, rate_limit_retries: 0, available_at: timestamp,
      started_at: null, completed_at: null, lease_until: null, claim_token: null, error: null, result: null,
      dispatch_error: null, dispatch_error_at: null } },
  );
  if (updated.modifiedCount !== 1) throw new RunConflict("The step changed while retrying; reload and try again");
  log.info("failed_step_retried", { run_id: runId, job_id: jobId, kind: job.kind, by });
  return { run_id: runId, job_id: jobId, stage };
}
