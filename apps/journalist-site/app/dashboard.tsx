"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { adminApi as api } from "@/lib/admin-client";
import LocationOnboarding from "./location-onboarding";
import RunOptionsPanel from "./components/run-options-panel";
import type { RunOptions } from "@/pipeline/core/run-values";
import { ExecutionNotice, RunExecutionSummary, useExecutionPolicy, executionDisabledReason } from "./components/execution-policy";
import ExplainedButton from "./components/explained-button";
import type { ExecutionBinding } from "@/pipeline/accounts/execution";
import PipelineApprovals from "./components/pipeline-approvals";

type System = { fscskey: string; name: string; website: string | null };
type Government = { status?: string; platform?: string | null; tenant?: string | null };
type Location = { id: string; name: string; systems: System[]; government: Government | null; source_coverage?: { status: "ready" | "partial" | "no_local_sources"; area: string; gaps: string[] } };
type RunIssue = { code: string; severity: "info" | "warning" | "failed"; message: string };
type Diagnostics = { deadline_at: number | null; overdue: boolean; issues: RunIssue[] };
type LocationHealth = {
  location_id: string;
  location_name: string;
  level: "ok" | "warning" | "failed" | "idle";
  run_id: string | null;
  stage: string;
  started_at: number | null;
  sources: { total: number; completed: number; failed: number; pending: number };
  failed_sources: { source_id: string; name: string; error: string | null }[];
  candidate_count: number;
  published_items: number | null;
  held: number | null;
  held_reasons: Record<string, number>;
  model_errors: string[];
  error: string | null;
  diagnostics: Diagnostics | null;
};
type Health = {
  scheduler: { seconds_since_tick: number | null; status: string; issues: { channel: string; at: number; message: string }[] };
  run_timeout_seconds: number | null;
  queue: Record<string, number>;
  model: { provider: string | null; name: string | null; status: string; detail?: string; providers?: Array<{ name: string; model: string | null; status: string }> } | null;
  status: string;
  totals: Record<string, number>;
  locations: LocationHealth[];
};
type RunSource = { source_id: string; job_id: string | null; name: string; status: string; result_status: string | null; detail: string | null; event_count: number; shortlisted: number; error: string | null };
type Story = { story_id: string; source_id: string; tier: string; disposition: string; title: string | null; reasons: string[]; rank?: number | null; why?: string | null };
type Job = { id: string; kind: string; status: string; attempts: number; error: string | null; log_file?: string | null; log_error?: string | null; dispatch_error?: string | null; dispatch_error_at?: number | null; dispatched_at?: number | null };
type Run = { _id: string; kind?: string; execution?: ExecutionBinding; location_id: string; location_name: string; status: string; created_at: number; completed_at: number | null; trigger: { by: string; kind: string }; published: { items: number; held: number } | null; error?: string | null; diagnostics?: Diagnostics | null; stage_transitions?: { status: string }[] };
type RunDetail = {
  funding?: { funding: "personal" | "admin"; provider: string; model: string; reason: string | null; ok: boolean; at: number }[];
  run: Run & { draft_id: string | null; window: [string, string]; sources: RunSource[]; error: string | null };
  health: LocationHealth;
  stories: Story[];
  jobs: Job[];
};
type Withdrawal = { story_id: string; reason: string; created_at: number };

const time = (value: number | null) => value ? new Date(value * 1000).toLocaleString() : "—";
const message = (caught: unknown) => caught instanceof Error ? caught.message : String(caught);
const PROCESSING = ["mapping", "collecting", "authoring", "finishing", "publishing"];
const ACTIVE = [...PROCESSING, "awaiting_authoring", "awaiting_finish"];
const CANCELLABLE = ACTIVE.filter((status) => status !== "publishing");
const stageLabel = (status: string, candidates?: number) => status === "awaiting_authoring" ? candidates === 0 ? "Collection finished — no usable items" : "Awaiting editor: start authoring"
  : status === "awaiting_finish" ? "Awaiting editor: write front page and email" : status.replaceAll("_", " ");
const stageIndex = (status: string) => status === "published" ? 3
  : ["awaiting_finish", "finishing", "publishing"].includes(status) ? 2
    : ["awaiting_authoring", "authoring"].includes(status) ? 1 : status === "collecting" ? 0 : -1;
