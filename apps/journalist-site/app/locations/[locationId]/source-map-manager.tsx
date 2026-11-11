"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminApi, mapApi } from "@/lib/admin-client";
import Link from "next/link";
import { displayStatus, liveStatus, NON_SCRAPABLE, nonScrapableReason, statusCounts } from "@/pipeline/sourcemap/display";
import { isOtherReason, reasonLabel, REASONS } from "@/pipeline/sourcemap/reasons";

type Source = {
  _id: string; location_id: string; location_name?: string; source_id: string; name: string; url: string | null; feed_url?: string | null; reader: string; section: string; status: string; note?: string | null; review?: Review; inside_area: boolean; link_only?: boolean;
  why?: string | null; source_kind?: string; access?: { robots?: string; rights?: string; fresh?: boolean } | null;
  gemini?: { verdict: "accept" | "reject" | null; reason_code: string | null; reason: string | null; evidence: string | null; note: string | null; model?: string | null } | null;
  review_flags?: { strength: string | null; duplicate_of: string | null; duplicate_candidates: Array<{ source_id: string; why: string }>; confirmed: boolean; reason: string | null; note: string | null } | null;
  found_by: { method: string; detail: string; how_found?: string | null }; found_by_label: string; window_label: string | null; score: number;
  health: { last_run_at: number | null; last_status: string | null; last_detail: string | null; runs: number; items_found: number; items_local: number; items_published: number; consecutive_failures: number; empty_runs: number; last_new_item_day: string | null };
  access_review?: { decision: string; collection_allowed: boolean; reason: string; expires_on: string; evidence: string[] };
};
export type Review = { decision: "accept" | "reject" | null; reason_code?: string | null; reason: string | null; initial_status: string };
type Discovery = { method: string; label: string; last_run_at?: number; ok?: boolean; found?: number; added?: number; detail?: string; never_run?: boolean };
type Data = { sections: Array<{ id: string; label: string }>; sources: Source[]; discovery: Discovery[] };

const MAX_REASON = 2000;
const DECISIONS = { accept: "Accept", reject: "Reject" };
const STATUS_LABELS: Record<string, string> = { [NON_SCRAPABLE]: "Non-scrapable" };
const statusTone = (status: string) => status === NON_SCRAPABLE ? "non-scrapable" : status === "rejected" ? "failed" : status === "paused" || status === "dormant" ? "warning" : "ok";

const READERS: Record<string, string> = { web: "Website or feed", opendata: "Open data", newssearch: "News search", library: "Library", meetings: "Meetings", hazards: "Alerts", trending: "Trends", homesafety: "Water", housing: "Housing data", remembrance: "Family notices", justice: "Prosecutors", community: "Reader stories" };

