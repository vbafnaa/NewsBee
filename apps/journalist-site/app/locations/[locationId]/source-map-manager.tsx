"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { adminApi, mapApi } from "@/lib/admin-client";
import Link from "next/link";

type Source = {
  _id: string; location_id: string; location_name?: string; source_id: string; name: string; url: string | null; feed_url?: string | null; reader: string; section: string; status: string; note?: string | null; inside_area: boolean; link_only?: boolean;
  found_by: { method: string; detail: string }; found_by_label: string; window_label: string | null; score: number;
  health: { last_run_at: number | null; last_status: string | null; last_detail: string | null; runs: number; items_found: number; items_local: number; items_published: number; consecutive_failures: number; empty_runs: number; last_new_item_day: string | null };
};
type Discovery = { method: string; label: string; last_run_at?: number; ok?: boolean; found?: number; added?: number; detail?: string; never_run?: boolean };
type Data = { sections: Array<{ id: string; label: string }>; sources: Source[]; discovery: Discovery[] };

const READERS: Record<string, string> = { web: "Website or feed", opendata: "Open data", newssearch: "News search", library: "Library", meetings: "Meetings", hazards: "Alerts", trending: "Trends", homesafety: "Water", housing: "Housing data", remembrance: "Family notices", justice: "Prosecutors", community: "Reader stories" };