const stalled = (diagnostics: Diagnostics | null | undefined) => Boolean(diagnostics?.issues.some((issue) => issue.severity === "failed"));
/** Badge for a run: active runs that cannot advance show as stalled instead of a running stage. */
function runBadge(status: string, diagnostics: Diagnostics | null | undefined, fallback: string, candidates?: number) {
  if (!PROCESSING.includes(status)) return { tone: ACTIVE.includes(status) ? "idle" : fallback, label: stageLabel(status, candidates) };
  if (stalled(diagnostics)) return { tone: "failed", label: `stalled · ${status}` };
  if (diagnostics?.issues.some((issue) => issue.severity === "warning")) return { tone: "warning", label: `${status} · attention` };
  return { tone: "running", label: status };
}

function RunIssues({ diagnostics, compact = false }: { diagnostics: Diagnostics | null | undefined; compact?: boolean }) {
  const issues = (diagnostics?.issues ?? []).filter((issue) => !compact || issue.severity !== "info");
  if (!issues.length) return null;
  const shown = compact ? issues.slice(0, 2) : issues;
  return <ul className="run-issues" aria-label="Run status details">
    {shown.map((issue, index) => <li key={`${issue.code}-${index}`} className={`run-issue severity-${issue.severity}`}>
      <span className={`status-badge tone-${issue.severity === "failed" ? "failed" : issue.severity === "warning" ? "warning" : "running"}`}>{issue.severity === "info" ? "info" : issue.severity === "failed" ? "blocked" : "warning"}</span> {issue.message}
    </li>)}
    {compact && issues.length > shown.length && <li className="chart-caption">+{issues.length - shown.length} more — inspect the run for details.</li>}
    {!compact && diagnostics?.deadline_at && !diagnostics.overdue && <li className="chart-caption">Automatic timeout at {time(diagnostics.deadline_at)}.</li>}
  </ul>;
}

function formatJobLog(content: string) {
  return content.trimEnd().split("\n").map((line) => {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (!record || typeof record !== "object" || Array.isArray(record)) return line;
      const { time, level, component, event, ...details } = record;
      return [time, level, component, event, Object.keys(details).length ? JSON.stringify(details) : null]
        .filter((part) => part !== null && part !== undefined && part !== "").join("  ");
    } catch {
      return line;
    }
  }).join("\n");
}

function JobLog({ job, source, initiallyOpen, retry, busy }: { job: Job; source?: RunSource; initiallyOpen: boolean; retry?: () => void; busy: boolean }) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  const [content, setContent] = useState<string | null>(null);
  const [logError, setLogError] = useState("");

  useEffect(() => {
    if (!expanded || !job.log_file) return;
    const controller = new AbortController();
    setContent(null);
    setLogError("");
    void fetch(`/api/admin/jobs/${encodeURIComponent(job.id)}/log`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const data = await response.json().catch(() => null) as { detail?: string } | null;
          throw new Error(data?.detail ?? `Log unavailable (${response.status})`);
        }
        return response.text();
      })
      .then(setContent)
      .catch((caught: unknown) => { if (!controller.signal.aborted) setLogError(message(caught)); });
    return () => controller.abort();
  }, [expanded, job.id, job.log_file, job.status, job.attempts]);

  const dispatchError = job.status === "pending" && job.dispatch_error && (job.dispatch_error_at ?? 0) > (job.dispatched_at ?? 0)
    ? `Dispatch failed: ${job.dispatch_error}` : null;
  const errors = [...new Set([job.error, source?.error ?? source?.detail, dispatchError].filter(Boolean))];

  return <details className="job-log-entry" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>
      <span><strong>{source?.name ?? job.kind.replaceAll("_", " ")}</strong> <small>{job.kind.replaceAll("_", " ")} · {job.id}</small></span>
      <span className={`status-badge tone-${job.status === "running" || job.status === "pending" ? "running" : job.status}`}>{job.status}</span>
    </summary>
    <p className="chart-caption">{job.attempts} {job.attempts === 1 ? "attempt" : "attempts"}
      {source && ` · ${source.result_status ?? source.status} · ${source.event_count} items kept`}
    </p>
    {errors.length > 0 && <p className="stage-error">{errors.join("; ")}</p>}
    {retry && <button type="button" className="secondary" disabled={busy} onClick={retry}>
      {job.status === "cancelled" ? "Retry interrupted step" : "Retry failed step only"}
    </button>}
    {job.log_error && <p className="alert">Log save failed: {job.log_error}</p>}
    {logError && <p className="alert" role="alert">{logError}</p>}
    {job.log_file ? content === null && !logError ? <p>Loading log…</p> : content ? <pre className="job-log-content">{formatJobLog(content)}</pre> : !logError && <p className="chart-caption">No log entries recorded.</p>
      : <p className="chart-caption">{job.status === "pending" ? "Waiting to start." : job.status === "running" ? "Log will be available after this attempt finishes." : "No log recorded for this job."}</p>}
  </details>;
}

