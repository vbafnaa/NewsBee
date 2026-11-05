/**
 * The decision log: who chose what, when and why, for every step in a run that items and
 * sources don't already record (queries, search results, candidates, access checks, agent
 * choices). The source map page's funnel and item trails read it. It has no expiry, so a run
 * keeps its record after items (90 days) and page text (30 days) are gone.
 */
import type { Db } from "mongodb";
import { runContext } from "../core/run-options";

export const RUN_DECISIONS = "run_decisions";
export type DecisionActor = "rule" | "model" | "classifier" | "agent" | "human" | "provider" | "reader";
export type DecisionStage = "query" | "result" | "fetch" | "source" | "plan" | "collect" | "topic";
export type Decision = {
  run_id: string;
  location_id: string;
  at: number;
  stage: DecisionStage;
  actor: DecisionActor;
  /** The URL, source id, query or topic this is about. */
  subject: string;
  decision: string;
  reason: string | null;
  rule?: string | null;
  topic?: string | null;
  evidence?: Record<string, unknown> | null;
  model?: string | null;
  cost_estimate?: number | null;
  /** Rules exploration or relaxed let through. */
  would_have_blocked?: string[];
};
export function runDecisions(db: Db) { return db.collection<Decision>(RUN_DECISIONS); }
export async function ensureDecisionIndexes(db: Db) {
  await runDecisions(db).createIndexes([{ key: { run_id: 1, stage: 1, at: 1 } }, { key: { run_id: 1, subject: 1 } }]);
}

/** Record many decisions in one write. */
export async function recordDecisions(values: Array<Omit<Decision, "run_id" | "location_id" | "at">>) {
  const context = runContext();
  if (!context || !values.length) return;
  const at = Date.now() / 1000;
  await runDecisions(context.db).insertMany(values.map((value) => ({ ...value, run_id: context.runId, location_id: context.locationId, at }))).catch(() => undefined);
}

/** Record one decision for the current run. Never fails the work it describes. */
export async function recordDecision(value: Omit<Decision, "run_id" | "location_id" | "at">) {
  const context = runContext();
  if (!context) return;
  await runDecisions(context.db).insertOne({ ...value, run_id: context.runId, location_id: context.locationId, at: Date.now() / 1000 }).catch(() => undefined);
}
