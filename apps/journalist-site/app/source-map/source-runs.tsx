"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi, mapApi } from "@/lib/admin-client";
import type { PaidService, RunOptions } from "@/pipeline/core/run-values";
import { isOtherReason, REASONS } from "@/pipeline/sourcemap/reasons";
import { SECTIONS } from "@/pipeline/sourcemap/sections";
import {
  choicesFor, codeState, DEFAULT_SETTINGS, DORK_SERVICES, filterPages, groupPages, READER_LABELS, STAGES, TOOLS, TOOL_IDS,
  type PageFilters, type PageRow, type RunSettings, type ToolId,
} from "@/pipeline/trace/source-run-settings";
import type { Cell } from "@/pipeline/agent/search-grid";
import type { AngleRow } from "@/pipeline/agent/search-angles";
import { ReviewCells, ReviewKey, type Review } from "../locations/[locationId]/source-map-manager";
import LiveSourceRun from "./live-source-run";

type RunItem = { run_id: string; number: number; status: string; created_at: number; completed_at: number | null; summary: string; recorded: boolean; isolated: boolean };
type Meter = { id: string; label: string; used: number; ceiling: number | null; unit: string; note: string | null };
type Detail = {
  run: { id: string; number: number | null; location_id: string; location_name: string; status: string; created_at: number; completed_at: number | null; error: string | null; by: string | null; recorded: boolean; isolated: boolean };
  settings: RunSettings; ending: { tone: string; text: string }; limits: Meter[];
  stages: Array<{ id: string; label: string; detail: string; count: number; by_tool: Array<{ tool: ToolId; count: number }> }>;
  categories: Array<{ category: string; label: string; pages: number; accepted_by_gemini: number; accepted_by_you: number; status: string; note: string | null }>;
  pages: PageRow[];
  tools: Array<{ tool: ToolId; searches: number | null; returned?: number; found_only?: number; found_elsewhere?: number; found: number; opened: number; passed_code: number; accepted_by_gemini: number; only_this_tool: number; accepted_by_you: number; limit_use: string }>;
  log: Array<{ step: string; action: string; tool: string | null; target: string | null; category: string | null; reason: string; result: string; outcome: string }>;
  /** An exhaustive run's grid of category × search tool; null for a run that searched until covered. */
  grid: GridDetail | null;
};
type GridTool = "dork" | "exa" | "tavily";
type GridDetail = {
  fixture?: boolean; cell_dry: number; cell_dry_dork?: number; hits: number; uncredited: number; open: number; rounds?: number;
  categories: Array<{ category: string; label: string; dry: boolean }>; cells: Cell[];
  curves: Record<GridTool, Array<{ searches: number; hits: number }>>;
  /** Each category's angles in order, with the agent's reason and each tool's result; empty for a run from before angles. */
  angles: Array<{ category: string; label: string; angles: AngleRow[] }>;
};
const GRID_TOOLS: GridTool[] = ["dork", "exa", "tavily"];
type Info = { defaults: RunOptions; deployed: boolean; configured: Record<PaidService, boolean>; isolated: boolean; proposed_until_approved?: boolean };

const SECTION_LABELS = Object.fromEntries(SECTIONS.map((section) => [section.id, section.label])) as Record<string, string>;
const short = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "");
const when = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const minutes = (run: { created_at: number; completed_at: number | null }) => run.completed_at ? `${Math.max(1, Math.round((run.completed_at - run.created_at) / 60))} min` : "running";
const runLabel = (run: RunItem) => `Run ${run.number} · ${when(run.created_at)} · ${run.summary}${run.isolated ? "" : " · wrote the source map"}${run.status === "mapped" ? "" : ` · ${run.status === "mapping" ? "running" : run.status}`}`;
/** Clicks on these don't open a row's drawer. */
const CONTROLS = "select, textarea, input, button, a, label, .source-decision, .source-reason";
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function ToolChip({ tool }: { tool: ToolId }) {
  return <span className="chip"><span className="dot" style={{ background: TOOLS[tool].color }} />{TOOLS[tool].label}</span>;
}

function Setting({ label, children, checked, locked, disabled, onChange, tag, dot, className }: { label: string; children?: React.ReactNode; checked: boolean; locked?: boolean; disabled?: boolean; onChange?: (value: boolean) => void; tag?: string; dot?: string; className?: string }) {
  return <label className={`setting${locked ? " locked" : ""}${className ? ` ${className}` : ""}`}>
    <input type="checkbox" checked={checked} disabled={locked || disabled || !onChange} onChange={(event) => onChange?.(event.target.checked)} />
    <span>{dot && <span className="dot" style={{ background: dot }} />}{label}{tag && <span className="type-tag">{tag}</span>}</span>
    {locked && <span className="always">Always on</span>}
    {children}
  </label>;
}

