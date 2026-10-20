/**
 * Artifact storage: published editions, locations.json, email previews and per-run artifacts.
 * Cloud mode uses Google Drive; local mode uses a folder under .local/stage2/drive with the
 * same layout, so the reader site can read either.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadSettings } from "../core/config";
import { DriveArtifacts } from "./drive";

export type StoredFile = { id: string; name: string };

export interface ArtifactStore {
  readonly kind: "drive" | "local";
  ensureFolder(parentId: string, name: string): Promise<string>;
  saveJson(parentId: string, name: string, value: unknown): Promise<string>;
  saveText(parentId: string, name: string, value: string, mimeType: string): Promise<string>;
  readJson<T>(fileId: string): Promise<T>;
  readText(fileId: string): Promise<string>;
  list(parentId: string): Promise<StoredFile[]>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,200}$/;

function segment(value: string) {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`Unsafe artifact path segment: ${value}`);
  }
  return value;
}

/** Ids are forward-slash paths relative to the root; every segment is validated. */
export class LocalArtifacts implements ArtifactStore {
  readonly kind = "local" as const;

  constructor(readonly root: string) {}

  private resolve(id: string) {
    const parts = id.split("/").map(segment);
    return path.join(this.root, ...parts);
  }

  async ensureFolder(parentId: string, name: string) {
    const id = `${parentId}/${segment(name)}`;
    await mkdir(this.resolve(id), { recursive: true });
    return id;
  }

  async saveText(parentId: string, name: string, value: string) {
    const id = `${parentId}/${segment(name)}`;
    await mkdir(this.resolve(parentId), { recursive: true });
    await writeFile(this.resolve(id), value, "utf8");
    return id;
  }

  async saveJson(parentId: string, name: string, value: unknown) {
    return this.saveText(parentId, name, `${JSON.stringify(value, null, 2)}\n`);
  }

  async readJson<T>(fileId: string) {
    return JSON.parse(await readFile(this.resolve(fileId), "utf8")) as T;
  }

  async readText(fileId: string) {
    return readFile(this.resolve(fileId), "utf8");
  }

  async list(parentId: string) {
    try {
      const entries = await readdir(this.resolve(parentId), { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => ({ id: `${parentId}/${entry.name}`, name: entry.name }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

let override: ArtifactStore | null = null;

export function useArtifacts(store: ArtifactStore | null) {
  override = store;
}

export function localDriveRoot() {
  return process.env.NEWSBEE_LOCAL_DRIVE_DIR ?? path.join(loadSettings().localDataDir, "drive");
}

export function getArtifacts(): ArtifactStore {
  if (override) return override;
  return loadSettings().mode === "cloud" ? new DriveArtifacts() : new LocalArtifacts(localDriveRoot());
}

/** The journalist app's managed Drive workspace, nested beneath the configured root. */
export async function journalistDriveFolder(store: ArtifactStore, pipelineFolderId = loadSettings().pipelineDriveFolderId) {
  const root = store.kind === "drive" ? pipelineFolderId : pipelineFolderId ?? "pipeline";
  if (!root) throw new Error("NEWSBEE_PIPELINE_DRIVE_FOLDER_ID is not configured");
  return store.ensureFolder(root, "newsbee");
}

/** Folder that holds pipeline run artifacts (not visible to the reader site). */
export async function runFolder(store: ArtifactStore, kind: "sources" | "editions" | "email-previews" | "logs", ...names: string[]) {
  let folder = await store.ensureFolder(await journalistDriveFolder(store), ".newsbee-pipeline");
  folder = await store.ensureFolder(folder, kind);
  for (const name of names) folder = await store.ensureFolder(folder, name);
  return folder;
}
