/**
 * Model usage accounting: one MongoDB record per provider call (tokens, latency, errors,
 * rate limits) and a Health summary with optional operator-configured limits and pricing.
 */
import type { Db } from "mongodb";
import type { ProviderConfig } from "../core/config";
import { COLLECTIONS } from "../storage/mongo";
import type { ModelCall, ModelCallSink } from "./runtime";

/** Usage records expire automatically; Health reports at most the last 7 days. */
export const USAGE_RETENTION_DAYS = 35;
const DAY = 86_400;

type UsageDocument = ModelCall & { created_at: number; expires_at: Date };

function usage(db: Db) {
  return db.collection<UsageDocument>(COLLECTIONS.modelUsage);
}

export async function ensureUsageIndexes(db: Db) {
  await usage(db).createIndexes([
    { key: { created_at: -1 } },
    { key: { expires_at: 1 }, expireAfterSeconds: 0, name: "usage_retention" },
  ]);
}

export function mongoUsageSink(db: Db, clock: () => number = Date.now): ModelCallSink {
  return async (call) => {
    const current = clock();
    await usage(db).insertOne({ ...call, created_at: current / 1000, expires_at: new Date(current + USAGE_RETENTION_DAYS * DAY * 1000) });
  };
}

export type UsageWindow = {
  calls: number;
  failures: number;
  rate_limited: number;
  input_tokens: number;
  output_tokens: number;
  /** Successful calls whose provider reported no token counts (excluded from cost). */
  calls_without_tokens: number;
  estimated_cost_usd: number | null;
  average_duration_ms: number | null;
};

export type ProviderUsage = {
  provider: string;
  model: string | null;
  last_24h: UsageWindow;
  last_7d: UsageWindow;
  roles: { role: string; calls: number; input_tokens: number; output_tokens: number }[];
  peak_requests_per_minute: number;
  limits: { requests_per_minute: number | null; requests_per_day: number | null };
  pricing: { input_per_mtok: number; output_per_mtok: number } | null;
  last_error: { at: number; message: string; status_code: number | null } | null;
  warnings: string[];
};

export type ModelUsageSummary = {
  generated_at: number;
  providers: ProviderUsage[];
  totals: { last_24h: UsageWindow; last_7d: UsageWindow };
  pricing_configured: boolean;
};

type Bucket = { calls: number; failures: number; rate_limited: number; input_tokens: number; output_tokens: number; calls_without_tokens: number; duration_ms: number };

const emptyBucket = (): Bucket => ({ calls: 0, failures: 0, rate_limited: 0, input_tokens: 0, output_tokens: 0, calls_without_tokens: 0, duration_ms: 0 });

function add(target: Bucket, source: Bucket) {
  for (const key of Object.keys(target) as (keyof Bucket)[]) target[key] += source[key];
}

function cost(bucket: Bucket, pricing: ProviderUsage["pricing"]) {
  if (!pricing) return null;
  return (bucket.input_tokens * pricing.input_per_mtok + bucket.output_tokens * pricing.output_per_mtok) / 1_000_000;
}

function windowOf(bucket: Bucket, pricing: ProviderUsage["pricing"]): UsageWindow {
  return {
    calls: bucket.calls,
    failures: bucket.failures,
    rate_limited: bucket.rate_limited,
    input_tokens: bucket.input_tokens,
    output_tokens: bucket.output_tokens,
    calls_without_tokens: bucket.calls_without_tokens,
    estimated_cost_usd: cost(bucket, pricing),
    average_duration_ms: bucket.calls ? Math.round(bucket.duration_ms / bucket.calls) : null,
  };
}

function pricingOf(config: ProviderConfig | undefined): ProviderUsage["pricing"] {
  const input = config?.usage.inputCostPerMTok ?? null;
  const output = config?.usage.outputCostPerMTok ?? null;
  return input === null && output === null ? null : { input_per_mtok: input ?? 0, output_per_mtok: output ?? 0 };
}