/** Editable only in a location's Sources tab; everywhere else it's a read-only view of the same records. */
export default function SourceMapManager({ locationId, editable = false }: { locationId?: string; editable?: boolean }) {
  const canEdit = Boolean(locationId && editable);
  const labels = canEdit;
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("");
  const [verdict, setVerdict] = useState("");
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
    return (data?.sections ?? []).map((section) => ({ ...section, sources: (data?.sources ?? []).filter((source) => source.section === section.id && (!status || liveStatus(source) === status || labelled.has(source._id)) && (!verdict || geminiVerdict(source) === verdict) && (!text || `${source.name} ${source.url ?? ""} ${source.found_by_label}`.toLowerCase().includes(text))) })).filter((section) => section.sources.length);
  }, [data, filter, status, verdict, labelled]);
  const counts = useMemo(() => statusCounts(data?.sources ?? []), [data]);
  const names = useMemo(() => new Map((data?.sources ?? []).map((source) => [source.source_id, source.name])), [data]);
  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="panel">
      <div className="section-heading"><div><h2>Source network</h2>{!canEdit && <p>Read-only. {locationId ? <Link href={`/locations/${encodeURIComponent(locationId)}?tab=sources`}>Edit these sources in the workspace</Link> : "Sources are edited in each location's workspace."}</p>}</div></div>
      <ReviewKey />
      <p className="chart-caption">{Object.entries(counts).map(([key, value]) => `${value} ${key}`).join(" · ")}</p>
      <div className="filters">
        <label>Search<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Name, link or how found" /></label>
        <label>Live status<select value={status} onChange={(event) => { setStatus(event.target.value); setLabelled(new Set()); }}><option value="">All</option>{["active", "pinned", "proposed", NON_SCRAPABLE, "dormant", "paused", "rejected"].map((value) => <option key={value} value={value}>{STATUS_LABELS[value] ?? value}</option>)}</select></label>
        <label>Model check<select value={verdict} onChange={(event) => setVerdict(event.target.value)}><option value="">All</option><option value="accept">Accept</option><option value="reject">Reject</option><option value="not_judged">Not judged</option></select></label>
      </div>
      {grouped.map((section) => <div key={section.id}><h3>{section.label} <small>· {section.sources.length}</small></h3>
        <div className="table-wrap"><table className="source-table">
          <thead>
            <tr className="column-groups"><th colSpan={locationId ? 7 : 8} /><th colSpan={2} className="review-group">Your review: a recorded verdict</th></tr>
            <tr><th>Source</th>{!locationId && <th>Location</th>}<th>Type</th><th>How found</th><th>Window</th><th>Health</th><th>Initial Status</th><th>Model check</th><th className="review-group">Decision</th><th className="review-group">Reasoning</th></tr>
          </thead>
          <tbody>{section.sources.map((source) => <tr key={source._id} id={source.source_id}>
            <td>{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a> : source.name}{source.inside_area && <small> · inside the area</small>}{source.note && <><br /><small>Note: {source.note}</small></>}</td>
            {!locationId && <td><Link href={`/source-map?location=${encodeURIComponent(source.location_id)}`}>{source.location_name ?? source.location_id}</Link></td>}
            <td>{READERS[source.reader] ?? source.reader}</td>
            <td><small title={source.found_by.detail}>{source.found_by_label}</small>{source.found_by.how_found && <small className="review-state">How I found it: {source.found_by.how_found}</small>}</td>
            <td><small>{source.window_label ?? (locationId ? "—" : "See location")}</small>{canEdit && <><br /><button type="button" className="run-inspect-link" disabled={busy} onClick={() => {
              const value = window.prompt("Days back (and optional days ahead), e.g. '35' or '14,30'. Leave empty to use the default.", "");
              if (value === null) return;
              const [back, ahead] = value.split(",").map((part) => Number(part.trim()));
              void act("Window updated.", () => patch({ source_id: source.source_id, window: value.trim() ? { back_days: back || undefined, ahead_days: ahead || undefined } : null }));
            }}>Change</button></>}</td>
            <td><small>{source.health.runs ? `${source.health.items_local} local, ${source.health.items_published} published over ${source.health.runs} runs` : "Not run yet"}{source.health.last_status && source.health.last_status !== "ingested" ? ` · last: ${source.health.last_status}${source.health.last_detail ? ` (${source.health.last_detail.slice(0, 120)})` : ""}` : ""}{source.health.last_new_item_day ? ` · newest item ${source.health.last_new_item_day}` : ""}</small></td>
            <td><InitialStatus source={source} />{source.access_review && <small className="review-state" title={source.access_review.reason}>{source.access_review.decision.replaceAll("_", " ")} · expires {source.access_review.expires_on}</small>}</td>
            <td><GeminiCheck source={source} names={names} /></td>
            <ReviewCells source={source} canLabel={labels} onSaved={saved} />
          </tr>)}</tbody>
        </table></div></div>)}
      {data && !grouped.length && <p>{data.sources.length ? "No sources match these filters." : "No sources yet. Sources are discovered on a location's first run."}</p>}
    </section>
    {canEdit && locationId && <SourceSheetInventory locationId={locationId} />}
    {canEdit && locationId && <AddSource locationId={locationId} sections={data?.sections ?? []} onAdded={(label) => { setNotice(label); void load(); }} />}
    {locationId && <section className="panel" id="discovery"><h2>Discovery methods</h2><p>What each method found last time.</p>
      <div className="table-wrap"><table><thead><tr><th>Method</th><th>Last run</th><th>Result</th></tr></thead><tbody>{(data?.discovery ?? []).map((state) => <tr key={state.method}>
        <td>{state.label}</td><td>{state.last_run_at ? new Date(state.last_run_at * 1000).toLocaleString() : "Never"}</td>
        <td>{state.never_run ? "Runs on the next run" : <><span className={`status-badge tone-${state.ok ? "ok" : "failed"}`}>{state.ok ? "ok" : "failed"}</span> <small>{state.found} found, {state.added} new. {state.detail}</small></>}</td>
      </tr>)}</tbody></table></div>
    </section>}
  </>;
}

