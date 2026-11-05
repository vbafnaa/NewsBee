"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import { ALL_LOCATIONS_CONFIRMATION, clearedTotal, type ClearCounts, type ClearPreview, type ClearRecord } from "@/pipeline/analytics/clear-scope";

const DELETED: [keyof ClearCounts, string, string][] = [
  ["impressions", "Impressions", "Edition view events, each listing the stories shown"],
  ["clicks", "Clicks", "Full article opens, including older source opens"],
  ["shares", "Shares", "Completed shares, which ranking counts as click-through"],
  ["interest_records", "Interest signups", "Whole records, including the email address and its consent"],
  ["interest_marks", "Interest on kept records", "Only the launch-interest fields; the record stays for its subscription or older signup"],
];
const describeDeleted = (deleted: ClearCounts) => DELETED.map(([key, label]) => `${deleted[key].toLocaleString()} ${label.toLowerCase()}`).join(", ");

export default function ClearData() {
  const [data, setData] = useState<ClearPreview | null>(null);
  const [location, setLocation] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ClearRecord | null>(null);
  const load = useCallback(() => adminApi<ClearPreview>("usage-map/clear").then((value) => { setData(value); return value; }), []);
  useEffect(() => {
    load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [load]);
  if (!data) return error ? <p className="alert" role="alert">{error}</p> : <p role="status">Loading reader data…</p>;

  const selected = data.locations.find((row) => row.id === location) ?? null;
  const counts = selected ?? data.totals;
  const scopeName = selected?.name ?? "all locations";
  const phrase = selected?.id ?? ALL_LOCATIONS_CONFIRMATION;
  const reset = () => { setConfirming(false); setConfirmation(""); };
  return <>
    <section className="panel" aria-labelledby="clear-data-heading">
      <h2 id="clear-data-heading">Choose what to clear</h2>
      {error && <p className="alert" role="alert">{error}</p>}
      {result && <p className="notice" role="status">Cleared {result.location_name ?? "all locations"}: {describeDeleted(result.deleted)}.</p>}
      <label className="field">Location
        <select value={location} disabled={busy} onChange={(event) => { setLocation(event.target.value); reset(); }}>
          <option value="">All locations</option>
          {data.locations.map((row) => <option key={row.id} value={row.id}>{row.name} ({clearedTotal(row).toLocaleString()})</option>)}
        </select>
      </label>
      <h3>Will be permanently deleted for {scopeName}</h3>
      <div className="table-wrap"><table><thead><tr><th>Data</th><th>Count</th><th>What it is</th></tr></thead><tbody>
        {DELETED.map(([key, label, hint]) => <tr key={key}><td>{label}</td><td>{counts[key].toLocaleString()}</td><td>{hint}</td></tr>)}
      </tbody></table></div>
      <h3>Will be kept</h3>
      <p>{counts.subscriptions.toLocaleString()} subscription signup(s) and {counts.legacy_signups.toLocaleString()} older signup record(s) of ambiguous intent.
        Editions, source maps, story submissions, reports and admin accounts are not touched.</p>
      <h3>What changes</h3>
      <p>The usage map loses these reads and interest signups, and its first-seen dates move forward. Future runs rank without this evidence: categories
        with no reader data keep the model&apos;s order until readers build it up again. Clearing one location also removes its share of the evidence pooled across
        communities. Already published editions do not change. This cannot be undone.</p>
      {!confirming ? <button className="secondary" type="button" disabled={!clearedTotal(counts)} onClick={async () => {
        setError(""); setResult(null);
        try { await load(); setConfirming(true); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>Review and clear…</button> : <form onSubmit={async (event) => {
        event.preventDefault();
        if (busy || confirmation !== phrase) return;
        setBusy(true); setError("");
        try {
          const cleared = await adminApi<ClearRecord>("usage-map/clear", { method: "POST", body: JSON.stringify(
            selected ? { scope: "location", location_id: selected.id, confirm: phrase } : { scope: "all", confirm: phrase },
          ) });
          setResult(cleared); setLocation(""); reset();
          await load();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          await load().catch(() => undefined);
        } finally {
          setBusy(false);
        }
      }}>
        <label className="field"><span>Type <code>{phrase}</code> to permanently delete {clearedTotal(counts).toLocaleString()} item(s) for {scopeName}</span>
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" disabled={busy} />
        </label>
        <div className="card-actions">
          <button type="submit" disabled={busy || confirmation !== phrase}>{busy ? "Deleting…" : "Permanently delete"}</button>
          <button type="button" className="secondary" disabled={busy} onClick={reset}>Keep data</button>
        </div>
      </form>}
    </section>
    <section className="panel" aria-labelledby="clear-history-heading">
      <h2 id="clear-history-heading">Clear history</h2>
      {!data.recent.length ? <p className="empty-state">No reader data has been cleared.</p> : <div className="table-wrap"><table><caption>The ten most recent clears</caption>
        <thead><tr><th>When</th><th>Who</th><th>Scope</th><th>Status</th><th>Deleted</th></tr></thead><tbody>
          {data.recent.map((row) => <tr key={row.id}><td>{new Date(row.at).toLocaleString()}</td><td>{row.by}</td><td>{row.location_name ?? "All locations"}</td>
            <td>{row.status}{row.error ? `: ${row.error}` : ""}</td><td>{describeDeleted(row.deleted)}</td></tr>)}
        </tbody></table></div>}
    </section>
  </>;
}