/** Usage over the last 24 hours and 7 days, per provider and model, with limit warnings. */
export async function modelUsageSummary(db: Db, providers: ProviderConfig[], now = Date.now()): Promise<ModelUsageSummary> {
  const current = now / 1000;
  const dayStart = current - DAY;
  const weekStart = current - 7 * DAY;
  const grouped = await usage(db).aggregate<{ _id: { provider: string; model: string | null; role: string; recent: boolean } } & Bucket>([
    { $match: { created_at: { $gte: weekStart } } },
    {
      $group: {
        _id: { provider: "$provider", model: "$model", role: "$role", recent: { $gte: ["$created_at", dayStart] } },
        calls: { $sum: 1 },
        failures: { $sum: { $cond: ["$ok", 0, 1] } },
        rate_limited: { $sum: { $cond: ["$rate_limited", 1, 0] } },
        input_tokens: { $sum: { $ifNull: ["$input_tokens", 0] } },
        output_tokens: { $sum: { $ifNull: ["$output_tokens", 0] } },
        calls_without_tokens: { $sum: { $cond: [{ $and: ["$ok", { $eq: [{ $ifNull: ["$input_tokens", null] }, null] }] }, 1, 0] } },
        duration_ms: { $sum: "$duration_ms" },
      },
    },
  ]).toArray();
  const peaks = await usage(db).aggregate<{ _id: { provider: string; model: string | null }; peak: number }>([
    { $match: { created_at: { $gte: dayStart } } },
    { $group: { _id: { provider: "$provider", model: "$model", minute: { $floor: { $divide: ["$created_at", 60] } } }, calls: { $sum: 1 } } },
    { $group: { _id: { provider: "$_id.provider", model: "$_id.model" }, peak: { $max: "$calls" } } },
  ]).toArray();

  const key = (provider: string, model: string | null) => `${provider}\u0000${model ?? ""}`;
  const rows = new Map<string, { provider: string; model: string | null; day: Bucket; week: Bucket; roles: Map<string, Bucket> }>();
  for (const group of grouped) {
    const id = key(group._id.provider, group._id.model);
    const row = rows.get(id) ?? { provider: group._id.provider, model: group._id.model, day: emptyBucket(), week: emptyBucket(), roles: new Map<string, Bucket>() };
    rows.set(id, row);
    add(row.week, group);
    if (group._id.recent) {
      add(row.day, group);
      const role = row.roles.get(group._id.role) ?? emptyBucket();
      add(role, group);
      row.roles.set(group._id.role, role);
    }
  }

  const totalsDay = emptyBucket();
  const totalsWeek = emptyBucket();
  let totalDayCost: number | null = null;
  let totalWeekCost: number | null = null;
  const result: ProviderUsage[] = [];
  for (const row of rows.values()) {
    const config = providers.find((item) => item.name === row.provider && (item.model ?? null) === row.model)
      ?? providers.find((item) => item.name === row.provider);
    const pricing = pricingOf(config);
    const limits = { requests_per_minute: config?.usage.requestsPerMinute ?? null, requests_per_day: config?.usage.requestsPerDay ?? null };
    const peak = peaks.find((item) => key(item._id.provider, item._id.model) === key(row.provider, row.model))?.peak ?? 0;
    const lastError = await usage(db).find({ provider: row.provider, model: row.model, ok: false, created_at: { $gte: weekStart } })
      .sort({ created_at: -1 }).limit(1).next();
    const warnings: string[] = [];
    if (row.day.rate_limited) {
      warnings.push(`${row.day.rate_limited} request(s) were rate-limited or over quota in 24 hours; reduce concurrency or batch size, raise the provider quota, or add a fallback provider.`);
    }
    if (limits.requests_per_minute && peak >= 0.8 * limits.requests_per_minute) {
      warnings.push(`Peak ${peak} requests/minute is ${Math.round((peak / limits.requests_per_minute) * 100)}% of the configured ${limits.requests_per_minute} RPM limit.`);
    }
    if (limits.requests_per_day && row.day.calls >= 0.8 * limits.requests_per_day) {
      warnings.push(`${row.day.calls} requests in 24 hours is ${Math.round((row.day.calls / limits.requests_per_day) * 100)}% of the configured ${limits.requests_per_day} requests/day limit.`);
    }
    if (row.day.calls && row.day.failures / row.day.calls >= 0.2) {
      warnings.push(`${Math.round((row.day.failures / row.day.calls) * 100)}% of calls failed in 24 hours.`);
    }
    add(totalsDay, row.day);
    add(totalsWeek, row.week);
    const day = windowOf(row.day, pricing);
    const week = windowOf(row.week, pricing);
    if (day.estimated_cost_usd !== null) totalDayCost = (totalDayCost ?? 0) + day.estimated_cost_usd;
    if (week.estimated_cost_usd !== null) totalWeekCost = (totalWeekCost ?? 0) + week.estimated_cost_usd;
    result.push({
      provider: row.provider,
      model: row.model,
      last_24h: day,
      last_7d: week,
      roles: [...row.roles.entries()].map(([role, bucket]) => ({ role, calls: bucket.calls, input_tokens: bucket.input_tokens, output_tokens: bucket.output_tokens }))
        .sort((a, b) => a.role.localeCompare(b.role)),
      peak_requests_per_minute: peak,
      limits,
      pricing,
      last_error: lastError ? { at: lastError.created_at, message: lastError.error ?? "Failed", status_code: lastError.status_code } : null,
      warnings,
    });
  }
  result.sort((a, b) => b.last_7d.calls - a.last_7d.calls || a.provider.localeCompare(b.provider));
  return {
    generated_at: current,
    providers: result,
    totals: {
      last_24h: { ...windowOf(totalsDay, null), estimated_cost_usd: totalDayCost },
      last_7d: { ...windowOf(totalsWeek, null), estimated_cost_usd: totalWeekCost },
    },
    pricing_configured: providers.some((item) => pricingOf(item) !== null),
  };
}
