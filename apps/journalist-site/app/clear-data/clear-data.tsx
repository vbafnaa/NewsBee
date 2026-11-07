"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import { ALL_LOCATIONS_CONFIRMATION, clearTypeCount, clearedTotal, DEFAULT_CLEAR_DATA_TYPES, type ClearCounts, type ClearDataType, type ClearPreview, type ClearRecord } from "@/pipeline/analytics/clear-scope";

const CHOICES: [ClearDataType, string, string][] = [
  ["impressions", "Impressions", "Edition view events, each listing the stories shown"],
  ["clicks", "Clicks", "Full article opens, including older source opens"],
  ["shares", "Shares", "Completed shares, which ranking counts as click-through"],
  ["interest", "Launch-interest signups", "Remove launch-interest registrations. Email records with a subscription or legacy signup stay."],
  ["subscriptions", "Subscription signups", "Remove subscription registrations. Email records with launch interest or a legacy signup stay."],
  ["legacy_signups", "Legacy signups", "Remove older registrations of ambiguous intent. Email records with explicit interest or subscriptions stay."],
];
const DELETED: [keyof ClearCounts, string, string][] = [
  ["impressions", "Impressions", "Edition view events, each listing the stories shown"],
  ["clicks", "Clicks", "Full article opens, including older source opens"],
  ["shares", "Shares", "Completed shares, which ranking counts as click-through"],
  ["interest_records", "Interest signups", "Whole records, including the email address and its consent"],
  ["interest_marks", "Interest on kept records", "Only the launch-interest fields; the record stays for its subscription or older signup"],
  ["subscriptions", "Subscription registrations", "Selected subscription records or fields"],
  ["legacy_signups", "Legacy registrations", "Selected legacy records or fields"],
];
const describeDeleted = (deleted: ClearCounts) => DELETED.filter(([key]) => deleted[key] > 0).map(([key, label]) => `${deleted[key].toLocaleString()} ${label.toLowerCase()}`).join(", ") || "No matching data";
const describeTypes = (types: ClearDataType[]) => CHOICES.filter(([type]) => types.includes(type)).map(([, label]) => label).join(", ");

export default function ClearData() {
  const [data, setData] = useState<ClearPreview | null>(null);
  const [location, setLocation] = useState("");
  const [types, setTypes] = useState<ClearDataType[]>([...DEFAULT_CLEAR_DATA_TYPES]);
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
  const counts = location ? selected ?? { impressions: 0, clicks: 0, shares: 0, interest_records: 0, interest_marks: 0, subscriptions: 0, legacy_signups: 0 } : data.totals;
  const scopeName = selected?.name ?? (location || "all locations");
  const phrase = location || ALL_LOCATIONS_CONFIRMATION;
  const total = clearedTotal(counts, types);
  const kept = CHOICES.filter(([type]) => !types.includes(type));
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
      <p>Only checked categories will be deleted for {scopeName}. Launch-interest, subscription and legacy signup emails are kept unless explicitly selected.</p>
      <fieldset disabled={busy}>
        <legend>Data categories</legend>
        <div className="table-wrap"><table><thead><tr><th>Delete</th><th>Count</th><th>What changes</th></tr></thead><tbody>
          {CHOICES.map(([type, label, hint]) => <tr key={type}><td><label className="source-select">
            <input type="checkbox" checked={types.includes(type)} onChange={(event) => {
              setTypes(event.target.checked ? [...types, type] : types.filter((item) => item !== type)); reset();
            }} /> <span>{label}</span>
          </label></td><td>{clearTypeCount(counts, type).toLocaleString()}</td><td>{hint}</td></tr>)}
        </tbody></table></div>
      </fieldset>
      <h3>Will be permanently deleted</h3>
      <p>{types.length ? describeTypes(types) : "Nothing selected"}: {total.toLocaleString()} matching event(s) or signup registration(s).
        A mixed email record can contain multiple registrations; the count is not a count of unique emails.</p>
      <h3>Will be kept</h3>
      <p>{kept.length ? kept.map(([type, label]) => `${clearTypeCount(counts, type).toLocaleString()} ${label.toLowerCase()}`).join(", ") : "No reader-data categories are excluded"}.
        Email records and their shared consent remain while any unselected signup intent remains.
        Editions, source maps, story submissions, reports and accounts are never touched.</p>
      <h3>What changes</h3>
      <p>The usage map loses only selected reads or registrations, and affected first-seen dates may move forward. Future runs rank without deleted engagement evidence: categories
        with no reader data keep the model&apos;s order until readers build it up again. Clearing one location also removes its share of the evidence pooled across
        communities. Already published editions do not change. This cannot be undone.</p>
      {!confirming ? <button className="secondary" type="button" disabled={!types.length || !total} onClick={async () => {
        setError(""); setResult(null);
        try { await load(); setConfirming(true); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>Review and clear…</button> : <form onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !types.length || !total || confirmation !== phrase) return;
        setBusy(true); setError("");
        try {
          const cleared = await adminApi<ClearRecord>("usage-map/clear", { method: "POST", body: JSON.stringify(
            location ? { scope: "location", location_id: location, data_types: types, confirm: phrase } : { scope: "all", data_types: types, confirm: phrase },
          ) });
          setResult(cleared); setLocation(""); setTypes([...DEFAULT_CLEAR_DATA_TYPES]); reset();
          await load();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          await load().catch(() => undefined);
        } finally {
          setBusy(false);
        }
      }}>
        <p><strong>Confirm categories:</strong> {describeTypes(types)}. Unchecked categories will not be cleared.</p>
        <label className="field"><span>Type <code>{phrase}</code> to permanently delete {total.toLocaleString()} event(s) or signup registration(s) for {scopeName}</span>
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" disabled={busy} />
        </label>
        <div className="card-actions">
          <button type="submit" disabled={busy || !types.length || !total || confirmation !== phrase}>{busy ? "Deleting…" : "Permanently delete selected data"}</button>
          <button type="button" className="secondary" disabled={busy} onClick={reset}>Keep data</button>
        </div>
      </form>}
    </section>
    <section className="panel" aria-labelledby="clear-history-heading">
      <h2 id="clear-history-heading">Clear history</h2>
      {!data.recent.length ? <p className="empty-state">No reader data has been cleared.</p> : <div className="table-wrap"><table><caption>The ten most recent clears</caption>
        <thead><tr><th>When</th><th>Who</th><th>Scope</th><th>Categories</th><th>Status</th><th>Deleted</th></tr></thead><tbody>
          {data.recent.map((row) => <tr key={row.id}><td>{new Date(row.at).toLocaleString()}</td><td>{row.by}</td><td>{row.location_name ?? "All locations"}</td>
            <td>{describeTypes(row.data_types)}</td><td>{row.status}{row.error ? `: ${row.error}` : ""}</td><td>{describeDeleted(row.deleted)}</td></tr>)}
        </tbody></table></div>}
    </section>
  </>;
}
