import { getToken } from "next-auth/jwt";

const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const PRIVACY_STATUSES = new Set(["private", "unlisted", "public"]);
export type YouTubePrivacyStatus = "private" | "unlisted" | "public";
export type YouTubeChannel = { id: string; title: string };
export type YouTubePlaylist = { id: string; title: string };

type VideoMetadata = {
  title: string;
  description: string;
  tags: string[];
};

function oauthConfig() {
  const clientId = process.env.AUTH_GOOGLE_ID?.trim();
  const clientSecret = process.env.AUTH_GOOGLE_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured for YouTube publishing");
  return { clientId, clientSecret };
}

async function signedInToken(request: Request, email: string) {
  const token = await getToken({ req: request });
  const expectedEmail = email.trim().toLowerCase();
  if (!token ||
      token.email?.trim().toLowerCase() !== expectedEmail ||
      token.youtubeAccountEmail !== expectedEmail) return null;
  return token;
}

export async function youtubeConnection(request: Request, email: string) {
  const token = await signedInToken(request, email);
  const authorized = Boolean(token?.youtubeRefreshToken && token.youtubeScopes?.includes(YOUTUBE_SCOPE));
  return {
    connected: authorized,
    email: authorized ? email : null,
    scope: YOUTUBE_SCOPE,
  };
}

async function youtubeAccessToken(request: Request, email: string) {
  const token = await signedInToken(request, email);
  if (!token?.youtubeRefreshToken || !token.youtubeScopes?.includes(YOUTUBE_SCOPE)) {
    throw new Error("Connect YouTube with the currently signed-in Google account before publishing");
  }
  const { clientId, clientSecret } = oauthConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: token.youtubeRefreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("YouTube authorization expired or was revoked. Reconnect YouTube and try again.");
  const result = await response.json() as { access_token?: unknown };
  if (typeof result.access_token !== "string" || !result.access_token) {
    throw new Error("Google did not return a YouTube access token. Reconnect YouTube and try again.");
  }
  return result.access_token;
}

async function youtubeGet<T>(accessToken: string, url: URL): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`YouTube API request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export async function listYouTubeChannels(request: Request, email: string): Promise<YouTubeChannel[]> {
  const accessToken = await youtubeAccessToken(request, email);
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.search = new URLSearchParams({ part: "id,snippet", mine: "true", maxResults: "50" }).toString();
  const result = await youtubeGet<{ items?: Array<{ id?: string; snippet?: { title?: string } }> }>(accessToken, url);
  return (result.items ?? []).flatMap((item) =>
    typeof item.id === "string" && item.id && typeof item.snippet?.title === "string"
      ? [{ id: item.id, title: item.snippet.title }]
      : [],
  );
}

export async function listYouTubePlaylists(request: Request, email: string, channelId: string): Promise<YouTubePlaylist[]> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(channelId)) throw new Error("Invalid YouTube channel");
  const channels = await listYouTubeChannels(request, email);
  if (!channels.some((channel) => channel.id === channelId)) {
    throw new Error("Choose a channel available to the signed-in YouTube account");
  }
  const accessToken = await youtubeAccessToken(request, email);
  const playlists: YouTubePlaylist[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlists");
    const params = new URLSearchParams({ part: "id,snippet", channelId, maxResults: "50" });
    if (pageToken) params.set("pageToken", pageToken);
    url.search = params.toString();
    const result = await youtubeGet<{
      items?: Array<{ id?: string; snippet?: { title?: string; channelId?: string } }>;
      nextPageToken?: string;
    }>(accessToken, url);
    playlists.push(...(result.items ?? []).flatMap((item) =>
      typeof item.id === "string" && item.id && item.snippet?.channelId === channelId && typeof item.snippet.title === "string"
        ? [{ id: item.id, title: item.snippet.title }]
        : [],
    ));
    if (!result.nextPageToken) break;
    pageToken = result.nextPageToken;
  }
  return playlists;
}

export async function publishVideoToYouTube(
  request: Request,
  email: string,
  bytes: Uint8Array,
  metadata: VideoMetadata,
  privacyStatus: YouTubePrivacyStatus,
) {
  if (privacyStatus !== "private" && privacyStatus !== "unlisted" && privacyStatus !== "public") {
    throw new Error("Choose a valid YouTube visibility setting");
  }
  if (!bytes.byteLength || bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("Video must be between 1 byte and 100 MB to upload to YouTube");
  }
  if (!metadata.title.trim() || metadata.title.length > 100 || metadata.description.length > 5000) {
    throw new Error("YouTube title or description exceeds the allowed length");
  }

  const accessToken = await youtubeAccessToken(request, email);
  const start = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=id,snippet,status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(bytes.byteLength),
      "X-Upload-Content-Type": "video/mp4",
    },
    body: JSON.stringify({
      snippet: {
        title: metadata.title.trim(),
        description: metadata.description,
        tags: metadata.tags.slice(0, 20),
        categoryId: "25",
      },
      status: { privacyStatus, selfDeclaredMadeForKids: false },
    }),
    cache: "no-store",
  });
  if (!start.ok) throw new Error(`YouTube upload could not be started (${start.status})`);
  const uploadUrl = start.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube did not return a resumable upload URL");
  const parsedUploadUrl = new URL(uploadUrl);
  if (parsedUploadUrl.protocol !== "https:" ||
      !["www.googleapis.com", "youtube.googleapis.com"].includes(parsedUploadUrl.hostname)) {
    throw new Error("YouTube returned an unexpected upload URL");
  }

  const uploadBody = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(uploadBody).set(bytes);
  const uploaded = await fetch(parsedUploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "video/mp4",
    },
    body: uploadBody,
    cache: "no-store",
  });
  if (!uploaded.ok) throw new Error(`YouTube video upload failed (${uploaded.status})`);
  const result = await uploaded.json() as { id?: unknown; snippet?: { channelId?: unknown } };
  if (typeof result.id !== "string" || !result.id) throw new Error("YouTube completed the upload without returning a video ID");
  return {
    videoId: result.id,
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(result.id)}`,
    channelId: typeof result.snippet?.channelId === "string" ? result.snippet.channelId : null,
  };
}

export async function addYouTubeVideoToPlaylist(request: Request, email: string, playlistId: string, videoId: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(playlistId) || !/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) {
    throw new Error("Invalid YouTube playlist or video");
  }
  const accessToken = await youtubeAccessToken(request, email);
  const response = await fetch("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      snippet: {
        playlistId,
        resourceId: { kind: "youtube#video", videoId },
      },
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`YouTube video uploaded, but adding it to the playlist failed (${response.status})`);
  return response.json();
}

export function youtubePrivacyStatus(value: unknown): YouTubePrivacyStatus | null {
  return typeof value === "string" && PRIVACY_STATUSES.has(value) ? value as YouTubePrivacyStatus : null;
}
