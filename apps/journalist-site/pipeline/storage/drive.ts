/** Google Drive adapter for ArtifactStore (service-account JWT auth, Drive v3 REST). */
import { createSign, randomUUID } from "node:crypto";
import { artifactSegment, type ArtifactStore, type StoredFile } from "./artifacts";

type DriveFile = { id: string; name?: string; mimeType?: string; ownedByMe?: boolean; driveId?: string };
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

let cachedToken: { value: string; expiresAt: number } | undefined;
let tokenRequest: Promise<string> | undefined;

function timedFetch(url: string, init?: RequestInit) {
  const timeout = AbortSignal.timeout(30_000);
  return fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
}

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function serviceAccount() {
  let email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    let credentials: unknown;
    let json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
    if (json.startsWith("'") && json.endsWith("'")) json = json.slice(1, -1);
    try {
      credentials = JSON.parse(json);
      if (typeof credentials === "string") credentials = JSON.parse(credentials);
    } catch {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON. " +
        "In Vercel, paste the full downloaded JSON key as the value, not a file path or a variable assignment. " +
        "Alternatively, remove GOOGLE_SERVICE_ACCOUNT_JSON and set GOOGLE_SERVICE_ACCOUNT_EMAIL and " +
        "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY. Redeploy after changing environment variables.",
      );
    }
    if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials) ||
      !("client_email" in credentials) || typeof credentials.client_email !== "string" || !credentials.client_email.trim() ||
      !("private_key" in credentials) || typeof credentials.private_key !== "string" || !credentials.private_key.trim()) {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_JSON must be a service-account key object with non-empty client_email and private_key strings. " +
        "Use the downloaded service-account JSON key, not an OAuth client secret or an API key.",
      );
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
  tokenRequest ??= (async () => {
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
    const response = await timedFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      cache: "no-store",
    });
    const data = await response.json() as { access_token?: unknown };
    if (!response.ok || typeof data.access_token !== "string") throw new Error("Google OAuth token request failed");
    cachedToken = { value: data.access_token, expiresAt: Date.now() + 3_500_000 };
    return data.access_token;
  })().finally(() => {
    tokenRequest = undefined;
  });
  return tokenRequest;
}

class DriveQuotaError extends Error {}

function driveError(operation: string, status: number, detail: string, guidance = "") {
  const message = `Google Drive ${operation} failed (${status}): ${detail.slice(0, 500)}${guidance}`;
  return status === 403 && /service accounts do not have storage quota|storageQuotaExceeded/i.test(detail)
    ? new DriveQuotaError(message)
    : new Error(message);
}

async function driveRequest<T>(url: string, init?: RequestInit, token?: string): Promise<T> {
  const response = await timedFetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token ?? await accessToken()}`, ...init?.headers },
    cache: "no-store",
  });
  if (!response.ok) {
    throw driveError("request", response.status, await response.text());
  }
  return response.json() as Promise<T>;
}

function quoted(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function checkId(id: string) {
  if (!DRIVE_ID.test(id)) throw new Error("Invalid Google Drive file or folder ID");
  return id;
}

async function findFile(parentId: string, name: string, mimeType?: string, token?: string, newest = false, signal?: AbortSignal) {
  const query = [`'${quoted(checkId(parentId))}' in parents`, `name = '${quoted(name)}'`, "trashed = false"];
  if (mimeType) query.push(`mimeType = '${mimeType}'`);
  const params = new URLSearchParams({
    q: query.join(" and "),
    fields: token ? "files(id,name,mimeType,ownedByMe,driveId)" : "files(id,name,mimeType)",
    pageSize: "10",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (newest) params.set("orderBy", "modifiedTime desc");
  const result = await driveRequest<{ files: DriveFile[] }>(`https://www.googleapis.com/drive/v3/files?${params}`, { signal }, token);
  if (token && !mimeType) return result.files.find((file) => file.ownedByMe || file.driveId);
  return result.files[0];
}

export class DriveArtifacts implements ArtifactStore {
  readonly kind = "drive" as const;
  private editorToken?: Promise<string>;

  constructor(private readonly quotaFallback?: () => Promise<string>, private readonly signal?: AbortSignal) {}

  private async withWriteQuotaFallback<T>(write: (token?: string) => Promise<T>) {
    if (this.editorToken) return write(await this.editorToken);
    try {
      return await write();
    } catch (error) {
      if (!(error instanceof DriveQuotaError) || !this.quotaFallback) throw error;
      this.editorToken ??= this.quotaFallback();
      return write(await this.editorToken);
    }
  }

