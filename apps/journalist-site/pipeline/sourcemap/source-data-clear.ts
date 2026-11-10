/**
 * Clears explicitly selected source data for one location or all of them, so a source map can
 * be rebuilt from scratch. Each category is separate, so an owner never clears more than they
 * chose. Editions, runs, collected items, reader data and the locations themselves are never
 * touched. Refused while a run is open, because a run reads and writes the same records.
 */
import type { Db, Document } from "mongodb";
import { listLocations } from "../communities/locations";
import { AGENT_STATE } from "../agent/map-sources";
import { DISCOVERED_SOURCES } from "../discovery/cache";
import { DISCOVERY_STATE } from "../discovery/run";
import { LANDMARK_CACHE } from "../connectors/locality";
import { ACTIVE_RUN_STATUSES, runs } from "../orchestration/runs";
import { SOURCE_HEALTH } from "../orchestration/source-health";
import { SEARCH_QUERIES } from "../search/provider";
import { COLLECTIONS } from "../storage/mongo";
import { emptyHealth, PAGE_DECISIONS, runSources, SOURCE_MAP, SOURCE_REVIEWS } from "./store";
import { EDITOR_METHODS, NO_SOURCE_DATA, parseSourceClearTypes, type SourceClearCounts, type SourceClearPreview, type SourceClearRecord, type SourceClearType } from "./source-clear-scope";

const CLEARS = "source_data_clears";
const REJECTIONS = "discovered_source_rejections";

type Scope = { location_id: string | null };
const own = ({ location_id }: Scope): Document => location_id ? { location_id } : {};

/** Each category's records for a scope, so the preview counts exactly what a clear would change. */
async function filters(db: Db, scope: Scope, ids: string[]) {
  const locationIds = scope.location_id ? [scope.location_id] : ids;
  const scopedRuns = await runs(db).find({ location_id: { $in: locationIds } }, { projection: { _id: 1, kind: 1, isolated: 1 } }).toArray();
  const runIds = scopedRuns.map((run) => run._id);
  return {
    discovered: { ...own(scope), "found_by.method": { $nin: EDITOR_METHODS } },
    editor_added: { ...own(scope), "found_by.method": { $in: EDITOR_METHODS } },
    reviews: { ...own(scope), review: { $exists: true } },
    settings: { ...own(scope), $or: [{ status: { $in: ["pinned", "paused"] } }, { window: { $ne: null, $exists: true } }] },
    caches: { discovered: { scope: { $in: locationIds } }, searches: { location_id: { $in: locationIds } }, agent: { run_id: { $in: runIds } }, landmarks: { _id: { $in: locationIds } } },
    health: { ...own(scope), $or: [{ status: "dormant" }, { "health.runs": { $gt: 0 } }] },
    gemini: { ...own(scope), $or: [{ gemini: { $exists: true } }, { review_flags: { $exists: true } }] },
    /** Each test-mode source run keeps its own store, named for the run. */
    testRuns: scopedRuns.filter((run) => run.kind === "map" && run.isolated).map((run) => run._id),
  };
}

async function countFor(db: Db, scope: Scope, ids: string[]): Promise<SourceClearCounts> {
  const f = await filters(db, scope, ids);
  const count = (name: string, filter: Document) => db.collection(name).countDocuments(filter);
  const [discovered, editor_added, reviewed, history, settings, discoveredCache, rejections, searches, agent, landmarks, addresses, health, healthRows] = await Promise.all([
    count(SOURCE_MAP, f.discovered), count(SOURCE_MAP, f.editor_added), count(SOURCE_MAP, f.reviews), count(SOURCE_REVIEWS, own(scope)), count(SOURCE_MAP, f.settings),
    count(DISCOVERED_SOURCES, f.caches.discovered), count(REJECTIONS, f.caches.discovered), count(SEARCH_QUERIES, f.caches.searches), count(AGENT_STATE, f.caches.agent), count(LANDMARK_CACHE, f.caches.landmarks),
    count(COLLECTIONS.linkCache, own(scope)), count(SOURCE_HEALTH, own(scope)), count(SOURCE_MAP, f.health),
  ]);
  const testRuns = (await Promise.all(f.testRuns.map((runId) => runSources(db, runId).estimatedDocumentCount().catch(() => 0)))).reduce((sum, value) => sum + value, 0);
  return {
    discovered, editor_added, reviews: reviewed + history, settings,
    page_decisions: await count(PAGE_DECISIONS, own(scope)),
    gemini_checks: await count(SOURCE_MAP, f.gemini),
    test_runs: testRuns,
    discovery_history: await count(DISCOVERY_STATE, own(scope)),
    cached_discovery: discoveredCache + rejections + searches + agent + landmarks,
    saved_addresses: addresses, source_health: health + healthRows,
  };
}

const openRuns = (db: Db, scope: Scope) => runs(db).countDocuments({ ...own(scope), status: { $in: ACTIVE_RUN_STATUSES } });

export async function sourceClearPreview(db: Db): Promise<SourceClearPreview> {
  const locations = await listLocations(db);
  const ids = locations.map((location) => location.id);
  const rows = await Promise.all(locations.map(async (location) => ({
    ...await countFor(db, { location_id: location.id }, ids), id: location.id, name: location.name, active_run: await openRuns(db, { location_id: location.id }) > 0,
  })));
  const totals = { ...NO_SOURCE_DATA };
  for (const row of rows) for (const key of Object.keys(totals) as SourceClearType[]) totals[key] += row[key];
  const recent = await db.collection(CLEARS).find({}).sort({ at: -1 }).limit(10).toArray();
  return { totals, locations: rows, active_runs: await openRuns(db, { location_id: null }), recent: recent.map(present) };
}

