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
import { editionPipelineProgress, sourcePipelineProgress, type RunProgressJob, type RunProgressStage } from "./run-progress";
import { availableMapStages, mapJobIsPast } from "@/pipeline/orchestration/map-stage-availability";

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
type Story = { when_where?: string | null; draft?: { headline: string; summary: string } | null; source_brief?: boolean; sources?: { name: string; url: string | null }[]; story_id: string; source_id: string; tier: string; disposition: string; title: string | null; reasons: string[]; rank?: number | null; why?: string | null; image?: { status: string; reason: string; provider?: string | null } };
type AgentActivity = { pass: number; models: Array<{ role: string; provider: string; model: string }>; steps: number; round: number | null; stage: string | null; last_step: { action: string; tool: string | null; category: string | null; result: string } | null };
type Job = RunProgressJob & { id: string; kind: string; status: string; attempts: number; error: string | null; discovery_label?: string; agent?: AgentActivity; log_file?: string | null; log_error?: string | null; dispatch_error?: string | null; dispatch_error_at?: number | null; dispatched_at?: number | null };
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
  : status === "awaiting_finish" ? "Awaiting editor: write front page and email" : status === "built" ? "Ready to publish" : status.replaceAll("_", " ");
const stageIndex = (status: string) => status === "published" || status === "built" ? 3
  : ["awaiting_finish", "finishing", "publishing"].includes(status) ? 2
    : ["awaiting_authoring", "authoring"].includes(status) ? 1 : status === "collecting" ? 0 : -1;
const stalled = (diagnostics: Diagnostics | null | undefined) => Boolean(diagnostics?.issues.some((issue) => issue.severity === "failed"));
const agentModels = (agent: AgentActivity) => agent.models.length
  ? agent.models.map((call) => `${call.role === "discovery" ? "Source check" : "Planning & triage"}: ${call.provider} / ${call.model}`).join(" · ")
  : "No model calls recorded for this job";
const jobLabel = (job: Job) => job.kind === "agent_round" ? `Explore additional sources · agent job ${job.agent?.pass ?? "—"}`
  : job.kind === "discover" && job.discovery_label ? `Discover ${job.discovery_label}`
  : job.kind === "author_start" ? "Filter and merge items"
  : job.kind === "author_rank" ? `Rank ${String(job.payload?.section ?? "section")} candidates`
    : job.kind === "author_story" ? `Write story ${Number(job.payload?.step ?? 0) + 1}`
      : job.kind === "author_finish" ? "Build edition front page and email" : job.kind.replaceAll("_", " ");
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

const progressLabel: Record<RunProgressStage["status"], string> = {
  completed: "Complete",
  in_progress: "In progress",
  waiting: "Waiting for editor",
  pending: "Not started",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Not needed",
};
const progressTone: Record<RunProgressStage["status"], string> = {
  completed: "ok",
  in_progress: "running",
  waiting: "warning",
  pending: "idle",
  failed: "failed",
  cancelled: "idle",
  skipped: "idle",
};