/** The settings by stage: editable for the next run, read-only for a past one, from what it recorded. */
function SettingsPanel({ settings, onChange, info, rebuild, onRebuild, isolated }: { settings: RunSettings; onChange?: (settings: RunSettings) => void; info?: Info | null; rebuild?: boolean; onRebuild?: (value: boolean) => void; isolated: boolean }) {
  const editable = Boolean(onChange);
  const set = (values: Partial<RunSettings>) => onChange?.({ ...settings, ...values });
  const change = (key: keyof RunSettings) => editable ? (value: boolean) => set({ [key]: value }) : undefined;
  const noKey = (service: PaidService) => editable && info && !info.configured[service] ? <small className="note warn">No key set: it will be skipped</small> : null;
  return <section className="panel">
    <div className="section-heading"><div>
      <h2>{editable ? "Next run settings" : "Settings this run used"}</h2>
      <p>{editable ? "Free readers and the model check always run." : "Read only, from what the run recorded. Choose + New run to change them."}</p>
    </div></div>
    {isolated ? <p className="notice">Test mode: {editable ? "this run starts" : "this run started"} from scratch. It reads every fixed reader again, reuses no searches from earlier runs and keeps its results to itself; All sources and editions are untouched. Your decisions are kept by page, so they show in every run.</p>
      : editable ? <p className="notice">This run writes into All sources{info?.proposed_until_approved ? ": what it finds is saved as proposed, and no edition reads it until someone accepts it" : ": a source that passes the code check and the model check goes on active, one the model check rejects is saved rejected, and one not judged waits as proposed for your review"}. Sites already on the map are left out of its searches. Decisions made in test-mode runs still stand.</p>
      : <p className="notice">Rows show the source map as it is now.</p>}
    <div className="settings-grid">
      <fieldset><legend>Access</legend>
        <Setting label="Respect site rules" checked={settings.respect} onChange={change("respect")}><small>Robots, AI opt-outs and terms. Off is Relaxed, a test option.</small></Setting>
        <Setting label="Safety and quality" checked locked><small>Private addresses, crawl delays and reposts</small></Setting>
      </fieldset>
      <fieldset><legend>Search</legend>
        <Setting label="Fixed readers" checked locked><small>Free, run once before the agent</small></Setting>
        {editable && !isolated && <Setting className="advanced" label="Read every fixed reader again" checked={rebuild ?? true} onChange={onRebuild}><small>Off runs only the readers that are due</small></Setting>}
        <Setting label="Agent loop" checked={settings.agent} onChange={change("agent")}><small>Your model fills the gaps with the tools below</small></Setting>
        <Setting label="Dorking" tag="Google operators" dot={TOOLS.dork.color} checked={settings.agent && settings.dork} disabled={!settings.agent} onChange={change("dork")}>
          <select aria-label="Dorking service" value={settings.dork_service} disabled={!editable || !settings.agent || !settings.dork} onChange={(event) => set({ dork_service: event.target.value as RunSettings["dork_service"] })}>
            {DORK_SERVICES.map((service) => <option key={service.id} value={service.id}>{service.label}</option>)}
          </select>{settings.agent && settings.dork && noKey(settings.dork_service)}
        </Setting>
        <Setting label="Exa" tag="Meaning-based" dot={TOOLS.exa.color} checked={settings.agent && settings.exa} disabled={!settings.agent} onChange={change("exa")}>{settings.agent && settings.exa && noKey("exa")}</Setting>
        <Setting label="Tavily" tag="AI search" dot={TOOLS.tavily.color} checked={settings.agent && settings.tavily} disabled={!settings.agent} onChange={change("tavily")}>{settings.agent && settings.tavily && noKey("tavily")}</Setting>
        {settings.agent && <small className="note">Each tool searches every category in rounds until it stops finding new sites{settings.depth === "enough" ? ". This older run used Enough: it stopped once every category had an accepted source" : ""}.</small>}
        {editable && !settings.agent && <small className="note">Search tools need the agent loop.</small>}
      </fieldset>
      <fieldset><legend>Scrape</legend>
        <Setting label="Free fetcher" checked locked />
        <Setting label="Jina Reader" checked locked><small>Free, for script-built pages</small></Setting>
        <Setting label="ScrapingBee" checked={settings.scrapingbee} onChange={change("scrapingbee")}><small>Paid fallback for fixed readers</small>{settings.scrapingbee && noKey("scrapingbee")}</Setting>
        <Setting label="Bright Data" checked={settings.brightdata_open} onChange={change("brightdata_open")}><small>Paid fallback</small>{settings.brightdata_open && noKey("brightdata_open")}</Setting>
      </fieldset>
      <fieldset><legend>Code checks</legend>
        <Setting label="Safety" checked locked><small>Private addresses, crawl delay</small></Setting>
        <Setting label="Quality" checked locked><small>Reposts, pages clearly about another place</small></Setting>
        <Setting label="Evidence" checked locked><small>Local and current facts for the model check</small></Setting>
      </fieldset>
      <fieldset><legend>Think</legend>
        {settings.gemini_check ? <Setting label="Model check" checked locked><small>Your light model judges every source</small></Setting>
          : <Setting label="Model check" checked={false}><small>Off for this run: a baseline test</small></Setting>}
        <Setting label="Final review" checked locked><small>Duplicates, and strong, usable or weak</small></Setting>
        {editable && <Setting className="advanced" label="Switch the model check off" checked={!settings.gemini_check} onChange={(value) => set({ gemini_check: !value })}><small>Advanced: a baseline test of the fixed pipeline alone</small></Setting>}
      </fieldset>
    </div>
  </section>;
}

function Meters({ limits }: { limits: Meter[] }) {
  return <div className="metric-grid">{limits.map((meter) => {
    const share = meter.ceiling ? Math.min(1, meter.used / meter.ceiling) : 0;
    return <div key={meter.id} className={`metric-card ${share > .8 ? "tone-warning" : "tone-ok"}`}>
      <p className="eyebrow">{meter.label}</p>
      <strong>{meter.used} <small>{meter.ceiling !== null ? `of ${meter.ceiling}` : "no limit"} {meter.unit}</small></strong>
      <div className="meter" aria-hidden="true"><span style={{ width: `${share * 100}%` }} /></div>
      {meter.note && <p>{meter.note}</p>}
    </div>;
  })}</div>;
}