  async listEntries(parentId: string): Promise<(StoredFile & { mimeType: string })[]> {
    const files: (StoredFile & { mimeType: string })[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${quoted(checkId(parentId))}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await driveRequest<{ files?: DriveFile[]; nextPageToken?: string }>(`https://www.googleapis.com/drive/v3/files?${params}`, { signal: this.signal });
      files.push(...(page.files ?? []).map((file) => ({ id: file.id, name: file.name ?? "", mimeType: file.mimeType ?? "application/octet-stream" })));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  async removeById(id: string) {
    const response = await timedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(checkId(id))}?supportsAllDrives=true`,
      { method: "DELETE", headers: { Authorization: `Bearer ${await accessToken()}` }, cache: "no-store", signal: this.signal },
    );
    if (!response.ok && response.status !== 404) throw new Error(`Google Drive artifact cleanup failed (${response.status})`);
  }

  async findFolder(parentId: string, name: string) {
    artifactSegment(name);
    const params = new URLSearchParams({
      q: `'${quoted(checkId(parentId))}' in parents and name = '${quoted(name)}' and trashed = false and mimeType = '${FOLDER_MIME}'`,
      fields: "files(id)", pageSize: "2", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
    });
    const { files } = await driveRequest<{ files: DriveFile[] }>(`https://www.googleapis.com/drive/v3/files?${params}`);
    if (files.length > 1 || files.some((file) => file.id === parentId)) {
      throw new Error(`Ambiguous artifact folder: ${name}`);
    }
    return files[0]?.id ?? null;
  }

  async removeFile(parentId: string, name: string) {
    artifactSegment(name);
    const matches = (await this.list(parentId)).filter((file) => file.name === name);
    for (const file of matches) {
      const metadata = await driveRequest<{ name: string; mimeType: string; parents: string[] }>(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(checkId(file.id))}?fields=name,mimeType,parents&supportsAllDrives=true`,
      );
      if (metadata.name !== name || metadata.mimeType === FOLDER_MIME ||
        metadata.parents?.length !== 1 || metadata.parents[0] !== parentId) {
        throw new Error(`Refusing cleanup of moved, shared or non-file artifact: ${name}`);
      }
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?supportsAllDrives=true`,
        { method: "DELETE", headers: { Authorization: `Bearer ${await accessToken()}` }, cache: "no-store" },
      );
      if (!response.ok && response.status !== 404) throw new Error(`Google Drive artifact cleanup failed (${response.status}): ${name}`);
    }
    return matches.length;
  }

  async ensureFolder(parentId: string, name: string) {
    return this.withWriteQuotaFallback((token) => this.writeFolder(parentId, name, token));
  }

