"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminApi, mapApi } from "@/lib/admin-client";
import Link from "next/link";
import { displayStatus, liveStatus, NON_SCRAPABLE, nonScrapableReason, statusCounts } from "@/pipeline/sourcemap/display";
import { isOtherReason, reasonLabel, REASONS } from "@/pipeline/sourcemap/reasons";

type Source = {
  _id: string; location_id: string; location_name?: string; source_id: string; name: string; url: string | null; feed_url?: string | null; reader: string; section: string; status: string; note?: string | null; review?: Review; inside_area: boolean; link_only?: boolean;
  why?: string | null; source_kind?: string; access?: { robots?: string; rights?: string; fresh?: boolean } | null;
  found_by: { method: string; detail: string }; found_by_label: string; window_label: string | null; score: number;
  health: { last_run_at: number | null; last_status: string | null; last_detail: string | null; runs: number; items_found: number; items_local: number; items_published: number; consecutive_failures: number; empty_runs: number; last_new_item_day: string | null };
};
type Review = { decision: "accept" | "reject" | null; reason_code?: string | null; reason: string | null; initial_status: string };
type Discovery = { method: string; label: string; last_run_at?: number; ok?: boolean; found?: number; added?: number; detail?: string; never_run?: boolean };
type Data = { sections: Array<{ id: string; label: string }>; sources: Source[]; discovery: Discovery[] };

const MAX_REASON = 2000;
const DECISIONS = { accept: "Accept", reject: "Reject" };
const STATUS_LABELS: Record<string, string> = { [NON_SCRAPABLE]: "Non-scrapable" };
const statusTone = (status: string) => status === NON_SCRAPABLE ? "non-scrapable" : status === "rejected" ? "failed" : status === "paused" || status === "dormant" ? "warning" : "ok";

const READERS: Record<string, string> = { web: "Website or feed", opendata: "Open data", newssearch: "News search", library: "Library", meetings: "Meetings", hazards: "Alerts", trending: "Trends", homesafety: "Water", housing: "Housing data", remembrance: "Family notices", justice: "Prosecutors", community: "Reader stories" };

