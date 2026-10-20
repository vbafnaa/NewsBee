"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import type { healthSummary } from "@/pipeline/orchestration/health";
import type { HealthDay, HealthHistory } from "@/pipeline/orchestration/health-history";

type Snapshot = Awaited<ReturnType<typeof healthSummary>>;
type Usage = Snapshot["model_usage"];
type Series = { key: Exclude<keyof HealthDay, "day">; label: string; tone: string };
const time = (value: number | null) => value === null ? "Never" : new Date(value * 1000).toLocaleString();
const count = (value: number) => value.toLocaleString();
const tokens = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
const usd = (value: number | null) => value === null ? "—" : value < 0.01 && value > 0 ? "< $0.01" : `$${value.toFixed(2)}`;
const ofLimit = (value: number, limit: number | null) => limit ? `${count(value)} / ${count(limit)} (${Math.round((value / limit) * 100)}%)` : count(value);

function ModelUsagePanel({ usage }: { usage: Usage }) {
  const warnings = usage.providers.flatMap((provider) => provider.warnings.map((warning) => ({ provider, warning })));
  return <section className="panel">
    <div className="section-heading">
      <div><h2>Model usage &amp; cost</h2><p className="chart-caption">Every provider attempt, including fallbacks and failures. Token counts as reported by the provider.</p></div>
      <span className={`status-badge tone-${warnings.length ? "warning" : "ok"}`}>{warnings.length ? `${warnings.length} warning(s)` : "within limits"}</span>
    </div>
    <div className="metric-grid">
      <section className="metric-card"><span className="eyebrow">Calls · 24 h</span><strong>{count(usage.totals.last_24h.calls)}</strong><p>{count(usage.totals.last_24h.failures)} failed / {count(usage.totals.last_24h.rate_limited)} rate-limited</p></section>
      <section className="metric-card"><span className="eyebrow">Tokens · 24 h</span><strong>{tokens(usage.totals.last_24h.input_tokens + usage.totals.last_24h.output_tokens)}</strong><p>{tokens(usage.totals.last_24h.input_tokens)} in / {tokens(usage.totals.last_24h.output_tokens)} out</p></section>
      <section className="metric-card"><span className="eyebrow">Est. cost · 24 h</span><strong>{usd(usage.totals.last_24h.estimated_cost_usd)}</strong><p>{usage.pricing_configured ? "From configured prices" : "Set NEWSBEE_MODEL_<NAME>_*_COST_PER_MTOK"}</p></section>
      <section className="metric-card"><span className="eyebrow">Est. cost · 7 d</span><strong>{usd(usage.totals.last_7d.estimated_cost_usd)}</strong><p>{count(usage.totals.last_7d.calls)} calls / {tokens(usage.totals.last_7d.input_tokens + usage.totals.last_7d.output_tokens)} tokens</p></section>
    </div>
    {warnings.length > 0 && <ul className="run-issues">{warnings.map(({ provider, warning }, index) =>
      <li key={index} className="stage-error">{provider.provider}{provider.model ? ` (${provider.model})` : ""}: {warning}</li>)}</ul>}
    {!usage.providers.length ? <p>No model calls recorded in the last 7 days.</p> : <div className="table-wrap"><table>
      <thead><tr>
        <th>Provider / model</th><th>Calls 24 h (by role)</th><th>Failed / 429</th><th>Tokens in / out 24 h</th><th>Est. cost 24 h / 7 d</th>
        <th>Peak req/min vs limit</th><th>Requests 24 h vs daily limit</th><th>Avg latency</th><th>Last error</th>
      </tr></thead>
      <tbody>{usage.providers.map((provider) => <tr key={`${provider.provider}-${provider.model}`}>
        <td><strong>{provider.provider}</strong><br /><small>{provider.model ?? "default model"}</small></td>
        <td>{count(provider.last_24h.calls)}<br /><small>{provider.roles.map((role) => `${role.role} ${count(role.calls)}`).join(" · ") || "—"}</small></td>
        <td>{count(provider.last_24h.failures)} / {count(provider.last_24h.rate_limited)}</td>
        <td>{tokens(provider.last_24h.input_tokens)} / {tokens(provider.last_24h.output_tokens)}{provider.last_24h.calls_without_tokens > 0 && <><br /><small>{provider.last_24h.calls_without_tokens} call(s) without token counts</small></>}</td>
        <td>{usd(provider.last_24h.estimated_cost_usd)} / {usd(provider.last_7d.estimated_cost_usd)}{!provider.pricing && <><br /><small>pricing not configured</small></>}</td>
        <td>{ofLimit(provider.peak_requests_per_minute, provider.limits.requests_per_minute)}</td>
        <td>{ofLimit(provider.last_24h.calls, provider.limits.requests_per_day)}</td>
        <td>{provider.last_24h.average_duration_ms === null ? "—" : `${(provider.last_24h.average_duration_ms / 1000).toFixed(1)} s`}</td>
        <td>{provider.last_error ? <><small>{time(provider.last_error.at)}</small><br />{provider.last_error.message}</> : "—"}</td>
      </tr>)}</tbody>
    </table></div>}
    <p className="chart-caption">Costs are estimates from operator-configured prices, not provider bills. Limits are operator-configured to match your provider quota tier.</p>
  </section>;
}