function reviewHeld(source: Source) {
  return Boolean(source.access_review && (!source.access_review.collection_allowed || source.access_review.expires_on < new Date().toISOString().slice(0, 10)));
}

function SourceSheetInventory({ locationId }: { locationId: string }) {
  const [data, setData] = useState<{ checked_on: string; spreadsheet_url: string; sources: Array<{ id: string; name: string; url: string; scope: string; decision: string; reason: string; evidence: string[] }> } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    adminApi<NonNullable<typeof data>>(`source-sheet?location=${encodeURIComponent(locationId)}`)
      .then((value) => { if (mounted) setData(value); })
      .catch((cause) => { if (mounted) setError(String(cause)); });
    return () => { mounted = false; };
  }, [locationId]);
  if (!data?.sources.length && !error) return null;
  return <section className="panel"><details>
    <summary>Spreadsheet source review {data ? `(${data.sources.length} entries)` : ""}</summary>
    {error && <p className="alert" role="alert">{error}</p>}
    {data && <><p>Checked {data.checked_on}. <a href={data.spreadsheet_url} target="_blank" rel="noopener noreferrer">Original spreadsheet</a>. Pending sources stay paused. Shared providers and software documentation are recorded here until a suitable integration is available. Photo reuse needs separate approval.</p>
      <div className="table-wrap"><table><thead><tr><th>Source</th><th>Decision</th><th>Reason and evidence</th></tr></thead><tbody>
        {data.sources.map((source) => <tr key={source.id}><td><a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a><br /><small>{source.scope === "shared_integration" ? "Shared integration" : "Community source"}</small></td>
          <td>{source.decision.replaceAll("_", " ")}</td><td>{source.reason}<br />{source.evidence.filter((url) => url !== source.url).map((url, i) => <span key={url}><a href={url} target="_blank" rel="noopener noreferrer">Evidence {i + 1}</a>{" "}</span>)}</td></tr>)}
      </tbody></table></div></>}
  </details></section>;
}

const geminiVerdict = (source: Source) => source.gemini?.verdict ?? (source.gemini ? "not_judged" : "");

/**
 * What Decision and Reasoning each do. They sit side by side but are different things: the Decision is the verdict that
 * changes whether runs read a source, and its Reasoning only says why.
 */
export function ReviewKey() {
  return <dl className="review-key" aria-label="What each column does">
    <div className="review-group"><dt>Decision</dt><dd>Your verdict, and what runs read: <strong>Accept</strong> reads it (pins stay pinned, paused ones resume), <strong>Reject</strong> stops it. Overrules the model check.</dd></div>
    <div className="review-group"><dt>Reasoning</dt><dd>Why, as a reason code. Changes nothing on its own; the model check learns from it.</dd></div>
  </dl>;
}

