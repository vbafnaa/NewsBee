"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import type { DetailedModelUsage, UsageMetrics, UsagePeriod } from "@/pipeline/model/usage";

const number = (value: number) => value.toLocaleString();
const usd = (value: number | null) => value === null ? "Not estimated" : new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 1 ? 6 : 2,
}).format(value);
const stamp = (value: number) => new Date(value * 1000).toLocaleString();

function Cost({ metrics }: { metrics: UsageMetrics }) {
  return <><strong>{usd(metrics.estimated_cost_usd)}</strong><small className="activity-time">{number(metrics.priced_calls)} / {number(metrics.calls)} calls priced{metrics.unpriced_calls ? " · partial coverage" : ""}</small></>;
}

function TokenCounts({ metrics }: { metrics: UsageMetrics }) {
  return <>{number(metrics.input_tokens)} / {number(metrics.output_tokens)}{metrics.calls_without_tokens > 0 && <small className="activity-time">{number(metrics.calls_without_tokens)} without complete token counts</small>}</>;
}

function DailyChart({ daily }: { daily: DetailedModelUsage["daily"] }) {
  const [metric, setMetric] = useState<"calls" | "tokens" | "cost">("calls");
  const value = (row: DetailedModelUsage["daily"][number]) => metric === "calls" ? row.calls : metric === "tokens" ? row.input_tokens + row.output_tokens : row.estimated_cost_usd ?? 0;
  const maximum = Math.max(0, ...daily.map(value));
  const slot = 680 / daily.length;
  return <section className="panel trend-panel">
    <div className="section-heading"><div><h2>Daily model activity</h2><p className="chart-caption">UTC days; first and last days can be partial. Cost shows the priced subtotal only.</p></div>
      <div className="period-switch" aria-label="Chart metric">{(["calls", "tokens", "cost"] as const).map((key) => <button key={key} className="secondary" aria-pressed={metric === key} onClick={() => setMetric(key)}>{key === "cost" ? "Est. cost" : key === "tokens" ? "Tokens" : "Calls"}</button>)}</div></div>
    {!maximum ? <p className="empty-state">{metric === "cost" ? "No positive estimated cost in this selection. Check pricing coverage; configured free models can have a $0 estimate." : "No recorded activity in this selection."}</p> :
      <svg viewBox="0 0 760 215" role="img" aria-label={`Daily ${metric}. Exact values are available in the daily usage table.`}>
        <text x="10" y="20" className="chart-axis">{metric === "cost" ? usd(maximum) : number(maximum)}</text>
        <line x1="60" x2="740" y1="170" y2="170" className="chart-baseline" />
        {daily.map((row, index) => {
          const height = value(row) / maximum * 130;
          return <g key={row.day}><rect x={60 + index * slot + slot * .15} y={170 - height} width={slot * .7} height={height} className="chart-bar informational"><title>{row.day}: {metric === "cost" ? usd(row.estimated_cost_usd) : number(value(row))} {metric}; {row.priced_calls}/{row.calls} calls priced</title></rect>
            {(index % Math.ceil(daily.length / 8) === 0 || index === daily.length - 1) && <text x={60 + (index + .5) * slot} y="195" textAnchor="middle" className="chart-axis">{row.day.slice(5)}</text>}</g>;
        })}
      </svg>}
  </section>;
}

