/**
 * Running discovery: which methods are due for a location, running one, and what each last
 * found (`discovery_state`, shown on the portal's Discovery page), in total and per category.
 * What a method finds is saved through the shared Model check (./gemini-check.ts), like the
 * agent's finds. A failed method keeps the sources it found before and is retried after an hour.
 * A test-mode run (NEWSBEE_SOURCE_RUNS_ISOLATED) runs every method and doesn't touch `discovery_state`.
 */
import type { Db } from "mongodb";
import { METHODS, methodDefinition, type DiscoveryContext } from "./methods";
import type { SourceCandidate } from "../sourcemap/store";
import { checkAndSave, type CheckCounts } from "./gemini-check";
import { JOB_DEADLINE_MS } from "./evaluate";
import { CATEGORIES } from "../sourcemap/sections";
import { isolatedRunId } from "../core/run-options";
import { logDiscoveredSources } from "../orchestration/source-log";

export const DISCOVERY_STATE = "discovery_state";
export const RETRY_AFTER_FAILURE_MS = 3600_000;
/** Time the model check may take after a method, before it leaves the rest for the final review. */
const CHECK_MS = 80_000;

export type DiscoveryState = {
  _id: string;
  location_id: string;
  method: string;
  label: string;
  last_run_at: number;
  ok: boolean;
  found: number;
  added: number;
  /** What it found in each of the ten categories, and how many of those are links only. */
  by_category?: CategoryCounts;
  /** What the model check made of its finds. */
  gemini?: CheckCounts;
  detail: string;
  next_due_at: number;
};
export type CategoryCounts = Partial<Record<typeof CATEGORIES[number], { found: number; link_only: number }>>;

/** Candidates per category. Weather isn't a category, so it isn't counted. */
export function countByCategory(candidates: SourceCandidate[]): CategoryCounts {
  const out: CategoryCounts = {};
  for (const candidate of candidates) {
    const category = CATEGORIES.find((id) => id === candidate.section);
    if (!category) continue;
    const row = out[category] ?? { found: 0, link_only: 0 };
    row.found += 1;
    if (candidate.link_only) row.link_only += 1;
    out[category] = row;
  }
  return out;
}

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
    const { added, counts } = await checkAndSave(context, candidates, { route: method, deadline: Math.max(Date.now(), started + JOB_DEADLINE_MS) + CHECK_MS });
    logDiscoveredSources(context.location.name, definition.label, candidates, added);
    const judged = counts.judged ? `; Model check: ${counts.accepted} accepted, ${counts.rejected} rejected` : "";
    const left = counts.unjudged ? `; ${counts.unjudged} not judged` : "";
    state = { _id: `${context.location.id}:${method}`, location_id: context.location.id, method, label: definition.label, last_run_at: started / 1000, ok: true, found: candidates.length, added, by_category: countByCategory(candidates), gemini: counts, detail: `${detail}${judged}${left}`, next_due_at: (started + definition.refreshDays * 86400_000) / 1000 };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    context.log.warn("discovery_method_failed", { location_id: context.location.id, method, error: detail });
    state = { _id: `${context.location.id}:${method}`, location_id: context.location.id, method, label: definition.label, last_run_at: started / 1000, ok: false, found: 0, added: 0, detail, next_due_at: (started + RETRY_AFTER_FAILURE_MS) / 1000 };
  }
  // A test-mode run leaves the location's discovery record alone: what it found is in its own decision log.
  if (!isolatedRunId()) await discoveryState(context.db).replaceOne({ _id: state._id }, state, { upsert: true });
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
