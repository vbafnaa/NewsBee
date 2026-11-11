import type { Db } from "mongodb";
import { assertGlobalAdmission } from "../accounts/execution";
import { getLocation } from "../communities/locations";
import { COLLECTIONS } from "../storage/mongo";
import { enqueue, runJobs, type Job } from "./jobs";
import { getRun, RunConflict, runs } from "./runs";
import { availableMapStages, type MapStage } from "./map-stage-availability";

export type { MapStage } from "./map-stage-availability";

/** Continue a failed map run using sources already discovered, without replaying collection. */
export async function triggerMapStage(db: Db, runId: string, stage: MapStage, by: string) {
  if (stage !== "review" && stage !== "save") throw new RunConflict("Unknown source-map stage");
  const run = await getRun(db, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  await getLocation(db, run.location_id);
  const jobs = await runJobs(db, runId);
  if (!availableMapStages(run, jobs).includes(stage)) throw new RunConflict(`Cannot continue to ${stage} from this run`);
  await assertGlobalAdmission(db, runId);
  const at = Date.now() / 1000;
  const changed = await runs(db).updateOne({ _id: runId, kind: "map", status: "failed" }, {
    $set: { status: "mapping", error: null, completed_at: null, updated_at: at, stage_started_at: at },
    $push: { stage_transitions: { status: "mapping", by, at } },
  });
  if (changed.modifiedCount !== 1) throw new RunConflict("The run changed while continuing; reload and try again");
  if (stage === "review") {
    await enqueue(db, { kind: "review_map", run_id: runId, location_id: run.location_id, payload: { step: 0 }, dedupe_key: `review_map:${runId}:0` });
  } else {
    const save = jobs.find((job) => job.kind === "finish_map");
    if (save) {
      const reset = await db.collection<Job>(COLLECTIONS.jobs).updateOne({ _id: save._id, status: save.status }, {
        $set: { status: "pending", attempts: 0, rate_limit_retries: 0, available_at: at, started_at: null, completed_at: null,
          lease_until: null, claim_token: null, error: null, result: null, dispatch_error: null, dispatch_error_at: null },
      });
      if (reset.modifiedCount !== 1) throw new RunConflict("The address-saving job changed; reload and try again");
    } else {
      await enqueue(db, { kind: "finish_map", run_id: runId, location_id: run.location_id, payload: { step: 0 }, dedupe_key: `finish_map:${runId}:0` });
    }
  }
  return { run_id: runId, stage };
}
