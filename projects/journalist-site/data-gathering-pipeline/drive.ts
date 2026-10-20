import { createSign } from "node:crypto";
import type { PipelineRun } from "./types";

type DriveFile = { id: string; name?: string; mimeType?: string };
type ServiceAccount = { client_email?: string; private_key?: string };
const FOLDER_MIME = "application/vnd.google-apps.folder";

let cachedToken: { value: string; expiresAt: number } | undefined;
let tokenRequest: Promise<string> | undefined;

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function serviceAccount() {
  let email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    let credentials: ServiceAccount;
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) as ServiceAccount;
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON");
    }
    email = credentials.client_email;
    privateKey = credentials.private_key;
  }
  if (!email || !privateKey) {
    throw new Error("Configure GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (or GOOGLE_SERVICE_ACCOUNT_JSON)");
  }
  return { email, privateKey: privateKey.replace(/\\n/g, "\n") };
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  if (!tokenRequest) {
    tokenRequest = (async () => {
      const { email, privateKey } = serviceAccount();
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({
        iss: email,
        scope: "https://www.googleapis.com/auth/drive",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }))}`;
      const signer = createSign("RSA-SHA256");
      signer.update(unsigned);
      const assertion = `${unsigned}.${base64url(signer.sign(privateKey))}`;
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
        cache: "no-store",
      });
      const data: unknown = await response.json();
      if (!response.ok || typeof data !== "object" || data === null ||
        !("access_token" in data) || typeof data.access_token !== "string") {
        throw new Error("Google OAuth token request failed");
      }
      cachedToken = { value: data.access_token, expiresAt: Date.now() + 3_500_000 };
      return data.access_token;
    })().finally(() => { tokenRequest = undefined; });
  }
  return tokenRequest;
}

async function driveRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...init?.headers },
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Google Drive request failed (${response.status}): ${detail}`);
  }
  return response.json() as Promise<T>;
}

async function findFile(parentId: string, name: string, mimeType?: string) {
  const query = [`'${parentId}' in parents`, `name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`, "trashed = false"];
  if (mimeType) query.push(`mimeType = '${mimeType}'`);
  const params = new URLSearchParams({ q: query.join(" and "), fields: "files(id,name,mimeType)", pageSize: "10" });
  const result = await driveRequest<{ files: DriveFile[] }>(`https://www.googleapis.com/drive/v3/files?${params}`);
  return result.files[0];
}

async function ensureFolder(parentId: string, name: string) {
  const found = await findFile(parentId, name, FOLDER_MIME);
  if (found) return found.id;
  const created = await driveRequest<DriveFile>("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return created.id;
}

function sourceFolderName(sourceId: string) {
  const safe = sourceId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 90);
  if (!safe) throw new Error("Source identifier cannot be used as a Drive folder name");
  return safe;
}

export async function pipelineRunFolder(run: PipelineRun) {
  const kind = run.kind === "source" ? "sources" : "editions";
  const name = run.kind === "source"
    ? sourceFolderName(run.source_id ?? "")
    : run.location_id;
  return pipelineFolder(run.drive_folder_id, kind, name, run._id);
}

export async function createOutputChannelFolder(channelId: string) {
  const parent = await ensureFolder(getPipelineDriveFolderId(), "output-channels");
  const folderId = await ensureFolder(parent, channelId);
  const locations = await readLocationIndex();
  await saveJson(folderId, "locations.json", { locations });
  return folderId;
}

export async function pipelineFolder(driveFolderId: string, kind: "sources" | "editions", name: string, runId?: string) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(driveFolderId)) throw new Error("Pipeline run has an invalid Drive folder ID");
  const root = await ensureFolder(driveFolderId, ".newsbee-pipeline");
  const category = await ensureFolder(root, kind);
  const entity = await ensureFolder(category, name);
  return runId ? ensureFolder(entity, runId) : entity;
}

export async function saveJson(parentId: string, name: string, value: unknown) {
  let file = await findFile(parentId, name);
  if (!file) {
    file = await driveRequest<DriveFile>("https://www.googleapis.com/drive/v3/files?fields=id,name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/json", parents: [parentId] }),
    });
  }
  const response = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=media`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(value),
      cache: "no-store",
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Google Drive file upload failed (${response.status}): ${detail}`);
  }
  return file.id;
}

export async function readJson<T>(fileId: string): Promise<T> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${await accessToken()}` }, cache: "no-store" },
  );
  if (!response.ok) throw new Error(`Google Drive file read failed (${response.status})`);
  return response.json() as Promise<T>;
}

export async function readLocationIndex() {
  const file = await findFile(getPipelineDriveFolderId(), "locations.json");
  if (!file) throw new Error("locations.json was not found in the pipeline Drive folder");
  const data = await readJson<{ locations?: unknown }>(file.id);
  if (!Array.isArray(data.locations)) throw new Error("Drive locations.json has no locations array");
  return data.locations.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const location = value as Record<string, unknown>;
    if (typeof location.id !== "string" || typeof location.name !== "string") return [];
    return [{ id: location.id, name: location.name }];
  });
}

export function getPipelineDriveFolderId() {
  const folderId = process.env.NEWSBEE_PIPELINE_DRIVE_FOLDER_ID;
  if (!folderId || !/^[A-Za-z0-9_-]{10,200}$/.test(folderId)) {
    throw new Error("Configure NEWSBEE_PIPELINE_DRIVE_FOLDER_ID with the shared pipeline Google Drive folder ID");
  }
  return folderId;
}
