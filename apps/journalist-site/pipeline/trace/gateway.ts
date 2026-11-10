/**
 * The paid-call gateway. Every paid call asks here first: the run must allow the service and
 * have budget left. A refused call is skipped and logged, and the run continues with what it
 * has. Free external APIs are logged too, and can be switched off per run.
 *
 * On top of each run's budget sit the hard limits for free-tier testing, from the playbook's
 * `hard_limits` set. Per-second and per-minute limits pace calls (wait), and the rest refuse
 * them. Run limits and the whole-run time apply to source map runs (Pipeline 1); hour, day and
 * month limits count every run. Each count is one conditional write that takes the call before
 * it is made, so calls running at the same time can't overshoot it, and a refused call gives
 * back what it took. Gemini's limits stop a run: the first one it reaches is kept as the reason it
 * stopped. Any other service's limit only makes that service unavailable for the rest of the run
 * (`unavailableServices`), so the agent carries on with its other tools.
 *
 * Outside a run (an editor's one-off action), existing services work as they always have and
 * new paid services stay off.
 */
import type { Db } from "mongodb";
import { FREE_SERVICES, PAID_SERVICES, LEGACY_OPTIONS, paidAllowance, currentOptions, runContext, type FreeService, type PaidService } from "../core/run-options";
import type { HttpTransport } from "../core/http";
import { safeError } from "../core/redaction";
import { limit, ruleSet } from "../playbook";

export const API_CALLS = "api_calls";
export type ApiCall = {
  run_id: string | null; location_id: string | null; service: string; paid: boolean; units: number; outcome: "ok" | "failed" | "skipped"; detail: string | null;
  cost_estimate: number | null; created_at: number;
  /** For a model call: the hard limit it counted against (`gemini` for a Gemini call), and the provider and model that served it. */
  limit?: string; provider?: string; model?: string | null;
};
/** What a model call adds to its usage record. */
export type CallSource = { limit?: string; provider?: string; model?: string | null };
export function apiCalls(db: Db) { return db.collection<ApiCall>(API_CALLS); }
const RUN_BUDGETS = "run_budgets";
type RunBudget = { _id: string; used: number; expires_at: Date; next_at?: number; limit?: string; reason?: string; at?: number };
export async function ensureApiCallIndexes(db: Db) {
  await apiCalls(db).createIndexes([{ key: { run_id: 1, service: 1 } }, { key: { created_at: -1 } }, { key: { service: 1, created_at: -1 } }]);
  await db.collection<RunBudget>(RUN_BUDGETS).createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
}
const budgets = (db: Db) => db.collection<RunBudget>(RUN_BUDGETS);

/** One service's hard limits. A per-run limit is a ceiling that stops a run cleanly, not a quota. */
export type HardLimit = {
  per_second?: number; per_minute?: number; per_hour?: number; per_run?: number; per_day?: number; per_month?: number; total?: number;
  /** A monthly spend guard in dollars, counted from each call's estimated cost. */
  spend_per_month?: number; estimated_cost?: number;
  /** Another limit whose month or total this one shares. */
  pool?: string;
  per_minute_without_key?: number;
};
/** Keyed by the rule id's last part: `general.stop.limit_gemini` is `gemini`. */
export const HARD_LIMITS: Record<string, HardLimit> = Object.fromEntries(ruleSet("hard_limits").map((rule) => [rule.id.replace(/^general\.stop\.limit_/, ""), (rule.map ?? {}) as HardLimit]));
export const RUN_MINUTES = limit("general.stop.run_minutes");
/** Gemini's free-tier day, and so every day count here, starts at midnight Pacific. */
const LIMIT_ZONE = "America/Los_Angeles";