/** The model check's verdict, the model that gave it, its reason code and evidence, and the final review's flags. A person's Decision overrules it. */
function GeminiCheck({ source, names }: { source: Source; names: Map<string, string> }) {
  const check = source.gemini, flags = source.review_flags;
  if (!check && !flags) return <>—</>;
  const duplicate = flags?.duplicate_of ? names.get(flags.duplicate_of) ?? flags.duplicate_of : null;
  return <>{check?.verdict ? <><span className={`status-badge tone-${check.verdict === "accept" ? "ok" : "failed"}`}>{check.verdict === "accept" ? "Accept" : "Reject"}</span> <small>{check.reason_code} {reasonLabel(check.reason_code) ?? ""}</small>
    {check.model && <small className="review-state">Judged by {check.model}</small>}
    {check.reason && <small className="review-state">{check.reason}</small>}{check.evidence && <small className="review-state">Evidence: {check.evidence}</small>}</> : check && <small>{check.note ?? "Not judged"}</small>}
    {flags?.strength && <small className="review-state">Final review: {flags.strength}</small>}
    {duplicate && <small className="review-state">Likely duplicate of {duplicate}</small>}
    {!duplicate && !flags?.confirmed && Boolean(flags?.duplicate_candidates.length) && <small className="review-state">Possible duplicate ({flags!.duplicate_candidates[0].why}), not confirmed</small>}</>;
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

/**
 * The Decision and Reasoning cells. Each saves on its own, and a failure stays on screen until it is retried. The Collect sources tab
 * uses them too, with its own `send` for a test-mode run, whose decisions are kept by page.
 */
export function ReviewCells({ source, canLabel, onSaved, send }: { source: Pick<Source, "_id" | "location_id" | "source_id" | "name" | "review"> & { status?: string }; canLabel: boolean; onSaved: (id: string, change: { status: string; review: Review }) => void; send?: (change: Record<string, string | null>) => Promise<{ status: string; review: Review }> }) {
  const [decision, setDecision] = useState<NonNullable<Review["decision"]> | "">(source.review?.decision ?? "");
  const [code, setCode] = useState(source.review?.reason_code ?? "");
  const [reason, setReason] = useState(source.review?.reason ?? "");
  const [saving, setSaving] = useState<{ decision: Saving; reason: Saving }>({ decision: null, reason: null });
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => setDecision(source.review?.decision ?? ""), [source.review?.decision]);
  useEffect(() => setCode(source.review?.reason_code ?? ""), [source.review?.reason_code]);
  useEffect(() => setReason(source.review?.reason ?? ""), [source.review?.reason]);
  if (!canLabel) return <>
    <td className="review-group">{source.review?.decision ? DECISIONS[source.review.decision] : "—"}</td>
    <td className="source-reason review-group"><ReasonText review={source.review} /></td>
  </>;
  function save(field: "decision" | "reason", change: Record<string, string | null>) {
    setSaving((all) => ({ ...all, [field]: { state: "saving" } }));
    // One at a time, so the last choice made is the one that lands.
    queue.current = queue.current.then(async () => {
      try {
        const result = send ? await send(change) : await adminApi<{ status: string; review: Review }>(`locations/${encodeURIComponent(source.location_id)}/source-map`, { method: "PATCH", body: JSON.stringify({ source_id: source.source_id, ...change }) });
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
    <td className="source-decision review-group"><select aria-label={`Decision for ${source.name}`} value={decision} onChange={(event) => {
      setDecision(event.target.value as typeof decision); setCode(""); leaveCode();
      setSaving((all) => ({ ...all, reason: null }));
      save("decision", { decision: event.target.value || null });
    }}>
      <option value="" />{Object.entries(DECISIONS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
    </select><SaveState saving={saving.decision} />
    {source.status === "paused" && decision === "accept" && <small className="review-state">Paused. Clear and Accept again to read it.</small>}</td>
    <td className="source-reason review-group"><select aria-label={`Reasoning for ${source.name}`} title={code ? reasonLabel(code) ?? undefined : undefined} disabled={!decision} value={code} onChange={(event) => {
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
    <p>A homepage, news page, calendar or feed.</p>
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
      <label className="field source-url">How did you find it? (optional)<input name="how_found" maxLength={300} placeholder="e.g. the library's branch list" /><small>Where you looked.</small></label>
      <label className="field source-url">Note (funeral homes: their permission to republish)<input name="note" maxLength={500} /></label>
      <button type="submit" disabled={busy}>{busy ? "Checking…" : "Check and add"}</button>
    </form>
  </section>;
}
