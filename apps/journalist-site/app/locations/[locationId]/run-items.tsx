"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import ItemTrace from "./item-trace";
import { useExecutionPolicy } from "../../components/execution-policy";

type Item = { _id: string; source_id: string; source_name: string; title: string; url: string | null; event_date: string | null; status: string; reason: string | null; step: string; section?: string | null; rank?: number | null; score?: number | null };
type Page = { items: Item[]; total: number; counts: Record<string, number> };

/** The selected run's items with their outcome, searchable, each traceable from source to story. */
export default function RunItems({ locationId }: { locationId: string }) {
  const [runId, setRunId] = useState<string | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [trace, setTrace] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { policy } = useExecutionPolicy();
  useEffect(() => {
    setRunId(new URLSearchParams(window.location.search).get("run"));
    const inspect = (event: Event) => { setRunId((event as CustomEvent<{ runId: string }>).detail.runId); setTrace(null); };
    window.addEventListener("newsbee:inspect-run", inspect);
    return () => window.removeEventListener("newsbee:inspect-run", inspect);
  }, []);
  const load = useCallback(async () => {
    if (!runId) return;
    try { setPage(await adminApi<Page>(`runs/${encodeURIComponent(runId)}/items?q=${encodeURIComponent(query)}&status=${encodeURIComponent(status)}`)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [runId, query, status]);
  useEffect(() => { void load(); }, [load]);
  async function reassemble() {
    if (!runId || !window.confirm("Throw away this run's ranking and drafts and assemble again from the collected items?")) return;
    setBusy(true);
    try { await adminApi(`runs/${encodeURIComponent(runId)}/actions`, { method: "POST", body: JSON.stringify({ action: "reassemble" }) }); window.dispatchEvent(new Event("newsbee:runs-changed")); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  if (!runId) return <section className="panel"><h2>Items</h2><p>Inspect a run to see its items.</p></section>;
  return <section className="panel" id="run-items">
    <div className="section-heading"><div><h2>Items in this run</h2><p>{page ? `${page.total} items · ${Object.entries(page.counts).map(([key, value]) => `${value} ${key.replace(/_/g, " ")}`).join(" · ")}` : "Loading…"}</p></div>
      <button type="button" className="secondary" disabled={busy || !policy?.permissions[runId]?.canSpend} onClick={() => void reassemble()}>Reassemble and rewrite</button></div>
    {error && <p className="alert" role="alert">{error}</p>}
    <div className="filters">
      <label>Search<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Headline" /></label>
      <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All</option>{["published", "candidate", "pooled", "not_selected", "held", "dropped", "collected"].map((value) => <option key={value} value={value}>{value.replace(/_/g, " ")}</option>)}</select></label>
    </div>
    {trace && <ItemTrace runId={runId} itemId={trace} onClose={() => setTrace(null)} onChanged={() => void load()} />}
    <div className="table-wrap"><table>
      <thead><tr><th>Status</th><th>Item</th><th>Source</th><th>Section</th><th>Rank</th><th>Why</th><th /></tr></thead>
      <tbody>{page?.items.map((item) => <tr key={item._id}>
        <td><span className={`item-status ${item.status}`}>{item.status.replace(/_/g, " ")}</span></td>
        <td>{item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a> : item.title}{item.event_date && <small> · {item.event_date}</small>}</td>
        <td><small>{item.source_name}</small></td><td><small>{item.section?.replace(/_/g, " ") ?? "—"}</small></td>
        <td>{item.rank ?? "—"}{item.score !== null && item.score !== undefined && <small> ({item.score})</small>}</td>
        <td><small>{item.reason ?? item.step}</small></td>
        <td><button type="button" className="run-inspect-link" onClick={() => setTrace(item._id)}>Trace</button></td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}
