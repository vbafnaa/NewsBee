import type { Db } from "mongodb";
import { loadSettings } from "../core/config";
import { logger } from "../core/log";
import { acquireWorker, releaseWorker, renewWorkerLease } from "../orchestration/jobs";
import { readerFolder, writeReaderDirectory } from "../orchestration/publish";
import { removeLocationFromOutputChannels } from "../orchestration/output-channels";
import { artifactSegment, type ArtifactStore } from "../storage/artifacts";
import { COLLECTIONS } from "../storage/mongo";
import { channelArtifactStore } from "../storage/mongo-channel-artifacts";
import { assertLocationIdle, getLocation, LocationBusy, removeLocationRecords } from "./locations";

type OwnedFile = { parent: string; name: string };
type RemovalPlan = {
  files: OwnedFile[];
  editionIds: string[];
  kind: ArtifactStore["kind"];
  readerRoot: string;
  pipelineRoot: string;
};
type RemovalDocument = { _id: string; removal?: { started_at: number; plan?: RemovalPlan; error?: string } };
const log = logger("communities.removal");

async function existingFolder(store: ArtifactStore, root: string, ...segments: string[]) {
  let folder: string | null = root;
  for (const name of segments) {
    if (!folder) return null;
    folder = await store.findFolder(folder, artifactSegment(name));
  }
  return folder;
}

async function planRemoval(db: Db, store: ArtifactStore, id: string): Promise<RemovalPlan> {
  artifactSegment(id);
  const readerRoot = await readerFolder(db);
  const configured = loadSettings().pipelineDriveFolderId;
  if (store.kind === "drive" && !configured) throw new Error("NEWSBEE_PIPELINE_DRIVE_FOLDER_ID is not configured");
  const pipelineRoot = configured ?? "pipeline";
  const editions = await db.collection(COLLECTIONS.editions).find({ location_id: id }, { projection: { id: 1 } }).toArray();
  const runs = await db.collection<{ _id: string; location_id: string; edition_id?: string; draft_id?: string }>(COLLECTIONS.runs).find({ location_id: id }).toArray();
  const videos = await db.collection<{ _id: string; location_id: string; story_id: string }>(COLLECTIONS.videoJobs)
    .find({ location_id: id }).project<{ _id: string; story_id: string }>({ _id: 1, story_id: 1 }).toArray();
  const editionIds = [...new Set([...editions.map((edition) => edition.id), ...runs.flatMap((run) => [run.edition_id, run.draft_id])].filter((value): value is string => typeof value === "string"))];
  for (const value of [...editionIds, ...runs.map((run) => run._id)]) artifactSegment(value);
  if (editionIds.includes("locations")) throw new Error("Refusing to remove the shared locations.json directory as an edition");
  // An ID collision must never let this location delete another location's output.
  if (await db.collection(COLLECTIONS.editions).countDocuments({ id: { $in: editionIds }, location_id: { $ne: id } }) ||
    await db.collection(COLLECTIONS.runs).countDocuments({ location_id: { $ne: id }, $or: [{ edition_id: { $in: editionIds } }, { draft_id: { $in: editionIds } }] })) {
    throw new Error("Edition ownership is ambiguous; no files were removed. Resolve the conflicting records before retrying cleanup.");
  }
  const files: OwnedFile[] = [];
  const add = (parent: string | null, name: string) => {
    artifactSegment(name);
    if (parent) files.push({ parent, name });
  };
  const readerStore = channelArtifactStore(db, store, readerRoot);
  const readerFiles = await readerStore.list(readerRoot);
  for (const editionId of editionIds) {
    const name = `${editionId}.json`;
    for (const file of readerFiles.filter((file) => file.name === name)) {
      const contents = await readerStore.readJson<{ location_id?: string }>(file.id);
      if (contents.location_id !== id) throw new Error(`Reader file ownership does not match ${id}: ${name}`);
    }
    add(readerRoot, name);
  }
  for (const kind of ["editions", "email-previews", "sources"] as const) {
    const folder = await existingFolder(store, pipelineRoot, ".newsbee-pipeline", kind, id);
    if (kind === "sources") {
      for (const run of runs) add(folder, `${run._id}.json`);
    } else {
      for (const editionId of editionIds) {
        if (kind === "editions") add(folder, `${editionId}.json`);
        else { add(folder, `${editionId}.html`); add(folder, `${editionId}.txt`); }
      }
    }
  }
  for (const run of runs) {
    const folder = await existingFolder(store, pipelineRoot, ".newsbee-pipeline", "logs", run._id);
    const jobs = await db.collection<{ _id: string; location_id: string; run_id: string }>(COLLECTIONS.jobs).find({ location_id: id, run_id: run._id }).toArray();
    for (const job of jobs) add(folder, `${artifactSegment(job._id)}.jsonl`);
    const present = folder ? new Set((await store.list(folder)).map((file) => file.name)) : new Set<string>();
    for (const stage of ["mapping", "collecting", "authoring", "finishing"]) if (present.has(`${stage}.jsonl`)) add(folder, `${stage}.jsonl`);
  }
  for (const storyId of new Set(videos.map((video) => video.story_id))) {
    const folder = await existingFolder(store, pipelineRoot, ".newsbee-pipeline", "video-production", id, storyId);
    for (const video of videos.filter((item) => item.story_id === storyId)) add(folder, `${video._id}.mp4`);
  }
  return { files, editionIds, kind: store.kind, readerRoot, pipelineRoot };
}