export default function SourceMapManager({ locationId, editable = false, canLabel = false }: { locationId?: string; editable?: boolean; canLabel?: boolean }) {
  const canEdit = Boolean(locationId && editable);
  const labels = canEdit || canLabel;
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("");
  // A row labelled under a status filter stays put until the filter changes, so its reason can still be typed.
  const [labelled, setLabelled] = useState<Set<string>>(new Set());
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
  const saved = useCallback((id: string, change: { status: string; review: Review }) => {
    setLabelled((ids) => new Set(ids).add(id));
    setData((current) => current && { ...current, sources: current.sources.map((source) => source._id === id ? { ...source, ...change } : source) });
  }, []);
  const grouped = useMemo(() => {
    const text = filter.trim().toLowerCase();
    return (data?.sections ?? []).map((section) => ({ ...section, sources: (data?.sources ?? []).filter((source) => source.section === section.id && (!status || liveStatus(source) === status || labelled.has(source._id)) && (!text || `${source.name} ${source.url ?? ""} ${source.found_by_label}`.toLowerCase().includes(text))) })).filter((section) => section.sources.length);
  }, [data, filter, status, labelled]);
  const counts = useMemo(() => statusCounts(data?.sources ?? []), [data]);
  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="panel">
      <div className="section-heading"><div><h2>Source network</h2><p>{canEdit ? <>Use Decision to accept or reject a source, and choose why under Reasoning. Pin to always read and rank higher. Pause to skip.</> : labels ? "Use Decision to accept or reject a source, and choose why under Reasoning." : "Read-only. Sign in as a journalist to label sources."}</p></div>
        {canEdit && <Link className="button" href={`/locations/${encodeURIComponent(locationId!)}?tab=runs`}>Configure source-map run</Link>}</div>
      <p className="chart-caption">{Object.entries(counts).map(([key, value]) => `${value} ${key}`).join(" · ")}</p>
      <div className="filters">
        <label>Search<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Name, link or how found" /></label>
        <label>Live status<select value={status} onChange={(event) => { setStatus(event.target.value); setLabelled(new Set()); }}><option value="">All</option>{["active", "pinned", "proposed", NON_SCRAPABLE, "dormant", "paused", "rejected"].map((value) => <option key={value} value={value}>{STATUS_LABELS[value] ?? value}</option>)}</select></label>
      </div>
      {grouped.map((section) => <div key={section.id}><h3>{section.label} <small>· {section.sources.length}</small></h3>
        <div className="table-wrap"><table className="source-table">
          <thead><tr><th>Source</th>{!locationId && <th>Location</th>}<th>Type</th><th>How found</th><th>Window</th><th>Health</th><th>Initial Status</th><th>Decision</th><th>Reasoning</th>{canEdit && <th>Actions</th>}</tr></thead>
          <tbody>{section.sources.map((source) => <tr key={source._id} id={source.source_id}>
            <td>{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a> : source.name}{source.inside_area && <small> · inside the area</small>}{source.note && <><br /><small>Note: {source.note}</small></>}</td>
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
            <td><InitialStatus source={source} /></td>
            <ReviewCells source={source} canLabel={labels} onSaved={saved} />
            {canEdit && <td>{source.review?.decision === "reject" ? <small>Change the Decision to use this source again.</small> : <div className="card-actions">
              {source.status !== "pinned" && <button type="button" className="secondary" disabled={busy} onClick={() => void act(`Pinned ${source.name}.`, () => patch({ source_id: source.source_id, status: "pinned" }))}>Pin</button>}
              {source.status !== "active" && <button type="button" className="secondary" disabled={busy} onClick={() => void act(`${source.name} is active.`, () => patch({ source_id: source.source_id, status: "active" }))}>Activate</button>}
              {source.status !== "paused" && <button type="button" className="secondary" disabled={busy} onClick={() => void act(`Paused ${source.name}.`, () => patch({ source_id: source.source_id, status: "paused" }))}>Pause</button>}
            </div>}</td>}
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

/** The status the pipeline gave the source, with the live status beneath it once they differ. A link-only source says it isn't read, and why. */
function InitialStatus({ source }: { source: Source }) {
  const initial = displayStatus(source.review?.initial_status ?? source.status, source.link_only);
  const live = liveStatus(source);
  return <><span className={`status-badge tone-${statusTone(initial)}`}>{STATUS_LABELS[initial] ?? initial}</span>
    {live !== initial && <small className="review-state">Now {STATUS_LABELS[live] ?? live}</small>}
    {source.link_only && <small className="review-state">Not being read: {nonScrapableReason(source)}</small>}</>;
}

type Saving = { state: "saving" | "saved" } | { state: "failed"; detail: string; retry: () => void } | null;

function SaveState({ saving }: { saving: Saving }) {
  if (!saving) return null;
  if (saving.state === "failed") return <small className="review-failed" role="alert">Not saved: {saving.detail} <button type="button" className="run-inspect-link" onClick={saving.retry}>Retry</button></small>;
  return <small className="review-state" role="status">{saving.state === "saving" ? "Saving…" : "Saved"}</small>;
}

/** The reason as read-only text. Text with no Other code is a note from before reason codes. */
function ReasonText({ review }: { review?: Review }) {
  const code = review?.reason_code;
  if (!code && !review?.reason) return <>—</>;
  return <>{code && `${code} ${reasonLabel(code) ?? ""}`}
    {isOtherReason(code) ? <small className="review-state">{review?.reason ?? "No explanation given"}</small> : review?.reason && <small className="review-state">Earlier note: {review.reason}</small>}</>;
}

/** The Decision and Reasoning cells. Each saves on its own, and a failure stays on screen until it is retried. */
function ReviewCells({ source, canLabel, onSaved }: { source: Source; canLabel: boolean; onSaved: (id: string, change: { status: string; review: Review }) => void }) {
  const [decision, setDecision] = useState<NonNullable<Review["decision"]> | "">(source.review?.decision ?? "");
  const [code, setCode] = useState(source.review?.reason_code ?? "");
  const [reason, setReason] = useState(source.review?.reason ?? "");
  const [saving, setSaving] = useState<{ decision: Saving; reason: Saving }>({ decision: null, reason: null });
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => setDecision(source.review?.decision ?? ""), [source.review?.decision]);
  useEffect(() => setCode(source.review?.reason_code ?? ""), [source.review?.reason_code]);
  useEffect(() => setReason(source.review?.reason ?? ""), [source.review?.reason]);
  if (!canLabel) return <>
    <td>{source.review?.decision ? DECISIONS[source.review.decision] : "—"}</td>
    <td className="source-reason"><ReasonText review={source.review} /></td>
  </>;
  function save(field: "decision" | "reason", change: Record<string, string | null>) {
    setSaving((all) => ({ ...all, [field]: { state: "saving" } }));
    // One at a time, so the last choice made is the one that lands.
    queue.current = queue.current.then(async () => {
      try {
        const result = await adminApi<{ status: string; review: Review }>(`locations/${encodeURIComponent(source.location_id)}/source-map`, { method: "PATCH", body: JSON.stringify({ source_id: source.source_id, ...change }) });
        onSaved(source._id, { status: result.status, review: result.review });
        setSaving((all) => ({ ...all, [field]: { state: "saved" } }));
      } catch (cause) {
        setSaving((all) => ({ ...all, [field]: { state: "failed", detail: cause instanceof Error ? cause.message : String(cause), retry: () => save(field, change) } }));
      }
    });
  }
  // The server clears Other text when its code goes, so the box and any note show the same straight away.
  const leaveCode = () => { if (isOtherReason(code)) setReason(""); };
  const other = isOtherReason(code);
  return <>
    <td className="source-decision"><select aria-label={`Decision for ${source.name}`} value={decision} onChange={(event) => {
      setDecision(event.target.value as typeof decision); setCode(""); leaveCode();
      setSaving((all) => ({ ...all, reason: null }));
      save("decision", { decision: event.target.value || null });
    }}>
      <option value="" />{Object.entries(DECISIONS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
    </select><SaveState saving={saving.decision} /></td>
    <td className="source-reason"><select aria-label={`Reasoning for ${source.name}`} title={code ? reasonLabel(code) ?? undefined : undefined} disabled={!decision} value={code} onChange={(event) => {
      const next = event.target.value;
      setCode(next); if (!isOtherReason(next)) leaveCode();
      save("reason", { reason_code: next || null });
    }}>
      <option value="" />{decision && REASONS[decision].map((option) => <option value={option.code} key={option.code}>{option.code} {option.label}</option>)}
    </select>
    {other && <textarea aria-label={`Explain the reason for ${source.name}`} rows={2} maxLength={MAX_REASON} value={reason} onChange={(event) => setReason(event.target.value)} onBlur={() => {
      const text = reason.trim();
      if (text !== (source.review?.reason ?? "")) save("reason", { reason_code: code, reason: text || null });
    }} />}
    {other && !reason.trim() && <small className="review-failed">Incomplete: add an explanation.</small>}
    {!other && reason && <small className="review-state">Earlier note: {reason}</small>}
    <SaveState saving={saving.reason} /></td>
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
    <p>Links are checked before saving. Use a homepage, news page, calendar or feed.</p>
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