/** The Pacific day and month, and when that day and month started. */
export function limitWindow(now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: LIMIT_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(now).map((part) => [part.type, part.value]));
  const offset = String(parts.timeZoneName).replace("GMT", "") || "+00:00";
  const day = `${parts.year}-${parts.month}-${parts.day}`, month = `${parts.year}-${parts.month}`;
  return { day, month, hour: `${day}T${parts.hour}`, dayStart: Date.parse(`${day}T00:00:00${offset}`) / 1000, monthStart: Date.parse(`${month}-01T00:00:00${offset}`) / 1000, hourStart: Date.parse(`${day}T${parts.hour}:00:00${offset}`) / 1000 };
}

const isDuplicate = (error: unknown) => (error as { code?: number }).code === 11000;

/**
 * Take `units` from a count in one conditional write. A count that doesn't exist yet is created
 * first, from `seed` (what the usage records already show for its window), and only one
 * creation can win, so two first calls can't both see an empty count.
 */
async function take(db: Db, id: string, ceiling: number, units: number, expires: Date, seed: () => Promise<number> = async () => 0): Promise<boolean> {
  if (units > ceiling) return false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const taken = await budgets(db).updateOne({ _id: id, used: { $lte: ceiling - units } }, { $inc: { used: units }, $set: { expires_at: expires } });
    if (taken.modifiedCount) return true;
    // Full, or created by another call since: only a count that is really full refuses.
    const found = await budgets(db).findOne({ _id: id }, { projection: { used: 1 } });
    if (found) { if (found.used > ceiling - units) return false; continue; }
    try { await budgets(db).insertOne({ _id: id, used: await seed(), expires_at: expires }); }
    catch (error) { if (!isDuplicate(error)) throw error; }
  }
  return false;
}
const giveBack = (db: Db, id: string, units: number) => budgets(db).updateOne({ _id: id }, { $inc: { used: -units } }).catch(() => undefined);