/** The page's trace, in order: found, opened (with fallbacks), code check, Model check with evidence, your decision. */
function PageDrawer({ row, onClose }: { row: PageRow; onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);
  const steps: Array<{ tone: string; title: string; small?: string | null; note?: string | null; evidence?: string | null }> = [];
  steps.push({ tone: "tone-ok", title: "Found", small: `${TOOLS[row.tool].label}${row.found.step ? ` · agent step ${row.found.step}` : row.tool === "fixed" ? " · before the agent" : ""}`, note: row.found.query ? `Search: “${row.found.query}”` : row.found.how });
  if (row.opened.reader) {
    for (const fallback of row.opened.fallbacks) steps.push({ tone: "tone-warning", title: READER_LABELS[fallback.reader] ?? fallback.reader, small: "Not enough", note: fallback.why });
    steps.push({ tone: "tone-ok", title: row.opened.reader === "unrecorded" ? "Opened" : `Opened with ${READER_LABELS[row.opened.reader] ?? row.opened.reader}`, note: row.opened.reader === "unrecorded" ? row.opened.why : null });
  } else steps.push({ tone: row.code.result === "fail" ? "tone-failed" : "tone-warning", title: "Not opened", small: row.code.result === "not_opened" ? row.code.skipped_by === "agent" ? "The agent's reason" : row.code.skipped_by === "code" ? "From the run's record" : "The agent's choice" : row.code.result === "pass" ? "A structured source" : row.code.result === "link_only" ? "Couldn't be read" : "Code check, before opening", note: row.code.result === "link_only" ? null : row.code.reason });
  const state = codeState(row.code.result);
  if (state && (row.opened.reader || state !== "passed")) {
    const [tone, label] = CODE_STATES[state];
    steps.push({ tone, title: `Code check: ${label}`, small: row.code.result === "unclear" ? "Locality unclear: the model check decides" : state === "link_only" ? "Still sent to the model check" : null, note: row.code.reason });
  }
  if (row.gemini) steps.push(row.gemini.verdict
    ? { tone: row.gemini.verdict === "accept" ? "tone-ok" : "tone-failed", title: `Model check: ${row.gemini.verdict === "accept" ? "Accept" : "Reject"} · ${row.gemini.reason_code ?? ""}`, small: [row.gemini.model, row.gemini.note].filter(Boolean).join(" · ") || null, note: row.gemini.reason, evidence: row.gemini.evidence }
    : { tone: "tone-warning", title: "Model check: not judged", note: row.gemini.note });
  if (row.decision) steps.push({ tone: row.decision.decision === "accept" ? "tone-ok" : row.decision.decision === "reject" ? "tone-failed" : "", title: row.decision.decision ? `Your decision: ${row.decision.decision === "accept" ? "Accept" : "Reject"}${row.decision.reason_code ? ` · ${row.decision.reason_code}` : ""}` : "Waiting for your decision", small: row.disagrees ? "Disagrees with the model check" : null, note: row.decision.reason });
  return <aside className="page-drawer" aria-label="Page detail" role="dialog">
    <button type="button" className="secondary close" onClick={onClose}>Close</button>
    <p className="eyebrow">Page trace</p>
    <h2 className="url">{short(row.url)}</h2>
    <p><a href={row.url} target="_blank" rel="noopener noreferrer">Open the page</a>{row.name ? ` · ${row.name}` : ""}</p>
    <div className="used-chips">{row.category && <span className="chip">{SECTION_LABELS[row.category] ?? row.category}</span>}{(row.tools ?? [row.tool]).map((tool) => <ToolChip key={tool} tool={tool} />)}{row.status && <span className="chip">Now {row.status}</span>}</div>
    <ul className="timeline">{steps.map((step, index) => <li key={index} className={step.tone}>
      <b>{step.title}</b>{step.small && <small>{step.small}</small>}{step.note && <span className="note">{step.note}</span>}{step.evidence && <div className="evidence">Evidence: {step.evidence}</div>}
    </li>)}</ul>
  </aside>;
}

/** The code check's three states: passed (unclear locality included: the model check decides it), kept as a link only, or dropped. */
const CODE_STATES = { passed: ["tone-ok", "Passed"], link_only: ["tone-warning", "Link only"], rejected: ["tone-failed", "Rejected"] } as const;
function CodeBadge({ row }: { row: PageRow }) {
  const state = codeState(row.code.result);
  // A page never opened or checked has no code check: its note says why.
  if (!state) return <span className="muted" title="No code check ran">–</span>;
  const [tone, label] = CODE_STATES[state];
  return <span className={`status-badge ${tone}`}>{label}</span>;
}
function GeminiBadge({ row }: { row: PageRow }) {
  if (!row.gemini) return <span className="status-badge">Not reached</span>;
  if (!row.gemini.verdict) return <span className="status-badge tone-warning">Not judged</span>;
  return <span className={`status-badge ${row.gemini.verdict === "accept" ? "tone-ok" : "tone-failed"}`} title={row.gemini.model ? `Judged by ${row.gemini.model}` : undefined}>{row.gemini.verdict === "accept" ? "Accept" : "Reject"} · {row.gemini.reason_code}</span>;
}

/** Bulk accept or reject: one decision and reason for every selected page that is on the source map. */
function BulkBar({ count, onApply, onClear }: { count: number; onApply: (decision: "accept" | "reject", code: string, reason: string) => Promise<void>; onClear: () => void }) {
  const [decision, setDecision] = useState<"accept" | "reject">("accept");
  const [code, setCode] = useState<string>(REASONS.accept[0].code);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return <div className="bulk review-guide panel" role="region" aria-label="Bulk decision">
    <strong>{count}</strong> selected
    <select aria-label="Decision" value={decision} onChange={(event) => { const next = event.target.value as "accept" | "reject"; setDecision(next); setCode(REASONS[next][0].code); }}><option value="accept">Accept</option><option value="reject">Reject</option></select>
    <select aria-label="Reason" value={code} onChange={(event) => setCode(event.target.value)}>{REASONS[decision].map((option) => <option key={option.code} value={option.code}>{option.code} {option.label}</option>)}</select>
    {isOtherReason(code) && <input aria-label="Explain the reason" placeholder="Explain the reason" maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} />}
    <button type="button" disabled={busy} onClick={async () => { setBusy(true); try { await onApply(decision, code, reason); } finally { setBusy(false); } }}>{busy ? "Saving…" : "Apply to selected"}</button>
    <button type="button" className="secondary" onClick={onClear}>Clear</button>
  </div>;
}

