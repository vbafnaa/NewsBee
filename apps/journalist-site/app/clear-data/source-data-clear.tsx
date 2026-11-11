"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { adminApi } from "@/lib/admin-client";
import { ALL_LOCATIONS_CONFIRMATION } from "@/pipeline/analytics/clear-scope";
import { NO_SOURCE_DATA, sourceClearTotal, type SourceClearPreview, type SourceClearRecord, type SourceClearType } from "@/pipeline/sourcemap/source-clear-scope";

const CHOICES: [SourceClearType, string, string][] = [
  ["discovered", "Discovered sources", "Sources found by discovery methods, the agent or search. The next source map run finds them again from scratch."],
  ["editor_added", "Editor-added sources", "Sources added by hand or from approved reader suggestions."],
  ["reviews", "Reviews and labels", "Accept and reject decisions on All sources, reasons and their history, which the model check learns from. This is your labelled data: download a copy first."],
  ["page_decisions", "Decisions on source-run pages", "Decisions made on pages in test-mode source runs, which carry across runs by page. Later runs show those pages undecided again."],
  ["gemini_checks", "Model check verdicts and review flags", "The model check's verdicts and the final review's strong, usable, weak and duplicate flags on All sources. The next run judges them again."],
  ["test_runs", "Test-mode collection runs", "Each test-mode run's own results. The runs stay in the list, but their pages can no longer be opened or compared."],
  ["settings", "Pins, pauses and lookup windows", "Settings editors chose per source. Sources go back to default reading rules."],
  ["discovery_history", "Discovery history", "Each method's last result and due date. Every method is due on the next source map run."],
  ["cached_discovery", "Cached discovery", "Area facts, newsrooms, saved search results and the agent's notes. The next run fetches and searches again, which can use paid calls."],
  ["saved_addresses", "Saved addresses", "Meeting platform and library feed addresses. Editions show needs_remap until a source map run saves them again."],
  ["source_health", "Source health", "Failure and empty streaks, timings and dormancy. Dormant sources are read again."],
];
const label = (types: SourceClearType[]) => CHOICES.filter(([type]) => types.includes(type)).map(([, name]) => name).join(", ");
const describe = (counts: Record<SourceClearType, number>) => CHOICES.filter(([type]) => counts[type] > 0).map(([type, name]) => `${counts[type].toLocaleString()} ${name.toLowerCase()}`).join(", ") || "Nothing matched";

