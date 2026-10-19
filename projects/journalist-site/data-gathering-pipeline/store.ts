import { randomUUID } from "node:crypto";
import type { Filter } from "mongodb";
import { getMongoDatabase } from "@/auth";
import type { ConfiguredSource } from "@/auth";
import type { PipelineRun, PipelineStage, StageRecord } from "./types";

const RUNS = "data_gathering_runs";
const INGESTION_STATE = "source_ingestion_state";

export async function createSourceRun(
  channelId: string,
  driveFolderId: string,
  source: ConfiguredSource,
  locationId: string,
  locationName: string,
) {
  const collection = (await getMongoDatabase()).collection<PipelineRun>(RUNS);
  const existing = await collection.findOne({
    channel_id: channelId,
    kind: "source",
    source_id: source.id,
    location_id: locationId,
    drive_folder_id: driveFolderId,
    status: { $in: ["ready", "running", "failed"] },
  }, { sort: { created_at: -1 } });
  if (existing) return existing;

  const now = new Date();
  const today = new Date();
  const start = new Date(today);
  const end = new Date(today);
  if (source.kind === "library") {
    start.setDate(start.getDate() + 1);
    end.setDate(start.getDate() + 7);
  } else if (source.kind === "state-newsroom") {
    start.setDate(start.getDate() - 14);
  } else {
    start.setDate(start.getDate() - 7);
    end.setDate(end.getDate() + 7);
  }
  const run: PipelineRun = {
    _id: randomUUID(),
    channel_id: channelId,
    drive_folder_id: driveFolderId,
    kind: "source",
    source_id: source.id,
    source_name: source.name,
    source_kind: source.kind,
    source_config: source,
    region: source.region,
    location_id: locationId,
    location_name: locationName,
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
    status: "ready",
    current_stage: "gather",
    stages: { gather: { status: "pending" }, normalize: { status: "pending" } },
    created_at: now,
    updated_at: now,
  };
  await collection.insertOne(run);
  return run;
}

export async function createEditionRun(
  channelId: string,
  driveFolderId: string,
  locationId: string,
  locationName: string,
  sourceRunIds: string[],
  periodStart: string,
  periodEnd: string,
) {
  const now = new Date();
  const run: PipelineRun = {
    _id: randomUUID(),
    channel_id: channelId,
    drive_folder_id: driveFolderId,
    kind: "edition",
    location_id: locationId,
    location_name: locationName,
    period_start: periodStart,
    period_end: periodEnd,
    source_run_ids: sourceRunIds,
    status: "ready",
    current_stage: "rank",
    stages: {
      rank: { status: "pending" },
      write: { status: "pending" },
      publish: { status: "pending" },
    },
    created_at: now,
    updated_at: now,
  };
  await (await getMongoDatabase()).collection<PipelineRun>(RUNS).insertOne(run);
  return run;
}

export async function getRun(runId: string, channelId: string) {
  return (await getMongoDatabase())
    .collection<PipelineRun>(RUNS)
    .findOne({ _id: runId, channel_id: channelId });
}

export async function listRuns(channelId: string, limit = 50) {
  return (await getMongoDatabase())
    .collection<PipelineRun>(RUNS)
    .find({ channel_id: channelId })
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
}

export async function getCompletedSourceRunsBySource(
  channelId: string,
  locationId: string,
  sourceIds: string[],
) {
  return (await getMongoDatabase())
    .collection<PipelineRun>(RUNS)
    .find({
      channel_id: channelId,
      kind: "source",
      location_id: locationId,
      source_id: { $in: sourceIds },
      "stages.normalize.status": "completed",
    })
    .sort({ created_at: -1 })
    .toArray();
}

export async function getCompletedSourceRunsById(
  channelId: string,
  locationId: string,
  runIds: string[],
) {
  return (await getMongoDatabase())
    .collection<PipelineRun>(RUNS)
    .find({
      channel_id: channelId,
      kind: "source",
      location_id: locationId,
      _id: { $in: runIds },
      "stages.normalize.status": "completed",
    })
    .sort({ created_at: -1 })
    .toArray();
}

export async function claimStage(runId: string, channelId: string, stage: PipelineStage) {
  const collection = (await getMongoDatabase()).collection<PipelineRun>(RUNS);
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
  const claimable: Filter<PipelineRun> = {
    $or: [
      { status: { $ne: "running" as const } },
      { status: "running", stage_started_at: { $lt: staleBefore } },
    ],
  };
  const run = await collection.findOne({
    _id: runId,
    channel_id: channelId,
    current_stage: stage,
    ...claimable,
    [`stages.${stage}.status`]: { $ne: "completed" },
  });
  if (!run) return null;
  const now = new Date();
  const result = await collection.updateOne(
    { _id: runId, channel_id: channelId, current_stage: stage, ...claimable },
    {
      $set: {
        status: "running",
        stage_started_at: now,
        updated_at: now,
        [`stages.${stage}.status`]: "running",
        [`stages.${stage}.started_at`]: now,
      },
      $unset: { [`stages.${stage}.error`]: "", [`stages.${stage}.completed_at`]: "" },
    },
  );
  return result.modifiedCount === 1 ? run : null;
}

export async function finishStage(
  run: PipelineRun,
  stage: PipelineStage,
  nextStage: PipelineStage | null,
  driveFileId: string,
) {
  const now = new Date();
  const stageRecord: StageRecord = {
    ...run.stages[stage],
    status: "completed",
    completed_at: now,
    drive_file_id: driveFileId,
  };
  const stages = { ...run.stages, [stage]: stageRecord };
  await (await getMongoDatabase()).collection<PipelineRun>(RUNS).updateOne(
    { _id: run._id, channel_id: run.channel_id },
    {
      $set: {
        stages,
        current_stage: nextStage,
        status: nextStage ? "ready" : "completed",
        updated_at: now,
      },
      $unset: { stage_started_at: "" },
    },
  );

  if (run.kind === "source" && (stage === "gather" || stage === "normalize") && run.source_id) {
    const collection = (await getMongoDatabase()).collection<{ _id: string }>(INGESTION_STATE);
    const sourceKey = `${run.channel_id}:${run.source_id}:${run.location_id}`;
    const updates = stage === "gather"
      ? {
          channel_id: run.channel_id,
          source_id: run.source_id,
          location_id: run.location_id,
          last_ingested_at: now,
          period_start: run.period_start,
          period_end: run.period_end,
          last_run_id: run._id,
          status: "gathered",
        }
      : { status: "normalized", normalized_at: now, last_run_id: run._id };
    await collection.updateOne(
      { _id: sourceKey },
      { $set: updates },
      { upsert: stage === "gather" },
    );
  }
}

export async function failStage(run: PipelineRun, stage: PipelineStage, error: unknown) {
  const now = new Date();
  const detail = error instanceof Error ? error.message : String(error);
  await (await getMongoDatabase()).collection<PipelineRun>(RUNS).updateOne(
    { _id: run._id, channel_id: run.channel_id },
    {
      $set: {
        status: "failed",
        current_stage: stage,
        updated_at: now,
        [`stages.${stage}.status`]: "failed",
        [`stages.${stage}.completed_at`]: now,
        [`stages.${stage}.error`]: detail.slice(0, 1000),
      },
      $unset: { stage_started_at: "" },
    },
  );
}
