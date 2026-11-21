/**
 * One managed-platform UTC daily allowance across principals, roles and child runs.
 * Every dispatched provider attempt reserves atomically; reads never reserve.
 *
 * Also: web-grounded search on the first configured model that can search the web (Gemini models,
 * with Google Search grounding), used by the optional model news search and model source suggestions.
 */
import type { Db } from "mongodb";
import { lightModelOf, type ProviderConfig, type Settings } from "../core/config";
import { fetchTransport, type HttpTransport } from "../core/http";
import { COLLECTIONS } from "../storage/mongo";
import { logApiCall, modelLimit, paidRefusal, reserveBudgetUnits } from "../trace/gateway";
import { runContext } from "../core/run-options";
import { safeError } from "../core/redaction";
import { ExecutionBlocked } from "../core/execution-errors";
import { UsageAccountingError, type ModelCall } from "./runtime";
import { MaintenanceError } from "../../../../shared/restore-maintenance";

export const CAPPED_ROLES = ["extraction", "discovery", "writing", "ranking", "agent"];
export type ModelFunding = "platform" | "personal" | "environment" | "unknown";
type BudgetIdentity = { funding: ModelFunding; initiatorId?: string };
export class ModelBudgetExceeded extends ExecutionBlocked {
  readonly code = "model_daily_allowance";
  constructor(readonly scope: "managed_platform" | "personal" | "environment", readonly resets_at: number, readonly cap: number) {
    super(scope === "managed_platform"
      ? "Daily model-call allowance exhausted. Managed work shares one allowance across all journalists and child runs; retry after midnight UTC."
      : "Daily model-call allowance exhausted for this credential identity; retry after midnight UTC.");
  }
}

export function startOfDay(now = Date.now()) {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime() / 1000;
}

function budgetIdentity(settings: Settings, provider?: string): BudgetIdentity {
  const binding = settings.modelFunding;
  const funding = provider ? binding?.providers?.[provider] ?? binding?.providers?.[provider.replace(/_light$/, "")] ?? binding?.source : binding?.source;
  return { funding: funding ?? "unknown", initiatorId: binding?.initiatorId };
}

export function modelFunding(settings: Settings, provider?: string) {
  return budgetIdentity(settings, provider).funding;
}

function budgetKey(identity: BudgetIdentity, now: number) {
  const scope = identity.funding === "platform" || identity.funding === "unknown"
    ? "managed" : `${identity.funding}:${identity.initiatorId ?? "unassigned"}`;
  return `model-daily:${scope}:${new Date(now).toISOString().slice(0, 10)}`;
}

async function recordedToday(db: Db, identity: BudgetIdentity, now: number) {
  const managed = identity.funding === "platform" || identity.funding === "unknown";
  const rows = await db.collection(COLLECTIONS.modelUsage).aggregate<{ _id: string; calls: number; unknown: number }>([
    { $match: { created_at: { $gte: startOfDay(now), $lt: startOfDay(now) + 86400 }, provider: { $ne: "ollama" },
      ...(managed ? { $or: [{ funding: "platform" }, { funding: "unknown" }, { funding: null }] }
        : { sponsor_id: identity.initiatorId ?? null, $or: [{ funding: identity.funding }, { funding: "unknown" }, { funding: null }] }) } },
    { $group: { _id: "$role", calls: { $sum: 1 }, unknown: { $sum: { $cond: [{ $in: [{ $ifNull: ["$funding", "unknown"] }, ["unknown"]] }, 1, 0] } } } },
  ]).toArray();
  const byRole = Object.fromEntries(rows.map((row) => [row._id ?? "other", row.calls]));
  return { total: rows.reduce((sum, row) => sum + row.calls, 0), byRole, unknown: rows.reduce((sum, row) => sum + row.unknown, 0) };
}

export async function callsToday(db: Db, identity: BudgetIdentity = { funding: "platform" }, now = Date.now()) {
  const [recorded, counter] = await Promise.all([
    recordedToday(db, identity, now),
    db.collection<{ _id: string; used: number }>("run_budgets").findOne({ _id: budgetKey(identity, now) }),
  ]);
  return { ...recorded, total: Math.max(recorded.total, counter?.used ?? 0), reserved_or_unrecorded: Math.max(0, (counter?.used ?? 0) - recorded.total) };
}

export async function modelBudget(db: Db, settings: Pick<Settings, "modelDailyCalls">, now = Date.now()) {
  const today = await callsToday(db, { funding: "platform" }, now);
  const cap = settings.modelDailyCalls;
  return { scope: "managed_platform" as const, resets_at: startOfDay(now) + 86400, unknown_historical_calls: today.unknown,
    reserved_or_unrecorded: today.reserved_or_unrecorded,
    used: today.total, cap, remaining: Math.max(0, cap - today.total), byRole: today.byRole, near: today.total >= cap * 0.8, exhausted: today.total >= cap };
}

export async function canSpend(db: Db, settings: Settings, calls = 1) {
  const today = await callsToday(db, budgetIdentity(settings));
  return settings.modelDailyCalls - today.total >= calls;
}