function EveryPage({ detail, canEdit, filters, setFilters, onSaved, onBulk }: { detail: Detail; canEdit: boolean; filters: PageFilters; setFilters: (filters: PageFilters) => void; onSaved: (key: string, change: { status: string; review: Review }) => void; onBulk: (ids: string[], decision: "accept" | "reject", code: string, reason: string) => Promise<string | null> }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const rows = useMemo(() => filterPages(detail.pages, filters), [detail.pages, filters]);
  // One section per category, its counts of what the filters show.
  const groups = useMemo(() => groupPages(rows), [rows]);
  const columns = canEdit ? 9 : 8;
  const decidable = rows.filter((row) => row.source_id);
  const opened = detail.pages.find((row) => row.key === open) ?? null;
  const close = useCallback(() => setOpen(null), []);
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return <div>
    <div className="filters">
      <label className="field">Search addresses<input type="search" value={filters.q ?? ""} placeholder="cityofml.com" onChange={(event) => setFilters({ ...filters, q: event.target.value })} /></label>
      <label className="field">Tool<select value={filters.tool ?? ""} onChange={(event) => setFilters({ ...filters, tool: event.target.value })}><option value="">All tools</option>{TOOL_IDS.map((tool) => <option key={tool} value={tool}>{TOOLS[tool].label}</option>)}</select></label>
      <label className="field">Category<select value={filters.category ?? ""} onChange={(event) => setFilters({ ...filters, category: event.target.value })}><option value="">All categories</option>{detail.categories.map((row) => <option key={row.category} value={row.category}>{row.label}</option>)}</select></label>
      <label className="field">Stage<select value={filters.stage ?? ""} onChange={(event) => setFilters({ ...filters, stage: event.target.value })}><option value="">Every page</option>{STAGES.filter((stage) => stage.id !== "found").map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}</select></label>
      <div className="period-switch"><button type="button" className="secondary" aria-pressed={Boolean(filters.disagrees)} onClick={() => setFilters({ ...filters, disagrees: !filters.disagrees })}>Disagrees with the model check</button></div>
      <small role="status">{rows.length} of {detail.pages.length} pages</small>
    </div>
    {notice && <p className="notice" role="status">{notice}</p>}
    {canEdit && selected.size > 0 && <BulkBar count={selected.size} onClear={() => setSelected(new Set())} onApply={async (decision, code, reason) => {
      const failed = await onBulk([...selected], decision, code, reason);
      setNotice(failed ?? `Saved ${decision === "accept" ? "Accept" : "Reject"} · ${code} on ${selected.size} sources.`);
      if (!failed) setSelected(new Set());
    }} />}
    <ReviewKey />
    <div className="table-wrap"><table className="source-table">
      <thead><tr className="column-groups"><th colSpan={canEdit ? 7 : 6} /><th colSpan={2} className="review-group">Your review: a recorded verdict</th></tr><tr>
        {canEdit && <th><input type="checkbox" className="row-check" aria-label="Select every page shown that is on the source map" checked={decidable.length > 0 && decidable.every((row) => selected.has(row.source_id!))} onChange={(event) => setSelected(event.target.checked ? new Set([...selected, ...decidable.map((row) => row.source_id!)]) : new Set([...selected].filter((id) => !decidable.some((row) => row.source_id === id))))} /></th>}
        <th>Page</th><th>Category</th><th>Found by</th><th>Opened by</th><th>Code check</th><th>Model check</th><th className="review-group">Decision</th><th className="review-group">Reasoning</th>
      </tr></thead>
      {groups.length ? groups.map((group) => <tbody key={group.category ?? "none"} className="category-group">
        <tr className="category-head"><th colSpan={columns} scope="colgroup">{group.heading}</th></tr>
        {group.rows.map((row) => <tr key={row.key} className="page-row" onClick={(event) => { if (!(event.target as HTMLElement).closest(CONTROLS)) setOpen(row.key); }}>
        {canEdit && <td onClick={stop}>{row.source_id && <input type="checkbox" className="row-check" aria-label={`Select ${short(row.url)}`} checked={selected.has(row.source_id)} onChange={(event) => { const next = new Set(selected); if (event.target.checked) next.add(row.source_id!); else next.delete(row.source_id!); setSelected(next); }} />}</td>}
        <td><button type="button" className="run-inspect-link url" onClick={(event) => { stop(event); setOpen(row.key); }}>{short(row.url)}</button>{row.name && <span className="note">{row.name}</span>}</td>
        <td>{row.category ? SECTION_LABELS[row.category] ?? row.category : "—"}</td>
        <td>{(row.tools ?? [row.tool]).map((tool) => <ToolChip key={tool} tool={tool} />)}<span className="note">{row.found.query ? `“${row.found.query}”` : row.found.how}{row.found.step ? ` · step ${row.found.step}` : ""}</span></td>
        <td>{row.opened.reader ? READER_LABELS[row.opened.reader] ?? row.opened.reader : "Not opened"}{row.opened.why && <span className="note">{row.opened.why}</span>}</td>
        <td><CodeBadge row={row} />{row.code.reason && <span className="note">{row.code.reason}</span>}</td>
        <td><GeminiBadge row={row} />{(row.gemini?.reason ?? row.gemini?.note) && <span className="note">{row.gemini?.reason ?? row.gemini?.note}</span>}{row.flags?.strength && <span className="note">Final review: {row.flags.strength}{row.flags.duplicate_of ? `, likely a duplicate of ${row.flags.duplicate_of}` : ""}</span>}{row.disagrees && <span className="note warn">Your decision disagrees with the model check</span>}</td>
        {row.source_id && row.decision ? <ReviewCellsFor row={row} locationId={detail.run.location_id} runId={detail.run.isolated ? detail.run.id : null} canEdit={canEdit} onSaved={onSaved} />
          : row.decision?.decision ? <><td className="review-group">{row.decision.decision === "accept" ? "Accept" : "Reject"}</td><td className="review-group"><small>{row.decision.reason_code ?? ""} Decided in another run</small></td></>
          : <><td className="review-group"><small>–</small></td><td className="review-group"><small>{detail.run.isolated ? "Not saved by this run" : "Not on the source map"}</small></td></>}
      </tr>)}
      </tbody>) : <tbody><tr><td colSpan={columns} className="empty">No pages match these filters.</td></tr></tbody>}
    </table></div>
    {opened && <PageDrawer row={opened} onClose={close} />}
  </div>;
}

/** A row's Decision and Reasoning, saved exactly as in All sources; for a test-mode run (`runId`), kept by page. */
function ReviewCellsFor({ row, locationId, runId, canEdit, onSaved }: { row: PageRow; locationId: string; runId: string | null; canEdit: boolean; onSaved: (key: string, change: { status: string; review: Review }) => void }) {
  const source = { _id: row.key, location_id: locationId, source_id: row.source_id!, name: short(row.url), review: row.decision ? { ...row.decision, initial_status: row.status ?? "proposed" } as Review : undefined };
  const send = runId ? async (change: Record<string, string | null>) => {
    const result = await adminApi<{ saved: Array<{ status: string; review: Review }>; failed: Array<{ detail: string }> }>(`locations/${encodeURIComponent(locationId)}/source-runs/${encodeURIComponent(runId)}/decisions`, { method: "POST", body: JSON.stringify({ source_ids: [row.source_id], ...change }) });
    if (!result.saved[0]) throw new Error(result.failed[0]?.detail ?? "Not saved");
    return result.saved[0];
  } : undefined;
  return <ReviewCells source={source} canLabel={canEdit} onSaved={onSaved} send={send} />;
}

