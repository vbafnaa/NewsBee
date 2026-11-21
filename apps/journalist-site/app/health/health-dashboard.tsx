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
const costLabel = (window: Usage["totals"]["last_24h"]) => window.cost_complete === false
  ? window.known_cost_usd === null || window.known_cost_usd === undefined ? "Unknown" : `${usd(window.known_cost_usd)} known subtotal`
  : usd(window.estimated_cost_usd);

function ModelUsagePanel({ usage }: { usage: Usage }) {
  const warnings = usage.providers.flatMap((provider) => provider.warnings.map((warning) => ({ provider, warning })));
  return <section className="panel">
    <div className="section-heading">
      <div><h2>Model usage &amp; cost</h2><p className="chart-caption">Every provider attempt, including fallbacks and failures. Token counts as reported by the provider.</p></div>
      <span className={`status-badge tone-${warnings.length ? "warning" : "idle"}`}>{warnings.length ? `${warnings.length} warning(s)` : "no recorded warnings"}</span>
    </div>
    <div className="metric-grid">
      <section className="metric-card"><span className="eyebrow">Calls · 24 h</span><strong>{count(usage.totals.last_24h.calls)}</strong><p>{count(usage.totals.last_24h.failures)} failed / {count(usage.totals.last_24h.rate_limited)} rate-limited</p></section>
      <section className="metric-card"><span className="eyebrow">Tokens · 24 h</span><strong>{tokens(usage.totals.last_24h.input_tokens + usage.totals.last_24h.output_tokens)}</strong><p>{tokens(usage.totals.last_24h.input_tokens)} in / {tokens(usage.totals.last_24h.output_tokens)} out</p></section>
      <section className="metric-card"><span className="eyebrow">Est. cost · 24 h</span><strong>{costLabel(usage.totals.last_24h)}</strong><p>{usage.totals.last_24h.cost_complete === false ? "Partial: some prices or token counts are unknown" : "From configured prices"}</p></section>
      <section className="metric-card"><span className="eyebrow">Est. cost · 7 d</span><strong>{costLabel(usage.totals.last_7d)}</strong><p>{count(usage.totals.last_7d.calls)} calls / {tokens(usage.totals.last_7d.input_tokens + usage.totals.last_7d.output_tokens)} tokens</p></section>
    </div>
    {warnings.length > 0 && <ul className="run-issues">{warnings.map(({ provider, warning }, index) =>
      <li key={index} className="stage-error">{provider.provider}{provider.model ? ` (${provider.model})` : ""}: {warning}</li>)}</ul>}
    {!usage.providers.length ? <p>No model calls recorded in the last 7 days.</p> : <div className="table-wrap"><table>
      <thead><tr>
        <th>Provider / model</th><th>Calls 24 h (by role)</th><th>Failed / 429</th><th>Tokens in / out 24 h</th><th>Est. cost 24 h / 7 d</th>
        <th>Peak req/min vs limit</th><th>Requests 24 h vs daily limit</th><th>Avg latency</th><th>Last observed call / success</th><th>Last error</th>
      </tr></thead>
      <tbody>{usage.providers.map((provider) => <tr key={`${provider.provider}-${provider.model}`}>
        <td><strong>{provider.provider}</strong><br /><small>{provider.model ?? "default model"}</small></td>
        <td>{count(provider.last_24h.calls)}<br /><small>{provider.roles.map((role) => `${role.role} ${count(role.calls)}`).join(" · ") || "—"}</small></td>
        <td>{count(provider.last_24h.failures)} / {count(provider.last_24h.rate_limited)}</td>
        <td>{tokens(provider.last_24h.input_tokens)} / {tokens(provider.last_24h.output_tokens)}{provider.last_24h.calls_without_tokens > 0 && <><br /><small>{provider.last_24h.calls_without_tokens} call(s) without token counts</small></>}</td>
        <td>{costLabel(provider.last_24h)} / {costLabel(provider.last_7d)}{!provider.pricing && <><br /><small>pricing not configured</small></>}</td>
        <td>{ofLimit(provider.peak_requests_per_minute, provider.limits.requests_per_minute)}</td>
        <td>{ofLimit(provider.last_24h.calls, provider.limits.requests_per_day)}</td>
        <td>{provider.last_24h.average_duration_ms === null ? "—" : `${(provider.last_24h.average_duration_ms / 1000).toFixed(1)} s`}</td>
        <td><small>{time(provider.observed.last_call_at)} / {time(provider.observed.last_success_at)}</small></td>
        <td>{provider.last_error ? <><small>{time(provider.last_error.at)}</small><br />{provider.last_error.message}</> : "—"}</td>
      </tr>)}</tbody>
    </table></div>}
    <p className="chart-caption">Costs are estimates from operator-configured prices, not provider bills. Limits are operator-configured to match your provider quota tier.</p>
  </section>;
}

