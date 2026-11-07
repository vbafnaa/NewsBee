/**
 * The daily model-call cap for detail extraction and discovery (NEWSBEE_MODEL_DAILY_CALLS),
 * counted from the usage records every provider call writes. Writing and ranking are
 * counted too, so the cap reflects the whole day, but only extraction and discovery stop
 * when it runs out: extraction falls back to rule-based details and discovery waits a day.
 *
 * Also: Gemini with Google Search grounding, used by the optional LLM news search and by
 * LLM source discovery when the key allows it.
 */
import type { Db } from "mongodb";
import type { Settings } from "../core/config";
import { fetchTransport, type HttpTransport } from "../core/http";
import { COLLECTIONS } from "../storage/mongo";
import { logApiCall, paidRefusal } from "../trace/gateway";
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

export type GroundedResult = { text: string; sources: Array<{ uri: string; title: string }> };

/**
 * One Gemini call with Google Search grounding. Returns null when no Gemini key is
 * configured or the key's tier does not allow grounding, so callers fall back.
 */
export async function groundedSearch(settings: Settings, prompt: string, transport: HttpTransport = fetchTransport, record?: (ok: boolean, error: string | null) => Promise<void>): Promise<GroundedResult | null> {
  const gemini = settings.modelProviders.find((provider) => provider.kind === "gemini" && provider.apiKey);
  if (!gemini?.apiKey) return null;
  // Grounded calls go straight to Gemini, so they pass the paid-call gate here.
  if (await paidRefusal("gemini")) return null;
  await logApiCall("gemini", true, "ok", "grounded search");
  const response = await transport({
    url: `${gemini.baseUrl}/models/${settings.lightModel}:generateContent`,
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": gemini.apiKey },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0 } }),
    timeoutMs: 90_000,
  }).catch(async (error: unknown) => { await record?.(false, String(error)); return null; });
  if (!response) return null;
  if (response.status >= 400) {
    await record?.(false, `HTTP ${response.status}`);
    return null;
  }
  await record?.(true, null);
  const data = JSON.parse(new TextDecoder().decode(response.body)) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> } }>;
  };
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? "").join("");
  const sources = (candidate?.groundingMetadata?.groundingChunks ?? []).flatMap((chunk) => chunk.web?.uri ? [{ uri: chunk.web.uri, title: chunk.web.title ?? "" }] : []);
  return { text, sources };
}

/** Records a grounded call in model usage, so it counts against the daily cap. */
export function usageRecorder(db: Db, settings: Settings, role: string) {
  return async (ok: boolean, error: string | null) => {
    const context = runContext();
    await db.collection(COLLECTIONS.modelUsage).insertOne({
      run_id: context?.runId, location_id: context?.locationId, sponsor_id: context?.sponsorId, credential_version: context?.credentialVersion,
      provider: "gemini", model: settings.lightModel, role, operation: "generate", ok, status_code: null, rate_limited: false,
      input_tokens: null, output_tokens: null, duration_ms: 0, error: error ? safeError(error) : null, created_at: Date.now() / 1000, expires_at: new Date(Date.now() + 35 * 86400_000),
    }).catch(() => undefined);
    if (context?.sponsorId) await db.collection("journalist_funding_audit").insertOne({
      run_id: context.runId, sponsor_id: context.sponsorId, credential_version: context.credentialVersion,
      approval_id: null, funding: "personal", provider: "gemini", model: settings.lightModel, role,
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
