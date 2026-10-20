import { createHmac, timingSafeEqual } from "node:crypto";

export function authorizedPipelineRequest(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Short-lived, server-only authorization for the portal's one-job-per-call chain. */
export function jobChainToken(secret: string, at = Date.now()) {
  const stamp = String(at);
  return `${stamp}.${createHmac("sha256", secret).update(`pipeline-advance:${stamp}`).digest("hex")}`;
}

export function authorizedJobChain(request: Request, secret = process.env.AUTH_SECRET) {
  if (!secret) return false;
  const token = request.headers.get("x-newsbee-job-token") ?? "";
  const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(token);
  if (!match || Math.abs(Date.now() - Number(match[1])) > 120_000) return false;
  const expected = Buffer.from(jobChainToken(secret, Number(match[1])));
  const actual = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