/** Clearing source data, one chosen category at a time, so a source map can be rebuilt from scratch. */
export default function SourceDataClear() {
  const [data, setData] = useState<SourceClearPreview | null>(null);
  const [location, setLocation] = useState("");
  const [types, setTypes] = useState<SourceClearType[]>([]);
  const [refresh, setRefresh] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SourceClearRecord | null>(null);
  const load = useCallback(() => adminApi<SourceClearPreview>("source-data/clear").then((value) => { setData(value); return value; }), []);
  useEffect(() => { load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }, [load]);
  if (!data) return error ? <p className="alert" role="alert">{error}</p> : <p role="status">Loading source data…</p>;

  const selected = data.locations.find((row) => row.id === location) ?? null;
  const counts = selected ?? (location ? NO_SOURCE_DATA : data.totals);
  const scopeName = selected?.name ?? "all locations";
  const phrase = location || ALL_LOCATIONS_CONFIRMATION;
  const total = sourceClearTotal(counts, types);
  const blocked = selected ? selected.active_run : data.active_runs > 0;
  const reset = () => { setConfirming(false); setConfirmation(""); };
  async function download() {
    try {
      const copy = await adminApi<unknown>(`source-data/clear?export=reviews${location ? `&location=${encodeURIComponent(location)}` : ""}`);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([JSON.stringify(copy, null, 2)], { type: "application/json" }));
      link.download = `source-reviews-${location || "all-locations"}-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <>
    <section className="panel" aria-labelledby="source-clear-heading">
      <h3 id="source-clear-heading">Choose what to clear</h3>
      {error && <p className="alert" role="alert">{error}</p>}
      {result && <p className="notice" role="status">Cleared {result.location_name ?? "all locations"}: {describe(result.deleted)}.
        {refresh && result.location_id && <> <Link href={`/locations/${encodeURIComponent(result.location_id)}?tab=collect-sources`}>Refresh its source map</Link> to rebuild it.</>}</p>}
      <label className="field">Location
        <select value={location} disabled={busy} onChange={(event) => { setLocation(event.target.value); reset(); }}>
          <option value="">All locations</option>
          {data.locations.map((row) => <option key={row.id} value={row.id}>{row.name} ({sourceClearTotal(row).toLocaleString()})</option>)}
        </select>
      </label>
      {blocked && <p className="alert" role="alert">{selected ? `${selected.name} has a run open.` : `${data.active_runs} run(s) are open.`} Finish or cancel them before clearing source data.</p>}
      <p>Nothing is selected by default. Editions, run history, collected items, reader data and the locations themselves are never cleared from here.</p>
      <fieldset disabled={busy}>
        <legend>Source data categories</legend>
        <div className="table-wrap"><table><thead><tr><th>Delete</th><th>Count</th><th>What changes</th></tr></thead><tbody>
          {CHOICES.map(([type, name, hint]) => <tr key={type}><td><label className="source-select">
            <input type="checkbox" checked={types.includes(type)} onChange={(event) => { setTypes(event.target.checked ? [...types, type] : types.filter((item) => item !== type)); reset(); }} /> <span>{name}</span>
          </label></td><td>{counts[type].toLocaleString()}</td><td>{hint}{type === "reviews" && counts.reviews > 0 && <> <button type="button" className="run-inspect-link" onClick={() => void download()}>Download a copy</button></>}</td></tr>)}
        </tbody></table></div>
        <label className="field"><span><input type="checkbox" checked={refresh} disabled={!location} onChange={(event) => setRefresh(event.target.checked)} /> Rebuild the source map afterwards{!location ? " (one location at a time)" : ""}</span></label>
      </fieldset>
      <h4>Will be permanently cleared</h4>
      <p>{types.length ? `${label(types)}: ${total.toLocaleString()} record(s) for ${scopeName}.` : "Nothing selected."}</p>
      <h4>Will be kept</h4>
      <p>{CHOICES.filter(([type]) => !types.includes(type)).map(([, name]) => name).join(", ") || "No source-data categories are kept"}.</p>
      {!confirming ? <button className="secondary" type="button" disabled={!types.length || !total || blocked} onClick={async () => {
        setError(""); setResult(null);
        try { await load(); setConfirming(true); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>Review and clear…</button> : <form onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !types.length || confirmation !== phrase) return;
        setBusy(true); setError("");
        try {
          setResult(await adminApi<SourceClearRecord>("source-data/clear", { method: "POST", body: JSON.stringify(location ? { scope: "location", location_id: location, data_types: types, confirm: phrase } : { scope: "all", data_types: types, confirm: phrase }) }));
          setTypes([]); reset(); await load();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          await load().catch(() => undefined);
        } finally { setBusy(false); }
      }}>
        <p><strong>Confirm categories:</strong> {label(types)}. Unchecked categories won&rsquo;t be cleared.</p>
        <label className="field"><span>Type <code>{phrase}</code> to permanently clear {total.toLocaleString()} record(s) for {scopeName}</span>
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" disabled={busy} />
        </label>
        <div className="card-actions">
          <button type="submit" disabled={busy || confirmation !== phrase}>{busy ? "Clearing…" : "Permanently clear selected data"}</button>
          <button type="button" className="secondary" disabled={busy} onClick={reset}>Keep data</button>
        </div>
      </form>}
    </section>
    <section className="panel" aria-labelledby="source-history-heading">
      <h3 id="source-history-heading">Source data clear history</h3>
      {!data.recent.length ? <p className="empty-state">No source data has been cleared.</p> : <div className="table-wrap"><table><caption>The ten most recent clears</caption>
        <thead><tr><th>When</th><th>Who</th><th>Scope</th><th>Categories</th><th>Status</th><th>Cleared</th></tr></thead><tbody>
          {data.recent.map((row) => <tr key={row.id}><td>{new Date(row.at).toLocaleString()}</td><td>{row.by}</td><td>{row.location_name ?? "All locations"}</td>
            <td>{label(row.data_types)}</td><td>{row.status}{row.error ? `: ${row.error}` : ""}</td><td>{describe(row.deleted)}</td></tr>)}
        </tbody></table></div>}
    </section>
  </>;
}