function present(record: Document): SourceClearRecord {
  return {
    id: String(record._id), by: record.by, at: record.at.toISOString(), finished_at: record.finished_at?.toISOString() ?? null, status: record.status,
    scope: record.scope, location_id: record.location_id, location_name: record.location_name, data_types: record.data_types,
    deleted: { ...NO_SOURCE_DATA, ...record.deleted }, error: record.error ?? null,
  };
}

/** Reviews and labels, for keeping a copy before they're cleared. */
export async function exportReviews(db: Db, locationId: string | null) {
  const rows = await db.collection(SOURCE_MAP).find({ ...own({ location_id: locationId }), review: { $exists: true } }, { projection: { location_id: 1, source_id: 1, name: 1, url: 1, status: 1, review: 1 } }).toArray();
  const history = await db.collection(SOURCE_REVIEWS).find(own({ location_id: locationId })).toArray();
  return { exported_at: new Date().toISOString(), location_id: locationId, sources: rows, history };
}

/** Clears the chosen categories. The log entry is written first, so a failure part-way is still on record. */
export async function clearSourceData(db: Db, scope: Scope & { data_types: unknown }, by: string): Promise<SourceClearRecord> {
  const data_types = parseSourceClearTypes(scope.data_types);
  if (await openRuns(db, scope)) throw new Error("A run is open for this scope. Finish or cancel it before clearing source data.");
  const locations = await listLocations(db);
  const ids = locations.map((location) => location.id);
  if (scope.location_id && !ids.includes(scope.location_id)) throw new Error("Unknown location");
  const location_name = scope.location_id ? locations.find((location) => location.id === scope.location_id)?.name ?? scope.location_id : null;
  const log = db.collection(CLEARS);
  const deleted = { ...NO_SOURCE_DATA };
  const { insertedId } = await log.insertOne({ by, at: new Date(), status: "started", scope: scope.location_id ? "location" : "all", location_id: scope.location_id, location_name, data_types, deleted, finished_at: null });
  const finish = (status: "completed" | "failed", error?: string) => log.findOneAndUpdate({ _id: insertedId }, { $set: { status, deleted, finished_at: new Date(), ...(error ? { error } : {}) } }, { returnDocument: "after" });
  try {
    const f = await filters(db, scope, ids);
    const map = db.collection(SOURCE_MAP);
    const chosen = (type: SourceClearType) => data_types.includes(type);
    // Changes to kept rows first, then deletions, so each count is what that category changed.
    if (chosen("reviews")) deleted.reviews = (await map.updateMany(f.reviews, { $unset: { review: "" } })).modifiedCount + (await db.collection(SOURCE_REVIEWS).deleteMany(own(scope))).deletedCount;
    if (chosen("page_decisions")) deleted.page_decisions = (await db.collection(PAGE_DECISIONS).deleteMany(own(scope))).deletedCount;
    if (chosen("gemini_checks")) deleted.gemini_checks = (await map.updateMany(f.gemini, { $unset: { gemini: "", review_flags: "" } })).modifiedCount;
    if (chosen("test_runs")) {
      for (const runId of f.testRuns) {
        const store = runSources(db, runId);
        deleted.test_runs += await store.estimatedDocumentCount().catch(() => 0);
        await store.drop().catch((error: { codeName?: string }) => { if (error.codeName !== "NamespaceNotFound") throw error; });
      }
    }
    if (chosen("settings")) {
      deleted.settings = (await map.updateMany({ ...own(scope), status: { $in: ["pinned", "paused"] } }, { $set: { status: "active" } })).modifiedCount;
      deleted.settings += (await map.updateMany({ ...own(scope), window: { $ne: null, $exists: true } }, { $unset: { window: "" } })).modifiedCount;
    }
    if (chosen("source_health")) {
      deleted.source_health = (await db.collection(SOURCE_HEALTH).deleteMany(own(scope))).deletedCount;
      deleted.source_health += (await map.updateMany({ ...own(scope), status: "dormant" }, { $set: { status: "active", dormant_until: null } })).modifiedCount;
      deleted.source_health += (await map.updateMany({ ...own(scope), "health.runs": { $gt: 0 } }, { $set: { health: emptyHealth(), score: 0 } })).modifiedCount;
    }
    if (chosen("discovery_history")) deleted.discovery_history = (await db.collection(DISCOVERY_STATE).deleteMany(own(scope))).deletedCount;
    if (chosen("cached_discovery")) {
      for (const [name, filter] of [[DISCOVERED_SOURCES, f.caches.discovered], [REJECTIONS, f.caches.discovered], [SEARCH_QUERIES, f.caches.searches], [AGENT_STATE, f.caches.agent], [LANDMARK_CACHE, f.caches.landmarks]] as const) {
        deleted.cached_discovery += (await db.collection(name).deleteMany(filter as Document)).deletedCount;
      }
    }
    if (chosen("saved_addresses")) deleted.saved_addresses = (await db.collection(COLLECTIONS.linkCache).deleteMany(own(scope))).deletedCount;
    if (chosen("discovered")) deleted.discovered = (await map.deleteMany(f.discovered)).deletedCount;
    if (chosen("editor_added")) {
      deleted.editor_added = (await map.deleteMany(f.editor_added)).deletedCount;
      await db.collection(COLLECTIONS.manualLinks).deleteMany(own(scope));
    }
  } catch (error) {
    await finish("failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
  return present((await finish("completed"))!);
}
