import { BSON } from "mongodb";
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { isMongoChannelFolderId, resolveReaderDriveFolderId } from "../../../../shared/reader-folder";
import { readerFolder } from "../orchestration/publish";
import { localDriveRoot } from "./artifacts";
import { DriveArtifacts } from "./drive";
import { BACKUP_STAGING_COLLECTIONS } from "./site-backup-upload";
import { BACKUP_MAX_BYTES } from "../../lib/site-backup-transfer";
import { repositoryRoot } from "../core/config";
import { safeError } from "../core/redaction";
import { ensurePublicationGenerationAdmissionIndex } from "../publications/generation-status";
import {
  MaintenanceError, maintenanceState, requireRestoreOwner, restoreDatabase, restoreEvent, restoreReserved,
  RESTORE_STATE, type Maintenance, type RestoreOwner,
} from "../../../../shared/restore-maintenance";

export const SITE_BACKUP_FORMAT = "newsbee-site-backup";
export const SITE_BACKUP_VERSION = 1;
export const SITE_BACKUP_MAX_BYTES = BACKUP_MAX_BYTES;
const MAX_FILES = 50_000;
const MAX_DOCUMENTS = 1_000_000;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,200}$/;
const TRANSFER_CONCURRENCY = 6;

export type BackupOptions = { signal?: AbortSignal; onProgress?: (message: string) => void };

function progress(options: BackupOptions, message: string) {
  options.signal?.throwIfAborted();
  options.onProgress?.(message);
}

function includedCollection(name: string) {
  return !name.startsWith("system.") && !BACKUP_STAGING_COLLECTIONS.includes(name) && !restoreReserved(name);
}

function validBase64(value: string) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length % 4 === 0 && !/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding));
}

export type BackupFile = { path: string; contentType: string; data: string };
export type BackupRoot = { name: string; files: BackupFile[] };
export type SiteBackup = {
  format: typeof SITE_BACKUP_FORMAT;
  version: typeof SITE_BACKUP_VERSION;
  createdAt: string;
  database: { collections: { name: string; documents: string[]; indexes?: string[] }[] };
  artifacts: { roots: BackupRoot[] };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePath(value: string) {
  const parts = value.split("/");
  if (!parts.length || parts.some((part) => !SAFE_NAME.test(part) || part === "." || part === "..")) {
    throw new Error("Archive contains an unsafe artifact path");
  }
  return parts;
}

/** Validate structure and BSON payloads before any destructive operation begins. */
export function validateSiteBackup(value: unknown): SiteBackup {
  if (!isRecord(value) || value.format !== SITE_BACKUP_FORMAT || value.version !== SITE_BACKUP_VERSION) {
    throw new Error("Unsupported backup format or version");
  }
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("Backup has an invalid creation date");
  }
  const database = value.database;
  const artifacts = value.artifacts;
  if (!isRecord(database) || !Array.isArray(database.collections) || !isRecord(artifacts) || !Array.isArray(artifacts.roots)) {
    throw new Error("Backup is missing database collections or artifact roots");
  }
  const collections = database.collections;
  const roots = artifacts.roots;
  let documentCount = 0;
  const collectionNames = new Set<string>();
  const rootNames = new Set<string>();
  const filePaths = new Set<string>();
  let fileCount = 0;
  for (const collection of collections) {
    if (!isRecord(collection) || typeof collection.name !== "string" ||
      !collection.name || !includedCollection(collection.name) || !Array.isArray(collection.documents)) {
      throw new Error("Backup contains an invalid collection");
    }
    if (collectionNames.has(collection.name)) throw new Error("Backup contains a duplicate collection");
    collectionNames.add(collection.name);
    if (collection.indexes !== undefined && (!Array.isArray(collection.indexes) || collection.indexes.some((index) => typeof index !== "string"))) {
      throw new Error("Backup contains invalid collection indexes");
    }
    for (const index of collection.indexes ?? []) {
      let parsed: unknown;
      try { parsed = BSON.EJSON.parse(index, { relaxed: false }); }
      catch { throw new Error(`Backup contains an invalid index in ${collection.name}`); }
      if (!isRecord(parsed) || !isRecord(parsed.key) || typeof parsed.name !== "string" ||
        Object.keys(parsed.key).length === 0 || !Object.keys(parsed.key).every((key) => /^[A-Za-z0-9_$.-]+$/.test(key))) {
        throw new Error(`Backup contains an invalid index in ${collection.name}`);
      }
    }
    for (const document of collection.documents) {
      if (typeof document !== "string") throw new Error("Backup contains an invalid database document");
      try {
        const parsed = BSON.EJSON.parse(document, { relaxed: false });
        if (!isRecord(parsed)) throw new Error();
      } catch {
        throw new Error(`Backup contains an invalid BSON document in ${collection.name}`);
      }
      documentCount += 1;
      if (documentCount > MAX_DOCUMENTS) throw new Error("Backup exceeds the maximum document count");
    }
  }
  for (const root of roots) {
    if (!isRecord(root) || typeof root.name !== "string" || !SAFE_NAME.test(root.name) || !Array.isArray(root.files)) {
      throw new Error("Backup contains an invalid artifact root");
    }
    if (rootNames.has(root.name)) throw new Error("Backup contains a duplicate artifact root");
    rootNames.add(root.name);
    for (const file of root.files) {
      if (!isRecord(file) || typeof file.path !== "string" || typeof file.contentType !== "string" ||
        typeof file.data !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(file.contentType) ||
        !validBase64(file.data)) {
        throw new Error("Backup contains an invalid artifact file");
      }
      safePath(file.path);
      const key = `${root.name}/${file.path}`;
      if (filePaths.has(key)) throw new Error("Backup contains a duplicate artifact path");
      filePaths.add(key);
      fileCount += 1;
      if (fileCount > MAX_FILES) throw new Error("Backup exceeds the maximum artifact count");
    }
  }
  return value as SiteBackup;
}

