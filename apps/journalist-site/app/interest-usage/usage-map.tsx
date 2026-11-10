"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiJson, mapApi } from "@/lib/admin-client";
import type { UsageSummary } from "@/pipeline/analytics/usage";
import InteractiveHeatmap from "./interactive-heatmap";

const METRICS = [["reads", "Edition reads"], ["subscriptions", "Subscription signups"], ["interest", "Interest signups"]] as const;
type Metric = (typeof METRICS)[number][0];
const COLORS = { reads: "#286b91", subscriptions: "#276749", interest: "#a65a17" };
const day = (value: string | null) => value ? new Date(value).toLocaleDateString() : "No recorded history";

const loadRecordedUsage = (range: string) => mapApi<UsageSummary>(`usage-map${range ? `?${range}` : ""}`);

export default function UsageMap({ loadUsage = loadRecordedUsage, preview = false, signedIn = false }: {
  loadUsage?: (range: string) => Promise<UsageSummary>; preview?: boolean; signedIn?: boolean;
}) {
  const router = useRouter();
  const [data, setData] = useState<UsageSummary | null>(null);
  const [metric, setMetric] = useState<Metric>("reads");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [range, setRange] = useState("");
  const [location, setLocation] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setData(null); setError(""); setSelected(""); setLocation("");
    loadUsage(range).then((value) => { if (active) setData(value); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [range, loadUsage]);
  const rows = useMemo(() => (data?.rows ?? []).filter((row) => !location || row.id === location).sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name)), [data, location, metric]);
  const totals = rows.reduce((sum, row) => ({ reads: sum.reads + row.reads, subscriptions: sum.subscriptions + row.subscriptions, interest: sum.interest + row.interest }), { reads: 0, subscriptions: 0, interest: 0 });
  const unmapped = rows.filter((row) => row.latitude === null || row.longitude === null);
  return <>
    <section className="panel">
      <form className="workspace-toolbar" onSubmit={(event) => {
        event.preventDefault();
        if (from && to && from > to) { setError("Start date must not follow end date."); return; }
        setError("");
        setRange(new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString());
      }}>
        <label className="field">From (UTC)<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className="field">Through (UTC)<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <button type="submit">Apply dates</button><button type="button" className="secondary" onClick={() => { setFrom(""); setTo(""); setRange(""); setError(""); }}>All recorded history</button>
        {!preview && !signedIn && <button type="button" className="secondary" onClick={async () => {
          try { await apiJson("/api/internal-access", { method: "DELETE" }); router.refresh(); }
          catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        }}>Lock maps</button>}
      </form>
      <p className="chart-caption">Blank dates: all history (UTC).</p>
    </section>
    {error && <p className="alert" role="alert">{error}</p>}
    {!data && !error && <p role="status">Loading recorded usage…</p>}
    {data && <>
      <div className="metric-grid usage-metrics">{METRICS.map(([key, label]) => <button key={key} type="button" className="metric-card" aria-pressed={metric === key} onClick={() => setMetric(key)} style={{ borderTopColor: COLORS[key] }}><small>{label}</small><strong>{totals[key].toLocaleString()}</strong><span>Show on map</span></button>)}</div>
      <section className="panel">
        <div className="section-heading"><div><h2>{METRICS.find(([key]) => key === metric)![1]} by community</h2><p>Darker means more activity.</p></div>
          <label className="field">Location<select aria-label="Location" value={location} onChange={(event) => { setLocation(event.target.value); setSelected(""); }}><option value="">All recorded locations</option>{data.rows.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label></div>
        {!totals[metric] ? <p className="empty-state">No {METRICS.find(([key]) => key === metric)![1].toLowerCase()} recorded for this selection. No activity is inferred from searches, source clicks or model calls.</p> :
          <InteractiveHeatmap key={`${range}/${location}/${metric}`} rows={rows} metric={metric} selected={selected} onSelect={setSelected} />}
        {unmapped.length > 0 && <p className="notice">{unmapped.length} location(s) have no saved coordinates. Their counts remain in the totals and table but are not placed on the map.</p>}
        <div className="table-wrap"><table><caption>Exact counts by newsletter / requested location</caption><thead><tr><th>Community</th>{METRICS.map(([key, label]) => <th key={key}>{label}</th>)}<th>Coverage</th></tr></thead><tbody>
          {rows.map((row) => <tr key={row.id} className={selected === row.id ? "selected-row" : ""}><td><button className="run-inspect-link" onClick={() => setSelected(row.id)}>{row.name}</button>{(row.latitude === null || row.longitude === null) && <small> · not mapped</small>}</td>{METRICS.map(([key]) => <td key={key}>{row[key].toLocaleString()}</td>)}<td>{preview ? "Sample only" : row.onboarded ? <Link href={`/locations/${encodeURIComponent(row.id)}`}>Open workspace</Link> : <Link href="/locations#onboarding">Not onboarded</Link>}</td></tr>)}
        </tbody></table></div>
        {!rows.length && <p>No activity in this range.</p>}
      </section>
      <details className="panel"><summary>Metric definitions, privacy &amp; history</summary>
        <dl className="metric-definitions"><dt>Edition reads</dt><dd>One anonymous edition-view event, not one event per story. Reloads and return visits count again; these are not unique people. Source opens and shares are excluded. Tracking can be blocked and is not email-open tracking.</dd>
          <dt>Subscription signups</dt><dd>The first recorded weekly-update signup per email and location through the subscription form. Email delivery is not active.</dd>
          <dt>Interest signups</dt><dd>The first recorded launch-interest signup per email and requested location. One person can explicitly register both intents; repeating either form does not inflate that metric.</dd>
          <dt>Geography and privacy</dt><dd>Saved community coordinates, not IP geolocation. No email addresses, IP addresses or reader identifiers are returned by this map.</dd>
          <dt>Available history</dt><dd>First read: {day(data.history.first_read)}. First separately recorded subscription: {day(data.history.first_subscription)}. First separately recorded interest: {day(data.history.first_interest)}. Historical gaps are not backfilled.</dd>
          <dt>Legacy signup records</dt><dd>{data.history.unclassified_legacy_signups} older record(s) have an ambiguous original intent. Their historical signups are excluded from both intent totals. New explicit intents on these records count from the time they are separately recorded.</dd>
        </dl>
      </details>
    </>}
  </>;
}