function ByTool({ detail }: { detail: Detail }) {
  return <div>
    <div className="table-wrap"><table>
      <thead><tr><th>Tool</th><th>Searches</th><th>Results returned</th><th>Found only by this tool</th><th>Pages found</th><th>Opened</th><th>Passed code check</th><th>Accepted by the model check</th><th>Accepted, only this tool</th><th>Accepted by you</th><th>Use of limit</th></tr></thead>
      <tbody>{detail.tools.length ? detail.tools.map((row) => <tr key={row.tool}><td><ToolChip tool={row.tool} /></td><td>{row.searches ?? "–"}</td><td>{row.returned ?? "–"}</td><td>{row.found_only ?? "–"}</td><td>{row.found}</td><td>{row.opened}</td><td>{row.passed_code}</td><td>{row.accepted_by_gemini}{row.found_elsewhere ? <span className="note">{row.found_elsewhere} found while searching another category</span> : null}</td><td>{row.only_this_tool}</td><td>{row.accepted_by_you}</td><td>{row.limit_use}</td></tr>)
        : <tr><td colSpan={11} className="empty">No pages recorded for this run.</td></tr>}</tbody>
    </table></div>
    <p className="chart-caption">&ldquo;Results returned&rdquo; is every result the tool's searches returned, including ones other tools returned too, so the tools' totals can add up to more than the run's pages. &ldquo;Found only by this tool&rdquo;: results no other tool or reader returned. &ldquo;Accepted, only this tool&rdquo;: accepted pages no other tool found.</p>
  </div>;
}

function AgentLog({ detail }: { detail: Detail }) {
  if (!detail.settings.agent) return <p className="empty">This run had the agent loop off, so there is no agent log.</p>;
  return <div className="table-wrap"><table className="log">
    <thead><tr><th>Step</th><th>Action</th><th>Tool</th><th>Query or page</th><th>Why the agent chose it</th><th>Result</th></tr></thead>
    <tbody>{detail.log.length ? detail.log.map((row, index) => <tr key={index}>
      <td>{row.step}</td><td>{row.action.replace("_", " ")}{row.category && <span className="note">{row.category}</span>}</td><td>{row.tool ? TOOLS[row.tool as ToolId]?.label ?? row.tool : "–"}</td>
      <td>{row.target ? <span className="url">{row.target}</span> : "–"}</td><td>{row.reason}</td>
      <td>{row.outcome !== "ok" && <span className={`status-badge ${row.outcome === "failed" || row.outcome === "invalid" ? "tone-failed" : "tone-warning"}`}>{row.outcome}</span>} {row.result}</td>
    </tr>) : <tr><td colSpan={6} className="empty">The agent recorded no steps.</td></tr>}</tbody>
  </table></div>;
}

/** What happened: the run, how it ended, and its limits, stages and categories. A stage or category filters the pages. */
function WhatHappened({ detail, filters, setFilters }: { detail: Detail; filters: PageFilters; setFilters: (filters: PageFilters) => void }) {
  const top = Math.max(1, detail.stages[0]?.count ?? 1);
  return <section className="panel">
    <div className="section-heading">
      <div><p className="eyebrow">Run {detail.run.number ?? ""} · {detail.run.location_name} · {when(detail.run.created_at)} · {minutes(detail.run)}{detail.run.by ? ` · started by ${detail.run.by}` : ""}</p><h2>What happened</h2></div>
      <span className={`status-badge ending-badge tone-${detail.ending.tone}`}>{detail.ending.text}</span>
    </div>
    {!detail.run.recorded && <p className="notice">Older run: these are its defaults.</p>}
    <details className="summary-acc">
      <summary><span>Limits, stages and categories</span><small>Show the run&rsquo;s charts</small></summary>
      <h3>Limits</h3>
      <Meters limits={detail.limits} />
      <h3>Stages</h3>
      <p className="chart-caption">Click a stage to filter pages.</p>
      <ol className="funnel">{detail.stages.map((stage) => <li key={stage.id}>
        <button type="button" aria-pressed={filters.stage === stage.id} onClick={() => setFilters({ ...filters, stage: filters.stage === stage.id ? "" : stage.id })}>{stage.label}<small>{stage.detail}</small></button>
        <div className="stack" style={{ width: `${Math.max(4, stage.count / top * 100)}%` }}>{stage.by_tool.map((item) => <span key={item.tool} title={`${TOOLS[item.tool].label}: ${item.count}`} style={{ width: `${item.count / Math.max(1, stage.count) * 100}%`, background: TOOLS[item.tool].color }} />)}</div>
        <span className="delta">{stage.count} pages</span>
      </li>)}</ol>
      <div className="chart-legend">{TOOL_IDS.map((tool) => <span key={tool}><span className="dot" style={{ background: TOOLS[tool].color }} />{TOOLS[tool].label}</span>)}</div>
      <h3>Categories</h3>
      <div className="coverage">{detail.categories.map((row) => {
        const tone = row.status === "covered" ? "tone-ok" : row.status === "not_found" ? "tone-failed" : "tone-warning";
        return <button key={row.category} type="button" className={tone} aria-pressed={filters.category === row.category} onClick={() => setFilters({ ...filters, category: filters.category === row.category ? "" : row.category })}>
          <strong>{row.label}</strong>
          <span className={`status-badge ${tone}`}>{row.status === "covered" ? "Covered" : row.status === "not_found" ? "Not found" : "Still open"}</span>
          <small>{row.accepted_by_gemini ? `${row.accepted_by_gemini} accepted by the model check` : row.note ?? "Nothing accepted yet"}{row.accepted_by_you ? ` · ${row.accepted_by_you} by you` : ""}</small>
        </button>;
      })}</div>
    </details>
  </section>;
}

const TONE: Record<Cell["status"], string> = { open: "tone-ok", dry: "tone-warning", unavailable: "tone-failed" };
const STATUS: Record<Cell["status"], string> = { open: "Open", dry: "Dry", unavailable: "Unavailable" };