async function localFiles(root: string, options: BackupOptions, excluded: string[] = []): Promise<BackupFile[]> {
  const files: BackupFile[] = [];
  try {
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Cannot export a non-regular artifact root");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }
  async function visit(directory: string, prefix: string) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      if (!SAFE_NAME.test(entry.name)) throw new Error("Cannot archive artifact path containing unsupported characters");
      const relativeEntry = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excluded.some((item) => relativeEntry === item || relativeEntry.startsWith(`${item}/`))) continue;
      const absolute = path.join(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("Cannot export artifact symlinks");
      if (stat.isDirectory()) await visit(absolute, prefix ? `${prefix}/${entry.name}` : entry.name);
      else if (stat.isFile()) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        files.push({ path: relative, contentType: "application/octet-stream", data: (await readFile(absolute)).toString("base64") });
        progress(options, `Exported ${files.length.toLocaleString()} local artifact file(s) from this root.`);
      } else throw new Error("Cannot export a non-regular artifact");
    }
  }
  await visit(root, "");
  return files;
}

async function driveFiles(store: DriveArtifacts, rootId: string, options: BackupOptions): Promise<BackupFile[]> {
  const files: BackupFile[] = [];
  const limit = pLimit(TRANSFER_CONCURRENCY);
  let bytes = 0;
  async function visit(folderId: string, prefix: string) {
    const entries = await limit(() => store.listEntries(folderId));
    await Promise.all(entries.map(async (entry) => {
      options.signal?.throwIfAborted();
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      safePath(relative);
      if (entry.mimeType === "application/vnd.google-apps.folder") await visit(entry.id, relative);
      else {
        const data = Buffer.from(await limit(() => store.readBinary(entry.id))).toString("base64");
        bytes += data.length;
        if (bytes > SITE_BACKUP_MAX_BYTES || files.length >= MAX_FILES) throw new Error("Backup exceeds the maximum artifact size or count");
        files.push({ path: relative, contentType: entry.mimeType || "application/octet-stream", data });
        progress(options, `Exported ${files.length.toLocaleString()} artifact file(s) from this root.`);
      }
    }));
  }
  await visit(rootId, "");
  return files;
}

