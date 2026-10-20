/** Google Drive adapter for ArtifactStore (service-account JWT auth, Drive v3 REST). */
import { createSign } from "node:crypto";
import type { ArtifactStore, StoredFile } from "./artifacts";

type DriveFile = { id: string; name?: string; mimeType?: string };
type ServiceAccount = { client_email?: string; private_key?: string };
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

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
    const response = await fetch("https://oauth2.googleapis.com/token", {
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

function quoted(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function checkId(id: string) {
  if (!DRIVE_ID.test(id)) throw new Error("Invalid Google Drive file or folder ID");
  return id;
}

async function findFile(parentId: string, name: string, mimeType?: string) {
  const query = [`'${quoted(checkId(parentId))}' in parents`, `name = '${quoted(name)}'`, "trashed = false"];
  if (mimeType) query.push(`mimeType = '${mimeType}'`);
  const params = new URLSearchParams({ q: query.join(" and "), fields: "files(id,name,mimeType)", pageSize: "10" });
  const result = await driveRequest<{ files: DriveFile[] }>(`https://www.googleapis.com/drive/v3/files?${params}`);
  return result.files[0];
}

export class DriveArtifacts implements ArtifactStore {
  readonly kind = "drive" as const;

  async ensureFolder(parentId: string, name: string) {
    const found = await findFile(parentId, name, FOLDER_MIME);
    if (found) return found.id;
    const created = await driveRequest<DriveFile>("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return created.id;
  }

  async saveText(parentId: string, name: string, value: string, mimeType: string) {
    let file = await findFile(parentId, name);
    file ??= await driveRequest<DriveFile>("https://www.googleapis.com/drive/v3/files?fields=id,name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType, parents: [parentId] }),
    });
    const response = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=media`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": `${mimeType}; charset=UTF-8` },
        body: value,
        cache: "no-store",
      },
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Google Drive file upload failed (${response.status}): ${detail}`);
    }
    return file.id;
  }

  async saveJson(parentId: string, name: string, value: unknown) {
    return this.saveText(parentId, name, JSON.stringify(value), "application/json");
  }

  async readJson<T>(fileId: string) {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(checkId(fileId))}?alt=media`,
      { headers: { Authorization: `Bearer ${await accessToken()}` }, cache: "no-store" },
    );
    if (!response.ok) throw new Error(`Google Drive file read failed (${response.status})`);
    return response.json() as Promise<T>;
  }

  async readText(fileId: string) {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(checkId(fileId))}?alt=media`,
      { headers: { Authorization: `Bearer ${await accessToken()}` }, cache: "no-store" },
    );
    if (!response.ok) throw new Error(`Google Drive file read failed (${response.status})`);
    return response.text();
  }

  async list(parentId: string): Promise<StoredFile[]> {
    const files: StoredFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${quoted(checkId(parentId))}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`,
        fields: "nextPageToken,files(id,name)",
        pageSize: "1000",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await driveRequest<{ files?: DriveFile[]; nextPageToken?: string }>(`https://www.googleapis.com/drive/v3/files?${params}`);
      files.push(...(page.files ?? []).map((file) => ({ id: file.id, name: file.name ?? "" })));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }
}
