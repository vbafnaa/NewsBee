/**
 * The paid-call gateway. Every paid call asks here first: the run must allow the service and
 * have budget left. A refused call is skipped and logged, and the run continues with what it
 * has. Free external APIs are logged too, and can be switched off per run.
 *
 * Outside a run (an editor's one-off action), existing services work as they always have and
 * new paid services stay off.
 */
import type { Db } from "mongodb";
import { FREE_SERVICES, PAID_SERVICES, LEGACY_OPTIONS, currentOptions, runContext, type FreeService, type PaidService } from "../core/run-options";
import type { HttpTransport } from "../core/http";
import { safeError } from "../core/redaction";

export const API_CALLS = "api_calls";
export type ApiCall = {
  run_id: string | null; location_id: string | null; service: string; paid: boolean; units: number; outcome: "ok" | "failed" | "skipped"; detail: string | null;
  cost_estimate: number | null; created_at: number;
};
export function apiCalls(db: Db) { return db.collection<ApiCall>(API_CALLS); }
const RUN_BUDGETS = "run_budgets";
type RunBudget = { _id: string; used: number; expires_at: Date };
export async function ensureApiCallIndexes(db: Db) {
  await apiCalls(db).createIndexes([{ key: { run_id: 1, service: 1 } }, { key: { created_at: -1 } }]);
  await db.collection<RunBudget>(RUN_BUDGETS).createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
}

/** Take one call from the run's budget in a single write, so parallel jobs can't overspend it. */
async function takeFromBudget(db: Db, runId: string, service: PaidService, allowance: number) {
  try {
    const taken = await db.collection<RunBudget>(RUN_BUDGETS).updateOne(
      { _id: `${runId}:${service}`, used: { $lt: allowance } },
      { $inc: { used: 1 }, $set: { expires_at: new Date(Date.now() + 30 * 86400_000) } },
      { upsert: allowance > 0 },
    );
    return taken.modifiedCount + taken.upsertedCount > 0;
  } catch (error) {
    // The upsert found the budget already spent.
    if ((error as { code?: number }).code === 11000) return false;
    throw error;
  }
}

const LABELS = Object.fromEntries(PAID_SERVICES.map((service) => [service.id, service.label])) as Record<PaidService, string>;

export async function logApiCall(service: string, paid: boolean, outcome: ApiCall["outcome"], detail: string | null = null, cost: number | null = null, units = 1) {
  const context = runContext();
  if (!context) return;
  await apiCalls(context.db).insertOne({ run_id: context.runId, location_id: context.locationId, service, paid, units, outcome, detail: detail ? safeError(detail) : null, cost_estimate: cost, created_at: Date.now() / 1000 }).catch(() => undefined);
}

/** Why a paid call may not happen now, or null when it may, which takes it from the budget. A refusal is logged. */
export async function paidRefusal(service: PaidService): Promise<string | null> {
  const context = runContext();
  const allowance = (context ? context.options : LEGACY_OPTIONS).paid[service];
  if (allowance === undefined) {
    const reason = `${LABELS[service]} is not ticked for this run`;
    await logApiCall(service, true, "skipped", reason);
    return reason;
  }
  if (!context) return null;
  // A rejected key won't start working mid-run: stop now rather than spend the budget failing.
  const rejected = await apiCalls(context.db).findOne({ run_id: context.runId, service, outcome: "failed", detail: { $regex: "HTTP 40[13]\\b" } });
  if (rejected) {
    const reason = `${LABELS[service]} rejected the key (${rejected.detail}): fix the key and rerun`;
    await logApiCall(service, true, "skipped", reason);
    return reason;
  }
  if (!await takeFromBudget(context.db, context.runId, service, allowance)) {
    const reason = `${LABELS[service]} reached this run's budget of ${allowance} calls`;
    await logApiCall(service, true, "skipped", reason);
    return reason;
  }
  return null;
}

/** Run one paid call through the gate. Returns null with the reason when it was refused. */
export async function paidCall<T>(service: PaidService, call: () => Promise<T>, cost?: (result: T) => number | null): Promise<{ value: T | null; refused: string | null }> {
  const refused = await paidRefusal(service);
  if (refused) return { value: null, refused };
  try {
    const value = await call();
    await logApiCall(service, true, "ok", null, cost?.(value) ?? null);
    return { value, refused: null };
  } catch (error) {
    await logApiCall(service, true, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** The paid service behind a model provider, or null for a local one. */
export function modelService(providerKind: string, role: string): PaidService | null {
  if (providerKind === "ollama") return null;
  if (role === "agent") return "agent_model";
  return providerKind.startsWith("gemini") ? "gemini" : "openai_compatible";
}

function freeServiceFor(url: string): FreeService | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (FREE_SERVICES.find((service) => (service.hosts as readonly string[]).some((name) => host === name || host.endsWith(`.${name}`)))?.id as FreeService | undefined) ?? null;
  } catch { return null; }
}

/** Logs free external API calls, and refuses those switched off for the run. */
export function externalTransport(transport: HttpTransport): HttpTransport {
  return async (request) => {
    const service = freeServiceFor(request.url);
    if (!service) return transport(request);
    if (currentOptions().external_off.includes(service)) {
      await logApiCall(service, false, "skipped", "switched off for this run");
      throw new Error(`${service} is switched off for this run`);
    }
    try {
      const response = await transport(request);
      await logApiCall(service, false, response.status < 400 ? "ok" : "failed", response.status < 400 ? null : `HTTP ${response.status}`);
      return response;
    } catch (error) {
      await logApiCall(service, false, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
}