export async function createSiteBackup(db: Db, options: BackupOptions = {}): Promise<SiteBackup> {
  progress(options, "Reading database collections...");
  const selectedReaderFolder = await readerFolder(db);
  const collections = await db.listCollections({}, { nameOnly: true, signal: options.signal, timeoutMS: 30_000 }).toArray();
  const databaseCollections: SiteBackup["database"]["collections"] = [];
  for (const { name } of collections.filter(({ name }) => includedCollection(name))) {
    progress(options, `Exporting database collection: ${name}`);
    const docs = await db.collection(name).find({}, { signal: options.signal, timeoutMS: 30_000 }).toArray();
    const indexes = await db.collection(name).listIndexes({ timeoutMS: 30_000 }).toArray();
    databaseCollections.push({
      name,
      documents: docs.map((doc) => BSON.EJSON.stringify(doc, { relaxed: false })),
      indexes: indexes.filter((index) => index.name !== "_id_").map((index) => {
        const { ns: _ns, v: _version, key, name: indexName, ...options } = index;
        return BSON.EJSON.stringify({ key, name: indexName, ...options }, { relaxed: false });
      }),
    });
  }

  const mode = (process.env.NEWSBEE_MODE ?? "local").trim().toLowerCase();
  let roots: BackupRoot[];
  if (mode === "local") {
    const root = localDriveRoot();
    const readerFolder = selectedReaderFolder;
    const pipelineFolder = "pipeline/.newsbee-pipeline";
    roots = [
      { name: "reader-drive", files: isMongoChannelFolderId(readerFolder) ? [] : await localFiles(path.join(root, readerFolder), options) },
      { name: "pipeline-drive", files: await localFiles(path.join(root, "pipeline", ".newsbee-pipeline"), options) },
      { name: "local-drive-extra", files: await localFiles(root, options, [readerFolder, pipelineFolder]) },
    ];
  } else if (mode === "cloud") {
    const drive = new DriveArtifacts(undefined, options.signal);
    const pipelineRoot = process.env.NEWSBEE_PIPELINE_DRIVE_FOLDER_ID?.trim();
    if (!pipelineRoot) throw new Error("NEWSBEE_PIPELINE_DRIVE_FOLDER_ID is required to export a complete cloud backup");
    const readerRoot = selectedReaderFolder;
    roots = [
      { name: "reader-drive", files: isMongoChannelFolderId(readerRoot) ? [] : await driveFiles(drive, readerRoot, options) },
      { name: "pipeline-drive", files: await driveFiles(drive, pipelineRoot, options) },
    ];
  } else throw new Error("NEWSBEE_MODE must be 'local' or 'cloud'");

  progress(options, "Validating the complete archive...");
  return validateSiteBackup({
    format: SITE_BACKUP_FORMAT,
    version: SITE_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    database: { collections: databaseCollections },
    artifacts: { roots },
  });
}

async function writeLocalFiles(root: string, files: BackupFile[], options: BackupOptions) {
  for (const file of files) {
    options.signal?.throwIfAborted();
    const parts = safePath(file.path);
    const destination = path.join(root, ...parts);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(file.data, "base64"));
  }
}

async function replaceDriveFiles(store: DriveArtifacts, rootId: string, files: BackupFile[], options: BackupOptions) {
  const limit = pLimit(TRANSFER_CONCURRENCY);
  async function clear(folderId: string) {
    const entries = await limit(() => store.listEntries(folderId));
    await settleTransfers(entries.map(async (entry) => {
      options.signal?.throwIfAborted();
      if (entry.mimeType === "application/vnd.google-apps.folder") {
        await clear(entry.id);
      }
      await limit(() => store.removeById(entry.id));
    }));
  }
  progress(options, "Clearing destination artifacts...");
  await clear(rootId);
  const folders = new Map<string, string>([["", rootId]]);
  for (const file of files) {
    options.signal?.throwIfAborted();
    const parts = safePath(file.path);
    let parent = "";
    for (const part of parts.slice(0, -1)) {
      const key = parent ? `${parent}/${part}` : part;
      if (!folders.has(key)) folders.set(key, await store.ensureFolder(folders.get(parent)!, part));
      parent = key;
    }
  }
  let completed = 0;
  await settleTransfers(files.map((file) => limit(async () => {
    options.signal?.throwIfAborted();
    const parts = safePath(file.path);
    await store.saveBinary(folders.get(parts.slice(0, -1).join("/"))!, parts[parts.length - 1], Buffer.from(file.data, "base64"), file.contentType);
    progress(options, `Restored ${++completed} of ${files.length} artifact file(s) in this root.`);
  })));
}