function RunPipeline({ run, jobs }: { run: Run; jobs: Job[] }) {
  const map = run.kind === "map";
  const stages = map ? sourcePipelineProgress(run, jobs) : editionPipelineProgress(run, jobs);
  return <section className="edition-pipeline" aria-label={map ? "Source collection progress" : "Collecting stories progress"}>
    <div className="section-heading">
      <h3>{map ? "Collecting sources" : "Collecting stories"}</h3>
      {!map && <a href={`/edition-map?${new URLSearchParams({ location: run.location_id, run: run._id })}`}>Detailed funnel and evidence</a>}
    </div>
    <ol className="pipeline-steps stage-tracker">
      {stages.map((stage) => <li key={stage.id} className={stage.status === "completed" ? "complete" : ["in_progress", "waiting"].includes(stage.status) ? "current" : ["failed", "cancelled"].includes(stage.status) ? "stopped" : ""} aria-current={stage.status === "in_progress" ? "step" : undefined}>
        <strong>{stage.label}</strong>
        <span className={`status-badge tone-${progressTone[stage.status]}`}>{progressLabel[stage.status]}</span>
        <small>{stage.detail}</small>
      </li>)}
    </ol>
  </section>;
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

export function JobLog({ job, run, source, initiallyOpen, retry, busy }: { job: Job; run?: Run; source?: RunSource; initiallyOpen: boolean; retry?: () => void; busy: boolean }) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  const [content, setContent] = useState<string | null>(null);
  const [logError, setLogError] = useState("");

  useEffect(() => {
    if (!expanded || !job.log_file) return;
    const controller = new AbortController();
    setContent(null);
    setLogError("");
    const loadLog = () => {
      if (controller.signal.aborted || document.hidden) return;
      void fetch(`/api/admin/jobs/${encodeURIComponent(job.id)}/log`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) {
            const data = await response.json().catch(() => null) as { detail?: string } | null;
            throw new Error(data?.detail ?? `Log unavailable (${response.status})`);
          }
          return response.text();
        })
        .then((text) => { setContent(text); setLogError(""); })
        .catch((caught: unknown) => { if (!controller.signal.aborted) setLogError(message(caught)); });
    };
    loadLog();
    const timer = job.status === "running" ? window.setInterval(loadLog, 3_000) : null;
    return () => { controller.abort(); if (timer) window.clearInterval(timer); };
  }, [expanded, job.id, job.log_file, job.status, job.attempts]);

  const dispatchError = job.status === "pending" && job.dispatch_error && (job.dispatch_error_at ?? 0) > (job.dispatched_at ?? 0)
    ? `Dispatch failed: ${job.dispatch_error}` : null;
  const errors = [...new Set([job.error, source?.error, dispatchError].filter(Boolean))];

  return <details className="job-log-entry" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>
      <span><strong>{source?.name ?? jobLabel(job)}</strong> <small>{job.kind.replaceAll("_", " ")} · {job.attempts} {job.attempts === 1 ? "attempt" : "attempts"} · {job.started_at ? `started ${time(job.started_at)}` : "queued"} · {job.id}</small>
        {job.agent && <small>{agentModels(job.agent)} · {job.agent.steps} steps recorded</small>}</span>
      <span className={`status-badge tone-${job.status === "running" || job.status === "pending" ? "running" : job.status}`}>{job.status}</span>
    </summary>
    <p className="chart-caption">{job.attempts} {job.attempts === 1 ? "attempt" : "attempts"}{job.started_at ? ` · started ${time(job.started_at)}` : ""}{job.completed_at ? ` · finished ${time(job.completed_at)}` : ""}
      {source && ` · ${source.result_status ?? source.status} · ${source.event_count} items kept`}
    </p>
    {source?.detail && <p className="chart-caption">{source.detail}</p>}
    {job.agent && <div className="agent-job-detail">
      <p>This agent looks for lasting local sources the fixed readers missed. It plans searches by category and tool, checks new pages, and uses a model check to judge proposed sources.</p>
      <p className="chart-caption">{agentModels(job.agent)} · {job.agent.steps} steps recorded{job.agent.round ? ` · round ${job.agent.round}` : ""}{job.agent.stage ? ` · ${job.agent.stage.replaceAll("_", " ")}` : ""}</p>
      {job.agent.last_step && <p className="chart-caption">Latest step: {job.agent.last_step.action.replaceAll("_", " ")}{job.agent.last_step.category ? ` · ${job.agent.last_step.category.replaceAll("_", " ")}` : ""}{job.agent.last_step.tool ? ` · ${job.agent.last_step.tool}` : ""} — {job.agent.last_step.result}</p>}
      {run?.kind === "map" && <Link href={`/source-map?${new URLSearchParams({ location: run.location_id, tab: "runs", run: run._id })}`}>See all agent search steps and source decisions</Link>}
    </div>}
    {errors.length > 0 && <p className="stage-error">{errors.join("; ")}</p>}
    {job.status === "running" && <p className="chart-caption" role="status">Live log updates every 3 seconds while this step runs.</p>}
    {retry && <button type="button" className="secondary" disabled={busy} onClick={retry}>
      {job.status === "cancelled" ? "Retry interrupted step" : "Retry failed step only"}
    </button>}
    {job.log_error && <p className="alert">Log save failed: {job.log_error}</p>}
    {logError && <p className="alert" role="alert">{logError}</p>}
    {job.log_file ? content === null && !logError ? <p>Loading log…</p> : content ? <pre className="job-log-content">{formatJobLog(content)}</pre> : !logError && <p className="chart-caption">No log entries recorded.</p>
      : <p className="chart-caption">{job.status === "pending" ? "Waiting to start." : job.status === "running" ? "Log will be available after this attempt finishes." : "No log recorded for this job."}</p>}
  </details>;
}

