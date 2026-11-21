"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminApi, mapApi, withPublication } from "@/lib/admin-client";
import { usePublicationScope } from "@/app/components/publication-scope";
import Link from "next/link";
import { displayStatus, liveStatus, NON_SCRAPABLE, nonScrapableReason, statusCounts } from "@/pipeline/sourcemap/display";
import { isOtherReason, reasonLabel, REASONS } from "@/pipeline/sourcemap/reasons";
import { DISCOVERY_DISABLED_GUIDANCE, discoveryDisabledExplanation, discoveryOutcome, type DiscoveryOutcomeFields } from "@/pipeline/discovery/status";

type Source = {
  _id: string; location_id: string; location_name?: string; source_id: string; name: string; url: string | null; feed_url?: string | null; reader: string; section: string; status: string; note?: string | null; review?: Review; inside_area: boolean; link_only?: boolean;
  partial_run_id?: string;
  why?: string | null; source_kind?: string; access?: { robots?: string; rights?: string; fresh?: boolean } | null;
  gemini?: { verdict: "accept" | "reject" | null; reason_code: string | null; reason: string | null; evidence: string | null; note: string | null; model?: string | null } | null;
  review_flags?: { strength: string | null; duplicate_of: string | null; duplicate_candidates: Array<{ source_id: string; why: string }>; confirmed: boolean; reason: string | null; note: string | null } | null;
  found_by: { method: string; detail: string; how_found?: string | null }; found_by_label: string; window_label: string | null; score: number;
  health: { last_run_at: number | null; last_status: string | null; last_detail: string | null; runs: number; items_found: number; items_local: number; items_published: number; consecutive_failures: number; empty_runs: number; last_new_item_day: string | null };
  access_review?: { decision: string; collection_allowed: boolean; reason: string; expires_on: string; evidence: string[] };
};
export type Review = { decision: "accept" | "reject" | null; reason_code?: string | null; reason: string | null; initial_status: string };
type Discovery = DiscoveryOutcomeFields & { method: string; label: string; last_run_at?: number; ok?: boolean; found?: number; added?: number; detail?: string; never_run?: boolean };
type LibrarySystem = { id: string; name: string };
type Data = { sections: Array<{ id: string; label: string }>; sources: Source[]; discovery: Discovery[]; systems?: LibrarySystem[] };

const MAX_REASON = 2000;
const DECISIONS = { accept: "Accept", reject: "Reject" };
const STATUS_LABELS: Record<string, string> = { [NON_SCRAPABLE]: "Non-scrapable" };
const statusTone = (status: string) => status === NON_SCRAPABLE ? "non-scrapable" : status === "rejected" ? "failed" : status === "paused" || status === "dormant" ? "warning" : "ok";

const READERS: Record<string, string> = { web: "Website or feed", opendata: "Open data", newssearch: "News search", library: "Library", meetings: "Meetings", hazards: "Alerts", trending: "Trends", homesafety: "Water", housing: "Housing data", remembrance: "Family notices", justice: "Prosecutors", community: "Reader stories" };

