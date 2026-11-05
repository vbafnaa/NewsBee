/**
 * Model usage accounting: one MongoDB record per provider call (tokens, latency, errors,
 * rate limits) and a Health summary with optional operator-configured limits and pricing.
 */
import type { Db } from "mongodb";
import type { ProviderConfig } from "../core/config";
import { COLLECTIONS } from "../storage/mongo";
import type { ModelCall, ModelCallSink } from "./runtime";

/** Usage records expire automatically; detailed reporting supports the last 30 days. */
export const USAGE_RETENTION_DAYS = 35;
const DAY = 86_400;

type UsageDocument = Omit<ModelCall, "location_id"> & { location_id?: string | null; created_at: number; expires_at: Date };

function usage(db: Db) {
  return db.collection<UsageDocument>(COLLECTIONS.modelUsage);
}

export async function ensureUsageIndexes(db: Db) {
  await usage(db).createIndexes([
    { key: { created_at: -1 } },
    { key: { location_id: 1, created_at: -1 } },
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
  return input === null || output === null ? null : { input_per_mtok: input, output_per_mtok: output };
}

function configFor(providers: ProviderConfig[], provider: string, model: string | null) {
  // Gemini records the physical provider name even for the separate light-model config.
  return providers.find((item) => item.name === provider && (item.model ?? null) === model)
    ?? providers.find((item) => provider === "gemini" && item.name === "gemini_light" && item.kind === "gemini" && item.model === model);
}

export type ModelPrice = { provider: string; model: string; input_per_mtok: number; output_per_mtok: number };

export function modelPriceOverrides(value: string | undefined): ModelPrice[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("Invalid NEWSBEE_MODEL_PRICING: expected a JSON array of model prices."); }
  if (!Array.isArray(parsed)) throw new Error("Invalid NEWSBEE_MODEL_PRICING: expected an array.");
  const prices: ModelPrice[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null ||
      typeof entry.provider !== "string" || !entry.provider.trim() ||
      typeof entry.model !== "string" || !entry.model.trim() ||
      typeof entry.input_per_mtok !== "number" || !Number.isFinite(entry.input_per_mtok) || entry.input_per_mtok < 0 ||
      typeof entry.output_per_mtok !== "number" || !Number.isFinite(entry.output_per_mtok) || entry.output_per_mtok < 0) {
      throw new Error("Invalid NEWSBEE_MODEL_PRICING: each model needs provider, model and non-negative input_per_mtok/output_per_mtok.");
    }
    if (prices.some((price) => price.provider === entry.provider && price.model === entry.model)) throw new Error("Invalid NEWSBEE_MODEL_PRICING: duplicate provider/model.");
    prices.push({ provider: entry.provider, model: entry.model, input_per_mtok: entry.input_per_mtok, output_per_mtok: entry.output_per_mtok });
  }
  return prices;
}

export const UNASSIGNED_USAGE = "__unassigned";
export type UsagePeriod = 1 | 7 | 30;
export type UsageMetrics = UsageWindow & { calls_with_tokens: number; priced_calls: number; unpriced_calls: number };
type ModelRow = UsageMetrics & {
  provider: string; model: string | null; pricing: ProviderUsage["pricing"];
  limits: ProviderUsage["limits"];
};
export type DetailedModelUsage = {
  generated_at: number; start_at: number; days: UsagePeriod; retention_days: number;
  totals: UsageMetrics;
  models: ModelRow[];
  locations: (UsageMetrics & { id: string; name: string; onboarded: boolean; attributed: boolean; models: number })[];
  location_options: { id: string; name: string }[];
  roles: (UsageMetrics & { role: string })[];
  daily: (UsageMetrics & { day: string })[];
  recent_failures: { at: number; provider: string; model: string | null; role: string; location: string; message: string; status_code: number | null }[];
};
type DetailedBucket = Bucket & { measured_calls: number; measured_input: number; measured_output: number };
type Accumulator = { bucket: DetailedBucket; priced_calls: number; estimated_cost_usd: number | null };
const accumulator = (): Accumulator => ({
  bucket: { ...emptyBucket(), measured_calls: 0, measured_input: 0, measured_output: 0 },
  priced_calls: 0, estimated_cost_usd: null,
});

function accumulate(target: Accumulator, source: DetailedBucket, pricing: ProviderUsage["pricing"]) {
  add(target.bucket, source);
  if (pricing && source.measured_calls) {
    target.priced_calls += source.measured_calls;
    target.estimated_cost_usd = (target.estimated_cost_usd ?? 0) +
      (source.measured_input * pricing.input_per_mtok + source.measured_output * pricing.output_per_mtok) / 1_000_000;
  }
}

function metrics(value: Accumulator): UsageMetrics {
  return {
    ...windowOf(value.bucket, null), estimated_cost_usd: value.estimated_cost_usd,
    calls_with_tokens: value.bucket.measured_calls, priced_calls: value.priced_calls,
    unpriced_calls: value.bucket.calls - value.priced_calls,
  };
}