function TrendChart({ title, days, series, unit = "" }: { title: string; days: HealthDay[]; series: Series[]; unit?: string }) {
  const width = 640, height = 180, baseline = 145, left = 40;
  const totals = days.map((day) => series.reduce((sum, item) => sum + (day[item.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const slot = (width - left) / days.length;
  const hasData = days.some((day) => series.some((item) => (day[item.key] ?? 0) > 0));
  return <section className="panel trend-panel">
    <h2>{title}</h2>
    <p className="chart-caption">{hasData ? `Daily totals${unit ? ` (${unit})` : ""}, UTC` : "No completed-run data in this window"}</p>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}, ${days.length} days. Exact values are available in the daily data table.`}>
      <text x="0" y="18" className="chart-axis">{Math.ceil(max)}</text>
      <text x="15" y={baseline} className="chart-axis">0</text>
      <line x1={left} y1={baseline} x2={width} y2={baseline} className="chart-baseline" />
      {days.map((day, index) => {
        let y = baseline;
        return <g key={day.day}>
          {series.map((item) => {
            const value = day[item.key];
            const barHeight = ((value ?? 0) / max) * 120;
            y -= barHeight;
            return value === null || value === 0 ? null : <rect key={item.key} x={left + index * slot + slot * .18}
              y={y} width={slot * .64} height={barHeight} className={`chart-bar ${item.tone}`}>
              <title>{day.day}: {Math.round(value * 10) / 10} {item.label}{unit ? ` ${unit}` : ""}</title>
            </rect>;
          })}
          {(index % Math.ceil(days.length / 7) === 0 || index === days.length - 1) &&
            <text x={left + index * slot + slot / 2} y="168" textAnchor="middle" className="chart-axis">{day.day.slice(5)}</text>}
        </g>;
      })}
    </svg>
    <div className="chart-legend">{series.map((item) => <span key={item.key}><i className={`legend-dot ${item.tone}`} />{item.label}</span>)}</div>
  </section>;
}

export default function HealthDashboard() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<HealthHistory | null>(null);
  const [days, setDays] = useState<7 | 30>(7);
  const [location, setLocation] = useState("");
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const [current, trends] = await Promise.all([
          adminApi<Snapshot>("health", { signal: controller.signal }),
          adminApi<HealthHistory>(`health/history?days=${days}&location=${encodeURIComponent(location)}`, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setSnapshot(current);
        setHistory(trends);
        setError("");
        setUpdated(Date.now() / 1000);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
      } finally { loading = false; }
    }
    setHistory(null);
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [days, location, refresh]);

  const rows = snapshot?.locations.filter((row) => !location || row.location_id === location) ?? [];
  const providers = snapshot?.model?.providers;
  return <>
    <div className="section-heading health-toolbar">
      <div className="period-switch" aria-label="History window">
        {([7, 30] as const).map((value) => <button key={value} className="secondary" aria-pressed={days === value} onClick={() => setDays(value)}>{value} days</button>)}
      </div>
      <label className="field"><span>Location</span><select value={location} onChange={(event) => setLocation(event.target.value)}>
        <option value="">All locations</option>{snapshot?.locations.map((row) => <option key={row.location_id} value={row.location_id}>{row.location_name}</option>)}
      </select></label>
      <button className="secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
    </div>
    {error && <p role="alert" className="alert">Health unavailable: {error}{updated ? ` Last successful update: ${time(updated)}. Displayed data may be stale.` : ""}</p>}
    {!snapshot && !error && <p role="status">Loading product health...</p>}
    {snapshot && <>
      <div className="metric-grid">
        <section className={`metric-card tone-${snapshot.status}`}><span className="eyebrow">Services now</span><strong>{snapshot.status}</strong><p>Model and scheduler readiness</p></section>
        <section className={`metric-card tone-${snapshot.scheduler.status === "ok" && !snapshot.scheduler.issues.length ? "ok" : "warning"}`}><span className="eyebrow">Scheduler</span><strong>{snapshot.scheduler.issues.length ? "errors" : snapshot.scheduler.status}</strong><p>{snapshot.scheduler.seconds_since_tick === null ? "No tick recorded" : `Last tick ${snapshot.scheduler.seconds_since_tick}s ago`}{snapshot.run_timeout_seconds ? ` · runs time out after ${Math.round(snapshot.run_timeout_seconds / 60)} min` : " · run timeout disabled"}</p></section>
        <section className="metric-card"><span className="eyebrow">Job queue</span><strong>{snapshot.queue.running} running</strong><p>{snapshot.queue.pending} waiting / {snapshot.queue.failed} failed</p></section>
        <section className="metric-card"><span className="eyebrow">Locations</span><strong>{rows.length}</strong><p>{rows.filter((row) => row.level === "ok").length} healthy / {rows.filter((row) => row.level === "warning" || row.level === "failed").length} need attention</p></section>
      </div>
      {(snapshot.scheduler.status !== "ok" && snapshot.queue.pending > 0 || snapshot.scheduler.issues.length > 0) && <section className="alert" role="alert">
        <strong>Queued pipeline work is not advancing</strong>
        <ul>
          {snapshot.scheduler.status !== "ok" && snapshot.queue.pending > 0 && <li>
            Scheduler is not running ({snapshot.scheduler.last_tick_at === null ? "no tick recorded" : `last tick ${time(snapshot.scheduler.last_tick_at)}`}) with {snapshot.queue.pending} job(s) waiting. Configure Vercel Cron (see vercel.mjs) or another scheduler to call /api/pipeline/tick every minute with CRON_SECRET.
          </li>}
          {snapshot.scheduler.issues.map((issue) => <li key={issue.channel}>{issue.message} ({time(issue.at)})</li>)}
        </ul>
      </section>}
      <section className="panel">
        <div className="section-heading"><h2>Model providers</h2><span className={`status-badge tone-${snapshot.model?.status ?? "idle"}`}>{snapshot.model?.status ?? "not configured"}</span></div>
        <div className="provider-grid">{providers ? providers.map((provider) =>
          <div className="provider-card" key={provider.name}><span className={`status-badge tone-${provider.status}`}>{provider.status}</span><h3>{provider.name}</h3><p>{provider.model}</p><small>{provider.detail}</small></div>) :
          <p>{snapshot.model?.detail ?? "No model configured"}</p>}</div>
        <p className="chart-caption">Live checks only. Historical provider uptime and queue depth were not recorded.</p>
      </section>
      <ModelUsagePanel usage={snapshot.model_usage} />
    </>}
    {!history && !error && <p role="status">Loading trend history...</p>}
    {history && <>
      <div className="trend-grid">
        <TrendChart title="Run outcomes" days={history.series} series={[{ key: "completed_runs", label: "Published runs", tone: "positive" }, { key: "failed_runs", label: "Failed runs", tone: "negative" }]} />
        <TrendChart title="Published vs held stories" days={history.series} series={[{ key: "published_items", label: "Published", tone: "positive" }, { key: "held_items", label: "Held by validation", tone: "caution" }]} />
        <TrendChart title="Source outcomes" days={history.series} series={[{ key: "source_ready", label: "Collected", tone: "positive" }, { key: "source_unavailable", label: "No feed / context / blocked", tone: "caution" }, { key: "source_failed", label: "Failed", tone: "negative" }]} />
        <TrendChart title="Average run duration" days={history.series} series={[{ key: "average_duration_seconds", label: "Average duration", tone: "informational" }]} unit="seconds" />
      </div>
      <details className="panel"><summary>Daily data (UTC)</summary><div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Published / failed runs</th><th>Published / held stories</th><th>Collected / unavailable / failed sources</th><th>Avg duration (s)</th></tr></thead>
        <tbody>{history.series.map((day) => <tr key={day.day}><td>{day.day}</td><td>{day.completed_runs} / {day.failed_runs}</td><td>{day.published_items} / {day.held_items}</td><td>{day.source_ready} / {day.source_unavailable} / {day.source_failed}</td><td>{day.average_duration_seconds === null ? "No runs" : Math.round(day.average_duration_seconds)}</td></tr>)}</tbody>
      </table></div></details>
    </>}
    <section className="panel">
      <div className="section-heading"><h2>Location health</h2><Link className="nav-button" href="/">Manage runs &amp; locations</Link></div>
      <div className="location-grid">{rows.map((row) => <details className={`location-card tone-${row.level}`} key={row.location_id}>
        <summary><span>{row.location_name}</span><span className={`status-badge tone-${row.level}`}>{row.level}</span></summary>
        <p>Latest stage: {row.stage} / {row.published_items ?? "-"} published / {row.held ?? "-"} held</p>
        <p>Sources: {row.sources.completed} completed, {row.sources.failed} failed, {row.sources.pending} pending</p>
        <p>Started {time(row.started_at)}</p>
        {row.diagnostics?.issues.map((issue, index) => <p className={issue.severity === "info" ? "chart-caption" : "stage-error"} key={`${issue.code}-${index}`}>{issue.message}</p>)}
        {row.diagnostics?.deadline_at && !row.diagnostics.overdue && <p className="chart-caption">Automatic timeout at {time(row.diagnostics.deadline_at)}</p>}
        {row.error && <p className="stage-error">{row.error}</p>}
        {row.failed_sources.map((source) => <p className="stage-error" key={source.source_id}>{source.name}: {source.error}</p>)}
        {row.empty_sources.map((source) => <p key={source.source_id}>{source.name}: {source.detail ?? "No events collected"}</p>)}
        {Object.entries(row.held_reasons).map(([reason, count]) => <p key={reason}>{count} held: {reason}</p>)}
        {row.model_errors.map((detail, index) => <p className="stage-error" key={index}>{detail}</p>)}
        {row.run_id && <Link href={`/?run=${encodeURIComponent(row.run_id)}&location=${encodeURIComponent(row.location_id)}`}>Inspect run and stories</Link>}
      </details>)}</div>
      {snapshot && !rows.length && <p>No locations in this view.</p>}
    </section>
    <p className="chart-caption">Updated {time(updated)}. Refreshes every 15 seconds. Charts include terminal runs by completion date, not active runs.</p>
  </>;
}
