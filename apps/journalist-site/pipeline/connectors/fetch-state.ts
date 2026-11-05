/**
 * What fetchers share between function calls, kept in MongoDB once the pipeline turns it on:
 * robots.txt for 24 hours, the next time each host may be asked (so parallel workers stay
 * polite), and recent pages with their validators, so a repeat read is reused or costs one short
 * conditional request. Without it (tests, one-off tools) fetchers keep to their own process.
 */
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { Binary, type Db } from "mongodb";

const ROBOTS = "robots_cache";
const PACE = "host_pace";
const PAGES = "page_cache";
const ROBOTS_MS = 24 * 3600_000;
/** Longer than the week between editions, so a repeat read can be conditional. */
const PAGE_MS = 8 * 86400_000;
/** A page read this recently is the same page: discovery, collection and evidence share it. */
export const PAGE_REUSE_MS = 30 * 60_000;
const MAX_CACHED_BYTES = 1024 * 1024;

export type SavedRobots = { kind: "rules" | "none" | "disallow-all"; text: string | null };
export type SavedPage = { body: Uint8Array; headers: Record<string, string>; etag: string | null; lastModified: string | null; fetchedAt: number };
type RobotsDoc = { _id: string; kind: SavedRobots["kind"]; text: string | null; expires_at: Date };
type PaceDoc = { _id: string; next_at: number; expires_at: Date };
type PageDoc = { _id: string; url: string; body: Binary; headers: Record<string, string>; etag: string | null; last_modified: string | null; fetched_at: number; expires_at: Date };

let shared: Db | null = null;

export function shareFetchState(db: Db) { shared = db; }
export function fetchStateShared() { return shared !== null; }

export async function ensureFetchStateIndexes(db: Db) {
  for (const name of [ROBOTS, PACE, PAGES]) await db.collection(name).createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
}

function pageKey(url: string, accept: string) { return createHash("sha256").update(`${accept}\n${url}`).digest("hex"); }

export async function savedRobots(origin: string): Promise<SavedRobots | null> {
  if (!shared) return null;
  const doc = await shared.collection<RobotsDoc>(ROBOTS).findOne({ _id: origin }).catch(() => null);
  return doc ? { kind: doc.kind, text: doc.text } : null;
}

export async function saveRobots(origin: string, value: SavedRobots) {
  await shared?.collection<RobotsDoc>(ROBOTS).replaceOne({ _id: origin }, { ...value, expires_at: new Date(Date.now() + ROBOTS_MS) }, { upsert: true }).catch(() => undefined);
}

/** Reserve the host's next turn; returns how long to wait for it, or null to pace in this process only. */
export async function reserveHost(host: string, intervalMs: number): Promise<number | null> {
  if (!shared) return null;
  const current = Date.now();
  try {
    const before = await shared.collection<PaceDoc>(PACE).findOneAndUpdate(
      { _id: host },
      [{ $set: { next_at: { $add: [{ $max: [current, { $ifNull: ["$next_at", 0] }] }, intervalMs] }, expires_at: new Date(current + 3600_000) } }],
      { upsert: true, returnDocument: "before" },
    );
    return Math.max(0, (before?.next_at ?? 0) - current);
  } catch { return null; }
}

export async function savedPage(url: string, accept: string): Promise<SavedPage | null> {
  if (!shared) return null;
  const doc = await shared.collection<PageDoc>(PAGES).findOne({ _id: pageKey(url, accept) }).catch(() => null);
  if (!doc) return null;
  try {
    return { body: new Uint8Array(gunzipSync(doc.body.buffer)), headers: doc.headers, etag: doc.etag, lastModified: doc.last_modified, fetchedAt: doc.fetched_at };
  } catch { return null; }
}

export async function savePage(url: string, accept: string, body: Uint8Array, headers: Record<string, string>) {
  if (!shared || body.byteLength > MAX_CACHED_BYTES) return;
  await shared.collection<PageDoc>(PAGES).replaceOne({ _id: pageKey(url, accept) }, {
    url, body: new Binary(gzipSync(body)), headers, etag: headers.etag ?? null, last_modified: headers["last-modified"] ?? null, fetched_at: Date.now(),
    // With no validator it can't be asked about later, so it's kept only for this run's repeat reads.
    expires_at: new Date(Date.now() + (headers.etag || headers["last-modified"] ? PAGE_MS : 2 * PAGE_REUSE_MS)),
  }, { upsert: true }).catch(() => undefined);
}

/** The server said the page hasn't changed: it counts as freshly read. */
export async function touchPage(url: string, accept: string) {
  await shared?.collection<PageDoc>(PAGES).updateOne({ _id: pageKey(url, accept) }, { $set: { fetched_at: Date.now(), expires_at: new Date(Date.now() + PAGE_MS) } }).catch(() => undefined);
}