/** Reuse the gateway's conditional counter. Never refund a dispatched or uncertain attempt. */
export async function reserveModelAttempt(db: Db, settings: Settings, identity = budgetIdentity(settings), now = Date.now()) {
  let accepted: boolean;
  try {
    accepted = await reserveBudgetUnits(db, budgetKey(identity, now), settings.modelDailyCalls, 1,
      new Date((startOfDay(now) + 36 * 86400) * 1000), async () => (await recordedToday(db, identity, now)).total);
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new UsageAccountingError("Model quota accounting is unavailable. No provider request was dispatched.");
  }
  if (!accepted) throw new ModelBudgetExceeded(identity.funding === "platform" || identity.funding === "unknown" ? "managed_platform" : identity.funding,
    startOfDay(now) + 86400, settings.modelDailyCalls);
}

export type GroundedResult = { text: string; sources: Array<{ uri: string; title: string }>; provider: string; model: string };
/** The provider and model a grounded call used, for its usage record. */
export type GroundedUse = { provider: string; model: string };
type GroundedRecorder = ((ok: boolean, error: string | null, used: GroundedUse) => Promise<void>) & {
  beforeDispatch?: (used: GroundedUse) => Promise<void>;
};

const GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta";

/**
 * The configured model that does web-grounded search: the first provider, in the configured order, that
 * can search the web and has a key. Today that is a Gemini provider (Google Search grounding), on its
 * light model. Other providers have no standard grounded search, so they are passed over.
 */
export function groundedModel(settings: Settings): { provider: ProviderConfig; model: string } | null {
  const provider = settings.modelProviders.find((item) => item.kind === "gemini" && item.apiKey);
  const model = provider ? lightModelOf(provider, settings) ?? provider.model : null;
  return provider && model ? { provider, model } : null;
}

/**
 * One web-grounded model call. Returns null when no configured model can search the web, the run
 * hasn't budgeted model calls, or the call fails, so callers fall back.
 */
export async function groundedSearch(settings: Settings, prompt: string, transport: HttpTransport = fetchTransport, record?: GroundedRecorder): Promise<GroundedResult | null> {
  const chosen = groundedModel(settings);
  if (!chosen) return null;
  const used = { provider: chosen.provider.name, model: chosen.model };
  const source = { limit: modelLimit(chosen.provider.kind, "model"), provider: chosen.provider.name, model: chosen.model };
  if (settings.modelFunding?.source === "platform" && !record?.beforeDispatch) {
    throw new ExecutionBlocked("Managed grounded search requires quota and usage accounting before dispatch.");
  }
  // Grounded calls go straight to the provider, so they pass the paid-call gate here, under the one model budget.
  if (await paidRefusal("model", { limits: source.limit, provider: source.provider })) return null;
  await record?.beforeDispatch?.(used);
  await logApiCall("model", true, "ok", "grounded search", null, 1, source);
  const response = await transport({
    url: `${GEMINI_ROOT}/models/${chosen.model}:generateContent`,
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": chosen.provider.apiKey! },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0 } }),
    timeoutMs: 90_000,
  }).catch(async (error: unknown) => {
    if (error instanceof ExecutionBlocked) throw error;
    await record?.(false, String(error), used);
    return null;
  });
  if (!response) return null;
  if (response.status >= 400) {
    await record?.(false, `HTTP ${response.status}`, used);
    return null;
  }
  await record?.(true, null, used);
  const data = JSON.parse(new TextDecoder().decode(response.body)) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> } }>;
  };
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? "").join("");
  const sources = (candidate?.groundingMetadata?.groundingChunks ?? []).flatMap((chunk) => chunk.web?.uri ? [{ uri: chunk.web.uri, title: chunk.web.title ?? "" }] : []);
  return { text, sources, ...used };
}

/** Records a grounded call in model usage, under the provider and model that served it, so it counts against the daily cap. */
export function usageRecorder(db: Db, settings: Settings, role: string): GroundedRecorder {
  const record: GroundedRecorder = async (ok, error, used) => {
    const context = runContext();
    const funding = modelFunding(settings, used.provider);
    const sponsorId = settings.modelFunding?.initiatorId ?? context?.sponsorId;
    const attribution = { sponsor_id: sponsorId, initiator_id: sponsorId, funding, funding_identity: funding === "platform" ? "managed" : funding,
      credential_version: settings.modelFunding?.credentialVersion ?? context?.credentialVersion } satisfies Partial<ModelCall>;
    try {
      await db.collection(COLLECTIONS.modelUsage).insertOne({
        run_id: context?.runId, location_id: context?.locationId, ...attribution,
        provider: used.provider, model: used.model, role, operation: "generate", ok, status_code: null, rate_limited: false,
        input_tokens: null, output_tokens: null, duration_ms: 0, error: error ? safeError(error) : null, created_at: Date.now() / 1000, expires_at: new Date(Date.now() + 35 * 86400_000),
      } satisfies Partial<ModelCall> & { created_at: number; expires_at: Date });
      if (sponsorId) await db.collection("journalist_funding_audit").insertOne({
        run_id: context?.runId, ...attribution,
        provider: used.provider, model: used.model, role,
        ok, reason: null, at: Date.now() / 1000,
      });
    } catch { throw new UsageAccountingError("Grounded provider attempt completed but usage accounting failed; do not retry the paid call automatically."); }
  };
  record.beforeDispatch = (used) => reserveModelAttempt(db, settings, budgetIdentity(settings, used.provider));
  return record;
}

/** The first JSON array in a model's text answer. */
export function jsonArray(text: string): unknown[] {
  const match = /\[[\s\S]*\]/.exec(text ?? "");
  if (!match) return [];
  try {
    const value = JSON.parse(match[0]);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