/** Bounded, aggregate-only reporting; historical calls without attribution are never guessed. */
export async function detailedModelUsage(
  db: Db, providers: ProviderConfig[],
  options: { days: UsagePeriod; location?: string; prices?: ModelPrice[] },
  now = Date.now(),
): Promise<DetailedModelUsage> {
  const end = now / 1000, start = end - options.days * DAY;
  const measured = { $and: [
    { $isNumber: "$input_tokens" }, { $isNumber: "$output_tokens" },
    { $gte: ["$input_tokens", 0] }, { $gte: ["$output_tokens", 0] },
  ] };
  const [groups, places, failures] = await Promise.all([
    usage(db).aggregate<DetailedBucket & { _id: { provider: string; model: string | null; role: string; location: string | null; day: string } }>([
      { $match: { created_at: { $gte: start, $lte: end } } },
      { $group: {
        _id: {
          provider: "$provider", model: { $ifNull: ["$model", null] }, role: { $ifNull: ["$role", "unknown"] },
          location: { $cond: [{ $and: [{ $eq: [{ $type: "$location_id" }, "string"] }, { $ne: ["$location_id", ""] }] }, "$location_id", null] },
          day: { $dateToString: { format: "%Y-%m-%d", date: { $toDate: { $multiply: ["$created_at", 1000] } }, timezone: "UTC" } },
        },
        calls: { $sum: 1 }, failures: { $sum: { $cond: ["$ok", 0, 1] } },
        rate_limited: { $sum: { $cond: ["$rate_limited", 1, 0] } },
        input_tokens: { $sum: { $ifNull: ["$input_tokens", 0] } }, output_tokens: { $sum: { $ifNull: ["$output_tokens", 0] } },
        calls_without_tokens: { $sum: { $cond: [measured, 0, 1] } },
        measured_calls: { $sum: { $cond: [measured, 1, 0] } },
        measured_input: { $sum: { $cond: [measured, "$input_tokens", 0] } },
        measured_output: { $sum: { $cond: [measured, "$output_tokens", 0] } },
        duration_ms: { $sum: "$duration_ms" },
      } },
    ]).toArray(),
    db.collection<{ _id: string; name: string }>(COLLECTIONS.locations).find({}, { projection: { name: 1 } }).toArray(),
    usage(db).find({
      created_at: { $gte: start, $lte: end }, ok: false,
      ...(options.location === UNASSIGNED_USAGE ? { $or: [{ location_id: null }, { location_id: "" }] } : options.location ? { location_id: options.location } : {}),
    }, { projection: { created_at: 1, provider: 1, model: 1, role: 1, location_id: 1, error: 1, status_code: 1 } }).sort({ created_at: -1 }).limit(20).toArray(),
  ]);
  const names = new Map(places.map((place) => [place._id, place.name]));
  const locationIds = new Set([...names.keys(), ...groups.map((group) => group._id.location ?? UNASSIGNED_USAGE)]);
  const locationName = (id: string) => id === UNASSIGNED_USAGE ? "Unassigned / historical" : names.get(id) ?? id;
  const models = new Map<string, { provider: string; model: string | null; value: Accumulator; pricing: ProviderUsage["pricing"]; limits: ProviderUsage["limits"] }>();
  const locations = new Map<string, { value: Accumulator; models: Set<string> }>();
  const roles = new Map<string, Accumulator>();
  const daily = new Map<string, Accumulator>();
  const totals = accumulator();
  for (let date = Math.floor(start / DAY) * DAY; date <= end; date += DAY) daily.set(new Date(date * 1000).toISOString().slice(0, 10), accumulator());
  for (const group of groups) {
    const location = group._id.location ?? UNASSIGNED_USAGE;
    if (options.location && location !== options.location) continue;
    const { provider, model, role, day } = group._id;
    const key = JSON.stringify([provider, model]);
    const config = configFor(providers, provider, model);
    const override = options.prices?.find((price) => price.provider === provider && price.model === model);
    const pricing = override ? { input_per_mtok: override.input_per_mtok, output_per_mtok: override.output_per_mtok } : pricingOf(config);
    const modelRow = models.get(key) ?? { provider, model, value: accumulator(), pricing, limits: {
      requests_per_minute: config?.usage.requestsPerMinute ?? null, requests_per_day: config?.usage.requestsPerDay ?? null,
    } };
    models.set(key, modelRow);
    accumulate(modelRow.value, group, pricing);
    const place = locations.get(location) ?? { value: accumulator(), models: new Set<string>() };
    place.models.add(key); locations.set(location, place); accumulate(place.value, group, pricing);
    const purpose = roles.get(role) ?? accumulator(); roles.set(role, purpose); accumulate(purpose, group, pricing);
    const date = daily.get(day)!; accumulate(date, group, pricing);
    accumulate(totals, group, pricing);
  }
  return {
    generated_at: end, start_at: start, days: options.days, retention_days: USAGE_RETENTION_DAYS, totals: metrics(totals),
    models: [...models.values()].map(({ value, ...row }) => ({ ...row, ...metrics(value) })).sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider) || (a.model ?? "").localeCompare(b.model ?? "")),
    locations: [...locations].map(([id, row]) => ({ id, name: locationName(id), onboarded: names.has(id), attributed: id !== UNASSIGNED_USAGE, models: row.models.size, ...metrics(row.value) })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    location_options: [...locationIds].map((id) => ({ id, name: locationName(id) })).sort((a, b) => a.name.localeCompare(b.name)),
    roles: [...roles].map(([role, row]) => ({ role, ...metrics(row) })).sort((a, b) => b.calls - a.calls || a.role.localeCompare(b.role)),
    daily: [...daily].map(([day, row]) => ({ day, ...metrics(row) })),
    recent_failures: failures.map((row) => ({
      at: row.created_at, provider: row.provider, model: row.model, role: row.role,
      location: locationName(row.location_id || UNASSIGNED_USAGE), message: row.error ?? "Provider attempt failed", status_code: row.status_code,
    })),
  };
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
    const config = configFor(providers, row.provider, row.model);
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
