"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import { useExecutionPolicy } from "../components/execution-policy";

type State = { method: string; label: string; last_run_at?: number; ok?: boolean; found?: number; added?: number; detail?: string; next_due_at?: number; never_run?: boolean; refresh_days?: number };
type Row = { location_id: string; location_name: string; methods: State[] };

const when = (value?: number) => value ? new Date(value * 1000).toLocaleString() : "—";

export default function DiscoveryView() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const { policy } = useExecutionPolicy();
  const load = useCallback(async () => {
    try { setRows((await adminApi<{ locations: Row[] }>("discovery")).locations); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function run(locationId: string, method: string) {
    setRunning(`${locationId}:${method}`); setError("");
    try { await adminApi("discovery", { method: "POST", body: JSON.stringify({ location_id: locationId, method }) }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setRunning(null); }
  }
  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {rows === null && <p>Loading…</p>}
    {rows?.map((row) => <section className="panel" key={row.location_id}>
      <div className="section-heading"><h2><Link href={`/locations/${encodeURIComponent(row.location_id)}?tab=sources`}>{row.location_name}</Link></h2></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Method</th><th>Last run</th><th>Result</th><th>Found</th><th>New</th><th>Next due</th><th /></tr></thead>
        <tbody>{row.methods.map((state) => <tr key={state.method}>
          <td>{state.label}</td><td>{when(state.last_run_at)}</td>
          <td>{state.never_run ? "Never run" : <><span className={`status-badge tone-${state.ok ? "ok" : "failed"}`}>{state.ok ? "ok" : "failed"}</span> <small>{state.detail}</small></>}</td>
          <td>{state.found ?? "—"}</td><td>{state.added ?? "—"}</td><td>{state.never_run ? "Next run" : when(state.next_due_at)}</td>
          <td>{state.method === "dork" ? <Link href={`/locations/${encodeURIComponent(row.location_id)}?tab=runs`}>Configure paid source-map search</Link>
            : <button type="button" className="secondary" disabled={running !== null || !policy || (state.method === "llm" && policy.reasons.length > 0)} onClick={() => void run(row.location_id, state.method)}>{running === `${row.location_id}:${state.method}` ? "Running…" : "Run now"}</button>}</td>
        </tr>)}</tbody>
      </table></div>
    </section>)}
  </>;
}