/** What the usage records show for a service or limit since `since` (seconds), so a new count starts from them. */
async function usedSince(db: Db, services: string[], since: number, field: "units" | "cost" = "units") {
  const [row] = await apiCalls(db).aggregate<{ used: number }>([
    { $match: { $or: [{ service: { $in: services } }, { limit: { $in: services } }], paid: true, outcome: { $in: ["ok", "failed"] }, created_at: { $gte: since } } },
    { $group: { _id: null, used: { $sum: field === "cost" ? { $ifNull: ["$cost_estimate", 0] } : { $ifNull: ["$units", 1] } } } },
  ]).toArray().catch(() => []);
  return row?.used ?? 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Space calls evenly, across workers: at most `count` in any `windowMs`. Waits, never refuses. */
async function pace(db: Db, key: string, count: number, windowMs: number) {
  if (!(count > 0)) return;
  const interval = Math.ceil(windowMs / count), now = Date.now();
  const before = await budgets(db).findOneAndUpdate({ _id: `pace:${key}` },
    [{ $set: { next_at: { $add: [{ $max: [now, { $ifNull: ["$next_at", 0] }] }, interval] }, used: { $ifNull: ["$used", 0] }, expires_at: new Date(now + 3600_000) } }],
    { upsert: true, returnDocument: "before" }).catch(() => null);
  const wait = Math.max(0, (before?.next_at ?? 0) - now);
  if (wait) await sleep(wait);
}

/** Pace a free service to its hard limit, such as Jina Reader's calls a minute. Outside a run there is nothing shared to pace against. */
export async function paceService(key: string, keyed = true) {
  const context = runContext(), hard = HARD_LIMITS[key];
  if (!context || !hard) return;
  if (hard.per_second) await pace(context.db, key, hard.per_second, 1000);
  const perMinute = keyed ? hard.per_minute : hard.per_minute_without_key ?? hard.per_minute;
  if (perMinute) await pace(context.db, key, perMinute, 60_000);
}

/** Keep the first hard limit a run reached, and record it once in the decision log. */
async function noteStop(db: Db, runId: string, key: string, reason: string) {
  try {
    await budgets(db).insertOne({ _id: `stop:${runId}`, used: 0, limit: key, reason, at: Date.now() / 1000, expires_at: new Date(Date.now() + 30 * 86400_000) });
    const context = runContext();
    if (context) await db.collection("run_decisions").insertOne({ run_id: runId, location_id: context.locationId, at: Date.now() / 1000, stage: "plan", actor: "rule", subject: key, decision: "limit_reached", reason, rule: `hard_limit:${key}`, evidence: null }).catch(() => undefined);
  } catch (error) { if (!isDuplicate(error)) throw error; }
}

/** The hard limits that stop a whole run when reached; any other limit takes only its own service out. */
export const RUN_STOPPING_LIMITS = new Set(["gemini"]);

/** Note once that a service reached its own hard limit in this run: it is unavailable from now on. */
async function noteUnavailable(db: Db, runId: string, key: string, reason: string) {
  try {
    await budgets(db).insertOne({ _id: `unavailable:${runId}:${key}`, used: 0, limit: key, reason, at: Date.now() / 1000, expires_at: new Date(Date.now() + 30 * 86400_000) });
    const context = runContext();
    if (context) await db.collection("run_decisions").insertOne({ run_id: runId, location_id: context.locationId, at: Date.now() / 1000, stage: "plan", actor: "rule", subject: key, decision: "service_unavailable", reason: `${reason}: unavailable for the rest of this run`, rule: `hard_limit:${key}`, evidence: null }).catch(() => undefined);
  } catch (error) { if (!isDuplicate(error)) throw error; }
}

/** The services that reached their own hard limit in this run, by limit key, with the reason. */
export async function unavailableServices(db: Db, runId: string): Promise<Record<string, string>> {
  const prefix = `unavailable:${runId}:`;
  const rows = await budgets(db).find({ _id: { $gte: prefix, $lt: `${prefix}\uffff` } }).toArray();
  return Object.fromEntries(rows.map((row) => [row.limit ?? row._id.split(":").pop()!, row.reason ?? ""]));
}

/** The hard limit that stopped this run, if one has. */
export async function stoppedBy(db: Db, runId: string): Promise<{ limit: string; reason: string } | null> {
  const found = await budgets(db).findOne({ _id: `stop:${runId}` });
  return found?.limit ? { limit: found.limit, reason: found.reason ?? found.limit } : null;
}

/** Whether a source map run has used up its whole-run time. */
export function pastRunTime(now = Date.now()) {
  const context = runContext();
  return Boolean(context?.runKind === "map" && context.startedAt && now / 1000 - context.startedAt > RUN_MINUTES * 60);
}

// Gemini's own limits apply to Gemini calls under the model budget, so they keep its name.
const LABELS: Record<string, string> = { ...Object.fromEntries(PAID_SERVICES.map((service) => [service.id, service.label])), gemini: "Gemini" };
const limitLabel = (key: string) => LABELS[key as PaidService] ?? key.replace(/_/g, " ");

export async function logApiCall(service: string, paid: boolean, outcome: ApiCall["outcome"], detail: string | null = null, cost: number | null = null, units = 1, source: CallSource = {}) {
  const context = runContext();
  if (!context) return;
  const extra = Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && !(key === "limit" && value === service)));
  await apiCalls(context.db).insertOne({ run_id: context.runId, location_id: context.locationId, service, paid, units, outcome, detail: detail ? safeError(detail) : null, cost_estimate: cost, created_at: Date.now() / 1000, ...extra }).catch(() => undefined);
}

/**
 * How a call is counted against the hard limits. `limits` defaults to the service; a model call on Gemini counts
 * against Gemini's limits. `provider` narrows the rejected-key check to the provider that rejected it.
 */
export type CallUnits = { limits?: string; units?: number; keyed?: boolean; provider?: string };

