/**
 * The daily model-call cap for detail extraction and discovery (NEWSBEE_MODEL_DAILY_CALLS),
 * counted from the usage records every provider call writes. Writing and ranking are
 * counted too, so the cap reflects the whole day, but only extraction and discovery stop
 * when it runs out: extraction falls back to rule-based details and discovery waits a day.
 *
 * Also: web-grounded search on the first configured model that can search the web (Gemini models,
 * with Google Search grounding), used by the optional model news search and model source suggestions.
 */
import type { Db } from "mongodb";
import { lightModelOf, type ProviderConfig, type Settings } from "../core/config";
import { fetchTransport, type HttpTransport } from "../core/http";
import { COLLECTIONS } from "../storage/mongo";
import { logApiCall, modelLimit, paidRefusal } from "../trace/gateway";
import { runContext } from "../core/run-options";
import { safeError } from "../core/redaction";

export const CAPPED_ROLES = ["extraction", "discovery"];

function startOfDay(now = Date.now()) {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime() / 1000;
}

export async function callsToday(db: Db) {
  const since = startOfDay();
  const rows = await db.collection(COLLECTIONS.modelUsage).aggregate<{ _id: string; calls: number }>([
    { $match: { created_at: { $gte: since }, ...(runContext()?.sponsorId ? { sponsor_id: runContext()!.sponsorId } : {}) } },
    { $group: { _id: "$role", calls: { $sum: 1 } } },
  ]).toArray();
  const byRole = Object.fromEntries(rows.map((row) => [row._id ?? "other", row.calls]));
  return { total: rows.reduce((sum, row) => sum + row.calls, 0), byRole };
}

export async function modelBudget(db: Db, settings: Settings) {
  const today = await callsToday(db);
  const cap = settings.modelDailyCalls;
  return { used: today.total, cap, remaining: Math.max(0, cap - today.total), byRole: today.byRole, near: today.total >= cap * 0.8, exhausted: today.total >= cap };
}

export async function canSpend(db: Db, settings: Settings, calls = 1) {
  const budget = await modelBudget(db, settings);
  return budget.remaining >= calls;
}

export type GroundedResult = { text: string; sources: Array<{ uri: string; title: string }>; provider: string; model: string };
/** The provider and model a grounded call used, for its usage record. */
export type GroundedUse = { provider: string; model: string };

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
export async function groundedSearch(settings: Settings, prompt: string, transport: HttpTransport = fetchTransport, record?: (ok: boolean, error: string | null, used: GroundedUse) => Promise<void>): Promise<GroundedResult | null> {
  const chosen = groundedModel(settings);
  if (!chosen) return null;
  const used = { provider: chosen.provider.name, model: chosen.model };
  const source = { limit: modelLimit(chosen.provider.kind, "model"), provider: chosen.provider.name, model: chosen.model };
  // Grounded calls go straight to the provider, so they pass the paid-call gate here, under the one model budget.
  if (await paidRefusal("model", { limits: source.limit, provider: source.provider })) return null;
  await logApiCall("model", true, "ok", "grounded search", null, 1, source);
  const response = await transport({
    url: `${GEMINI_ROOT}/models/${chosen.model}:generateContent`,
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": chosen.provider.apiKey! },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0 } }),
    timeoutMs: 90_000,
  }).catch(async (error: unknown) => { await record?.(false, String(error), used); return null; });
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
export function usageRecorder(db: Db, _settings: Settings, role: string) {
  return async (ok: boolean, error: string | null, used: GroundedUse) => {
    const context = runContext();
    await db.collection(COLLECTIONS.modelUsage).insertOne({
      run_id: context?.runId, location_id: context?.locationId, sponsor_id: context?.sponsorId, credential_version: context?.credentialVersion,
      provider: used.provider, model: used.model, role, operation: "generate", ok, status_code: null, rate_limited: false,
      input_tokens: null, output_tokens: null, duration_ms: 0, error: error ? safeError(error) : null, created_at: Date.now() / 1000, expires_at: new Date(Date.now() + 35 * 86400_000),
    }).catch(() => undefined);
    if (context?.sponsorId) await db.collection("journalist_funding_audit").insertOne({
      run_id: context.runId, sponsor_id: context.sponsorId, credential_version: context.credentialVersion,
      funding: "personal", provider: used.provider, model: used.model, role,
      ok, reason: null, at: Date.now() / 1000,
    });
  };
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
