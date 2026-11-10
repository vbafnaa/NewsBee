const MODEL = "minimax/h3-max/text-to-video";
const QUEUE_URL = `https://queue.fal.run/${MODEL}`;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export type FalVideoStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

function apiKey(override?: string | null) {
  const key = override?.trim();
  if (!key) throw new ExecutionBlocked("Add your personal fal.ai API key in Environment & API settings.");
  return key;
}

async function falJson<T>(url: string, init?: RequestInit, override?: string | null): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Key ${apiKey(override)}`, ...init?.headers },
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`fal.ai request failed (${response.status}): ${detail}`);
  }
  return response.json() as Promise<T>;
}

export function falVideoConfigured(override?: string | null) {
  return Boolean(override?.trim());
}

export function falVideoModel() {
  return MODEL;
}

export async function submitFalVideo(prompt: string, key?: string | null) {
  const result = await falJson<{ request_id?: string }>(QUEUE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      aspect_ratio: "9:16",
      duration: 15,
      resolution: "768P",
      enable_safety_checker: true,
      prompt_expansion_mode: "disabled",
    }),
  }, key);
  if (!result.request_id) throw new Error("fal.ai did not return a video request ID");
  return result.request_id;
}

export async function falVideoStatus(requestId: string, key?: string | null) {
  const result = await falJson<{ status?: string; error?: string }>(
    `${QUEUE_URL}/requests/${encodeURIComponent(requestId)}/status`, undefined, key,
  );
  const status = result.status;
  if (status !== "IN_QUEUE" && status !== "IN_PROGRESS" && status !== "COMPLETED" && status !== "FAILED") {
    throw new Error("fal.ai returned an unknown video status");
  }
  return { status: status as FalVideoStatus, error: result.error ?? null };
}

export async function falVideoResult(requestId: string, key?: string | null) {
  const result = await falJson<{ video?: { url?: string; content_type?: string } }>(
    `${QUEUE_URL}/requests/${encodeURIComponent(requestId)}`, undefined, key,
  );
  const url = result.video?.url;
  if (!url) throw new Error("fal.ai completed without returning a video URL");
  const parsed = new URL(url);
  const falMediaHost = parsed.hostname.endsWith(".fal.media");
  const falStorageHost = parsed.hostname === "storage.googleapis.com" && parsed.pathname.startsWith("/falserverless/");
  if (parsed.protocol !== "https:" || (!falMediaHost && !falStorageHost)) {
    throw new Error("fal.ai returned a video URL outside its media domain");
  }
  const response = await fetch(parsed, { cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error(`fal.ai video download failed (${response.status})`);
  const size = Number(response.headers.get("content-length") ?? 0);
  if (size > MAX_VIDEO_BYTES) throw new Error("Generated video exceeds the 100 MB download limit");
  const mimeType = response.headers.get("content-type")?.split(";")[0] ?? result.video?.content_type ?? "";
  if (mimeType !== "video/mp4") throw new Error("fal.ai did not return an MP4 video");
  if (!response.body) throw new Error("fal.ai video response has no content");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_VIDEO_BYTES) {
      await reader.cancel();
      throw new Error("Generated video exceeds the 100 MB download limit");
    }
    chunks.push(value);
  }
  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { content, mimeType };
}
import { ExecutionBlocked } from "../core/execution-errors";