/** Cumulative hits against searches, one line per tool, so it shows where each tool flattens. */
function YieldCurve({ curves }: { curves: GridDetail["curves"] }) {
  const width = 520, height = 200, pad = { left: 36, right: 12, top: 12, bottom: 30 };
  const most = Math.max(1, ...GRID_TOOLS.map((tool) => curves[tool].length));
  const top = Math.max(1, ...GRID_TOOLS.map((tool) => curves[tool].at(-1)?.hits ?? 0));
  const x = (n: number) => pad.left + (n / most) * (width - pad.left - pad.right);
  const y = (n: number) => height - pad.bottom - (n / top) * (height - pad.top - pad.bottom);
  const ticks = [...new Set([0, Math.round(top / 2), top])];
  return <figure className="yield-curve">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Cumulative hits against searches, by tool">
      {ticks.map((tick) => <g key={tick}><line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} className="grid-line" /><text x={pad.left - 6} y={y(tick) + 4} textAnchor="end">{tick}</text></g>)}
      <text x={x(most)} y={height - 8} textAnchor="end">{most} searches</text>
      <text x={pad.left} y={height - 8}>0</text>
      {GRID_TOOLS.map((tool) => curves[tool].length ? <polyline key={tool} fill="none" stroke={TOOLS[tool].color} strokeWidth={2.5}
        points={[`${x(0)},${y(0)}`, ...curves[tool].map((point) => `${x(point.searches)},${y(point.hits)}`)].join(" ")}><title>{`${TOOLS[tool].label}: ${curves[tool].at(-1)!.hits} hits in ${curves[tool].length} searches`}</title></polyline> : null)}
    </svg>
    <figcaption className="chart-legend">{GRID_TOOLS.map((tool) => <span key={tool}><span className="dot" style={{ background: TOOLS[tool].color }} />{TOOLS[tool].label}: {curves[tool].at(-1)?.hits ?? 0} hits in {curves[tool].length} searches</span>)}</figcaption>
  </figure>;
}

const RESULT_TONE: Record<AngleRow["results"][GridTool], string> = { hit: "tone-ok", miss: "tone-warning", waiting: "tone-running", "not yet": "" };

/** The agent's categories and the sections they are filed under. */
const TOPIC_SECTION: Record<string, string> = { crime: "safety", deaths: "obituaries", government: "civic", home_sales: "real_estate" };
const categoryLabel = (category: string) => SECTION_LABELS[TOPIC_SECTION[category] ?? category] ?? category;

/** Each category's angles in the order the agent picked them, why, and which tools hit on each. Every tool runs the same angles. */
function AngleSequences({ rows, cells }: { rows: GridDetail["angles"]; cells: Cell[] }) {
  return <>
    <h3>Angles</h3>
    <p className="chart-caption">Each search takes an angle. The first in every category is the anchor; after it the agent picks the next angle, says why, and every tool runs it in its own phrasing.</p>
    {rows.map((row) => <details key={row.category} open={row.angles.length > 0}>
      <summary>{row.label} <span className="count">{row.angles.length} {row.angles.length === 1 ? "angle" : "angles"}</span></summary>
      {row.angles.length ? <div className="table-wrap"><table className="angle-sequence">
        <thead><tr><th>#</th><th>Angle</th><th>Why</th>{GRID_TOOLS.map((tool) => <th key={tool}><span className="dot" style={{ background: TOOLS[tool].color }} />{TOOLS[tool].label}</th>)}</tr></thead>
        <tbody>{row.angles.map((angle, index) => <tr key={angle.family}>
          <td>{index + 1}</td><th scope="row">{angle.label}</th>
          <td>{angle.family === "anchor" ? "Always first: the place and the category's main term" : angle.reason || "No reason given"}<span className="note">Picked at step {angle.step}, with {TOOLS[angle.tool].label}</span></td>
          {GRID_TOOLS.map((tool) => <td key={tool} title={angle.queries[tool] ?? undefined}>{angle.results[tool] === "not yet" ? <span className="note">Not yet</span> : <span className={`status-badge ${RESULT_TONE[angle.results[tool]]}`}>{angle.results[tool] === "hit" ? "Hit" : angle.results[tool] === "miss" ? "Miss" : "Waiting"}</span>}{angle.queries[tool] && <span className="note">{angle.queries[tool]}</span>}{angle.elsewhere?.[tool]?.length ? <span className="note">Also a hit for {angle.elsewhere[tool]!.map(categoryLabel).join(", ")}</span> : null}</td>)}
        </tr>)}</tbody>
      </table></div> : <p className="note">No angle tried yet.</p>}
      {cells.filter((cell) => cell.category === row.category && Object.keys(cell.found_elsewhere ?? {}).length).map((cell) => <p key={cell.tool} className="note">{TOOLS[cell.tool].label}: {Object.entries(cell.found_elsewhere).map(([searched, count]) => `${count} ${count === 1 ? "hit" : "hits"} found while searching ${categoryLabel(searched)}`).join(", ")}</p>)}
    </details>)}
  </>;
}

/** An exhaustive run: each category with each search tool, how many searches and hits, and when and why a cell stopped. */
function SearchGrid({ grid, ending }: { grid: GridDetail; ending: Detail["ending"] }) {
  const share = (value: number | null | undefined) => value !== null && value !== undefined ? ` · share ${value}` : grid.fixture ? " · no share: the local fixture has no cap" : "";
  const cell = (category: string, tool: GridTool) => grid.cells.find((item) => item.category === category && item.tool === tool);
  return <section className="panel">
    <div className="section-heading"><div>
      <p className="eyebrow">Exhaustive search</p><h2>Search grid</h2>
      <p>A hit is a source the model check accepted on a site new to this run, credited to the category it is filed under. A cell goes dry after {grid.cell_dry} searches in a row with no hit ({grid.cell_dry_dork ?? grid.cell_dry} for Dorking); the run stops when every cell is dry or unavailable. Each tool searches in rounds: no cell takes another turn until every open cell of its tool has had its share of turns so far.{grid.rounds ? ` ${grid.rounds} ${grid.rounds === 1 ? "round" : "rounds"} finished.` : ""}</p>
    </div><span className={`status-badge ending-badge tone-${ending.tone}`}>{ending.text}</span></div>
    <div className="table-wrap"><table className="search-grid">
      <thead><tr><th>Category</th>{GRID_TOOLS.map((tool) => <th key={tool}><span className="dot" style={{ background: TOOLS[tool].color }} />{TOOLS[tool].label}</th>)}</tr></thead>
      <tbody>{grid.categories.map((row) => <tr key={row.category}>
        <th scope="row">{row.label}{row.dry && <span className="note">Dry</span>}</th>
        {GRID_TOOLS.map((tool) => {
          const item = cell(row.category, tool);
          if (!item) return <td key={tool}>–</td>;
          return <td key={tool} className={TONE[item.status]}>
            <span className={`status-badge ${TONE[item.status]}`}>{STATUS[item.status]}</span>
            <span className="cell-counts">{item.searches} {item.searches === 1 ? "search" : "searches"} · {item.hits} {item.hits === 1 ? "hit" : "hits"}</span>
            {item.searches > 0 && <span className="note">{item.new_sites} new sites · {item.overlap} overlap{item.rejected ? ` · ${item.rejected} rejected` : ""}{item.pending ? ` · ${item.pending} waiting for a verdict` : ""}{item.status === "open" ? ` · ${item.dry_streak} ${item.dry_streak === 1 ? "miss" : "misses"} in a row` : ""}</span>}
            {item.status !== "open" && <span className="note">{item.since ? `${when(item.since)}${item.at_step ? `, step ${item.at_step}` : ""}: ` : ""}{item.why}</span>}
            {item.angles?.length > 0 && <span className="note">Angles: {item.angles.map((family) => family.replace(/_/g, " ")).join(", ")}</span>}
            {item.round !== undefined && <span className="note">{item.status === "open" ? `Round ${item.round}` : `${item.searches} ${item.searches === 1 ? "round" : "rounds"}`}{share(item.share)}{item.status === "open" && item.waiting ? " · waiting for its turn" : ""}{item.dry_after ? ` · dry after ${item.dry_after}` : ""}</span>}
            {item.last_refused && <span className="note warn">Missed: query refused, {item.last_refused}{item.refused > 1 ? ` (${item.refused} refused turns)` : ""}</span>}
            {Object.keys(item.found_elsewhere ?? {}).length > 0 && <span className="note">{Object.entries(item.found_elsewhere).map(([searched, count]) => `${count} found while searching ${categoryLabel(searched)}`).join(", ")}</span>}
          </td>;
        })}
      </tr>)}</tbody>
    </table></div>
    <p className="chart-caption">{grid.hits} hits in all{grid.uncredited ? `, ${grid.uncredited} of them from pages the agent proposed without a search` : ""}. {grid.open ? `${grid.open} cells still open.` : "No cell is still open."}</p>
    {grid.angles.length > 0 && <AngleSequences rows={grid.angles} cells={grid.cells} />}
    <h3>Yield curve</h3>
    <p className="chart-caption">Hits so far against searches, by tool: where a line flattens, that tool has stopped finding new sites.</p>
    <YieldCurve curves={grid.curves} />
  </section>;
}