/** `kind` limits a location's controls to one step: its source map runs, or its editions. */
export default function Dashboard({ locationId, owner = false, kind, inspectorOnly = false }: { locationId?: string; owner?: boolean; kind?: "map" | "edition"; inspectorOnly?: boolean }) {
  const showMap = kind !== "edition", showEdition = kind !== "map";
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
      window.history.replaceState(window.history.state, "", `/locations/${encodeURIComponent(locationId)}?tab=${kind === "map" ? "collect-sources" : "edition"}&run=${encodeURIComponent(runId)}`);
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
    if (detail && kind !== "map" && window.location.search.includes("run=")) {
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
    if (detail.run.kind === "map" && mapJobIsPast(job.kind, detail.jobs)) return false;
    const stage = detail.run.kind === "map" ? "mapping" : ["discover", "agent_round", "plan_sources", "collect_source"].includes(job.kind) ? "collecting" : job.kind === "author_finish" ? "finishing" : "authoring";
    if (detail.run.status === "failed") {
      const last = detail.run.stage_transitions?.filter((transition) => PROCESSING.includes(transition.status)).at(-1)?.status;
      return (last === "publishing" ? "finishing" : last) === stage;
    }
    return detail.run.status === stage || (stage === "collecting" && detail.run.status === "awaiting_authoring")
      || (["image_story", "stock_story"].includes(job.kind) && detail.run.status === "awaiting_finish");
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

  /** The latest run of this step's kind. Health describes only the very latest run, so an older one shows its status alone. */
  function forStep(latest: LocationHealth): LocationHealth {
    if (!kind) return latest;
    const own = recent.find((run) => run.location_id === latest.location_id && (run.kind === "map") === (kind === "map"));
    if (own?._id === latest.run_id) return latest;
    return { ...latest, run_id: own?._id ?? null, stage: own?.status ?? "none", started_at: own?.created_at ?? null, level: own?.status === "failed" ? "failed" : "idle",
      sources: { total: 0, completed: 0, failed: 0, pending: 0 }, failed_sources: [], candidate_count: 0, published_items: null, held: null, held_reasons: {}, model_errors: [], error: own?.error ?? null, diagnostics: null };
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

      {!inspectorOnly && <section className="panel">
        <div className="section-heading">
            <div><h2>{kind === "map" ? "Refresh the source map" : kind === "edition" ? "Collect stories" : locationId ? "Pipeline" : "Locations & runs"}</h2>
              <p>{kind === "map" ? "Finds sources to review."
                : kind === "edition" ? "Collects source items, ranks and writes stories, then builds the edition."
                : "Refresh updates the source list. Collect stories uses the saved source map."}</p></div>
           {!locationId && <button disabled
             onClick={() => void act("Started an edition for every location with a source map.", () => api("ingestion", { method: "POST", body: JSON.stringify({ options: runOptions }) }))}>
             Batch runs disabled: one unfinished run per newsroom
           </button>}
        </div>
        <h3>{kind === "map" ? "Source map run options" : kind === "edition" ? "Edition options" : "New run options"}</h3><p className="chart-caption">For new runs only.</p>
        <RunOptionsPanel onChange={setRunOptions} onError={setRunOptionsError} scope={kind ?? "all"} />
        <div className="operations-toolbar"><span>{health?.queue.running ?? 0} jobs running / {health?.queue.pending ?? 0} waiting</span><Link href="/locations">Overview &rarr;</Link></div>
         <div className="location-run-list">
           {health?.locations.filter((row) => !locationId || row.location_id === locationId).map((latest) => {
            // One run at a time per location, of either kind; each step shows its own latest run.
            const running = ACTIVE.includes(latest.stage);
            const row = forStep(latest);
            const badge = row.stage === "none" ? { tone: "idle", label: kind === "map" ? "No source map run yet" : "No edition yet" } : runBadge(row.stage, row.diagnostics, row.level, row.candidate_count);
            const coverage = locations.find((location) => location.id === row.location_id)?.source_coverage;
            return <article className="run-card" key={row.location_id}>
              <div className="section-heading"><h3><Link href={`/locations/${encodeURIComponent(row.location_id)}`}>{row.location_name}</Link></h3><span className={`status-badge tone-${badge.tone}`}>{badge.label}</span></div>
              <RunExecutionSummary run={recent.find((run) => run._id === row.run_id)} />
              <ol className="pipeline-steps" aria-label={`${row.location_name} pipeline`}>
                 {(kind === "map" ? ["Discover and check sources", "Save addresses", "Ready for review"] : ["Collect", "Filter, rank & write", "Front page & email"]).map((step, index) => {
                  const stage = kind === "map" ? (row.stage === "mapping" ? 0 : row.stage === "mapped" ? 3 : -1) : stageIndex(row.stage);
                  return <li key={step} className={stage > index ? "complete" : stage === index ? "current" : ""} aria-current={stage === index ? "step" : undefined}>{step}</li>;
                })}
              </ol>
              {kind !== "map" && <div className="run-counts"><span><strong>{row.sources.completed}/{row.sources.total}</strong> sources completed</span><span><strong>{row.candidate_count}</strong> candidates</span><span><strong>{row.published_items ?? "-"}</strong> published</span><span><strong>{row.held ?? "-"}</strong> held</span></div>}
              {row.run_id && emptyCollection({ _id: row.run_id, location_id: row.location_id, location_name: row.location_name }, row.stage, row.candidate_count)}
              <p className="chart-caption">Last started: {time(row.started_at)}</p>
              {coverage && showMap && <details className="location-settings"><summary>Location resolved / sources {coverage.status.replaceAll("_", " ")}</summary>
                   <p>{coverage.area}</p><ul>{coverage.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul><Link href={`/locations/${encodeURIComponent(row.location_id)}?tab=sources`}>Review the source map</Link>
                </details>}
              {running && <RunIssues diagnostics={row.diagnostics} compact />}
              {(row.error || row.failed_sources.length > 0 || row.model_errors.length > 0) && <p className="stage-error">
                {[row.error, ...row.model_errors, ...row.failed_sources.map((source) => `${source.name}: ${source.error ?? "failed"}`)].filter(Boolean).join("; ")}
              </p>}
              <div className="card-actions">
                  {showMap && <ExplainedButton className={kind === "map" ? undefined : "secondary"} disabledReason={busy ? "Another action is in progress." : runOptionsError || executionDisabledReason(policy, policyError, "map") || (!runOptions ? "Loading run options." : running ? "A run is open. Inspect it first." : null)}
                    onClick={() => void act(`Refreshing the source map for ${row.location_name}.`, () =>
                      api(`locations/${encodeURIComponent(row.location_id)}/map-run`, { method: "POST", body: JSON.stringify({ options: runOptions, rebuild: true }) }))}>Refresh source map</ExplainedButton>}
                  {showEdition && <ExplainedButton disabledReason={busy ? "Another action is in progress." : runOptionsError || executionDisabledReason(policy, policyError, "edition") || (!runOptions ? "Loading run options." : running ? "A run is open. Inspect it first." : null)}
                    onClick={() => void act(`Started ${row.location_name}.`, () =>
                      api(`locations/${encodeURIComponent(row.location_id)}/ingestion`, { method: "POST", body: JSON.stringify({ options: runOptions }) }))}>{running ? "Run open" : runOptions?.mode === "manual" ? "Start collection" : "Collect stories"}</ExplainedButton>}
                  {row.run_id && showEdition && <a className="button secondary" href={`/edition-map?${new URLSearchParams({ location: row.location_id, run: row.run_id })}`}>See the funnel</a>}
                  {row.run_id && stageAction(row.run_id, row.stage, row.candidate_count)}
                   {row.run_id && (locationId
                     ? <button className="secondary" onClick={() => { void openRun(row.run_id!, row.location_id); window.dispatchEvent(new CustomEvent("newsbee:inspect-run", { detail: { runId: row.run_id } })); }}>Inspect run</button>
                     : <Link className="button secondary" href={`/locations/${encodeURIComponent(row.location_id)}?tab=edition&run=${encodeURIComponent(row.run_id)}`}>Inspect run</Link>)}
                  {row.run_id && CANCELLABLE.includes(row.stage) && <button className="secondary" disabled={busy} onClick={() => cancelSelected({ _id: row.run_id!, location_name: row.location_name })}>Cancel run</button>}
                  {row.run_id && !running && <ExplainedButton className="secondary" disabledReason={busy ? "Another action is in progress." : executionDisabledReason(policy, policyError, "restart", row.run_id)} onClick={() => void restartSelected({ _id: row.run_id!, location_id: row.location_id, location_name: row.location_name })}>Restart run</ExplainedButton>}
              </div>
              {!locationId && owner && <details className="location-settings"><summary>Location actions</summary><div className="card-actions">
                  <Link href={`/locations/${encodeURIComponent(row.location_id)}?tab=settings#remove-location`}>Remove location and files…</Link>
              </div></details>}
            </article>;
          })}
           {health && !health.locations.length && !locationId && <p>No locations yet.</p>}
        </div>
      </section>}

      {detail && (
         <section className="panel" id="run-inspector">
          <div className="section-heading">
            <h2>{detail.run.location_name} · {stageLabel(detail.run.status, detail.health.candidate_count)} · {detail.run.window.join(" to ")}</h2>
            <div className="card-actions">
              {stageAction(detail.run._id, detail.run.status, detail.health.candidate_count)}
              {availableMapStages(detail.run, detail.jobs).map((stage) => <ExplainedButton key={stage} className="secondary"
                disabledReason={busy ? "Another action is in progress." : executionDisabledReason(policy, policyError, "spend", detail.run._id)}
                onClick={() => void act(stage === "review" ? "Source review started." : "Saving source addresses started.", () =>
                  api(`runs/${encodeURIComponent(detail.run._id)}/map-stage`, { method: "POST", body: JSON.stringify({ stage }) }))}>
                {stage === "review" ? "Review and deduplicate sources" : "Save source addresses"}
              </ExplainedButton>)}
              {CANCELLABLE.includes(detail.run.status) && <button className="secondary" disabled={busy} onClick={() => cancelSelected(detail.run)}>Cancel run</button>}
              {detail.run.status === "built" && <Link className="button" href={`/locations/${encodeURIComponent(detail.run.location_id)}?tab=published`}>Publish</Link>}
              {["mapped", "built", "published", "failed", "cancelled"].includes(detail.run.status) && <ExplainedButton className="secondary" disabledReason={busy ? "Another action is in progress." : executionDisabledReason(policy, policyError, "restart", detail.run._id)} onClick={() => void restartSelected(detail.run)}>Restart run</ExplainedButton>}
               <button className="secondary" onClick={() => { setDetail(null); window.history.replaceState(window.history.state, "", `/locations/${encodeURIComponent(detail.run.location_id)}?tab=collect-sources`); }}>Close</button>
            </div>
          </div>
          <RunExecutionSummary run={detail.run} />
          {!detail.funding?.length && <p className="chart-caption">No model funding calls recorded yet.</p>}
          {!!detail.funding?.length && <details className="location-settings"><summary>Recorded model calls · {detail.funding.length} attempts{detail.funding.length === 50 ? " (latest 50)" : ""}</summary><ul>{detail.funding.map((call, index) => <li key={index}><strong>{call.funding === "admin" ? "Owner backup (older run)" : "This run's keys"}</strong>: {call.provider} / {call.model} / {call.ok ? "served" : "failed"}{call.reason ? ` / ${call.reason}` : ""}</li>)}</ul></details>}
          <RunPipeline run={detail.run} jobs={detail.jobs} />
          <p className="chart-caption">{detail.run.kind === "map" ? "Source map run · " : ""}Started {time(detail.run.created_at)} · {detail.run.trigger.kind} by {detail.run.trigger.by} · Finished {time(detail.run.completed_at)} · Run ID {detail.run._id}</p>
          {detail.run.error && <p className="alert">{detail.run.error}</p>}
          {ACTIVE.includes(detail.run.status) && detail.health?.diagnostics && detail.health.diagnostics.issues.length > 0 && <>
            <h3>Why this run is {stalled(detail.health.diagnostics) ? "stalled" : "still running"}</h3>
            <RunIssues diagnostics={detail.health.diagnostics} />
          </>}
          {emptyCollection(detail.run, detail.run.status, detail.health.candidate_count)}
          <h3>Run log</h3>
          {detail.run.status === "failed" && <p>Open the failed job and choose <strong>Retry failed step only</strong> to keep completed work. For source maps, use the available review or save action above to continue with sources already found. Restart run starts a new collection.</p>}
          <div className="job-log-list">{detail.jobs.map((job) =>
            <JobLog key={job.id} job={job} run={detail.run} source={detail.run.sources.find((source) => source.job_id === job.id)}
              initiallyOpen={job.id === defaultLogId} busy={busy}
              retry={canRetryStep(job) && canSpend(detail.run._id) ? () => void act("Retrying only the selected step; completed work is preserved.", () =>
                api(`runs/${encodeURIComponent(detail.run._id)}/jobs/${encodeURIComponent(job.id)}/retry`, { method: "POST" })) : undefined} />
          )}</div>
          {!detail.jobs.length && <p>No work has been queued for this run.</p>}
          <section aria-label="Generated articles" id="generated-articles">
            <h3>Generated articles</h3>
            {detail.stories.filter(story => story.draft).map(story => <article className="panel" key={story.story_id}>
              <p>{story.disposition === "checks_passed" ? (detail.run.status === "published" ? "Validated article · published to Reader" : "Validated draft · not published to Reader") : "Held draft · needs review"}{story.source_brief ? " · exact-source brief" : ""}</p>
              <h4>{story.draft!.headline}</h4>
              <p>{story.draft!.summary}</p>
              {story.when_where && <p>{story.when_where}</p>}
              {Boolean(story.sources?.length) && <p>Sources: {story.sources!.map((source, index) => <span key={`${source.url}:${index}`}>{index > 0 ? " · " : ""}{source.url && /^https?:\/\//i.test(source.url) ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a> : source.name}</span>)}</p>}
              {story.reasons.length > 0 && <p>Review: {story.reasons.join("; ")}</p>}
            </article>)}
            {!detail.stories.some(story => story.draft) && <p>No article drafts yet.</p>}
          </section>
          <h3>Stories</h3>
          {detail.run.status === "awaiting_finish" && <button type="button" className="secondary" disabled={busy}
            onClick={() => void act("Retrying photo sourcing; validated story text is preserved.", () =>
              api(`runs/${encodeURIComponent(detail.run._id)}/actions`, { method: "POST", body: JSON.stringify({ action: "images" }) }))}>Retry photo sourcing</button>}
          <div className="table-wrap"><table>
            <thead><tr><th>Rank</th><th>Title</th><th>Source</th><th>Tier</th><th>Why ranked</th><th>Outcome</th><th>Held because</th><th>Photo</th><th /></tr></thead>
            <tbody>{detail.stories.map((story) => (
              <tr key={story.story_id}>
                <td>{story.rank ?? "—"}</td><td>{story.title ?? story.story_id}</td><td>{story.source_id}</td><td>{story.tier}</td><td>{story.why ?? "—"}</td>
                <td>{story.disposition}</td><td>{story.reasons.join("; ") || "—"}</td>
                <td title={story.image?.reason.replaceAll("_", " ")}>{story.image?.status.replaceAll("_", " ") ?? "Not processed"}</td>
                <td>{story.disposition !== "held" && ["published", "built"].includes(detail.run.status) &&
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