export default function SourceMapManager({ locationId, editable = false }: { locationId?: string; editable?: boolean }) {
  const canEdit = Boolean(locationId && editable);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("");
  const path = locationId ? `locations/${encodeURIComponent(locationId)}` : "";
  const load = useCallback(async () => {
    try { setData(await (canEdit ? adminApi : mapApi)<Data>(path ? `${path}/source-map` : "source-map")); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [path, canEdit]);
  useEffect(() => { void load(); }, [load]);
  async function act(label: string, action: () => Promise<unknown>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); setNotice(label); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  const patch = (body: Record<string, unknown>) => adminApi(`${path}/source-map`, { method: "PATCH", body: JSON.stringify(body) });
  const grouped = useMemo(() => {
    const text = filter.trim().toLowerCase();
    return (data?.sections ?? []).map((section) => ({ ...section, sources: (data?.sources ?? []).filter((source) => source.section === section.id && (!status || source.status === status) && (!text || `${source.name} ${source.url ?? ""} ${source.found_by_label}`.toLowerCase().includes(text))) })).filter((section) => section.sources.length);
  }, [data, filter, status]);
  const counts = useMemo(() => (data?.sources ?? []).reduce<Record<string, number>>((all, source) => ({ ...all, [source.status]: (all[source.status] ?? 0) + 1 }), {}), [data]);
  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="panel">
      <div className="section-heading"><div><h2>Source network</h2><p>{canEdit ? <>Every source this location reads, grouped by section. Pin a source to always read it and rank it higher; pause it to skip it for now; reject it to remove it for good (discovery won&rsquo;t add it back).</> : locationId ? "A read-only view of this location's sources, discovery history and health. Source editing requires journalist sign-in." : "The overall source network, grouped by section across all coverage areas."}</p></div>
        {canEdit && <button type="button" disabled={busy} onClick={() => void act("Refreshing the source map. Every discovery method will run.", () => adminApi(`${path}/map-run`, { method: "POST", body: JSON.stringify({ rebuild: true }) }))}>Refresh source map</button>}</div>
      {!locationId && <p>All locations, including paused and rejected sources. Choose a location above, or follow a location link below, to review its network and editions.</p>}
      <p className="chart-caption">{Object.entries(counts).map(([key, value]) => `${value} ${key}`).join(" · ")}</p>
      <div className="filters">
        <label>Search<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Name, link or how found" /></label>
        <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All</option>{["active", "pinned", "dormant", "paused", "rejected"].map((value) => <option key={value}>{value}</option>)}</select></label>
      </div>
      {grouped.map((section) => <div key={section.id}><h3>{section.label} <small>· {section.sources.length}</small></h3>
        <div className="table-wrap"><table>
          <thead><tr><th>Source</th>{!locationId && <th>Location</th>}<th>Type</th><th>How found</th><th>Window</th><th>Health</th><th>Status</th>{canEdit && <th>Actions</th>}</tr></thead>
          <tbody>{section.sources.map((source) => <tr key={source._id} id={source.source_id}>
            <td>{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a> : source.name}{source.inside_area && <small> · inside the area</small>}{source.link_only && <small> · link only</small>}{source.note && <><br /><small>Note: {source.note}</small></>}</td>
            {!locationId && <td><Link href={`/source-map?location=${encodeURIComponent(source.location_id)}`}>{source.location_name ?? source.location_id}</Link></td>}
            <td>{READERS[source.reader] ?? source.reader}</td>
            <td><small title={source.found_by.detail}>{source.found_by_label}</small></td>
            <td><small>{source.window_label ?? (locationId ? "—" : "See location")}</small>{canEdit && <><br /><button type="button" className="run-inspect-link" disabled={busy} onClick={() => {
              const value = window.prompt("Days back (and optional days ahead), e.g. '35' or '14,30'. Leave empty to use the default.", "");
              if (value === null) return;
              const [back, ahead] = value.split(",").map((part) => Number(part.trim()));
              void act("Window updated.", () => patch({ source_id: source.source_id, window: value.trim() ? { back_days: back || undefined, ahead_days: ahead || undefined } : null }));
            }}>Change</button></>}</td>
            <td><small>{source.health.runs ? `${source.health.items_local} local, ${source.health.items_published} published over ${source.health.runs} runs` : "Not run yet"}{source.health.last_status && source.health.last_status !== "ingested" ? ` · last: ${source.health.last_status}${source.health.last_detail ? ` (${source.health.last_detail.slice(0, 120)})` : ""}` : ""}{source.health.last_new_item_day ? ` · newest item ${source.health.last_new_item_day}` : ""}</small></td>
            <td><span className={`status-badge tone-${source.status === "rejected" ? "failed" : source.status === "paused" || source.status === "dormant" ? "warning" : "ok"}`}>{source.status}</span></td>
            {canEdit && <td><div className="card-actions">
              {source.status !== "pinned" && <button type="button" className="secondary" disabled={busy} onClick={() => void act(`Pinned ${source.name}.`, () => patch({ source_id: source.source_id, status: "pinned" }))}>Pin</button>}
              {source.status !== "active" && <button type="button" className="secondary" disabled={busy} onClick={() => void act(`${source.name} is active.`, () => patch({ source_id: source.source_id, status: "active" }))}>Activate</button>}
              {source.status !== "paused" && <button type="button" className="secondary" disabled={busy} onClick={() => void act(`Paused ${source.name}.`, () => patch({ source_id: source.source_id, status: "paused" }))}>Pause</button>}
              {source.status !== "rejected" && <button type="button" className="secondary" disabled={busy} onClick={() => { const note = window.prompt(`Reject ${source.name}? Optional note:`); if (note === null) return; void act(`Rejected ${source.name}.`, () => patch({ source_id: source.source_id, status: "rejected", note })); }}>Reject</button>}
            </div></td>}
          </tr>)}</tbody>
        </table></div></div>)}
      {data && !grouped.length && <p>{data.sources.length ? "No sources match these filters." : "No sources yet. Sources are discovered on a location's first run."}</p>}
    </section>
    {canEdit && locationId && <AddSource locationId={locationId} sections={data?.sections ?? []} onAdded={(label) => { setNotice(label); void load(); }} />}
    {locationId && <section className="panel"><h2>Discovery</h2><p>What each discovery method last found for this location.</p>
      <div className="table-wrap"><table><thead><tr><th>Method</th><th>Last run</th><th>Result</th></tr></thead><tbody>{(data?.discovery ?? []).map((state) => <tr key={state.method}>
        <td>{state.label}</td><td>{state.last_run_at ? new Date(state.last_run_at * 1000).toLocaleString() : "Never"}</td>
        <td>{state.never_run ? "Runs on the next run" : <><span className={`status-badge tone-${state.ok ? "ok" : "failed"}`}>{state.ok ? "ok" : "failed"}</span> <small>{state.found} found, {state.added} new. {state.detail}</small></>}</td>
      </tr>)}</tbody></table></div>
    </section>}
  </>;
}

function AddSource({ locationId, sections, onAdded }: { locationId: string; sections: Array<{ id: string; label: string }>; onAdded: (label: string) => void }) {
  const [type, setType] = useState("web");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    setBusy(true); setError("");
    try {
      const result = await adminApi<{ link: { validated_events: number } }>(`locations/${encodeURIComponent(locationId)}/links`, { method: "POST", body: JSON.stringify({ ...Object.fromEntries(form.entries()), type, inside_area: form.get("inside_area") === "on" }) });
      onAdded(`Source checked and pinned (${result.link.validated_events} items found now).`);
      element.reset();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  return <section className="panel"><h2>Add a source</h2>
    <p>The link is read once before it is saved; unusable links are rejected. Websites can be a homepage, a news page, a calendar page or a feed.</p>
    {error && <p className="alert" role="alert">{error}</p>}
    <form className="source-form" onSubmit={(event) => void submit(event)}>
      <label className="field">Type<select value={type} onChange={(event) => setType(event.target.value)}>
        <option value="web">Website or feed</option><option value="opendata">Open-data dataset (Socrata)</option><option value="meetings">Meeting platform (Legistar, CivicClerk)</option><option value="library">Library catalogue</option>
      </select></label>
      <label className="field">Name<input name="name" required maxLength={120} /></label>
      <label className="field source-url">Link<input name="url" type="url" required placeholder="https://" /></label>
      {type === "web" && <label className="field">Section<select name="section" defaultValue="news">{sections.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}</select></label>}
      {type === "web" && <label className="field"><span><input name="inside_area" type="checkbox" /> This organisation is inside the area (its posts count as local)</span></label>}
      {type === "opendata" && <label className="field">Topic<select name="topic" defaultValue="permits">{["police", "fire", "permits", "inspections", "licences", "311"].map((topic) => <option key={topic}>{topic}</option>)}</select></label>}
      {type === "opendata" && <label className="field">Filter<select name="filter" defaultValue="radius"><option value="radius">By location (dataset has coordinates)</option><option value="city">By city name (statewide dataset)</option></select></label>}
      <label className="field source-url">Note (required for funeral homes: how they gave permission to republish)<input name="note" maxLength={500} /></label>
      <button type="submit" disabled={busy}>{busy ? "Checking…" : "Check and add"}</button>
    </form>
  </section>;
}
