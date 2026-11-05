import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const INTERNAL_COOKIE = "newsbee-internal";
export const INTERNAL_TTL = 8 * 60 * 60;

function digest(value: string) { return createHash("sha256").update(value).digest(); }
function signature(payload: string, password: string) {
  return createHmac("sha256", password).update(`newsbee-internal-v2:${payload}`).digest("hex");
}

export function passwordMatches(input: string, password: string | undefined) {
  return Boolean(password) && timingSafeEqual(digest(input), digest(password!));
}

export function internalToken(password: string, now = Date.now()) {
  const payload = `${Math.floor(now / 1000) + INTERNAL_TTL}.${randomBytes(16).toString("hex")}`;
  return `${payload}.${signature(payload, password)}`;
}

export function validInternalToken(token: string | undefined, password: string | undefined, now = Date.now()) {
  if (!password || !token) return false;
  const [expires, nonce, mac, extra] = token.split(".");
  const expiry = Number(expires);
  if (extra || !/^\d+$/.test(expires) || !Number.isSafeInteger(expiry) ||
      expiry <= now / 1000 || expiry > now / 1000 + INTERNAL_TTL ||
      !/^[a-f0-9]{32}$/.test(nonce ?? "") || !/^[a-f0-9]{64}$/.test(mac ?? "")) return false;
  return timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(signature(`${expires}.${nonce}`, password), "hex"));
}

export function internalReturnPath(value: unknown) {
  if (typeof value !== "string" || !/^\/(?:source-map|interest-usage)(?:\?|$)/.test(value)) return "/source-map";
  const url = new URL(value, "http://internal");
  return `${url.pathname}${url.search}`;
}