/** Historical bindings remain visible without implying that new work needs personal keys. */
function RunModelsPanel({ usage }: { usage: Usage }) {
  return <section className="panel">
    <div className="section-heading"><div><h2>Models by run</h2><p className="chart-caption">The last 7 days of recorded attempts. New work uses Newsbee-managed providers; historical runs may retain personal or deployment credential bindings. <a href="/health?view=usage">Model usage</a> breaks this down by person and run. Costs with unpriced calls are known subtotals only.</p></div></div>
    {!usage.runs?.length ? <p>No run made model calls in the last 7 days.</p> : <div className="table-wrap"><table>
      <thead><tr><th>Run</th><th>Started by</th><th>Models (calls)</th><th>Calls / failed</th><th>Est. cost</th></tr></thead>
      <tbody>{usage.runs.map((run) => <tr key={run.run_id}>
        <td><a href={run.location_id ? `/locations/${encodeURIComponent(run.location_id)}?tab=runs&run=${encodeURIComponent(run.run_id)}` : "#"}>{run.location_name ?? run.run_id}</a><br /><small>{run.kind === "map" ? "Source map" : "Edition"}{run.started_at ? ` · ${time(run.started_at)}` : ""}</small></td>
        <td>
          {run.started_by ?? "Unknown"}<br />
          <small>{run.credential_source === "platform" ? "Newsbee-managed providers" : run.credential_source === "environment" ? "deployment default keys" : run.credential_source === "personal" ? "own keys" : ""}</small>
        </td>
        <td>{run.models.map((model) => `${model.model ?? model.provider} (${count(model.calls)})`).join(", ")}</td>
        <td>{count(run.calls)} / {count(run.failures)}</td>
        <td>{usd(run.estimated_cost_usd)}{run.unpriced_calls > 0 && <><br /><small>{run.estimated_cost_usd === null ? "unknown cost" : "known subtotal"} · {count(run.unpriced_calls)} unpriced call(s)</small></>}</td>
      </tr>)}</tbody>
    </table></div>}
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

export default function HealthDashboard({ mode = "health" }: { mode?: "health" | "models" }) {
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
          mode === "health" ? adminApi<HealthHistory>(`health/history?days=${days}&location=${encodeURIComponent(location)}`, { signal: controller.signal }) : Promise.resolve(null),
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
  }, [days, location, refresh, mode]);

  const rows = snapshot?.locations.filter((row) => !location || row.location_id === location) ?? [];
  const providers = snapshot?.model?.providers;
  const schedulerIdle = snapshot ? snapshot.queue.pending + snapshot.queue.running === 0 : true;
  return <>
    <div className="section-heading health-toolbar">
      {mode === "health" && <><div className="period-switch" aria-label="History window">
        {([7, 30] as const).map((value) => <button key={value} className="secondary" aria-pressed={days === value} onClick={() => setDays(value)}>{value} days</button>)}
      </div>
      <label className="field"><span>Location</span><select value={location} onChange={(event) => setLocation(event.target.value)}>
        <option value="">All locations</option>{snapshot?.locations.map((row) => <option key={row.location_id} value={row.location_id}>{row.location_name}</option>)}
      </select></label></>}
      <button className="secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
    </div>
    {error && <p role="alert" className="alert">Health unavailable: {error}{updated ? ` Last successful update: ${time(updated)}. Displayed data may be stale.` : ""}</p>}
    {!snapshot && !error && <p role="status">Loading product health...</p>}
    {snapshot && <>
      {mode === "health" && <><div className="metric-grid">
        <section className={`metric-card tone-${snapshot.status}`}><span className="eyebrow">Recorded health</span><strong>{snapshot.status}</strong><p>Configuration and recorded observations; not a live check</p></section>
        <section className={`metric-card tone-${schedulerIdle || snapshot.scheduler.status === "ok" && !snapshot.scheduler.issues.length ? "ok" : "warning"}`}><span className="eyebrow">Scheduler</span><strong>{schedulerIdle ? "idle" : snapshot.scheduler.issues.length ? "errors" : snapshot.scheduler.status}</strong><p>{snapshot.scheduler.seconds_since_tick === null ? "No tick recorded" : `Last tick ${snapshot.scheduler.seconds_since_tick}s ago`}{snapshot.run_timeout_seconds ? ` · in-progress stages time out after ${Math.round(snapshot.run_timeout_seconds / 60)} min (editor waits excluded)` : " · stage timeout disabled"}</p></section>
        <section className="metric-card"><span className="eyebrow">Job queue</span><strong>{snapshot.queue.running} running</strong><p>{snapshot.queue.pending} waiting / {snapshot.queue.failed} failed. Last observed consumer delivery: {time(snapshot.observations.last_consumer_delivery_at)}</p></section>
        <section className="metric-card"><span className="eyebrow">Locations</span><strong>{rows.length}</strong><p>{rows.filter((row) => row.level === "ok").length} healthy / {rows.filter((row) => row.level === "warning" || row.level === "failed").length} need attention</p></section>
      </div>
      {(snapshot.scheduler.status !== "ok" && snapshot.queue.pending > 0 && snapshot.queue.running === 0 || snapshot.scheduler.issues.length > 0) && <section className="alert" role="alert">
        <strong>Recorded scheduler / queue issues</strong>
        <ul>
          {snapshot.scheduler.status !== "ok" && snapshot.queue.pending > 0 && snapshot.queue.running === 0 && <li>
            No pipeline worker has run recently ({snapshot.scheduler.last_tick_at === null ? "no call recorded" : `last call ${time(snapshot.scheduler.last_tick_at)}`}) with {snapshot.queue.pending} job(s) waiting. Use Resume on the run's current stage in Runs &amp; locations to restart processing. Cron remains disabled.
          </li>}
          {snapshot.scheduler.issues.map((issue) => <li key={issue.channel}>{issue.message} ({time(issue.at)})</li>)}
        </ul>
      </section>}
      </>}
      <section className="panel">
        <div className="section-heading"><h2>Managed model configuration</h2><span className={`status-badge tone-${snapshot.model.status === "not_configured" ? "failed" : "idle"}`}>{snapshot.model.status.replaceAll("_", " ")}</span></div>
        <p>{snapshot.model.detail}</p>
        {mode === "models" && <div className="provider-grid">{providers?.map((provider) =>
          <div className="provider-card" key={`${provider.name}-${provider.model}`}><span className={`status-badge tone-${provider.configured ? "idle" : "warning"}`}>{provider.configured ? "configured · untested" : "not configured"}</span><h3>{provider.name}</h3><p>{provider.model}</p><small>RPM cap: {provider.limits.requests_per_minute ?? "unknown"} · Daily provider cap: {provider.limits.requests_per_day ?? "unknown"} · Input/output per million tokens: {usd(provider.pricing.input_per_mtok)} / {usd(provider.pricing.output_per_mtok)}</small></div>)}</div>}
        {snapshot.model_budget && <p>Shared managed allowance today: {count(snapshot.model_budget.used)} / {count(snapshot.model_budget.cap)} attempts; {count(snapshot.model_budget.remaining)} remaining. Resets {time(snapshot.model_budget.resets_at)} (UTC midnight). {snapshot.model_budget.exhausted ? "Exhausted." : snapshot.model_budget.near ? "Near limit." : ""} Historical calls with unknown funding: {count(snapshot.model_budget.unknown_historical_calls)}; reserved or unrecorded: {count(snapshot.model_budget.reserved_or_unrecorded)}.</p>}
        <p className="chart-caption">Configured does not mean live tested. This page makes no provider probes or quota reservations. Usage observations include historical bindings, not only managed work.</p>
        {snapshot.configuration.wiring && <p className="chart-caption">Wiring: queue consumer route declared; scheduler authentication {snapshot.configuration.wiring.scheduler_auth_configured ? "configured" : "not configured"}; automatic scheduling disabled. Wiring is not proof of consumer delivery.</p>}
        {mode === "models" && Object.keys(snapshot.configuration.integrations).length > 0 && <p className="chart-caption">Integration configuration (not live tested): {Object.entries(snapshot.configuration.integrations).map(([name, configured]) => `${name}: ${configured ? "configured" : "not configured"}`).join(" · ")}</p>}
      </section>
      {mode === "models" && <ModelUsagePanel usage={snapshot.model_usage} />}
      {mode === "health" && snapshot.model_usage && <RunModelsPanel usage={snapshot.model_usage} />}
      {mode === "health" && snapshot.publication_freshness.length > 0 && <section className="panel">
        <h2>Publication freshness</h2>
        <p className="chart-caption">Recorded successful stages, not live reader checks. A historical publication remains historical when its release is withdrawn.</p>
        <div className="table-wrap"><table><thead><tr><th>Publication</th><th>Built</th><th>Ever published</th><th>Currently live</th><th>Availability</th></tr></thead><tbody>
          {snapshot.publication_freshness.map((publication) => <tr key={publication.publication_id}><td>{publication.publication_id}</td><td>{time(publication.built_at)}</td><td>{time(publication.published_at)}</td><td>{time(publication.live_published_at)}</td><td>{publication.availability.replaceAll("_", " ")}</td></tr>)}
        </tbody></table></div>
      </section>}
      {mode === "health" && <section className="panel">
        <div className="section-heading"><div><h2>Sources needing attention</h2><p className="chart-caption">Failing: 3 or more collections in a row failed or were blocked. Quiet: 4 or more successful collections in a row found nothing.</p></div>
          <span className={`status-badge tone-${snapshot.source_attention.length ? "warning" : "ok"}`}>{snapshot.source_attention.length ? `${snapshot.source_attention.length} source(s)` : "all healthy"}</span></div>
        {snapshot.source_attention.length > 0 && <div className="table-wrap"><table>
          <thead><tr><th>Location</th><th>Source</th><th>Flag</th><th>Last status</th><th>Last success</th><th>Last items</th></tr></thead>
          <tbody>{snapshot.source_attention.map((item) => <tr key={item._id}>
            <td>{item.location_id}</td><td>{item.source_id}</td><td>{item.flag} ({item.flag === "failing" ? item.consecutive_failures : item.consecutive_empty} runs)</td>
            <td>{item.last_status} on {item.last_day}</td><td>{item.last_success_day ?? "never"}</td><td>{item.last_items_day ?? "never"}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>}
    </>}
    {mode === "health" && !history && !error && <p role="status">Loading trend history...</p>}
    {mode === "health" && history && <>
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
    {mode === "health" && <section className="panel">
      <div className="section-heading"><h2>Location health</h2><Link className="nav-button" href="/locations">Manage locations &amp; runs</Link></div>
      <div className="location-grid">{rows.map((row) => <details className={`location-card tone-${row.level}`} key={row.location_id}>
        <summary><span>{row.location_name}</span><span className={`status-badge tone-${row.level}`}>{row.level}</span></summary>
        <p>Latest stage: {row.stage.replaceAll("_", " ")} / {row.built_items ?? "-"} prepared / {row.published_items ?? "-"} published / {row.held ?? "-"} held</p>
        {row.stage === "awaiting_authoring" && <p>{row.candidate_count === 0 ? "Collection finished — no usable items. Review sources and retry collection in Location workspaces." : "Waiting for an editor to start authoring in Runs & locations."}</p>}
        {row.stage === "awaiting_finish" && <p>Waiting for an editor to write the front page and email preview, then publish.</p>}
        <p>Sources: {row.sources.completed} completed, {row.sources.failed} failed, {row.sources.pending} pending</p>
        <p>Started {time(row.started_at)}</p>
        {snapshot?.freshness.filter((item) => item.location_id === row.location_id).map((item) => <p className="chart-caption" key={item.location_id}>Last successful map: {time(item.mapped_at)} · Built: {time(item.built_at)} · Actual publish: {time(item.published_at)} · Recorded live: {time(item.live_published_at)} ({item.availability.replaceAll("_", " ")})</p>)}
        {row.diagnostics?.issues.map((issue, index) => <p className={issue.severity === "info" ? "chart-caption" : "stage-error"} key={`${issue.code}-${index}`}>{issue.message}</p>)}
        {row.diagnostics?.deadline_at && !row.diagnostics.overdue && <p className="chart-caption">Automatic timeout at {time(row.diagnostics.deadline_at)}</p>}
        {row.error && <p className="stage-error">{row.error}</p>}
        {row.failed_sources.map((source) => <p className="stage-error" key={source.source_id}>{source.name}: {source.error}</p>)}
        {row.empty_sources.map((source) => <p key={source.source_id}>{source.name}: {source.detail ?? "No events collected"}</p>)}
        {Object.entries(row.held_reasons).map(([reason, count]) => <p key={reason}>{count} held: {reason}</p>)}
        {row.model_errors.map((detail, index) => <p className="stage-error" key={index}>{detail}</p>)}
        {row.run_id && <Link href={`/locations/${encodeURIComponent(row.location_id)}?tab=edition&run=${encodeURIComponent(row.run_id)}`}>Inspect run and stories</Link>}
      </details>)}</div>
      {snapshot && !rows.length && <p>No locations in this view.</p>}
    </section>}
    <p className="chart-caption">Updated {time(updated)}. Refreshes every 15 seconds. Charts include terminal runs by completion date, not active runs.</p>
  </>;
}
