"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";

type Step = { step: string; label: string; count: number; previous: number | null };
type Row = {
  location_id: string; location_name: string; alerts: number; sources: Record<string, number>; funnel: Step[];
  run: { id: string; status: string; created_at: number; completed_at: number | null; duration_seconds: number; active: boolean; sources: number; sources_done: number; published: number | null; held: number | null; error: string | null } | null;
};
type Alert = { id: string; severity: string; location_name: string | null; message: string; fix: string; link: string };
type Overview = {
  strip: { model: { used: number; cap: number; near: boolean; exhausted: boolean }; queue: Record<string, number>; failing_sources: number; discovery_due: number; alerts: number };
  locations: Row[];
  alerts: Alert[];
};

const minutes = (seconds: number) => seconds < 90 ? `${Math.round(seconds)} s` : seconds < 5400 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`;
const stage = (status: string) => status.replaceAll("_", " ");

export default function DashboardHome() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setData(await adminApi<Overview>("overview")); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15000); return () => window.clearInterval(timer); }, [load]);
  async function startAll() {
    setBusy(true);
    try { await adminApi("ingestion", { method: "POST" }); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  const pick = (row: Row, step: string) => row.funnel.find((item) => item.step === step);
  return <>
    <div className="workflow-grid">
      <Link className="workflow-card" href="/locations"><span className="eyebrow">01 · Prepare coverage</span><strong>Location workspaces</strong><small>Onboard a community or open its desk</small></Link>
      <Link className="workflow-card" href="/inbox"><span className="eyebrow">02 · Review inputs</span><strong>Editorial inbox</strong><small>Approve sources and stories before collection</small></Link>
      <Link className="workflow-card" href="/alerts"><span className="eyebrow">03 · Resolve blockers</span><strong>Attention queue</strong><small>Unblock sources, jobs and staged runs</small></Link>
    </div>
    {error && <p className="alert" role="alert">{error}</p>}
    {!data && !error && <p role="status">Loading newsroom health…</p>}
    {data && <div className="strip">
      <div className={`strip-card${data.strip.model.exhausted ? " bad" : data.strip.model.near ? " warn" : ""}`}><small>Model calls today</small><strong>{data.strip.model.used} / {data.strip.model.cap}</strong><Link href="/model-usage">Model usage</Link></div>
      <div className="strip-card"><small>Jobs running / waiting</small><strong>{data.strip.queue.running ?? 0} / {data.strip.queue.pending ?? 0}</strong></div>
      <div className={`strip-card${data.strip.failing_sources ? " warn" : ""}`}><small>Sources failing 3+ runs</small><strong>{data.strip.failing_sources}</strong></div>
      <div className="strip-card"><small>Discovery methods due</small><strong>{data.strip.discovery_due}</strong><Link href="/discovery">Discovery</Link></div>
      <div className={`strip-card${data.strip.alerts ? " warn" : ""}`}><small>Open alerts</small><strong>{data.strip.alerts}</strong><Link href="/alerts">Alerts</Link></div>
    </div>}
    <section className="panel">
      <div className="section-heading"><div><h2>Community desks</h2><p>Changes compare with the previous edition.</p></div>
        <Link className="button" href="/locations#onboarding">Onboard a location</Link></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Location</th><th>Latest pipeline activity</th><th>Sources</th><th>Edition funnel</th><th>Attention</th></tr></thead>
        <tbody>{data?.locations.map((row) => {
          const cell = (step: string) => { const value = pick(row, step); return value ? <>{value.count}{value.previous !== null && value.previous !== undefined && <small> ({value.count >= value.previous ? "+" : "−"}{Math.abs(value.count - value.previous)})</small>}</> : "—"; };
          return <tr key={row.location_id}>
            <td><Link href={`/locations/${encodeURIComponent(row.location_id)}`}><strong>{row.location_name}</strong></Link><div className="desk-links"><Link href={`/locations/${encodeURIComponent(row.location_id)}?tab=review`}>Review inputs</Link><Link href={`/locations/${encodeURIComponent(row.location_id)}?tab=runs`}>Pipeline</Link></div></td>
            <td>{row.run ? <><Link href={`/locations/${encodeURIComponent(row.location_id)}?tab=runs&run=${encodeURIComponent(row.run.id)}`}><span className={`status-badge tone-${row.run.status === "failed" ? "failed" : row.run.active ? "running" : row.run.status === "published" ? "ok" : "warning"}`}>{stage(row.run.status)}</span></Link><small className="activity-time">{new Date(row.run.created_at * 1000).toLocaleDateString()} · {minutes(row.run.duration_seconds)}</small></> : "No runs yet"}{row.run?.error && <small className="stage-error"> {row.run.error}</small>}</td>
            <td>{(row.sources.active ?? 0) + (row.sources.pinned ?? 0)} active{row.sources.dormant ? `, ${row.sources.dormant} dormant` : ""}{row.run?.active ? <small> · {row.run.sources_done}/{row.run.sources} done</small> : null}</td>
            <td><dl className="mini-funnel">{[["collected", "Collected"], ["local", "Local"], ["candidates", "Candidates"], ["published", "Published"]].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{cell(key)}</dd></div>)}</dl></td>
            <td>{row.alerts ? <Link href={`/locations/${encodeURIComponent(row.location_id)}?tab=review`}>{row.alerts} alerts</Link> : <span className="muted">Clear</span>}</td>
          </tr>;
        })}</tbody>
      </table></div>
      {data && !data.locations.length && <p>No locations yet. <Link href="/locations">Add one</Link>.</p>}
    </section>
    <section className="notice"><p>One unfinished source-map or edition run may occupy the newsroom. Open a location to start or resume its run; paused and editor-waiting work holds the slot too.</p></section>
    {data && data.alerts.length > 0 && <section className="panel"><h2>Latest alerts</h2>
      <ul className="alert-list">{data.alerts.map((alert) => <li key={alert.id}>
        <span><span className={`status-badge tone-${alert.severity}`}>{alert.severity}</span> {alert.location_name && <strong>{alert.location_name}: </strong>}{alert.message}</span>
        <small>{alert.fix} <Link href={alert.link}>Open</Link></small>
      </li>)}</ul></section>}
  </>;
}