/** Editable only in a location's Sources tab; everywhere else it's a read-only view of the same records. */
/** `operatorControls` (pause, resume, look-back windows, the source sheet) is off for journalists in a newsroom. */
export default function SourceMapManager({ locationId, editable = false, operatorControls = true }: { locationId?: string; editable?: boolean; operatorControls?: boolean }) {
  const canEdit = Boolean(locationId && editable);
  const scope = usePublicationScope();
  const scoped = (value: string) => withPublication(value, scope?.publicationId);
  const runsHref = (location: string) => scope ? `${scope.base}/source-map?${new URLSearchParams({ location, tab: "runs" })}` : `/locations/${encodeURIComponent(location)}/source-map?tab=runs`;
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("");
  const [verdict, setVerdict] = useState("");
  // A row labelled under a status filter stays put until the filter changes, so its reason can still be typed.
  const [labelled, setLabelled] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const pendingIds = useRef(new Set<string>());
  const reviewVersions = useRef(new Map<string, number>());
  const pendingChanged = useCallback((id: string, value: boolean) => {
    if (pendingIds.current.has(id) === value) return;
    if (value) pendingIds.current.add(id); else pendingIds.current.delete(id);
    setPending(new Set(pendingIds.current));
  }, []);
  const path = locationId ? `locations/${encodeURIComponent(locationId)}` : "";
  const load = useCallback(async () => {
    const versions = new Map(reviewVersions.current);
    try {
      const next = await (canEdit ? adminApi : mapApi)<Data>(scoped(path ? `${path}/source-map` : "source-map"));
      setData((current) => {
        const existing = new Map((current?.sources ?? []).map((source) => [source._id, source]));
        const sources = next.sources.map((source) => {
          const saved = existing.get(source._id);
          return saved && versions.get(source._id) !== reviewVersions.current.get(source._id) ? { ...source, status: saved.status, review: saved.review } : source;
        });
        return { ...next, sources: [...sources, ...(current?.sources ?? []).filter((source) => pendingIds.current.has(source._id) && !next.sources.some((item) => item._id === source._id))] };
      });
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [path, canEdit, scope?.publicationId]);
  useEffect(() => { void load(); }, [load]);
  async function act(label: string, action: () => Promise<unknown>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); setNotice(label); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  const reviewPartial = async (source: Source, change: Record<string, string | null>) => {
    const runId = encodeURIComponent(source.partial_run_id!);
    const result = await adminApi<{ saved: Array<{ status: string; review: Review }>; failed: Array<{ detail: string }> }>(
      scoped(`${path}/source-runs/${runId}/decisions`), { method: "POST", body: JSON.stringify({ source_ids: [source.source_id], ...change }) },
    );
    if (!result.saved[0]) throw new Error(result.failed[0]?.detail ?? "Review could not be saved");
    if (change.decision === "accept") await load();
    return { ...result.saved[0], status: result.saved[0].review.decision === null ? "proposed" : result.saved[0].status };
  };
  const patch = (body: Record<string, unknown>) => adminApi(scoped(`${path}/source-map`), { method: "PATCH", body: JSON.stringify(body) });
  const saved = useCallback((id: string, change: { status: string; review: Review }) => {
    reviewVersions.current.set(id, (reviewVersions.current.get(id) ?? 0) + 1);
    setLabelled((ids) => new Set(ids).add(id));
    setData((current) => current && { ...current, sources: current.sources.map((source) => source._id === id ? { ...source, ...change } : source) });
  }, []);
  const grouped = useMemo(() => {
    const text = filter.trim().toLowerCase();
    return (data?.sections ?? []).map((section) => ({ ...section, sources: (data?.sources ?? []).filter((source) => source.section === section.id).map((source) => ({
      source, visible: pending.has(source._id) || ((!status || liveStatus(source) === status || labelled.has(source._id)) && (!verdict || geminiVerdict(source) === verdict) && (!text || `${source.name} ${source.url ?? ""} ${source.found_by_label}`.toLowerCase().includes(text))),
    })) }));
  }, [data, filter, status, verdict, labelled, pending]);
  const visibleCount = grouped.reduce((sum, section) => sum + section.sources.filter((item) => item.visible).length, 0);
  const counts = useMemo(() => statusCounts(data?.sources ?? []), [data]);
  const names = useMemo(() => new Map((data?.sources ?? []).map((source) => [source.source_id, source.name])), [data]);
  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="panel source-network">
      <div className="section-heading"><div><h2>Source network</h2>{!canEdit && <p>Read-only. {locationId ? <Link href={`/locations/${encodeURIComponent(locationId)}?tab=sources`}>Edit these sources in the workspace</Link> : "Sources are edited in each location's workspace."}</p>}</div></div>
      {locationId && !scope && <p className="chart-caption">Location ID: <code>{locationId}</code>. Newsroom coverage uses this location&apos;s active source map, not a run name or review label.{" "}
        <Link href={`/locations/${encodeURIComponent(locationId)}?tab=settings#location-evidence`}>Review readiness evidence</Link>.
      </p>}
      {data && locationId && data.sources.length === 0 && <p className="notice" role="status">
        No saved sources are available for this location ID. A successful or labelled collection run does not establish an active source map here.{" "}
        <Link href={runsHref(locationId)}>Inspect this location&apos;s collection runs</Link>{" "}
        and confirm the original run&apos;s location ID and whether it stored discoveries separately before starting another run. Do not overwrite or relabel another location&apos;s map.
      </p>}
      <ReviewKey />
      <p className="chart-caption">{Object.entries(counts).map(([key, value]) => `${value} ${key}`).join(" · ")}</p>
      <div className="filters">
        <label>Search<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Name, link or how found" /></label>
        <label>Live status<select value={status} onChange={(event) => { setStatus(event.target.value); setLabelled(new Set()); }}><option value="">All</option>{["active", "pinned", "proposed", NON_SCRAPABLE, "dormant", "paused", "rejected"].map((value) => <option key={value} value={value}>{STATUS_LABELS[value] ?? value}</option>)}</select></label>
        <label>Model check<select value={verdict} onChange={(event) => setVerdict(event.target.value)}><option value="">All</option><option value="accept">Accept</option><option value="reject">Reject</option><option value="not_judged">Not judged</option></select></label>
      </div>
      {pending.size > 0 && <p className="review-state" role="status">Unfinished reviews stay visible through filters. Save or retry before leaving; reloading requires discarding unfinished input.</p>}
      {grouped.map((section) => <div key={section.id} hidden={!section.sources.some((item) => item.visible)}>
        <h3>{section.label} <small>· {section.sources.filter((item) => item.visible).length}</small></h3>
        <div className="source-review-list">
          {section.sources.map(({ source, visible }) => <article className="source-review-row" key={source._id} id={source.source_id} hidden={!visible} aria-label={source.name}>
            <div className="source-review-identity">
              <strong>{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a> : source.name}</strong>
              {!locationId && <Link href={`/source-map?location=${encodeURIComponent(source.location_id)}`}>{source.location_name ?? source.location_id}</Link>}
              <div className="source-review-status"><span className={`status-badge tone-${statusTone(liveStatus(source))}`}>Live: {STATUS_LABELS[liveStatus(source)] ?? liveStatus(source)}</span>
                <small>Review: {source.review?.decision ? DECISIONS[source.review.decision] : "Not reviewed"}</small></div>
              {source.partial_run_id && <small className="review-state">Partial run · awaiting activation. Accept rechecks eligibility.</small>}
              {source.link_only && <small className="review-failed">Not being read: {nonScrapableReason(source)}</small>}
              {!source.link_only && (source.access?.robots === "blocked" || source.access?.rights === "link-only") && <small className="review-failed">Collection restricted: {source.access.robots === "blocked" ? "Blocked from reading" : "Rights: headline and link only"}</small>}
              {source.access_review && <small className={reviewHeld(source) ? "review-failed" : "review-state"}>
                {reviewHeld(source) ? "Access held" : "Access review"}: {source.access_review.decision.replaceAll("_", " ")} · expires {source.access_review.expires_on}. {source.access_review.reason}
              </small>}
              {(source.health.consecutive_failures > 0 || source.health.last_status && source.health.last_status !== "ingested") && <small className="review-failed">Health: {source.health.last_status ?? "failed"}{source.health.consecutive_failures > 0 ? ` · ${source.health.consecutive_failures} consecutive failures` : ""}. See source details.</small>}
            </div>
            <div className="source-review-controls">
              <ReviewCells source={source} canLabel={canEdit} layout="row" onSaved={saved} onPendingChange={pendingChanged} send={source.partial_run_id ? (change) => reviewPartial(source, change) : undefined} />
            </div>
            <div className="source-review-bottom"><details className="source-review-details"><summary>Source details</summary>
              <dl>
                <div><dt>Source</dt><dd>{source.url ?? "No URL"}{source.feed_url && <div>Feed: {source.feed_url}</div>}{source.inside_area && <div>Inside the area</div>}{source.note && <div>Note: {source.note}</div>}</dd></div>
                <div><dt>Type</dt><dd>{READERS[source.reader] ?? source.reader}{source.source_kind && ` · ${source.source_kind}`}</dd></div>
                <div><dt>How found</dt><dd>{source.found_by_label} · {source.found_by.method}<div>{source.found_by.detail}</div>{source.found_by.how_found && <div>How I found it: {source.found_by.how_found}</div>}</dd></div>
                <div><dt>Window</dt><dd>{source.window_label ?? (locationId ? "Default" : "See location")}{canEdit && operatorControls && !source.partial_run_id && <button type="button" className="run-inspect-link" disabled={busy} onClick={() => {
                  const value = window.prompt("Days back (and optional days ahead), e.g. '35' or '14,30'. Leave empty to use the default.", "");
                  if (value === null) return;
                  const [back, ahead] = value.split(",").map((part) => Number(part.trim()));
                  void act("Window updated.", () => patch({ source_id: source.source_id, window: value.trim() ? { back_days: back || undefined, ahead_days: ahead || undefined } : null }));
                }}>Change window</button>}</dd></div>
                <div><dt>Health</dt><dd>{source.health.runs ? `${source.health.items_found} found, ${source.health.items_local} local, ${source.health.items_published} published over ${source.health.runs} runs` : "Not run yet"}
                  <div>Last: {source.health.last_status ?? "Not run"}{source.health.last_run_at ? ` · ${new Date(source.health.last_run_at * 1000).toLocaleString()}` : ""}</div>
                  {source.health.last_detail && <div>{source.health.last_detail}</div>}
                  <div>{source.health.consecutive_failures} consecutive failures · {source.health.empty_runs} empty runs{source.health.last_new_item_day ? ` · newest item ${source.health.last_new_item_day}` : ""}</div></dd></div>
                <div><dt>Initial status</dt><dd><InitialStatus source={source} /></dd></div>
                <div><dt>Model check</dt><dd><GeminiCheck source={source} names={names} /></dd></div>
                {source.why && <div><dt>Source evidence</dt><dd>{source.why}</dd></div>}
                {source.access && <div><dt>Access evidence</dt><dd>Robots: {source.access.robots ?? "Unknown"} · rights: {source.access.rights ?? "Unknown"} · freshness: {source.access.fresh === undefined ? "Unknown" : source.access.fresh ? "Current" : "Not current"}</dd></div>}
                {source.access_review?.evidence.length ? <div><dt>Access review evidence</dt><dd>{source.access_review.evidence.map((evidence, index) => <div key={index}>{evidence}</div>)}</dd></div> : null}
              </dl>
            </details>
              <div className="source-review-actions">
                {canEdit && source.partial_run_id && source.review?.decision === "accept" && <button type="button" className="run-inspect-link" disabled={busy}
                  onClick={() => void act("Source activated.", () => reviewPartial(source, { decision: "accept" }))}>Activate source</button>}
                {canEdit && operatorControls && !source.partial_run_id && (["active", "pinned", "dormant"].includes(source.status) || source.status === "paused") && <button type="button" className="run-inspect-link"
                  disabled={busy || source.status === "paused" && (reviewHeld(source) || source.link_only || source.review?.decision === "reject")}
                  onClick={() => void act(source.status === "paused" ? "Source resumed. Review labels unchanged." : "Source paused. Review labels unchanged.",
                    () => patch({ source_id: source.source_id, status: source.status === "paused" ? "resume" : "paused" }))}>{source.status === "paused" ? "Resume" : "Pause"}</button>}
              </div>
            </div>
          </article>)}
        </div></div>)}
      {data && !visibleCount && <p>{data.sources.length ? "No sources match these filters." : "No sources yet. Sources are discovered on a location's first run."}</p>}
    </section>
    {canEdit && operatorControls && locationId && <SourceSheetInventory locationId={locationId} />}
    {canEdit && locationId && data && <AddSource locationId={locationId} sections={data.sections} systems={data.systems ?? []} onAdded={(label) => { setNotice(label); void load(); }} />}
    {locationId && <section className="panel" id="discovery"><h2>Discovery methods</h2><p>What each method found last time.</p>
      <div className="table-wrap"><table><thead><tr><th>Method</th><th>Last run</th><th>Result</th></tr></thead><tbody>{(data?.discovery ?? []).map((state) => <tr key={state.method}>
        <td>{state.label}</td><td>{state.last_run_at ? new Date(state.last_run_at * 1000).toLocaleString() : "Never"}</td>
        <td>{discoveryOutcome(state) === "not_attempted" ? "Not attempted. Check next-run settings before starting." : discoveryOutcome(state) === "disabled"
          ? <><span className="status-badge tone-warning">Disabled / unavailable</span> <small>{discoveryDisabledExplanation(state)} {DISCOVERY_DISABLED_GUIDANCE}</small>
            {state.detail && <details><summary>Discovery diagnostics</summary><small>{state.found ?? 0} found, {state.added ?? 0} new. {state.detail}</small></details>}</>
          : <><span className={`status-badge tone-${discoveryOutcome(state) === "succeeded" ? "ok" : "failed"}`}>{discoveryOutcome(state) === "succeeded" ? "ok" : "failed"}</span> <small>{state.found} found, {state.added} new.</small>
            {state.detail && <details><summary>Discovery diagnostics</summary><small>{state.detail}</small></details>}</>}</td>
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
  return <dl className="review-key" aria-label="What review controls do">
    <div className="review-group"><dt>Decision</dt><dd>Your recorded verdict: <strong>Accept</strong> enables eligible sources; <strong>Reject</strong> stops them. Access restrictions still apply. Use Pause/Resume for operations without changing review or training labels.</dd></div>
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
    {check?.verdict && check.note && <small className="review-state">{check.note}</small>}
    {flags?.strength && <small className="review-state">Final review: {flags.strength}</small>}
    {duplicate && <small className="review-state">Likely duplicate of {duplicate}</small>}
    {flags?.duplicate_candidates.map((candidate) => <small className="review-state" key={candidate.source_id}>Possible duplicate: {names.get(candidate.source_id) ?? candidate.source_id} ({candidate.why}){!flags.confirmed && ", not confirmed"}</small>)}
    {flags?.reason && <small className="review-state">{flags.reason}</small>}
    {flags?.note && <small className="review-state">{flags.note}</small>}</>;
}

/** The status the pipeline gave the source, with the live status beneath it once they differ. A link-only source says it isn't read, and why. */
function InitialStatus({ source }: { source: Source }) {
  const initial = displayStatus(source.review?.initial_status ?? source.status, source.link_only);
  const live = liveStatus(source);
  return <><span className={`status-badge tone-${statusTone(initial)}`}>{STATUS_LABELS[initial] ?? initial}</span>
    {live !== initial && <small className="review-state">Now {STATUS_LABELS[live] ?? live}</small>}
    {source.link_only && <small className="review-state">Not being read: {nonScrapableReason(source)}</small>}</>;
}

type Saving = { state: "saving" | "saved" } | { state: "failed"; detail: string } | null;

function SaveState({ saving, retry }: { saving: Saving; retry: () => void }) {
  if (!saving) return null;
  if (saving.state === "failed") return <small className="review-failed" role="alert">Save incomplete: {saving.detail} <button type="button" className="run-inspect-link" onClick={retry}>Retry</button></small>;
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
export function ReviewCells({ source, canLabel, onSaved, send, layout = "table", onPendingChange }: { source: Pick<Source, "_id" | "location_id" | "source_id" | "name" | "review"> & { status?: string }; canLabel: boolean; onSaved: (id: string, change: { status: string; review: Review }) => void; send?: (change: Record<string, string | null>) => Promise<{ status: string; review: Review }>; layout?: "table" | "row"; onPendingChange?: (id: string, pending: boolean) => void }) {
  const scope = usePublicationScope();
  const [decision, setDecision] = useState<NonNullable<Review["decision"]> | "">(source.review?.decision ?? "");
  const [code, setCode] = useState(source.review?.reason_code ?? "");
  const [reason, setReason] = useState(source.review?.reason ?? "");
  const [saving, setSaving] = useState<{ decision: Saving; reason: Saving }>({ decision: null, reason: null });
  const queue = useRef<Promise<void>>(Promise.resolve());
  const dirty = useRef({ decision: false, reason: false });
  // Input versions protect unblurred text as well as work already in the save queue.
  const versions = useRef({ decision: 0, reason: 0 });
  const requests = useRef({ decision: 0, reason: 0 });
  const decisionReasonVersion = useRef(0);
  useEffect(() => { if (!dirty.current.decision) setDecision(source.review?.decision ?? ""); }, [source.review?.decision]);
  useEffect(() => { if (!dirty.current.reason) setCode(source.review?.reason_code ?? ""); }, [source.review?.reason_code]);
  useEffect(() => { if (!dirty.current.reason) setReason(source.review?.reason ?? ""); }, [source.review?.reason]);
  const other = isOtherReason(code);
  const pending = canLabel && (dirty.current.decision || dirty.current.reason || other && !reason.trim() || Object.values(saving).some((value) => value?.state === "saving" || value?.state === "failed"));
  useEffect(() => { onPendingChange?.(source._id, pending); }, [source._id, pending, onPendingChange]);
  useEffect(() => {
    if (!pending) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [pending]);
  const Cell = layout === "row" ? "div" : "td";
  if (!canLabel) return <>
    <Cell className="review-group">{layout === "row" && <strong>Decision: </strong>}{source.review?.decision ? DECISIONS[source.review.decision] : "—"}</Cell>
    <Cell className="source-reason review-group">{layout === "row" && <strong>Reasoning: </strong>}<ReasonText review={source.review} /></Cell>
  </>;
  function save(field: "decision" | "reason", change: Record<string, string | null>) {
    const version = { ...versions.current };
    const request = ++requests.current[field];
    setSaving((all) => ({ ...all, [field]: { state: "saving" } }));
    // One at a time, so the last choice made is the one that lands.
    queue.current = queue.current.then(async () => {
      try {
        const result = send ? await send(change) : await adminApi<{ status: string; review: Review }>(withPublication(`locations/${encodeURIComponent(source.location_id)}/source-map`, scope?.publicationId), { method: "PATCH", body: JSON.stringify({ source_id: source.source_id, ...change }) });
        onSaved(source._id, { status: result.status, review: result.review });
        if (request !== requests.current[field]) return;
        if (version[field] !== versions.current[field]) {
          setSaving((all) => ({ ...all, [field]: null }));
          return;
        }
        dirty.current[field] = false;
        if (field === "decision") setDecision(result.review.decision ?? "");
        if ((field === "reason" ? version.reason : decisionReasonVersion.current) === versions.current.reason) {
          dirty.current.reason = false;
          setCode(result.review.reason_code ?? "");
          setReason(result.review.reason ?? "");
        }
        setSaving((all) => ({ ...all, [field]: { state: "saved" } }));
      } catch (cause) {
        if (request === requests.current[field]) setSaving((all) => ({ ...all, [field]: { state: "failed", detail: cause instanceof Error ? cause.message : String(cause) } }));
      }
    });
  }
  const edit = (field: "decision" | "reason") => { dirty.current[field] = true; versions.current[field] += 1; };
  const discardReason = () => !(dirty.current.reason && Boolean(code) || saving.reason?.state === "failed" || other && !reason.trim()) || window.confirm("Changing this choice discards unfinished Reasoning for this source. Continue?");
  // The server clears Other text when its code goes, so the box and any note show the same straight away.
  const leaveCode = () => { if (isOtherReason(code)) setReason(""); };
  return <>
    <Cell className="source-decision review-group"><label>{layout === "row" && <span>Decision</span>}<select aria-label={`Decision for ${source.name}`} value={decision} onChange={(event) => {
      if (!discardReason()) return;
      edit("decision"); edit("reason");
      decisionReasonVersion.current = versions.current.reason;
      requests.current.reason += 1;
      setDecision(event.target.value as typeof decision); setCode(""); leaveCode();
      setSaving((all) => ({ ...all, reason: null }));
      save("decision", { decision: event.target.value || null });
    }}>
      <option value="" />{Object.entries(DECISIONS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
    </select></label><SaveState saving={saving.decision} retry={() => save("decision", { decision: decision || null })} />
    {source.status === "paused" && source.review?.decision === "accept" && <small className="review-state">Operationally paused. Use Resume; no new verdict is needed.</small>}</Cell>
    <Cell className="source-reason review-group"><label>{layout === "row" && <span>Reasoning</span>}<select aria-label={`Reasoning for ${source.name}`} title={code ? reasonLabel(code) ?? undefined : undefined} disabled={!decision} value={code} onChange={(event) => {
      const next = event.target.value;
      if (next !== code && !discardReason()) return;
      edit("reason");
      setCode(next); if (!isOtherReason(next)) leaveCode();
      save("reason", { reason_code: next || null });
    }}>
      <option value="" />{decision && REASONS[decision].map((option) => <option value={option.code} key={option.code}>{option.code} {option.label}</option>)}
    </select></label>
    {other && <textarea aria-label={`Explain the reason for ${source.name}`} rows={2} maxLength={MAX_REASON} value={reason} onChange={(event) => {
      edit("reason"); setReason(event.target.value);
      setSaving((all) => all.reason?.state === "saved" ? { ...all, reason: null } : all);
    }} onBlur={() => {
      const text = reason.trim();
      if (dirty.current.reason || text !== (source.review?.reason ?? "")) save("reason", { reason_code: code, reason: text || null });
    }} />}
    {other && !reason.trim() && <small className="review-failed">Incomplete: add an explanation.</small>}
    {other && reason.trim() && dirty.current.reason && saving.reason?.state !== "failed" && <small className="review-state">Explanation not yet saved.</small>}
    {!other && reason && <small className="review-state">Earlier note: {reason}</small>}
    <SaveState saving={saving.reason} retry={() => save("reason", { reason_code: code || null, ...(other ? { reason: reason.trim() || null } : {}) })} /></Cell>
  </>;
}

export function AddSource({ locationId, sections, systems, onAdded }: { locationId: string; sections: Array<{ id: string; label: string }>; systems: LibrarySystem[]; onAdded: (label: string) => void }) {
  const scope = usePublicationScope();
  const [type, setType] = useState("web");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    setBusy(true); setError("");
    try {
      const result = await adminApi<{ link: { validated_events: number } }>(withPublication(`locations/${encodeURIComponent(locationId)}/links`, scope?.publicationId), { method: "POST", body: JSON.stringify({ ...Object.fromEntries(form.entries()), type, inside_area: form.get("inside_area") === "on" }) });
      onAdded(`Source checked and pinned (${result.link.validated_events} items found now).`);
      element.reset();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  return <section className="panel" id="add-source" tabIndex={-1}><h2>Add a source</h2>
    <p>A homepage, news page, calendar or feed.</p>
    {error && <p className="alert" role="alert">{error}</p>}
    <form className="source-form" onSubmit={(event) => void submit(event)}>
      <label className="field">Type<select value={type} onChange={(event) => setType(event.target.value)}>
        <option value="web">Website or feed</option><option value="opendata">Open-data dataset (Socrata)</option><option value="meetings">Meeting platform (Legistar, CivicClerk)</option><option value="library">Library catalogue</option>
      </select></label>
      {type === "library" && <label className="field">Library system<select name="system_id" required defaultValue="" disabled={!systems.length}>
        <option value="" disabled>Select this location's library system</option>
        {systems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
      </select>{!systems.length && <small>No eligible library systems with branches belong to this location. Resolve its library branch selection before adding a catalogue.</small>}</label>}
      <label className="field">Name<input name="name" required maxLength={120} /></label>
      <label className="field source-url">Link<input name="url" type="url" required placeholder="https://" /></label>
      {type === "web" && <label className="field">Section<select name="section" defaultValue="news">{sections.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}</select></label>}
      {type === "web" && <label className="field"><span><input name="inside_area" type="checkbox" /> This organisation is inside the area (its posts count as local)</span></label>}
      {type === "opendata" && <label className="field">Topic<select name="topic" defaultValue="permits">{["police", "fire", "permits", "inspections", "licences", "311"].map((topic) => <option key={topic}>{topic}</option>)}</select></label>}
      {type === "opendata" && <label className="field">Filter<select name="filter" defaultValue="radius"><option value="radius">By location (dataset has coordinates)</option><option value="city">By city name (statewide dataset)</option></select></label>}
      <label className="field source-url">How did you find it? (optional)<input name="how_found" maxLength={300} placeholder="e.g. the library's branch list" /><small>Where you looked.</small></label>
      <label className="field source-url">Note (funeral homes: their permission to republish)<input name="note" maxLength={500} /></label>
      <button type="submit" disabled={busy || type === "library" && !systems.length}>{busy ? "Checking…" : "Check and add"}</button>
    </form>
  </section>;
}
