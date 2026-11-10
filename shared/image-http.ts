import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { safeImageUrl } from "./story-image";

type Address = { address: string; family: number };
export type PublicImageRequest = {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  allowedContentTypes?: readonly string[];
};
export type PublicImageResponse = { url: string; status: number; headers: Record<string, string>; body: Uint8Array };

/** Public global addresses only; exclude local, reserved and IPv6 transition networks. */
export function isPublicImageAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const groups = address.toLowerCase().split(":");
  const first = Number.parseInt(groups[0], 16);
  const second = Number.parseInt(groups[1] || "0", 16);
  return first >= 0x2000 && first < 0x3fff && first !== 0x2002
    && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8));
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Image request timed out"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function publicAddress(url: URL, signal: AbortSignal): Promise<Address> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }]
    : await untilAborted(lookup(hostname, { all: true, verbatim: true }), signal);
  if (!addresses.length || addresses.some((entry) => !isPublicImageAddress(entry.address))) {
    throw new Error("Image host is not public");
  }
  // IPv4 remains reachable on hosts without an IPv6 route, even when DNS returns IPv6 first.
  return addresses.find((entry) => entry.family === 4) ?? addresses[0];
}

/** One bounded, DNS-pinned HTTPS GET. Redirects are returned for caller revalidation. */
export async function publicHttpsGet(input: PublicImageRequest): Promise<PublicImageResponse> {
  const safe = safeImageUrl(input.url);
  if (!safe) throw new Error("Image URL is invalid");
  const url = new URL(safe);
  const deadline = AbortSignal.timeout(input.timeoutMs ?? 8_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const address = await publicAddress(url, signal);
  const limit = input.maxBytes ?? 6 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      agent: false,
      signal,
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [address]) : callback(null, address.address, address.family),
      headers: { "Accept-Encoding": "identity", "User-Agent": "Newsbee-Image/1.0", ...input.headers },
    }, (response) => {
      const status = response.statusCode ?? 0;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      if ([301, 302, 303, 307, 308].includes(status)) {
        resolve({ url: safe, status, headers, body: new Uint8Array() });
        response.destroy();
        return;
      }
      const contentType = (headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if ((input.allowedContentTypes && (status !== 200 || !input.allowedContentTypes.includes(contentType)))
        || Number(headers["content-length"] ?? 0) > limit
        || (headers["content-encoding"] && headers["content-encoding"] !== "identity")) {
        reject(new Error("Image response has an unsupported type or size"));
        response.destroy();
        return;
      }
      let length = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > limit) {
          reject(new Error("Image exceeds the size limit"));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("Image response was interrupted")));
      response.on("end", () => resolve({ url: safe, status, headers, body: Buffer.concat(chunks, length) }));
    });
    req.on("error", reject);
    req.end();
  });
}