export default function Dashboard({ locationId, owner = false }: { locationId?: string; owner?: boolean }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [recent, setRecent] = useState<Run[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [runOptions, setRunOptions] = useState<RunOptions | null>(null);
  const [runOptionsError, setRunOptionsError] = useState("");
  const { policy, error: policyError, refresh: refreshPolicy } = useExecutionPolicy(runOptions);
  const canSpend = (runId: string) => Boolean(policy?.permissions[runId]?.canSpend);

  const load = useCallback(async () => {
    try {
      const [healthData, locationData, runsData] = await Promise.all([
        api<Health>("health"),
        api<{ locations: Location[] }>("locations"),
        api<{ runs: Run[] }>(locationId ? `runs?location=${encodeURIComponent(locationId)}&limit=30` : "runs?limit=30"),
      ]);
      setHealth(healthData);
      setLocations(locationData.locations);
      setRecent(runsData.runs);
      setError("");
    } catch (caught) {
      setError(message(caught));
    }
  }, [locationId]);

  const openRun = useCallback(async (runId: string, locationId: string) => {
    try {
      const [run, withdrawn] = await Promise.all([
        api<RunDetail>(`runs/${encodeURIComponent(runId)}`),
        api<{ withdrawals: Withdrawal[] }>(`withdrawals?location=${encodeURIComponent(locationId)}`),
      ]);
      setDetail(run);
      setWithdrawals(withdrawn.withdrawals);
      window.history.replaceState(window.history.state, "", `/locations/${encodeURIComponent(locationId)}?tab=runs&run=${encodeURIComponent(runId)}`);
    } catch (caught) {
      setError(message(caught));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const runId = params.get("run");
    if (runId && locationId) void openRun(runId, locationId);
  }, [openRun, locationId]);

  useEffect(() => {
    if (!locationId) return;
    const inspect = (event: Event) => {
      const runId = (event as CustomEvent<{ runId: string }>).detail.runId;
      void openRun(runId, locationId).then(() => document.getElementById("run-inspector")?.scrollIntoView({ block: "start" }));
    };
    window.addEventListener("newsbee:inspect-run", inspect);
    return () => window.removeEventListener("newsbee:inspect-run", inspect);
  }, [locationId, openRun]);

  useEffect(() => {
    if (detail && window.location.search.includes("run=")) {
      document.getElementById("run-inspector")?.scrollIntoView({ block: "start" });
    }
  }, [detail?.run._id]);

  useEffect(() => {
    if (!detail || !ACTIVE.includes(detail.run.status)) return;
    const timer = window.setInterval(() => void openRun(detail.run._id, detail.run.location_id), 10000);
    return () => window.clearInterval(timer);
  }, [detail?.run._id, detail?.run.location_id, detail?.run.status, openRun]);

  async function act(label: string, action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(label);
      await load();
      window.dispatchEvent(new Event("newsbee:runs-changed"));
      if (detail) await openRun(detail.run._id, detail.run.location_id);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  function stageAction(runId: string, status: string, candidates: number) {
    const action = status === "awaiting_authoring" ? "authoring" : status === "awaiting_finish" ? "finish" : PROCESSING.includes(status) ? "resume" : null;
    if (!action) return null;
    const label = action === "authoring" ? "Start authoring" : action === "finish" ? "Write front page and email, then publish" : "Resume";
    return <ExplainedButton className="secondary" disabledReason={busy ? "Another action is in progress." : executionDisabledReason(policy, policyError, "spend", runId) ?? (action === "authoring" && candidates === 0 ? "No usable items collected. Review sources and retry collection." : null)}
      onClick={() => void act(`${label}: processing kicked off.`, () => api(`runs/${encodeURIComponent(runId)}/${action}`, { method: "POST" }))}>{label}</ExplainedButton>;
  }

  function cancelSelected(run: { _id: string; location_name: string }) {
    if (!window.confirm(`Cancel the run for ${run.location_name}? Queued jobs will be stopped.`)) return;
    void act(`Cancelled ${run.location_name}.`, () => api(`runs/${encodeURIComponent(run._id)}/cancel`, { method: "POST" }));
  }

  async function restartSelected(run: Pick<Run, "_id" | "location_id" | "location_name">, retryCollection = false) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (retryCollection) await api(`runs/${encodeURIComponent(run._id)}/cancel`, { method: "POST" });
      const result = await api<{ run_id: string }>(`runs/${encodeURIComponent(run._id)}/restart`, { method: "POST" });
      setNotice(`New run started for ${run.location_name}.`);
      await load();
      window.dispatchEvent(new Event("newsbee:runs-changed"));
      await openRun(result.run_id, run.location_id);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  function withdrawStory(story: Story) {
    if (!detail?.run.draft_id) return;
    const reason = window.prompt("Public correction reason (10–500 characters)");
    if (!reason) return;
    void act("Story withdrawn and edition republished.", () => api("withdrawals", {
      method: "POST",
      body: JSON.stringify({ edition_id: detail.run.draft_id, story_id: story.story_id, reason }),
    }));
  }

  function canRetryStep(job: Job) {
    if (!detail || !["failed", "cancelled"].includes(job.status)) return false;
    const stage = ["discover", "agent_round", "plan_sources", "collect_source"].includes(job.kind) ? "collecting" : job.kind === "author_finish" ? "finishing" : "authoring";
    if (detail.run.status === "failed") {
      const last = detail.run.stage_transitions?.filter((transition) => PROCESSING.includes(transition.status)).at(-1)?.status;
      return (last === "publishing" ? "finishing" : last) === stage;
    }
    return detail.run.status === stage || (stage === "collecting" && detail.run.status === "awaiting_authoring");
  }

  function emptyCollection(run: Pick<Run, "_id" | "location_id" | "location_name">, status: string, candidates: number) {
    if (status !== "awaiting_authoring" || candidates !== 0) return null;
    const coverage = locations.find((location) => location.id === run.location_id)?.source_coverage;
    return <div className="notice" role="status">
      <strong>No usable items collected.</strong> Review source gaps before trying collection again. Authoring needs at least one retained item.
      {coverage?.gaps.length ? <ul>{coverage.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul> : null}
      <div className="card-actions">
        <a href={`/locations/${encodeURIComponent(run.location_id)}?tab=sources`}>Review sources</a>
        <button className="secondary" disabled={busy || !canSpend(run._id)} onClick={() => void restartSelected(run, true)}>Retry collection</button>
      </div>
    </div>;
  }

  const defaultLogId = detail?.jobs.findLast((job) => !!job.log_file)?.id ?? detail?.jobs[0]?.id;

  return (
    <>
      <ExecutionNotice policy={policy} error={policyError} runId={detail?.run._id} refresh={refreshPolicy} />
      {error && <p className="alert" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {health && health.scheduler.status !== "ok" && (health.queue.pending ?? 0) > 0 && (health.queue.running ?? 0) === 0 && <p className="alert" role="alert">
        No pipeline worker has run recently ({health.scheduler.seconds_since_tick === null ? "no call recorded" : `last call ${Math.round(health.scheduler.seconds_since_tick / 60)} min ago`}) and {health.queue.pending} job(s) are waiting.
        Use Resume on the current stage to restart processing.
        {health.run_timeout_seconds ? ` In-progress stages time out after ${Math.round(health.run_timeout_seconds / 60)} min; editor waiting time is excluded.` : ""}
      </p>}
      {health && health.scheduler.issues.length > 0 && <div className="alert" role="alert">
        <strong>Pipeline dispatch problems</strong>
        <ul>{health.scheduler.issues.map((issue) => <li key={issue.channel}>{issue.message} <span className="chart-caption">({time(issue.at)})</span></li>)}</ul>
      </div>}

       {!locationId && <LocationOnboarding busy={busy} enrolled={locations.map((location) => location.id)}
         onAdd={(place) => act(`Added ${place.name}. Its sources are discovered on the first run.`, () => api("locations", {
          method: "POST", body: JSON.stringify({ place_id: place.id }),
        }))} />}

      <section className="panel">
        <div className="section-heading">
            <div><h2>{locationId ? "Pipeline" : "Locations & runs"}</h2><p>Refresh updates sources. Create edition uses the saved source map.</p></div>
           {!locationId && <button disabled
             onClick={() => void act("Started an edition for every location with a source map.", () => api("ingestion", { method: "POST", body: JSON.stringify({ options: runOptions }) }))}>
             Batch runs disabled: one unfinished run per newsroom
           </button>}
        </div>
        <h3>New run options</h3><p className="chart-caption">Applies to new runs only; existing purpose, sponsor and approval stay unchanged.</p>
        <RunOptionsPanel onChange={setRunOptions} onError={setRunOptionsError} />
        <div className="operations-toolbar"><span>{health?.queue.running ?? 0} jobs running / {health?.queue.pending ?? 0} waiting</span><Link href="/dashboard">Dashboard &rarr;</Link></div>
         <div className="location-run-list">
           {health?.locations.filter((row) => !locationId || row.location_id === locationId).map((row) => {
            const running = ACTIVE.includes(row.stage);
            const badge = runBadge(row.stage, row.diagnostics, row.level, row.candidate_count);
            const coverage = locations.find((location) => location.id === row.location_id)?.source_coverage;
            return <article className="run-card" key={row.location_id}>
              <div className="section-heading"><h3><Link href={`/locations/${encodeURIComponent(row.location_id)}`}>{row.location_name}</Link></h3><span className={`status-badge tone-${badge.tone}`}>{badge.label}</span></div>
              <RunExecutionSummary run={recent.find((run) => run._id === row.run_id)} />
              <ol className="pipeline-steps" aria-label={`${row.location_name} pipeline`}>
                 {["Discover & collect", "Assemble, rank & write", "Front page & email"].map((step, index) => {
                  const stage = stageIndex(row.stage);
                  return <li key={step} className={stage > index ? "complete" : stage === index ? "current" : ""} aria-current={stage === index ? "step" : undefined}>{step}</li>;
                })}
              </ol>
              <div className="run-counts"><span><strong>{row.sources.completed}/{row.sources.total}</strong> sources completed</span><span><strong>{row.candidate_count}</strong> candidates</span><span><strong>{row.published_items ?? "-"}</strong> published</span><span><strong>{row.held ?? "-"}</strong> held</span></div>
              {row.run_id && emptyCollection({ _id: row.run_id, location_id: row.location_id, location_name: row.location_name }, row.stage, row.candidate_count)}
              <p className="chart-caption">Last started: {time(row.started_at)}</p>
              {coverage && <details className="location-settings"><summary>Location resolved / sources {coverage.status.replaceAll("_", " ")}</summary>
                   <p>{coverage.area}</p><ul>{coverage.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul><a href={`/locations/${encodeURIComponent(row.location_id)}?tab=sources`}>Review the source map</a>
                </details>}
              {running && <RunIssues diagnostics={row.diagnostics} compact />}
              {(row.error || row.failed_sources.length > 0 || row.model_errors.length > 0) && <p className="stage-error">
                {[row.error, ...row.model_errors, ...row.failed_sources.map((source) => `${source.name}: ${source.error ?? "failed"}`)].filter(Boolean).join("; ")}
              </p>}
              <div className="card-actions">
                  <ExplainedButton className="secondary" disabledReason={busy ? "Another action is in progress." : runOptionsError || executionDisabledReason(policy, policyError, "map") || (!runOptions ? "Loading run options." : running ? "This location already has an unfinished run. Inspect it before refreshing sources." : null)}
                    onClick={() => void act(`Refreshing the source map for ${row.location_name}.`, () =>
                      api(`locations/${encodeURIComponent(row.location_id)}/map-run`, { method: "POST", body: JSON.stringify({ options: runOptions, rebuild: true }) }))}>Refresh source map</ExplainedButton>
                  <ExplainedButton disabledReason={busy ? "Another action is in progress." : runOptionsError || executionDisabledReason(policy, policyError, "edition") || (!runOptions ? "Loading run options." : running ? "This location already has an unfinished run. Inspect it before starting new work." : null)}
                    onClick={() => void act(`Started ${row.location_name}.`, () =>
                      api(`locations/${encodeURIComponent(row.location_id)}/ingestion`, { method: "POST", body: JSON.stringify({ options: runOptions }) }))}>{running ? "Run open" : runOptions?.mode === "manual" ? "Start collection" : "Create edition"}</ExplainedButton>
                  {row.run_id && <a className="button secondary" href={`/source-map?${new URLSearchParams({ location: row.location_id, mode: "edition", run: row.run_id })}`}>See the funnel</a>}
                  {row.run_id && stageAction(row.run_id, row.stage, row.candidate_count)}
                   {row.run_id && (locationId
                     ? <button className="secondary" onClick={() => { void openRun(row.run_id!, row.location_id); window.dispatchEvent(new CustomEvent("newsbee:inspect-run", { detail: { runId: row.run_id } })); }}>Inspect run</button>
                     : <Link className="button secondary" href={`/locations/${encodeURIComponent(row.location_id)}?tab=runs&run=${encodeURIComponent(row.run_id)}`}>Inspect run</Link>)}
                  {row.run_id && CANCELLABLE.includes(row.stage) && <button className="secondary" disabled={busy} onClick={() => cancelSelected({ _id: row.run_id!, location_name: row.location_name })}>Cancel run</button>}
                  {row.run_id && !running && <ExplainedButton className="secondary" disabledReason={busy ? "Another action is in progress." : executionDisabledReason(policy, policyError, "restart", row.run_id)} onClick={() => void restartSelected({ _id: row.run_id!, location_id: row.location_id, location_name: row.location_name })}>Restart run</ExplainedButton>}
              </div>
              <PipelineApprovals locationId={row.location_id} kind="map" options={runOptions ? { ...runOptions, rebuild: true } : null} onStarted={async (runId) => { await load(); await openRun(runId, row.location_id); }} />
              <PipelineApprovals locationId={row.location_id} kind="edition" options={runOptions} onStarted={async (runId) => { await load(); await openRun(runId, row.location_id); }} />
              <details className="location-settings"><summary>Location actions</summary><div className="card-actions">
                    <a href={`/locations/${encodeURIComponent(row.location_id)}?tab=sources`}>Source map</a>
                  {owner && <Link href={`/locations/${encodeURIComponent(row.location_id)}?tab=settings#remove-location`}>Remove location and files…</Link>}
              </div></details>
            </article>;
          })}
           {health && !health.locations.length && !locationId && <p>No locations onboarded yet. Add one above to start its pipeline.</p>}
        </div>
      </section>

      {detail && (
         <section className="panel" id="run-inspector">
          <div className="section-heading">
            <h2>{detail.run.location_name} · {stageLabel(detail.run.status, detail.health.candidate_count)} · {detail.run.window.join(" to ")}</h2>
            <div className="card-actions">
              {stageAction(detail.run._id, detail.run.status, detail.health.candidate_count)}
              {CANCELLABLE.includes(detail.run.status) && <button className="secondary" disabled={busy} onClick={() => cancelSelected(detail.run)}>Cancel run</button>}
              {["mapped", "published", "failed", "cancelled"].includes(detail.run.status) && <ExplainedButton className="secondary" disabledReason={busy ? "Another action is in progress." : executionDisabledReason(policy, policyError, "restart", detail.run._id)} onClick={() => void restartSelected(detail.run)}>Restart run</ExplainedButton>}
               <button className="secondary" onClick={() => { setDetail(null); window.history.replaceState(window.history.state, "", `/locations/${encodeURIComponent(detail.run.location_id)}?tab=runs`); }}>Close</button>
            </div>
          </div>
          <RunExecutionSummary run={detail.run} />
          {!detail.funding?.length && <p className="chart-caption">No model funding calls recorded yet.</p>}
          {!!detail.funding?.length && <details className="location-settings"><summary>Recorded funding · {detail.funding.filter((call) => call.funding === "admin").length} Admin / {detail.funding.filter((call) => call.funding !== "admin").length} personal attempts{detail.funding.length === 50 ? " (latest 50)" : ""}</summary><ul>{detail.funding.map((call, index) => <li key={index}><strong>{call.funding === "admin" ? "Admin tokens" : "Personal tokens"}</strong>: {call.provider} / {call.model} / {call.ok ? "served" : "failed"}{call.reason ? ` / ${call.reason}` : ""}</li>)}</ul></details>}
          <ol className="pipeline-steps" aria-label="Run stages">
            {["Collect", "Author", "Front page & email"].map((step, index) => {
              const stage = stageIndex(detail.run.status);
              const active = ACTIVE.includes(detail.run.status);
              return <li key={step} className={stage > index ? "complete" : stage === index ? active ? "current" : detail.run.status === "published" ? "complete" : "stopped" : ""}>{step}</li>;
            })}
          </ol>
          <p className="chart-caption">{detail.run.kind === "map" ? "Source map run · " : ""}Started {time(detail.run.created_at)} · {detail.run.trigger.kind} by {detail.run.trigger.by} · Finished {time(detail.run.completed_at)} · Run ID {detail.run._id}</p>
          {detail.run.error && <p className="alert">{detail.run.error}</p>}
          {ACTIVE.includes(detail.run.status) && detail.health?.diagnostics && detail.health.diagnostics.issues.length > 0 && <>
            <h3>Why this run is {stalled(detail.health.diagnostics) ? "stalled" : "still running"}</h3>
            <RunIssues diagnostics={detail.health.diagnostics} />
          </>}
          {emptyCollection(detail.run, detail.run.status, detail.health.candidate_count)}
          <h3>Run log</h3>
          {detail.run.status === "failed" && <p>Open the failed job and choose <strong>Retry failed step only</strong> to keep completed jobs and authored work. Restart run starts a new collection.</p>}
          <div className="job-log-list">{detail.jobs.map((job) =>
            <JobLog key={job.id} job={job} source={detail.run.sources.find((source) => source.job_id === job.id)}
              initiallyOpen={job.id === defaultLogId} busy={busy}
              retry={canRetryStep(job) && canSpend(detail.run._id) ? () => void act("Retrying only the selected step; completed work is preserved.", () =>
                api(`runs/${encodeURIComponent(detail.run._id)}/jobs/${encodeURIComponent(job.id)}/retry`, { method: "POST" })) : undefined} />
          )}</div>
          {!detail.jobs.length && <p>No work has been queued for this run.</p>}
          <h3>Stories</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Rank</th><th>Title</th><th>Source</th><th>Tier</th><th>Why ranked</th><th>Outcome</th><th>Held because</th><th /></tr></thead>
            <tbody>{detail.stories.map((story) => (
              <tr key={story.story_id}>
                <td>{story.rank ?? "—"}</td><td>{story.title ?? story.story_id}</td><td>{story.source_id}</td><td>{story.tier}</td><td>{story.why ?? "—"}</td>
                <td>{story.disposition}</td><td>{story.reasons.join("; ") || "—"}</td>
                <td>{story.disposition !== "held" && detail.run.status === "published" &&
                  <button className="secondary" disabled={busy} onClick={() => withdrawStory(story)}>Withdraw</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <h3>Withdrawn stories</h3>
          {!withdrawals.length ? <p>None.</p> : <ul>{withdrawals.map((item) => (
            <li key={item.story_id}>
              {item.story_id}: {item.reason}{" "}
              <button className="secondary" disabled={busy}
                onClick={() => void act("Story restored and edition republished.", () => api("withdrawals", {
                  method: "DELETE",
                  body: JSON.stringify({ location_id: detail.run.location_id, story_id: item.story_id }),
                }))}>Restore</button>
            </li>
          ))}</ul>}
        </section>
      )}

    </>
  );
}