/** Take a call from every hard limit, or none of them: the reason for the first that is full. */
async function takeHardLimits(db: Db, runId: string, service: PaidService, call: Required<Omit<CallUnits, "keyed" | "provider">> & { keyed: boolean }, allowance: number): Promise<string | null> {
  const context = runContext();
  const hard = HARD_LIMITS[call.limits] ?? {};
  const mapRun = context?.runKind === "map";
  if (mapRun && pastRunTime()) {
    const reason = `the whole-run limit of ${RUN_MINUTES} minutes`;
    await noteStop(db, runId, "run_minutes", reason);
    return `Hard limit: ${reason} was reached`;
  }
  if (hard.per_second) await pace(db, call.limits, hard.per_second, 1000);
  const perMinute = call.keyed ? hard.per_minute : hard.per_minute_without_key ?? hard.per_minute;
  if (perMinute) await pace(db, call.limits, perMinute, 60_000);
  const window = limitWindow();
  const seedServices = call.limits === service ? [service] : [call.limits];
  const pool = hard.pool ?? call.limits;
  const month = new Date(Date.now() + 40 * 86400_000);
  const counts: Array<{ id: string; ceiling: number; units: number; seed?: () => Promise<number>; expires: Date; label: string; stops: boolean }> = [
    { id: `${runId}:${service}`, ceiling: allowance, units: call.units, expires: new Date(Date.now() + 30 * 86400_000), label: `this run's budget of ${allowance}`, stops: false },
  ];
  if (mapRun && hard.per_run !== undefined) counts.push({ id: `${runId}:limit:${call.limits}`, ceiling: hard.per_run, units: call.units, expires: month, label: `${hard.per_run} a run`, stops: true });
  if (hard.per_hour !== undefined) counts.push({ id: `hour:${call.limits}:${window.hour}`, ceiling: hard.per_hour, units: call.units, seed: () => usedSince(db, seedServices, window.hourStart), expires: new Date(Date.now() + 2 * 3600_000), label: `${hard.per_hour} an hour`, stops: false });
  if (hard.per_day !== undefined) counts.push({ id: `day:${call.limits}:${window.day}`, ceiling: hard.per_day, units: call.units, seed: () => usedSince(db, seedServices, window.dayStart), expires: new Date(Date.now() + 2 * 86400_000), label: `${hard.per_day} a day (it resets at midnight Pacific)`, stops: true });
  if (hard.per_month !== undefined) counts.push({ id: `month:${pool}:${window.month}`, ceiling: hard.per_month, units: call.units, seed: () => usedSince(db, seedServices, window.monthStart), expires: month, label: `${hard.per_month} a month`, stops: true });
  if (hard.total !== undefined) counts.push({ id: `total:${pool}`, ceiling: hard.total, units: call.units, seed: () => usedSince(db, seedServices, 0), expires: new Date(Date.now() + 3650 * 86400_000), label: `${hard.total} in total`, stops: true });
  if (hard.spend_per_month !== undefined) counts.push({ id: `spend:${pool}:${window.month}`, ceiling: hard.spend_per_month, units: hard.estimated_cost ?? 0, seed: () => usedSince(db, seedServices, window.monthStart, "cost"), expires: month, label: `$${hard.spend_per_month} a month`, stops: true });
  const taken: typeof counts = [];
  for (const count of counts) {
    if (await take(db, count.id, count.ceiling, count.units, count.expires, count.seed)) { taken.push(count); continue; }
    for (const done of taken) await giveBack(db, done.id, done.units);
    if (!taken.length && count.id === `${runId}:${service}`) return `${LABELS[service]} reached this run's budget of ${allowance} calls`;
    const reason = `${limitLabel(call.limits)}: ${count.label}`;
    if (count.stops) await (RUN_STOPPING_LIMITS.has(call.limits) ? noteStop : noteUnavailable)(db, runId, call.limits, reason);
    return `Hard limit: ${reason} was reached`;
  }
  return null;
}

