/**
 * Running discovery: which methods are due for a location, running one, and what each last
 * found (`discovery_state`, shown on the portal's Discovery page). A failed method keeps the
 * sources it found before and is retried after an hour.
 */
import type { Db } from "mongodb";
import { METHODS, methodDefinition, type DiscoveryContext } from "./methods";
import { upsertCandidates } from "../sourcemap/store";
import { logDiscoveredSources } from "../orchestration/source-log";

export const DISCOVERY_STATE = "discovery_state";
export const RETRY_AFTER_FAILURE_MS = 3600_000;

export type DiscoveryState = {
  _id: string;
  location_id: string;
  method: string;
  label: string;
  last_run_at: number;
  ok: boolean;
  found: number;
  added: number;
  detail: string;
  next_due_at: number;
};

export function discoveryState(db: Db) { return db.collection<DiscoveryState>(DISCOVERY_STATE); }

export async function dueMethods(db: Db, locationId: string, now = Date.now()) {
  const states = await discoveryState(db).find({ location_id: locationId }).toArray();
  const byMethod = new Map(states.map((state) => [state.method, state]));
  return METHODS.filter((definition) => {
    const state = byMethod.get(definition.method);
    return !state || state.next_due_at * 1000 <= now;
  }).map((definition) => definition.method);
}

export async function runMethod(context: DiscoveryContext, method: string) {
  const definition = methodDefinition(method);
  if (!definition) throw new Error(`Unknown discovery method: ${method}`);
  const started = Date.now();
  let state: DiscoveryState;
  try {
    const { candidates, detail } = await definition.run(context);
    const added = await upsertCandidates(context.db, context.location.id, candidates);
    logDiscoveredSources(context.location.name, definition.label, candidates, added);
    state = { _id: `${context.location.id}:${method}`, location_id: context.location.id, method, label: definition.label, last_run_at: started / 1000, ok: true, found: candidates.length, added, detail, next_due_at: (started + definition.refreshDays * 86400_000) / 1000 };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    context.log.warn("discovery_method_failed", { location_id: context.location.id, method, error: detail });
    state = { _id: `${context.location.id}:${method}`, location_id: context.location.id, method, label: definition.label, last_run_at: started / 1000, ok: false, found: 0, added: 0, detail, next_due_at: (started + RETRY_AFTER_FAILURE_MS) / 1000 };
  }
  await discoveryState(context.db).replaceOne({ _id: state._id }, state, { upsert: true });
  return state;
}

/** Makes every method (or one) due now: the editor's "Refresh sources". */
export async function refreshDiscovery(db: Db, locationId: string, method?: string) {
  await discoveryState(db).updateMany({ location_id: locationId, ...(method ? { method } : {}) }, { $set: { next_due_at: 0 } });
}

export async function locationDiscovery(db: Db, locationId: string) {
  const states = await discoveryState(db).find({ location_id: locationId }).toArray();
  return METHODS.map((definition) => states.find((state) => state.method === definition.method) ?? { method: definition.method, label: definition.label, location_id: locationId, never_run: true, refresh_days: definition.refreshDays });
}
