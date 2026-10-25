import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { httpsLink } from "./common";
import type { HttpTransport } from "../core/http";

function privateAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  return !/^[23][0-9a-f]{0,3}:/i.test(address) || /^2001:db8:/i.test(address);
}

/** Publishers whose terms or robots.txt forbid automated or AI use of their content. */
const NO_AUTOMATED_USE = /(?:^|\.)(?:seattletimes\.com|kuow\.org|mynorthwest\.com)$/i;

export async function assertPublicReportingUrl(raw: string) {
  const url = new URL(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!httpsLink(raw) || (url.port && url.port !== "443") || hostname === "localhost" || hostname.endsWith(".local")) throw new Error("Source URL must use public HTTPS");
  if (NO_AUTOMATED_USE.test(hostname)) throw new Error("Publisher does not permit automated or AI use");
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new Error("Source URL resolves to a non-public address");
}

/** Validate every request's destination, keeping each request's own timeout. */
export function publicOnlyTransport(transport: HttpTransport): HttpTransport {
  return async (request) => {
    await assertPublicReportingUrl(request.url);
    return transport(request);
  };
}

/** Validate every request, including robots and redirect hops, not just the initial link. */
export function publicSourceTransport(transport: HttpTransport, timeoutMs = 8000): HttpTransport {
  return publicOnlyTransport((request) => transport({ ...request, timeoutMs }));
}
