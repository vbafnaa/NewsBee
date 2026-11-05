import { createHash } from "node:crypto";

export type Group = { id: string; name: string; url: string; createdAt: string };
export type Scan = { sort: "CHRONOLOGICAL" | "RECENT_ACTIVITY"; status: "complete" | "partial" | "failed"; reason: string | null; postRefs: string[] };
export type PostInput = {
  ref: string; id: string | null; text: string; permalink: string | null; sourceLinks: string[];
  publishedAt: string | null; rawTime: string | null; observedAt: string;
  commentCount: number | null; reactions: { total: number | null; kinds: string[]; counts: Record<string, number> };
  contentVerified: boolean; truncated: boolean;
};
export type ReportInput = {
  runTime: string; windowStart: string; windowEnd: string; status: "complete" | "partial" | "failed";
  scans: Scan[]; posts: PostInput[]; issues: string[];
};

export class InputError extends Error {}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const required = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new InputError(`${name} must be a nonempty string of at most ${max} characters`);
  return value.trim();
};
const nullable = (value: unknown, name: string, max: number): string | null => value == null ? null : required(value, name, max);
const iso = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new InputError(`${name} must be an ISO-8601 UTC timestamp`);
  }
  return new Date(value).toISOString();
};
const count = (value: unknown, name: string): number | null => {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new InputError(`${name} must be a nonnegative integer or null`);
  return value as number;
};
const status = (value: unknown, name: string): ReportInput["status"] => {
  if (value !== "complete" && value !== "partial" && value !== "failed") throw new InputError(`${name} must be complete, partial, or failed`);
  return value;
};
function httpUrl(value: unknown, name: string, facebook = false): string {
  const text = required(value, name, 2048);
  let url: URL;
  try { url = new URL(text); } catch { throw new InputError(`${name} must be a URL`); }
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || (facebook && (url.protocol !== "https:" || !["facebook.com", "www.facebook.com", "m.facebook.com"].includes(url.hostname.toLowerCase())))) {
    throw new InputError(`${name} must be ${facebook ? "a Facebook HTTPS" : "an HTTP(S)"} URL`);
  }
  return url.href;
}
export function validateGroup(value: unknown): { name: string; url: string } {
  if (!record(value)) throw new InputError("Expected a JSON object");
  const url = httpUrl(value.url, "url", true);
  const path = new URL(url).pathname;
  if (!/^\/groups\/[a-zA-Z0-9._-]+\/?$/.test(path)) throw new InputError("url must link to a Facebook group");
  const name = required(value.name, "name", 120);
  if (/[\r\n\x00-\x1f]/.test(name)) throw new InputError("name must not contain control characters");
  return { name, url: `https://www.facebook.com${path.replace(/\/$/, "")}` };
}
function stringArray(value: unknown, name: string, limit: number, maxLength = 300): string[] {
  if (!Array.isArray(value) || value.length > limit) throw new InputError(`${name} must be an array of at most ${limit} strings`);
  return value.map((item, i) => required(item, `${name}[${i}]`, maxLength));
}
export function validateReport(value: unknown): ReportInput {
  if (!record(value)) throw new InputError("Expected a JSON object");
  const runTime = iso(value.runTime, "runTime");
  const windowStart = iso(value.windowStart, "windowStart");
  const windowEnd = iso(value.windowEnd, "windowEnd");
  if (windowEnd !== runTime || Date.parse(windowEnd) - Date.parse(windowStart) !== 3_600_000) throw new InputError("window must cover exactly one hour ending at runTime");
  if (!Array.isArray(value.scans) || value.scans.length !== 2 || !Array.isArray(value.posts) || value.posts.length > 500) throw new InputError("Expected exactly two scans and at most 500 posts");
  const posts = value.posts.map((raw: unknown, i): PostInput => {
    if (!record(raw)) throw new InputError(`posts[${i}] must be an object`);
    const reactions = raw.reactions;
    if (!record(reactions) || !record(reactions.counts)) throw new InputError(`posts[${i}].reactions is required`);
    const kinds = stringArray(reactions.kinds, "reactions.kinds", 12);
    const counts: Record<string, number> = {};
    for (const [kind, amount] of Object.entries(reactions.counts)) {
      if (!kinds.includes(kind) || count(amount, `reactions.counts.${kind}`) === null) throw new InputError("Reaction counts must be numbers for listed kinds");
      counts[kind] = amount as number;
    }
    if (typeof raw.contentVerified !== "boolean" || typeof raw.truncated !== "boolean") throw new InputError("contentVerified and truncated must be booleans");
    const publishedAt = raw.publishedAt == null ? null : iso(raw.publishedAt, "publishedAt");
    const links = stringArray(raw.sourceLinks, "sourceLinks", 8, 2048).map((link) => httpUrl(link, "sourceLink"));
    return {
      ref: required(raw.ref, "ref", 160), id: nullable(raw.id, "id", 160), text: required(raw.text, "text", 20000),
      permalink: raw.permalink == null ? null : httpUrl(raw.permalink, "permalink", true),
      sourceLinks: links, publishedAt, rawTime: nullable(raw.rawTime, "rawTime", 120), observedAt: iso(raw.observedAt, "observedAt"),
      commentCount: count(raw.commentCount, "commentCount"), reactions: { total: count(reactions.total, "reactions.total"), kinds, counts },
      contentVerified: raw.contentVerified, truncated: raw.truncated,
    };
  });
  const refs = new Set(posts.map((post) => post.ref));
  if (refs.size !== posts.length) throw new InputError("Post refs must be unique in a report");
  if (new Set(posts.map(postKey)).size !== posts.length) throw new InputError("Duplicate posts must be merged across scans");
  const scans = value.scans.map((raw: unknown, i): Scan => {
    if (!record(raw) || (raw.sort !== "CHRONOLOGICAL" && raw.sort !== "RECENT_ACTIVITY")) throw new InputError(`scans[${i}].sort is invalid`);
    const postRefs = stringArray(raw.postRefs, "postRefs", 500);
    if (new Set(postRefs).size !== postRefs.length || postRefs.some((ref) => !refs.has(ref))) throw new InputError("Scan postRefs must uniquely reference supplied posts");
    if (raw.sort === "RECENT_ACTIVITY" && postRefs.length > 10) throw new InputError("Recent-activity scan accepts at most ten posts");
    return { sort: raw.sort, status: status(raw.status, "scan status"), reason: nullable(raw.reason, "reason", 500), postRefs };
  });
  if (scans[0].sort === scans[1].sort) throw new InputError("Include one scan of each sort");
  const reportStatus = status(value.status, "status");
  if (reportStatus === "complete" && scans.some((scan) => scan.status !== "complete")) throw new InputError("A report with partial or failed scans cannot be complete");
  const issues = stringArray(value.issues, "issues", 30);
  return { runTime, windowStart, windowEnd, status: reportStatus, scans, posts, issues };
}

export function postKey(post: PostInput): string {
  const identity = post.id ? `id:${post.id}` : post.permalink ? `url:${post.permalink}` : `text:${post.text}`;
  return createHash("sha256").update(identity).digest("hex");
}