  private async writeFolder(parentId: string, name: string, token?: string) {
    const found = await findFile(parentId, name, FOLDER_MIME, token, false, this.signal);
    if (found) return found.id;
    const created = await driveRequest<DriveFile>("https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      signal: this.signal,
    }, token);
    return created.id;
  }

  async saveText(parentId: string, name: string, value: string, mimeType: string) {
    return this.withWriteQuotaFallback((token) => this.writeText(parentId, name, value, mimeType, token));
  }

  private async writeText(parentId: string, name: string, value: string, mimeType: string, token?: string) {
    const file = await findFile(parentId, name, undefined, token, Boolean(this.quotaFallback));
    const metadata = JSON.stringify({ name, mimeType, parents: [parentId] });
    if (!file && this.quotaFallback) {
      const boundary = randomUUID();
      const body = [
        `--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", metadata,
        `--${boundary}`, `Content-Type: ${mimeType}; charset=UTF-8`, "", value,
        `--${boundary}--`, "",
      ].join("\r\n");
      const created = await driveRequest<DriveFile>(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true",
        { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body },
        token,
      );
      return created.id;
    }
    const target = file ?? await driveRequest<DriveFile>("https://www.googleapis.com/drive/v3/files?fields=id,name&supportsAllDrives=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: metadata,
    });
    const response = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(target.id)}?uploadType=media&supportsAllDrives=true`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token ?? await accessToken()}`, "Content-Type": `${mimeType}; charset=UTF-8` },
        body: value,
        cache: "no-store",
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      const quotaGuidance = !this.quotaFallback && detail.includes("Service Accounts do not have storage quota")
        ? " The parent folder must be on a Shared Drive where the service account has at least Contributor access; a My Drive folder shared with the account is not sufficient."
        : "";
      throw driveError("file upload", response.status, detail, quotaGuidance);
    }
    return target.id;
  }

  async saveBinary(parentId: string, name: string, value: Uint8Array, mimeType: string) {
    artifactSegment(name);
    let file = await findFile(parentId, name, undefined, undefined, false, this.signal);
    file ??= await driveRequest<DriveFile>("https://www.googleapis.com/drive/v3/files?fields=id,name&supportsAllDrives=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType, parents: [checkId(parentId)] }),
      signal: this.signal,
    });
    const bytes = new Uint8Array(value.byteLength);
    bytes.set(value);
    const response = await timedFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(checkId(file.id))}?uploadType=media&supportsAllDrives=true`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": mimeType },
        body: bytes.buffer,
        cache: "no-store",
        signal: this.signal,
      },
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      const quotaGuidance = detail.includes("Service Accounts do not have storage quota")
        ? " The parent folder must be on a Shared Drive where the service account has at least Contributor access; a My Drive folder shared with the account is not sufficient."
        : "";
      throw new Error(`Google Drive file upload failed (${response.status}): ${detail}${quotaGuidance}`);
    }
    return file.id;
  }

  async saveJson(parentId: string, name: string, value: unknown) {
    return this.saveText(parentId, name, JSON.stringify(value), "application/json");
  }

  async readJson<T>(fileId: string) {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(checkId(fileId))}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${await accessToken()}` }, cache: "no-store" },
    );
    if (!response.ok) throw new Error(`Google Drive file read failed (${response.status})`);
    return response.json() as Promise<T>;
  }

  async readText(fileId: string) {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(checkId(fileId))}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${await accessToken()}` }, cache: "no-store" },
    );
    if (!response.ok) throw new Error(`Google Drive file read failed (${response.status})`);
    return response.text();
  }

  async readBinary(fileId: string) {
    const response = await timedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(checkId(fileId))}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${await accessToken()}` }, cache: "no-store", signal: this.signal },
    );
    if (!response.ok) throw new Error(`Google Drive file read failed (${response.status})`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 100 * 1024 * 1024) throw new Error("Video file exceeds the 100 MB YouTube upload limit");
    if (!response.body) throw new Error("Google Drive video response has no content");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 100 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Video file exceeds the 100 MB YouTube upload limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  async list(parentId: string): Promise<StoredFile[]> {
    const files: StoredFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${quoted(checkId(parentId))}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`,
        fields: "nextPageToken,files(id,name)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await driveRequest<{ files?: DriveFile[]; nextPageToken?: string }>(`https://www.googleapis.com/drive/v3/files?${params}`);
      files.push(...(page.files ?? []).map((file) => ({ id: file.id, name: file.name ?? "" })));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }
}

/** Admin diagnostics use the same credentials and upload path as pipeline artifacts. */
export function driveServiceAccountEmail() {
  return serviceAccount().email;
}

export type DriveFolderDetails = {
  id: string;
  name?: string;
  mimeType?: string;
  driveId?: string;
  webViewLink?: string;
  capabilities?: { canAddChildren?: boolean };
};

export async function driveFolderDetails(folderId: string) {
  const params = new URLSearchParams({
    fields: "id,name,mimeType,driveId,webViewLink,capabilities(canAddChildren)",
    supportsAllDrives: "true",
  });
  return driveRequest<DriveFolderDetails>(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(checkId(folderId))}?${params}`);
}

export async function testDriveUpload(folderId: string) {
  checkId(folderId);
  const name = `.newsbee-drive-test-${randomUUID()}.txt`;
  let uploaded = false;
  let fileId: string | undefined;
  let error: string | null = null;
  let cleanupError: string | null = null;
  try {
    fileId = await new DriveArtifacts().saveText(folderId, name, "Newsbee Drive write test\n", "text/plain");
    uploaded = true;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  // saveText creates file metadata before uploading content, so clean up even after a 403.
  try {
    fileId ??= (await findFile(folderId, name))?.id;
    if (fileId) {
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
        { method: "DELETE", headers: { Authorization: `Bearer ${await accessToken()}` }, cache: "no-store" },
      );
      if (!response.ok) throw new Error(`Google Drive test file cleanup failed (${response.status})`);
    }
  } catch (cause) {
    cleanupError = cause instanceof Error ? cause.message : String(cause);
  }
  return { uploaded, error, cleanupError };
}
