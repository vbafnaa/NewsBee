/**
 * Run-time source discovery results, cached in MongoDB (never in code). Each entry is a list
 * of discovered items for one scope (a location id or a state code) and kind. Good results
 * are reused for `ttlDays`; failed or empty discoveries are retried after an hour, so a
 * temporary outage never leaves a location without sources for long.
 */
import type { Db } from "mongodb";

export const DISCOVERED_SOURCES = "discovered_sources";
export const RETRY_MS = 3600_000;
export type Provenance = { method: string; detail?: string };
export type DiscoveryEntry<T> = { _id: string; scope: string; kind: string; items: T[]; refreshed_at: string; ok: boolean; detail: string | null };

export function discoveredSources<T>(db: Db) { return db.collection<DiscoveryEntry<T>>(DISCOVERED_SOURCES); }

export async function cachedDiscovery<T>(db: Db, scope: string, kind: string, ttlDays: number, build: () => Promise<{ items: T[]; detail?: string | null }>): Promise<DiscoveryEntry<T>> {
  const collection = discoveredSources<T>(db);
  const _id = `${scope}:${kind}`;
  const cached = await collection.findOne({ _id });
  const age = cached ? Date.now() - Date.parse(cached.refreshed_at) : Infinity;
  const fresh = cached && (cached.ok && cached.items.length ? age < ttlDays * 86400_000 : age < RETRY_MS);
  if (cached && fresh) return cached;
  let entry: DiscoveryEntry<T>;
  try {
    const { items, detail } = await build();
    entry = { _id, scope, kind, items, refreshed_at: new Date().toISOString(), ok: true, detail: detail ?? null };
  } catch (error) {
    // Keep serving the last good items while discovery is failing.
    entry = { _id, scope, kind, items: cached?.items ?? [], refreshed_at: new Date().toISOString(), ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  await collection.replaceOne({ _id }, entry, { upsert: true });
  return entry;
}

/** Editors can drop a discovered item; it stays excluded on later discoveries. */
export async function rejectDiscovered(db: Db, scope: string, kind: string, url: string) {
  await db.collection("discovered_source_rejections").updateOne({ _id: `${scope}:${kind}:${url}` as never }, { $set: { scope, kind, url, rejected_at: new Date().toISOString() } }, { upsert: true });
  // Discovered items carry their address as `feed` (feeds) or `url` (other sources).
  await discoveredSources<{ url?: string; feed?: string }>(db).updateOne({ _id: `${scope}:${kind}` }, { $pull: { items: { $or: [{ url }, { feed: url }] } } } as never);
}
export async function rejectedUrls(db: Db, scope: string, kind: string): Promise<Set<string>> {
  const rows = await db.collection<{ url: string }>("discovered_source_rejections").find({ scope, kind }).toArray();
  return new Set(rows.map((row) => row.url));
}