export default function ModelUsageDashboard() {
  const [days, setDays] = useState<UsagePeriod>(7);
  const [location, setLocation] = useState("");
  const [data, setData] = useState<DetailedModelUsage | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    setData(null); setError("");
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const result = await adminApi<DetailedModelUsage>(`model-usage?days=${days}&location=${encodeURIComponent(location)}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setData(result); setError(""); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { loading = false; }
    }
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [days, location, refresh]);
  const selectedName = data?.location_options.find((option) => option.id === location)?.name ?? location;
  return <>
    <section className="panel workspace-toolbar">
      <div className="field"><span>Reporting window</span><div className="period-switch" aria-label="Usage window">{([1, 7, 30] as const).map((period) => <button key={period} className="secondary" aria-pressed={days === period} onClick={() => setDays(period)}>{period === 1 ? "24 hours" : `${period} days`}</button>)}</div></div>
      <label className="field">Location<select value={location} onChange={(event) => setLocation(event.target.value)}><option value="">All locations and unassigned calls</option>{location && !data?.location_options.some((option) => option.id === location) && <option value={location}>{selectedName}</option>}{data?.location_options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
      <button className="secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh</button><Link href="/health">System health &amp; provider readiness</Link>
    </section>
    {error && <p className="alert" role="alert">Model usage unavailable: {error}{data ? " Displayed data is from the last successful update and may be stale." : ""}</p>}
    {!data && !error && <p role="status">Loading model usage...</p>}
    {data && <>
      <p className="chart-caption">{stamp(data.start_at)} to {stamp(data.generated_at)} · {location ? selectedName : "All locations, including unassigned / historical calls"}. Every recorded provider attempt counts separately, including failures and fallbacks.</p>
      <div className="metric-grid">
        <section className="metric-card"><span className="eyebrow">Model calls</span><strong>{number(data.totals.calls)}</strong><p>{number(data.totals.calls - data.totals.failures)} successful · {number(data.totals.failures)} failed · {number(data.totals.rate_limited)} rate-limited</p></section>
        <section className="metric-card"><span className="eyebrow">Reported tokens</span><strong>{number(data.totals.input_tokens + data.totals.output_tokens)}</strong><p>{number(data.totals.input_tokens)} input · {number(data.totals.output_tokens)} output</p><small>{number(data.totals.calls_with_tokens)} / {number(data.totals.calls)} calls have both token counts</small></section>
        <section className="metric-card"><span className="eyebrow">Estimated cost · USD</span><Cost metrics={data.totals} /><p>{data.totals.unpriced_calls ? "Priced subtotal, not the full bill" : data.totals.calls ? "From configured model prices" : "No calls in this selection"}</p></section>
        <section className="metric-card"><span className="eyebrow">Models used</span><strong>{number(data.models.length)}</strong><p>{number(data.locations.filter((row) => row.attributed).length)} attributed locations · {data.totals.average_duration_ms === null ? "No latency data" : `${(data.totals.average_duration_ms / 1000).toFixed(2)} s average latency`}</p></section>
      </div>
      {data.totals.unpriced_calls > 0 && <p className="notice">{number(data.totals.unpriced_calls)} call(s) are not included in the cost estimate: either token counts or exact model pricing are unavailable. Unknown costs are never treated as free.</p>}
      {!data.totals.calls && <section className="panel empty-state"><h2>No recorded calls for this selection</h2><p>Change the location or time window. Usage appears after a provider attempt is recorded; no historical usage is invented.</p></section>}
      {data.totals.calls > 0 && <>
      <section className="panel"><div className="section-heading"><div><h2>Usage by model</h2><p>Actual provider and model identifiers, not just the configured primary. Output includes separately reported Gemini reasoning tokens.</p></div></div>
        <div className="table-wrap"><table><thead><tr><th>Provider / model</th><th>Calls</th><th>Failed / rate-limited</th><th>Tokens in / out</th><th>Est. cost (USD)</th><th>Input / output price per 1M</th><th>Avg latency</th></tr></thead><tbody>
          {data.models.map((row) => <tr key={JSON.stringify([row.provider, row.model])}><td><strong>{row.model ?? "Unspecified model"}</strong><small className="activity-time">{row.provider}</small></td><td>{number(row.calls)}</td><td>{number(row.failures)} / {number(row.rate_limited)}</td><td><TokenCounts metrics={row} /></td><td><Cost metrics={row} /></td><td>{row.pricing ? `${usd(row.pricing.input_per_mtok)} / ${usd(row.pricing.output_per_mtok)}` : "Pricing not configured for this model"}</td><td>{row.average_duration_ms === null ? "-" : `${(row.average_duration_ms / 1000).toFixed(2)} s`}</td></tr>)}
        </tbody></table></div>
      </section>
      <DailyChart daily={data.daily} />
      <section className="panel"><div className="section-heading"><div><h2>Usage by location</h2><p>Pipeline jobs and manual discovery are attributed to their community. Older calls without context stay unassigned.</p></div>{location && <button className="secondary" onClick={() => setLocation("")}>Show all locations</button>}</div>
        <div className="table-wrap"><table><thead><tr><th>Location</th><th>Models</th><th>Calls</th><th>Failed</th><th>Tokens in / out</th><th>Est. cost (USD)</th><th>Workspace</th></tr></thead><tbody>{data.locations.map((row) => <tr key={row.id}><td><button className="run-inspect-link" onClick={() => setLocation(row.id)}>{row.name}</button></td><td>{number(row.models)}</td><td>{number(row.calls)}</td><td>{number(row.failures)}</td><td><TokenCounts metrics={row} /></td><td><Cost metrics={row} /></td><td>{row.onboarded ? <Link href={`/locations/${encodeURIComponent(row.id)}`}>Open workspace</Link> : row.attributed ? "Not currently onboarded" : "Attribution unavailable"}</td></tr>)}</tbody></table></div>
      </section>
      <section className="panel"><h2>Usage by pipeline role</h2><div className="table-wrap"><table><thead><tr><th>Role</th><th>Calls</th><th>Failed</th><th>Tokens in / out</th><th>Est. cost (USD)</th></tr></thead><tbody>{data.roles.map((row) => <tr key={row.role}><td>{row.role}</td><td>{number(row.calls)}</td><td>{number(row.failures)}</td><td><TokenCounts metrics={row} /></td><td><Cost metrics={row} /></td></tr>)}</tbody></table></div></section>
      <details className="panel"><summary>Daily usage data (UTC)</summary><div className="table-wrap"><table><thead><tr><th>Date</th><th>Calls</th><th>Failed</th><th>Tokens in / out</th><th>Est. cost (USD)</th></tr></thead><tbody>{data.daily.map((row) => <tr key={row.day}><td>{row.day}</td><td>{number(row.calls)}</td><td>{number(row.failures)}</td><td><TokenCounts metrics={row} /></td><td><Cost metrics={row} /></td></tr>)}</tbody></table></div></details>
      {data.recent_failures.length > 0 && <details className="panel"><summary>Recent failed attempts ({data.recent_failures.length}, up to 20)</summary><div className="table-wrap"><table><thead><tr><th>Time</th><th>Provider / model</th><th>Location / role</th><th>Error</th></tr></thead><tbody>{data.recent_failures.map((row, index) => <tr key={index}><td>{stamp(row.at)}</td><td>{row.provider} / {row.model ?? "unspecified"}</td><td>{row.location} / {row.role}</td><td>{row.status_code ? `${row.status_code}: ` : ""}{row.message}</td></tr>)}</tbody></table></div></details>}
      </>}
      <details className="panel"><summary>Pricing, quotas and data coverage</summary>
        <p>These are estimates, not provider invoices. Prices are USD per million input/output tokens. Only attempts with both token counts and configured rates are priced; cached-token discounts, batch discounts and other provider billing adjustments are not modeled. Configured zero prices are supported for free/local models.</p>
        <p>Configure <code>NEWSBEE_MODEL_&lt;NAME&gt;_INPUT_COST_PER_MTOK</code> and <code>NEWSBEE_MODEL_&lt;NAME&gt;_OUTPUT_COST_PER_MTOK</code> for the current model. Gemini light uses <code>GEMINI_LIGHT</code>, not the writing model's price. Exact historical or other model prices can be set with <code>NEWSBEE_MODEL_PRICING</code>; see deployment documentation. Current prices are applied to the selected history; they are not historical billing-rate snapshots.</p>
        <p>Usage records are retained for {data.retention_days} days; this dashboard supports up to 30 days. Calls predating location attribution remain unassigned. Provider metadata can omit token usage, especially on failed requests. No prompts or responses are returned by this dashboard. Provider health probes are not generation calls.</p>
        <div className="table-wrap"><table><caption>Configured quota reference (not a live quota balance)</caption><thead><tr><th>Provider / model</th><th>Requests / minute</th><th>Requests / day</th></tr></thead><tbody>{data.models.map((row) => <tr key={JSON.stringify([row.provider, row.model])}><td>{row.provider} / {row.model ?? "unspecified"}</td><td>{row.limits.requests_per_minute === null ? "Not configured" : number(row.limits.requests_per_minute)}</td><td>{row.limits.requests_per_day === null ? "Not configured" : number(row.limits.requests_per_day)}</td></tr>)}</tbody></table></div>
      </details>
      <p className="chart-caption">Updated {stamp(data.generated_at)}. Refreshes every 30 seconds.</p>
    </>}
  </>;
}