/** Two source runs side by side, by category and by page: what each found, what was accepted, and what only one of them found. */
function CompareRuns({ base, detail, runs }: { base: string; detail: Detail; runs: RunItem[] }) {
  const others = runs.filter((run) => run.run_id !== detail.run.id);
  const [otherId, setOtherId] = useState(others[0]?.run_id ?? "");
  const [other, setOther] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setOther(null);
    if (!otherId) return;
    mapApi<Detail>(`${base}/source-runs/${encodeURIComponent(otherId)}`).then(setOther).catch((cause: unknown) => setError(message(cause)));
  }, [base, otherId]);
  if (!others.length) return <p>No other source run to compare with yet.</p>;
  // A person's decision wins; otherwise the model check's verdict.
  const accepted = (row: PageRow) => row.decision?.decision ? row.decision.decision === "accept" : row.gemini?.verdict === "accept";
  const label = (category: string | null) => category ? SECTION_LABELS[category] ?? category : "No category";
  const mine = new Map(detail.pages.map((row) => [row.key, row]));
  const theirs = new Map((other?.pages ?? []).map((row) => [row.key, row]));
  const categories = [...new Set([...detail.pages, ...(other?.pages ?? [])].map((row) => label(row.category)))].sort();
  const count = (rows: PageRow[], category: string) => { const shown = rows.filter((row) => label(row.category) === category); return `${shown.length} · ${shown.filter(accepted).length} accepted`; };
  const onlyMine = detail.pages.filter((row) => accepted(row) && !theirs.has(row.key));
  const onlyTheirs = (other?.pages ?? []).filter((row) => accepted(row) && !mine.has(row.key));
  const otherRun = others.find((run) => run.run_id === otherId);
  return <>
    <label className="field">Compare with<select value={otherId} onChange={(event) => setOtherId(event.target.value)}>{others.map((run) => <option key={run.run_id} value={run.run_id}>{runLabel(run)}</option>)}</select></label>
    {error && <p className="alert" role="alert">{error}</p>}
    {!other ? <p role="status">Loading the other run…</p> : <>
      <div className="table-wrap"><table><caption>Pages found, and how many were accepted, by category</caption>
        <thead><tr><th>Category</th><th>This run (Run {detail.run.number ?? "?"})</th><th>Run {otherRun?.number ?? "?"}</th></tr></thead>
        <tbody>{categories.map((category) => <tr key={category}><td>{category}</td><td>{count(detail.pages, category)}</td><td>{count(other.pages, category)}</td></tr>)}</tbody>
      </table></div>
      <div className="compare-lists">
        {[[`Accepted only in this run (${onlyMine.length})`, onlyMine], [`Accepted only in Run ${otherRun?.number ?? "?"} (${onlyTheirs.length})`, onlyTheirs]].map(([title, rows]) => <div key={String(title)}>
          <h3>{String(title)}</h3>
          {(rows as PageRow[]).length ? <ul>{(rows as PageRow[]).slice(0, 30).map((row) => <li key={row.key}><a href={row.url} target="_blank" rel="noopener noreferrer">{row.name ?? short(row.url)}</a> <small>{label(row.category)} · {TOOLS[row.tool]?.label ?? row.tool}</small></li>)}</ul> : <p>None.</p>}
        </div>)}
      </div>
    </>}
  </>;
}

/**
 * Collect sources: start a source map run with chosen services, or read what a past run did, page by page.
 * Editing (starting runs and recording decisions) happens only in a location's workspace, which passes
 * `canEdit`; the Source map page shows the same runs read-only, with a link to that workspace.
 */
