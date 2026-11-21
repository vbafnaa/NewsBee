import { getToken } from "next-auth/jwt";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

function googleOAuthConfig() {
  const clientId = process.env.AUTH_GOOGLE_ID?.trim();
  const clientSecret = process.env.AUTH_GOOGLE_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured for Drive folder creation");
  return { clientId, clientSecret };
}

async function signedInDriveToken(request: Request, email: string) {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error("AUTH_SECRET is required to read Google Drive authorization");
  const token = await getToken({ req: request, secret });
  const expectedEmail = email.trim().toLowerCase();
  if (!token ||
      token.email?.trim().toLowerCase() !== expectedEmail ||
      token.googleDriveAccountEmail !== expectedEmail ||
      !token.googleDriveRefreshToken ||
      !token.googleDriveScopes?.includes(DRIVE_SCOPE)) return null;
  return token;
}

export async function hasGoogleDriveAuthorization(request: Request, email: string) {
  return Boolean(await signedInDriveToken(request, email));
}

async function driveAccessToken(request: Request, email: string) {
  const token = await signedInDriveToken(request, email);
  if (!token?.googleDriveRefreshToken) {
    throw new Error("Connect Google Drive with the currently signed-in account before creating a publishing channel");
  }
  return refreshGoogleDriveAccess(token.googleDriveRefreshToken);
}

export async function refreshGoogleDriveAccess(refreshToken: string) {
  const { clientId, clientSecret } = googleOAuthConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Google Drive authorization expired or was revoked. Reconnect Google Drive and try again.");
  const result = await response.json() as { access_token?: unknown };
  if (typeof result.access_token !== "string" || !result.access_token) {
    throw new Error("Google did not return a Drive access token. Reconnect Google Drive and try again.");
  }
  return result.access_token;
}

async function driveRequest<T>(accessToken: string, url: URL, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...init?.headers },
    cache: "no-store",
  });
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      throw new Error("The signed-in Google account cannot create folders in the configured pipeline Drive folder. Grant it access to that Shared Drive and try again.");
    }
    throw new Error(`Google Drive folder request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

async function findFolder(accessToken: string, parentId: string, name: string) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.search = new URLSearchParams({
    q: `'${parentId}' in parents and name = '${name}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id)",
    pageSize: "10",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  }).toString();
  const result = await driveRequest<{ files?: Array<{ id?: unknown }> }>(accessToken, url);
  const id = result.files?.find((file) => typeof file.id === "string")?.id;
  return typeof id === "string" && DRIVE_ID.test(id) ? id : null;
}

async function ensureFolder(accessToken: string, parentId: string, name: string) {
  const found = await findFolder(accessToken, parentId, name);
  if (found) return found;
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("fields", "id");
  url.searchParams.set("supportsAllDrives", "true");
  const result = await driveRequest<{ id?: unknown }>(accessToken, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  if (typeof result.id !== "string" || !DRIVE_ID.test(result.id)) {
    throw new Error("Google Drive did not return a valid channel folder ID");
  }
  return result.id;
}

export async function createUserDriveChannelFolder(request: Request, email: string, pipelineRoot: string | null, channelId: string) {
  if (!pipelineRoot || !DRIVE_ID.test(pipelineRoot)) {
    throw new Error("NEWSBEE_PIPELINE_DRIVE_FOLDER_ID is not configured with a valid Google Drive folder ID");
  }
  if (!/^[a-f0-9]{32}$/.test(channelId)) throw new Error("Invalid publishing channel ID");
  const accessToken = await driveAccessToken(request, email);
  const channelsFolder = await ensureFolder(accessToken, pipelineRoot, "output-channels");
  return ensureFolder(accessToken, channelsFolder, channelId);
}

export async function reserveUserDriveFolderId(request: Request, email: string) {
  const token = await driveAccessToken(request, email);
  const result = await driveRequest<{ ids?: string[] }>(token, new URL("https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files"));
  const id = result.ids?.[0];
  if (!id || !DRIVE_ID.test(id)) throw new Error("Google Drive did not reserve a valid folder identity.");
  return id;
}

export async function provisionUserDriveChannelFolder(
  request: Request, email: string, pipelineRoot: string | null, channelId: string, folderId: string,
) {
  if (!pipelineRoot || !DRIVE_ID.test(pipelineRoot) || !DRIVE_ID.test(folderId) || !/^[a-f0-9]{32}$/.test(channelId)) {
    throw new Error("Invalid Google Drive newsroom folder configuration.");
  }
  const token = await driveAccessToken(request, email);
  const existingUrl = new URL(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,mimeType,trashed&supportsAllDrives=true`);
  const existing = await fetch(existingUrl, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (existing.ok) {
    const file = await existing.json() as { mimeType?: string; trashed?: boolean };
    if (file.mimeType !== FOLDER_MIME || file.trashed) throw new Error("The reserved newsroom folder is no longer usable.");
    return;
  }
  if (existing.status !== 404) throw new Error(`Google Drive folder inspection failed (${existing.status}). Retry the same creation request.`);
  // A preallocated ID makes even overlapping or lost-response create attempts idempotent.
  const response = await fetch("https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true", {
    method: "POST", cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: folderId, name: `channel-${channelId}`, mimeType: FOLDER_MIME, parents: [pipelineRoot] }),
  });
  if (!response.ok && response.status !== 409) throw new Error(`Google Drive folder creation failed (${response.status}). Retry the same creation request.`);
}