async function settleTransfers(transfers: Promise<unknown>[]) {
  const settled = await Promise.allSettled(transfers);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

export type RestoreOptions = BackupOptions & {
  owner?: RestoreOwner; governanceConfirmation?: string; expectedIdentityGeneration?: string;
};
export const GOVERNANCE_CONFIRMATION = "ROLL BACK ACCOUNTS AND GOVERNANCE";

export async function replaceSiteBackup(database: Db, input: unknown, options: RestoreOptions = {}) {
  const expectedIdentityGeneration = options.expectedIdentityGeneration;
  progress(options, "Validating the archive before replacing data...");
  const backup = validateSiteBackup(input);
  if (!options.owner || options.governanceConfirmation !== GOVERNANCE_CONFIRMATION) {
    throw new MaintenanceError("Explicit owner action and governance rollback confirmation are required.");
  }
  await requireRestoreOwner(database, options.owner);
  const db = restoreDatabase(database);
  const channels = backup.database.collections.find((collection) => collection.name === "output_channels");
  // Artifacts must match the channel the restored database will expose, not the current one.
  const readerRoot = await resolveReaderDriveFolderId(async (id) => {
    for (const document of channels?.documents ?? []) {
      const channel: unknown = BSON.EJSON.parse(document, { relaxed: false });
      if (isRecord(channel) && channel._id === id) {
        return { _id: id, enabled: channel.enabled, drive_folder_id: channel.drive_folder_id };
      }
    }
    return null;
  });
  const mode = (process.env.NEWSBEE_MODE ?? "local").trim().toLowerCase();
  if (!["local", "cloud"].includes(mode)) throw new Error("NEWSBEE_MODE must be 'local' or 'cloud'");
  if (!backup.artifacts.roots.some((root) => root.name === "reader-drive")
    || !backup.artifacts.roots.some((root) => root.name === "pipeline-drive")
    || backup.artifacts.roots.some((root) => !["reader-drive", "pipeline-drive", "local-drive-extra"].includes(root.name))) {
    throw new Error("Backup artifact roots do not match destination storage");
  }
  if (mode === "cloud" && !process.env.NEWSBEE_PIPELINE_DRIVE_FOLDER_ID?.trim()) {
    throw new Error("Configure NEWSBEE_PIPELINE_DRIVE_FOLDER_ID before importing this backup");
  }
  if (mode === "local") {
    const root = path.resolve(localDriveRoot());
    const relative = path.relative(root, repositoryRoot());
    if (root === path.parse(root).root || !relative
      || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw new Error("Configure an app-specific artifact directory, not the repository or its ancestor.");
    }
  } else if (readerRoot === process.env.NEWSBEE_PIPELINE_DRIVE_FOLDER_ID?.trim()) {
    throw new Error("Backup destinations must use distinct Reader and pipeline roots");
  }
  const state = await maintenanceState(db);
  if (!["draining", "failed", "restored"].includes(state.phase) || state.writers.length) {
    throw new MaintenanceError("Close maintenance and drain all writers before restoring; concurrent restore is forbidden.");
  }
  if (expectedIdentityGeneration !== state.identityGeneration) {
    throw new MaintenanceError("Restore authorization is obsolete; sign in again before replacing data.");
  }
  // Also reject authority held by older/uninstrumented workers, even when a lease looks expired.
  if (state.phase === "draining") for (const [collection, filter] of [
    ["pipeline_jobs", { status: "running" }],
    ["pipeline_heartbeat", { lease_until: { $gt: Date.now() / 1000 } }],
    ["reader_newsletter_mail", { status: "sending" }],
    ["publication_email_deliveries", { status: "sending" }],
    ["video_production_jobs", { status: { $in: ["submitting", "processing", "uploading"] } }],
    ["video_upload_sessions", { status: "finalizing" }],
  ] as const) {
    if (await db.collection(collection).findOne(filter)) {
      throw new MaintenanceError(`Drain or resolve active writers in ${collection} before restoring.`);
    }
  }
  const restoreId = randomUUID();
  const archiveHash = createHash("sha256").update(JSON.stringify(backup)).digest("hex");
  const states = db.collection<Maintenance>(RESTORE_STATE);
  const acquired = await states.updateOne({
    _id: "site", epoch: state.epoch, phase: state.phase, identityGeneration: expectedIdentityGeneration, writers: { $size: 0 },
  }, {
    $set: { phase: "restoring", restoreId, archiveHash, identityGeneration: randomUUID() },
    $unset: { error: "" },
  }, { writeConcern: { w: "majority" } });
  if (!acquired.matchedCount) throw new MaintenanceError("Restore ownership changed; nothing was replaced.");
  try {
    await restoreEvent(db, {
      action: "restore_started", restoreId, archiveHash, owner: options.owner,
      governanceRollback: true, sourceCreatedAt: backup.createdAt,
      collections: backup.database.collections.map((collection) => collection.name),
    });
    progress(options, "Writers fenced and drained; restoring the full snapshot including governance...");
    const result = await replaceSnapshot(db, backup, readerRoot, mode, options);
    await quarantineRestoredAuthority(db, restoreId);
    options.signal?.throwIfAborted();
    await restoreEvent(db, { action: "restore_completed_maintenance_closed", restoreId, result });
    await states.updateOne({ _id: "site", restoreId, phase: "restoring" }, {
      $set: { phase: "restored" },
    }, { writeConcern: { w: "majority" } });
    return result;
  } catch (error) {
    // Keep the durable in-progress marker if recording failure itself fails. Never auto-open.
    const detail = safeError(error).slice(0, 1000);
    await states.updateOne({ _id: "site", restoreId, phase: "restoring" }, {
      $set: { phase: "failed", error: detail },
    }, { writeConcern: { w: "majority" } });
    await restoreEvent(db, { action: "restore_failed_maintenance_closed", restoreId, detail });
    throw error;
  }
}

async function quarantineRestoredAuthority(db: Db, restoreId: string) {
  await ensurePublicationGenerationAdmissionIndex(db);
  const reason = "Full snapshot restored. Obsolete work is fenced; deliberate fresh admission is required.";
  const preservedAuthority = { $set: { restore_quarantine: {
    restoreId, at: new Date(), status: "$status", claim_token: "$claim_token",
    lease_until: "$lease_until", token: "$token", leaseUntil: "$leaseUntil",
  } } };
  await db.collection("pipeline_jobs").updateMany({ status: { $in: ["pending", "running"] } }, [preservedAuthority, {
    $set: { status: "cancelled", error: reason, claim_token: null, lease_until: null },
  }]);
  await db.collection("pipeline_runs").updateMany({ status: { $nin: ["completed", "failed", "cancelled", "published"] } }, {
    $set: { execution_blocked: { reason, at: Date.now() / 1000 } },
  });
  await db.collection("publication_generations").updateMany({ status: { $in: ["starting", "running", "combining", "blocked", "paused", "cancelling"] } }, [preservedAuthority, {
    $set: { status: "blocked", error: reason, execution_blocked: { reason, at: Date.now() / 1000 } },
  }]);
  await db.collection("pipeline_heartbeat").updateMany({ lease_until: { $exists: true } }, [preservedAuthority, {
    $set: { lease_until: 0, token: null },
  }]);
  await db.collection("video_production_jobs").updateMany({ status: { $in: ["submitting", "queued", "processing", "uploading"] } }, [preservedAuthority, {
    $set: { status: "failed", error: reason },
  }]);
  await db.collection("video_upload_sessions").updateMany({}, [preservedAuthority, { $set: { status: "restore_blocked" } }]);
  await db.collection("reader_newsletter_mail").updateMany({ status: { $in: ["queued", "sending"] } }, [preservedAuthority, {
    $set: { status: "cancelled", error: reason },
  }, { $unset: "leaseUntil" }]);
  await db.collection("publication_email_deliveries").updateMany({
    status: { $in: ["pending", "sending", "retryable_failed", "unknown"] },
  }, [preservedAuthority, { $set: { status: "cancelled", last_detail: reason, claim_token: null, lease_until: null } }]);
  await db.collection("publication_email_campaigns").updateMany({ state: { $in: ["snapshotting", "ready", "sending"] } }, {
    $set: { state: "blocked", blocked_reason: reason },
  });
}

async function replaceSnapshot(db: Db, backup: SiteBackup, readerRoot: string, mode: string, options: BackupOptions) {
  if (mode === "local") {
    const reader = backup.artifacts.roots.find((item) => item.name === "reader-drive");
    const pipeline = backup.artifacts.roots.find((item) => item.name === "pipeline-drive");
    const extra = backup.artifacts.roots.find((item) => item.name === "local-drive-extra");
    if (!reader || !pipeline || backup.artifacts.roots.some((item) => !["reader-drive", "pipeline-drive", "local-drive-extra"].includes(item.name))) {
      throw new Error("Backup artifact roots do not match local storage");
    }
    const root = localDriveRoot();
    progress(options, "Replacing local artifacts...");
    await rm(root, { recursive: true, force: true });
    if (!isMongoChannelFolderId(readerRoot)) await writeLocalFiles(path.join(root, readerRoot), reader.files, options);
    await writeLocalFiles(path.join(root, "pipeline", ".newsbee-pipeline"), pipeline.files, options);
    if (extra) await writeLocalFiles(root, extra.files, options);
  } else if (mode === "cloud") {
    const reader = backup.artifacts.roots.find((item) => item.name === "reader-drive");
    const pipeline = backup.artifacts.roots.find((item) => item.name === "pipeline-drive");
    const extra = backup.artifacts.roots.find((item) => item.name === "local-drive-extra");
    const drive = new DriveArtifacts(undefined, options.signal);
    if (!reader || !pipeline ||
      backup.artifacts.roots.some((item) => !["reader-drive", "pipeline-drive", "local-drive-extra"].includes(item.name))) {
      throw new Error("Backup artifact roots do not match cloud storage");
    }
    const pipelineRoot = process.env.NEWSBEE_PIPELINE_DRIVE_FOLDER_ID?.trim();
    if (!pipelineRoot) throw new Error("Configure NEWSBEE_PIPELINE_DRIVE_FOLDER_ID before importing this backup");
    if (!isMongoChannelFolderId(readerRoot)) await replaceDriveFiles(drive, readerRoot, reader.files, options);
    await replaceDriveFiles(drive, pipelineRoot, [
      ...pipeline.files,
      ...(extra?.files ?? []).map((file) => ({ ...file, path: `.newsbee-local-extra/${file.path}` })),
    ], options);
  } else throw new Error("NEWSBEE_MODE must be 'local' or 'cloud'");

  progress(options, "Replacing database collections...");
  const existing = (await db.listCollections({}, { nameOnly: true, signal: options.signal, timeoutMS: 30_000 }).toArray()).map(({ name }) => name).filter(includedCollection);
  for (const name of existing) {
    options.signal?.throwIfAborted();
    await db.collection(name).drop({ timeoutMS: 30_000 });
  }
  for (const collection of backup.database.collections) {
    progress(options, `Restoring database collection: ${collection.name}`);
    const documents = collection.documents.map((document) => BSON.EJSON.parse(document, { relaxed: false }));
    await db.createCollection(collection.name, { timeoutMS: 30_000 });
    if (documents.length) await db.collection(collection.name).insertMany(documents, { timeoutMS: 30_000 });
    for (const rawIndex of collection.indexes ?? []) {
      const index = BSON.EJSON.parse(rawIndex, { relaxed: false }) as { key: Record<string, 1 | -1 | "text" | "2dsphere" | "hashed">; name: string; [key: string]: unknown };
      const { key, name, ...options } = index;
      await db.collection(collection.name).createIndex(key, { ...options, name } as never);
    }
  }
  return {
    collections: backup.database.collections.length,
    documents: backup.database.collections.reduce((sum, item) => sum + item.documents.length, 0),
    artifactFiles: backup.artifacts.roots.reduce((sum, item) => sum + item.files.length, 0),
  };
}