export default function SourceRuns({ locationId, runId, canEdit, locations, routeFor, editHref }: {
  locationId: string; runId: string | null; canEdit: boolean; locations: Array<{ id: string; name: string }>;
  /** Where a location and run live; the workspace keeps its own location. */
  routeFor?: (location: string, run?: string | null) => string;
  /** Read-only: where to go to start runs and record decisions. */
  editHref?: string | null;
}) {
  const router = useRouter();
  const [list, setList] = useState<{ runs: RunItem[]; completed: number } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [settings, setSettings] = useState<RunSettings>(DEFAULT_SETTINGS);
  const [rebuild, setRebuild] = useState(true);
  const [filters, setFilters] = useState<PageFilters>({});
  const [view, setView] = useState<"tools" | "log" | "compare">("tools");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const path = routeFor ?? ((location: string, run?: string | null) => `/source-map?${new URLSearchParams({ ...(location ? { location } : {}), tab: "runs", ...(run ? { run } : {}) })}`);
  const base = `locations/${encodeURIComponent(locationId)}`;
  useEffect(() => {
    if (!locationId) return;
    mapApi<{ runs: RunItem[]; completed: number }>(`${base}/source-runs`).then(setList).catch((cause: unknown) => setError(message(cause)));
  }, [base, locationId, runId]);
  useEffect(() => {
    if (!canEdit) return;
    adminApi<Info>("run-options").then(setInfo).catch((cause: unknown) => setError(message(cause)));
  }, [canEdit]);
  const load = useCallback(async () => {
    if (!locationId || !runId) return;
    try { setDetail(await mapApi<Detail>(`${base}/source-runs/${encodeURIComponent(runId)}`)); setError(""); } catch (cause) { setError(message(cause)); }
  }, [base, locationId, runId]);
  useEffect(() => {
    setDetail(null); setFilters({});
    void load();
  }, [load]);
  // A run still mapping updates as it goes.
  useEffect(() => {
    if (detail?.run.status !== "mapping") return;
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => clearInterval(timer);
  }, [detail?.run.status, load]);

  async function start() {
    if (!info) return;
    setStarting(true); setError("");
    try {
      const result = await adminApi<{ run_id: string; started: boolean }>(`${base}/map-run`, { method: "POST", body: JSON.stringify({ options: choicesFor(settings, info.defaults), rebuild }) });
      if (!result.started) setError("A run is already going. It’s open below.");
      router.push(path(locationId, result.run_id));
    } catch (cause) { setError(message(cause)); } finally { setStarting(false); }
  }
  const saved = useCallback((key: string, change: { status: string; review: Review }) => {
    setDetail((current) => current && { ...current, pages: current.pages.map((row) => row.key !== key ? row : { ...row, status: change.status, decision: { decision: change.review.decision, reason_code: change.review.reason_code ?? null, reason: change.review.reason },
      disagrees: Boolean(change.review.decision && row.gemini?.verdict && change.review.decision !== row.gemini.verdict) }) });
  }, []);
  async function bulk(ids: string[], decision: "accept" | "reject", code: string, reason: string) {
    try {
      // A test-mode run's decisions are kept by page; any other run's go on the source map.
      const path = detail?.run.isolated ? `${base}/source-runs/${encodeURIComponent(detail.run.id)}/decisions` : `${base}/source-map/reviews`;
      const result = await adminApi<{ saved: unknown[]; failed: Array<{ source_id: string; detail: string }> }>(path, { method: "POST", body: JSON.stringify({ source_ids: ids, decision, reason_code: code, ...(isOtherReason(code) && reason.trim() ? { reason } : {}) }) });
      await load();
      return result.failed.length ? `Saved ${result.saved.length}; ${result.failed.length} not saved: ${result.failed.map((item) => item.detail).slice(0, 3).join("; ")}` : null;
    } catch (cause) { return `Not saved: ${message(cause)}`; }
  }

  const isNew = !runId;
  return <div className="source-runs">
    <section className="panel workspace-toolbar">
      {!routeFor && <label className="field">Location<select value={locationId} onChange={(event) => router.push(path(event.target.value))}>
        <option value="">Choose a location</option>{locations.map((location) => <option value={location.id} key={location.id}>{location.name}</option>)}
      </select></label>}
      <label className="field">Run<select value={runId ?? "new"} disabled={!locationId} onChange={(event) => router.push(path(locationId, event.target.value === "new" ? null : event.target.value))}>
        <option value="new">+ New run</option>
        {(list?.runs ?? []).map((run) => <option key={run.run_id} value={run.run_id}>{runLabel(run)}</option>)}
      </select></label>
      <div className="toolbar-end">
        {isNew ? canEdit ? <button type="button" disabled={!locationId || !info || starting} onClick={() => void start()}>{starting ? "Starting…" : "Start collecting sources"}</button>
            : editHref && locationId ? <a className="button" href={editHref}>Start a run in the workspace</a> : null
          : list && <span className="status-badge tone-ok">{list.completed} {list.completed === 1 ? "run" : "runs"} completed</span>}
        {!isNew && !canEdit && editHref && locationId && <a className="button secondary" href={editHref}>Review in the workspace</a>}
      </div>
    </section>
    {error && <p className="alert" role="alert">{error}</p>}
    {runId && canEdit && <LiveSourceRun key={runId} runId={runId} />}
    {!locationId ? <section className="panel"><h2>Choose a location above to start or review its collection runs</h2></section> : isNew ? <>
      {!canEdit && <p className="notice">Read-only. Edit in the location&rsquo;s workspace.</p>}
      <SettingsPanel settings={settings} onChange={canEdit ? setSettings : undefined} info={info} rebuild={rebuild} onRebuild={setRebuild} isolated={info?.isolated ?? false} />
    </> : !detail ? <p role="status">Loading the run…</p> : <>
      <SettingsPanel settings={detail.settings} isolated={detail.run.isolated} />
      <WhatHappened detail={detail} filters={filters} setFilters={setFilters} />
      {detail.grid && <SearchGrid grid={detail.grid} ending={detail.ending} />}
      <section className="panel">
        <nav className="tabs trace-tabs" aria-label="Run details">
          <button type="button" aria-pressed={view === "tools"} onClick={() => setView("tools")}>By tool</button>
          <button type="button" aria-pressed={view === "log"} onClick={() => setView("log")}>Agent log</button>
          <button type="button" aria-pressed={view === "compare"} onClick={() => setView("compare")}>Compare runs</button>
        </nav>
        {view === "tools" && <ByTool detail={detail} />}
        {view === "log" && <AgentLog detail={detail} />}
        {view === "compare" && <CompareRuns base={base} detail={detail} runs={list?.runs ?? []} />}
      </section>
      <section className="panel" aria-label="Sources inventory">
        <h2>Sources inventory</h2>
        <p className="chart-caption">Pages found in this source run, including rejected and unsaved pages. Review saved addresses in <a href={`/locations/${encodeURIComponent(locationId)}?tab=sources`}>All sources</a>.</p>
        <EveryPage key={detail.run.id} detail={detail} canEdit={canEdit} filters={filters} setFilters={setFilters} onSaved={saved} onBulk={bulk} />
      </section>
    </>}
  </div>;
}