/** Keep the profile and durable file manifest until every cleanup step succeeds. */
export async function removeLocation(db: Db, store: ArtifactStore, id: string) {
  await getLocation(db, id, true);
  const token = await acquireWorker(db);
  if (!token) throw new LocationBusy("A pipeline worker or cleanup is still running; wait for it to finish, then retry removal");
  const locations = db.collection<RemovalDocument>(COLLECTIONS.locations);
  let stage = "checking active runs";
  let marked = false;
  try {
    await getLocation(db, id, true);
    await assertLocationIdle(db, id);
    await locations.updateOne({ _id: id, removal: { $exists: false } }, { $set: { removal: { started_at: Date.now() / 1000 } } });
    marked = true;
    await assertLocationIdle(db, id);
    stage = "planning owned-file cleanup";
    let plan = (await locations.findOne({ _id: id }))?.removal?.plan;
    if (!plan) {
      plan = await planRemoval(db, store, id);
      await locations.updateOne({ _id: id }, { $set: { "removal.plan": plan } });
    }
    if (plan.kind !== store.kind || plan.readerRoot !== await readerFolder(db) ||
      plan.pipelineRoot !== (loadSettings().pipelineDriveFolderId ?? "pipeline")) {
      throw new Error("Artifact storage configuration changed since removal began; restore it before retrying cleanup");
    }
    stage = "updating the reader directory";
    await renewWorkerLease(db, token);
    await writeReaderDirectory(db, store);
    await removeLocationFromOutputChannels(db, store, id);
    let removedFiles = 0;
    stage = "removing generated files";
    for (const [index, file] of plan.files.entries()) {
      await renewWorkerLease(db, token);
      removedFiles += await channelArtifactStore(db, store, file.parent).removeFile(file.parent, file.name);
      await locations.updateOne({ _id: id }, { $set: { "removal.plan.files": plan.files.slice(index + 1) } });
    }
    stage = "removing location pipeline records";
    await renewWorkerLease(db, token);
    const removed = await removeLocationRecords(db, id, plan.editionIds);
    stage = "finalizing the reader directory";
    await writeReaderDirectory(db, store);
    const deleted = await locations.deleteOne({ _id: id });
    if (!deleted.deletedCount) throw new Error("Location changed during cleanup; reload to verify its state");
    log.info("location_removed", { location_id: id, removed, removed_files: removedFiles });
    return { removed: { ...removed, locations: 1 }, removed_files: removedFiles };
  } catch (cause) {
    if (!marked) throw cause;
    const detail = `Removal incomplete while ${stage}: ${cause instanceof Error ? cause.message : String(cause)}. Some data or files may already be removed. This location is retained for cleanup only; retry removal in Location details.`;
    log.error("location_removal_incomplete", { location_id: id, detail });
    try {
      await locations.updateOne({ _id: id }, { $set: { "removal.error": detail } });
    } catch (recordError) {
      log.error("location_removal_error_record_failed", { location_id: id, error: String(recordError) });
      throw new Error(`${detail} Could not save the error status: ${String(recordError)}`);
    }
    throw new Error(detail);
  } finally {
    await releaseWorker(db, token);
  }
}
