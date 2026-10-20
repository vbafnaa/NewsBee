/**
 * Swappable HTTP transport. Connectors never call fetch directly, so integration tests can
 * replay recorded source responses (see tests/support/replay.ts).
 */

export type HttpRequest = {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Maximum response body size in bytes; larger bodies are rejected while streaming. */
  maxBytes?: number;
};

export type HttpResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
};

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export class ResponseTooLargeError extends Error {}

export class HttpStatusError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} from ${url}`);
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** fetch-based transport; redirects are returned, not followed, so callers can vet each hop. */
export const fetchTransport: HttpTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method ?? "GET",
    headers: request.headers,
    body: request.body,
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const limit = request.maxBytes ?? Number.POSITIVE_INFINITY;
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    await response.body?.cancel();
    throw new ResponseTooLargeError(`Response exceeds ${limit} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ResponseTooLargeError(`Response exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { url: request.url, status: response.status, headers, body };
};

export function text(response: HttpResponse) {
  return new TextDecoder().decode(response.body);
}

export function json<T = unknown>(response: HttpResponse): T {
  return JSON.parse(text(response)) as T;
}

export function isRedirect(status: number) {
  return [301, 302, 303, 307, 308].includes(status);
}