/** Why a paid call may not happen now, or null when it may, which takes it from the budget and the hard limits. A refusal is logged. */
export async function paidRefusal(service: PaidService, units: CallUnits = {}): Promise<string | null> {
  const context = runContext();
  const allowance = paidAllowance((context ? context.options : LEGACY_OPTIONS).paid, service);
  if (allowance === undefined) {
    const reason = `${LABELS[service]} is not ticked for this run`;
    await logApiCall(service, true, "skipped", reason);
    return reason;
  }
  if (!context) return null;
  // A rejected key won't start working mid-run: stop now rather than spend the budget failing.
  const rejected = await apiCalls(context.db).findOne({ run_id: context.runId, service, ...(units.provider ? { provider: units.provider } : {}), outcome: "failed", detail: { $regex: "HTTP 40[13]\\b" } });
  if (rejected) {
    const reason = `${LABELS[service]} rejected the key (${rejected.detail}): fix the key and rerun`;
    await logApiCall(service, true, "skipped", reason, null, 1, { provider: units.provider });
    return reason;
  }
  const reason = await takeHardLimits(context.db, context.runId, service, { limits: units.limits ?? service, units: units.units ?? 1, keyed: units.keyed ?? true }, allowance);
  if (reason) await logApiCall(service, true, "skipped", reason, null, 0);
  return reason;
}

/**
 * Model calls this run can still make, by the budget they count against: the agent's own calls
 * (its run budget), the model check's (the model budget), and Gemini's per-run and daily limits,
 * which both share. Null where nothing limits them.
 */
export async function modelCallsLeft(db: Db, runId: string): Promise<{ agent: number | null; judge: number | null; gemini: number | null }> {
  const context = runContext();
  const paid = (context ? context.options : LEGACY_OPTIONS).paid;
  const used = async (id: string) => (await budgets(db).findOne({ _id: id }, { projection: { used: 1 } }))?.used ?? 0;
  const left = async (allowance: number | undefined, id: string) => allowance === undefined ? null : Math.max(0, allowance - await used(id));
  const hard = HARD_LIMITS.gemini ?? {};
  const gemini = [
    hard.per_run !== undefined && context?.runKind === "map" ? Math.max(0, hard.per_run - await used(`${runId}:limit:gemini`)) : null,
    hard.per_day !== undefined ? Math.max(0, hard.per_day - await used(`day:gemini:${limitWindow().day}`)) : null,
  ].filter((value): value is number => value !== null);
  return { agent: await left(paidAllowance(paid, "agent_model"), `${runId}:agent_model`), judge: await left(paidAllowance(paid, "model"), `${runId}:model`), gemini: gemini.length ? Math.min(...gemini) : null };
}

/** Run one paid call through the gate. Returns null with the reason when it was refused. */
export async function paidCall<T>(service: PaidService, call: () => Promise<T>, cost?: (result: T) => number | null, units: CallUnits = {}): Promise<{ value: T | null; refused: string | null }> {
  const refused = await paidRefusal(service, units);
  if (refused) return { value: null, refused };
  const counted = units.units ?? 1;
  try {
    const value = await call();
    const spent = cost?.(value) ?? null;
    await logApiCall(service, true, "ok", null, spent ?? HARD_LIMITS[units.limits ?? service]?.estimated_cost ?? null, counted);
    await settleSpend(service, units.limits ?? service, spent);
    return { value, refused: null };
  } catch (error) {
    await logApiCall(service, true, "failed", error instanceof Error ? error.message : String(error), null, counted);
    throw error;
  }
}

/** Swap a spend guard's estimate for the call's real cost, once the service reports it. */
async function settleSpend(service: PaidService, key: string, spent: number | null) {
  const context = runContext(), hard = HARD_LIMITS[key];
  if (!context || spent === null || hard?.spend_per_month === undefined) return;
  const difference = spent - (hard.estimated_cost ?? 0);
  if (difference) await budgets(context.db).updateOne({ _id: `spend:${hard.pool ?? key}:${limitWindow().month}` }, { $inc: { used: difference } }).catch(() => undefined);
}

/** The paid service behind a model provider, or null for a local one. Every hosted model shares one budget. */
export function modelService(provider: string, role: string): PaidService | null {
  if (provider === "ollama") return null;
  if (role === "agent") return "agent_model";
  return "model";
}

/** The hard limit a model call counts against: Gemini's own limits for a Gemini call, otherwise its service's. */
export function modelLimit(provider: string, service: PaidService) {
  return provider.startsWith("gemini") ? "gemini" : service;
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
