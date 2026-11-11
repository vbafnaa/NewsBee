import { BSON } from "mongodb";
import type { Db } from "mongodb";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMongoChannelFolderId, resolveReaderDriveFolderId } from "../../../../shared/reader-folder";
import { readerFolder } from "../orchestration/publish";
import { getArtifacts, localDriveRoot, type ArtifactStore } from "./artifacts";
import { DriveArtifacts } from "./drive";

export const SITE_BACKUP_FORMAT = "newsbee-site-backup";
export const SITE_BACKUP_VERSION = 1;
export const SITE_BACKUP_MAX_BYTES = 250 * 1024 * 1024;
const MAX_FILES = 50_000;
const MAX_DOCUMENTS = 1_000_000;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,200}$/;

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
      !collection.name || collection.name.startsWith("system.") || !Array.isArray(collection.documents)) {
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
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) {
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

async function localFiles(root: string, excluded: string[] = []): Promise<BackupFile[]> {
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
      } else throw new Error("Cannot export a non-regular artifact");
    }
  }
  await visit(root, "");
  return files;
}

async function driveFiles(store: DriveArtifacts, rootId: string): Promise<BackupFile[]> {
  const files: BackupFile[] = [];
  async function visit(folderId: string, prefix: string) {
    for (const entry of await store.listEntries(folderId)) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mimeType === "application/vnd.google-apps.folder") await visit(entry.id, relative);
      else files.push({
        path: relative,
        contentType: entry.mimeType || "application/octet-stream",
        data: Buffer.from(await store.readBinary(entry.id)).toString("base64"),
      });
    }
  }
  await visit(rootId, "");
  return files;
}

export async function createSiteBackup(db: Db): Promise<SiteBackup> {
  const selectedReaderFolder = await readerFolder(db);
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  const databaseCollections: SiteBackup["database"]["collections"] = [];
  for (const { name } of collections.filter(({ name }) => !name.startsWith("system."))) {
    const docs = await db.collection(name).find({}).toArray();
    const indexes = await db.collection(name).listIndexes().toArray();
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
      { name: "reader-drive", files: isMongoChannelFolderId(readerFolder) ? [] : await localFiles(path.join(root, readerFolder)) },
      { name: "pipeline-drive", files: await localFiles(path.join(root, "pipeline", ".newsbee-pipeline")) },
      { name: "local-drive-extra", files: await localFiles(root, [readerFolder, pipelineFolder]) },
    ];
  } else if (mode === "cloud") {
    const drive = getArtifacts();
    if (!(drive instanceof DriveArtifacts)) throw new Error("Cloud artifact storage is unavailable");
    const pipelineRoot = process.env.NEWSBEE_PIPELINE_DRIVE_FOLDER_ID?.trim();
    if (!pipelineRoot) throw new Error("NEWSBEE_PIPELINE_DRIVE_FOLDER_ID is required to export a complete cloud backup");
    const readerRoot = selectedReaderFolder;
    roots = [
      { name: "reader-drive", files: isMongoChannelFolderId(readerRoot) ? [] : await driveFiles(drive, readerRoot) },
      { name: "pipeline-drive", files: await driveFiles(drive, pipelineRoot) },
    ];
  } else throw new Error("NEWSBEE_MODE must be 'local' or 'cloud'");

  return validateSiteBackup({
    format: SITE_BACKUP_FORMAT,
    version: SITE_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    database: { collections: databaseCollections },
    artifacts: { roots },
  });
}

async function writeLocalFiles(root: string, files: BackupFile[]) {
  for (const file of files) {
    const parts = safePath(file.path);
    const destination = path.join(root, ...parts);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(file.data, "base64"));
  }
}

async function replaceDriveFiles(store: DriveArtifacts, rootId: string, files: BackupFile[]) {
  async function clear(folderId: string) {
    for (const entry of await store.listEntries(folderId)) {
      if (entry.mimeType === "application/vnd.google-apps.folder") {
        await clear(entry.id);
        await store.removeById(entry.id);
      } else await store.removeById(entry.id);
    }
  }
  await clear(rootId);
  const folders = new Map<string, string>([["", rootId]]);
  for (const file of files) {
    const parts = safePath(file.path);
    let parent = "";
    for (const part of parts.slice(0, -1)) {
      const key = parent ? `${parent}/${part}` : part;
      if (!folders.has(key)) folders.set(key, await store.ensureFolder(folders.get(parent)!, part));
      parent = key;
    }
    await store.saveBinary(folders.get(parent)!, parts[parts.length - 1], Buffer.from(file.data, "base64"), file.contentType);
  }
}

export async function replaceSiteBackup(db: Db, input: unknown) {
  const backup = validateSiteBackup(input);
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
  if (mode === "local") {
    const reader = backup.artifacts.roots.find((item) => item.name === "reader-drive");
    const pipeline = backup.artifacts.roots.find((item) => item.name === "pipeline-drive");
    const extra = backup.artifacts.roots.find((item) => item.name === "local-drive-extra");
    if (!reader || !pipeline || backup.artifacts.roots.some((item) => !["reader-drive", "pipeline-drive", "local-drive-extra"].includes(item.name))) {
      throw new Error("Backup artifact roots do not match local storage");
    }
    const root = localDriveRoot();
    await rm(root, { recursive: true, force: true });
    if (!isMongoChannelFolderId(readerRoot)) await writeLocalFiles(path.join(root, readerRoot), reader.files);
    await writeLocalFiles(path.join(root, "pipeline", ".newsbee-pipeline"), pipeline.files);
    if (extra) await writeLocalFiles(root, extra.files);
  } else if (mode === "cloud") {
    const reader = backup.artifacts.roots.find((item) => item.name === "reader-drive");
    const pipeline = backup.artifacts.roots.find((item) => item.name === "pipeline-drive");
    const extra = backup.artifacts.roots.find((item) => item.name === "local-drive-extra");
    const drive = getArtifacts();
    if (!(drive instanceof DriveArtifacts) || !reader || !pipeline ||
      backup.artifacts.roots.some((item) => !["reader-drive", "pipeline-drive", "local-drive-extra"].includes(item.name))) {
      throw new Error("Backup artifact roots do not match cloud storage");
    }
    const pipelineRoot = process.env.NEWSBEE_PIPELINE_DRIVE_FOLDER_ID?.trim();
    if (!pipelineRoot) throw new Error("Configure NEWSBEE_PIPELINE_DRIVE_FOLDER_ID before importing this backup");
    if (!isMongoChannelFolderId(readerRoot)) await replaceDriveFiles(drive, readerRoot, reader.files);
    await replaceDriveFiles(drive, pipelineRoot, [
      ...pipeline.files,
      ...(extra?.files ?? []).map((file) => ({ ...file, path: `.newsbee-local-extra/${file.path}` })),
    ]);
  } else throw new Error("NEWSBEE_MODE must be 'local' or 'cloud'");

  const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).map(({ name }) => name).filter((name) => !name.startsWith("system."));
  for (const name of existing) await db.collection(name).drop();
  for (const collection of backup.database.collections) {
    const documents = collection.documents.map((document) => BSON.EJSON.parse(document, { relaxed: false }));
    await db.createCollection(collection.name);
    if (documents.length) await db.collection(collection.name).insertMany(documents);
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
