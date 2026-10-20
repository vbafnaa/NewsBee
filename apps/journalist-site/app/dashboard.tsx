"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { adminApi as api } from "@/lib/admin-client";
import LocationOnboarding from "./location-onboarding";

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
type Story = { story_id: string; source_id: string; tier: string; disposition: string; title: string | null; reasons: string[] };
type Job = { id: string; kind: string; status: string; attempts: number; error: string | null; log_file?: string | null; log_error?: string | null; dispatch_error?: string | null; dispatch_error_at?: number | null; dispatched_at?: number | null };
type Run = { _id: string; location_id: string; location_name: string; status: string; created_at: number; completed_at: number | null; trigger: { by: string; kind: string }; published: { items: number; held: number } | null; error?: string | null; diagnostics?: Diagnostics | null };
type RunDetail = {
  run: Run & { draft_id: string | null; window: [string, string]; sources: RunSource[]; error: string | null };
  health: LocationHealth;
  stories: Story[];
  jobs: Job[];
};
type Withdrawal = { story_id: string; reason: string; created_at: number };

const time = (value: number | null) => value ? new Date(value * 1000).toLocaleString() : "—";
const message = (caught: unknown) => caught instanceof Error ? caught.message : String(caught);
const PROCESSING = ["collecting", "authoring", "finishing", "publishing"];
const ACTIVE = [...PROCESSING, "awaiting_authoring", "awaiting_finish"];
const CANCELLABLE = ACTIVE.filter((status) => status !== "publishing");
const stageLabel = (status: string) => status === "awaiting_authoring" ? "Awaiting editor: start authoring"
  : status === "awaiting_finish" ? "Awaiting editor: write front page and email" : status.replaceAll("_", " ");
const stageIndex = (status: string) => status === "published" ? 3
  : ["awaiting_finish", "finishing", "publishing"].includes(status) ? 2
    : ["awaiting_authoring", "authoring"].includes(status) ? 1 : status === "collecting" ? 0 : -1;
const stalled = (diagnostics: Diagnostics | null | undefined) => Boolean(diagnostics?.issues.some((issue) => issue.severity === "failed"));
/** Badge for a run: active runs that cannot advance show as stalled instead of a running stage. */
function runBadge(status: string, diagnostics: Diagnostics | null | undefined, fallback: string) {
  if (!PROCESSING.includes(status)) return { tone: ACTIVE.includes(status) ? "idle" : fallback, label: stageLabel(status) };
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

function JobLog({ job, source, initiallyOpen }: { job: Job; source?: RunSource; initiallyOpen: boolean }) {
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
      {source && ` · ${source.result_status ?? source.status} · ${source.event_count} events · ${source.shortlisted} shortlisted`}
    </p>
    {errors.length > 0 && <p className="stage-error">{errors.join("; ")}</p>}
    {job.log_error && <p className="alert">Log save failed: {job.log_error}</p>}
    {logError && <p className="alert" role="alert">{logError}</p>}
    {job.log_file ? content === null && !logError ? <p>Loading log…</p> : content ? <pre className="job-log-content">{formatJobLog(content)}</pre> : !logError && <p className="chart-caption">No log entries recorded.</p>
      : <p className="chart-caption">{job.status === "pending" ? "Waiting to start." : job.status === "running" ? "Log will be available after this attempt finishes." : "No log recorded for this job."}</p>}
  </details>;
}

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [recent, setRecent] = useState<Run[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [healthData, locationData, runsData] = await Promise.all([
        api<Health>("health"),
        api<{ locations: Location[] }>("locations"),
        api<{ runs: Run[] }>("runs?limit=30"),
      ]);
      setHealth(healthData);
      setLocations(locationData.locations);
      setRecent(runsData.runs);
      setError("");
    } catch (caught) {
      setError(message(caught));
    }
  }, []);

  const openRun = useCallback(async (runId: string, locationId: string) => {
    try {
      const [run, withdrawn] = await Promise.all([
        api<RunDetail>(`runs/${encodeURIComponent(runId)}`),
        api<{ withdrawals: Withdrawal[] }>(`withdrawals?location=${encodeURIComponent(locationId)}`),
      ]);
      setDetail(run);
      setWithdrawals(withdrawn.withdrawals);
      window.history.replaceState(null, "", `/?run=${encodeURIComponent(runId)}&location=${encodeURIComponent(locationId)}`);
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
    const runId = params.get("run"), locationId = params.get("location");
    if (runId && locationId) void openRun(runId, locationId);
  }, [openRun]);

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
      if (detail) await openRun(detail.run._id, detail.run.location_id);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  function stageAction(runId: string, status: string) {
    const action = status === "awaiting_authoring" ? "authoring" : status === "awaiting_finish" ? "finish" : PROCESSING.includes(status) ? "resume" : null;
    if (!action) return null;
    const label = action === "authoring" ? "Start authoring" : action === "finish" ? "Write front page and email, then publish" : "Resume";
    return <button className="secondary" disabled={busy}
      onClick={() => void act(`${label}: processing kicked off.`, () => api(`runs/${encodeURIComponent(runId)}/${action}`, { method: "POST" }))}>{label}</button>;
  }

  function cancelSelected(run: { _id: string; location_name: string }) {
    if (!window.confirm(`Cancel the run for ${run.location_name}? Queued jobs will be stopped.`)) return;
    void act(`Cancelled ${run.location_name}.`, () => api(`runs/${encodeURIComponent(run._id)}/cancel`, { method: "POST" }));
  }

  async function restartSelected(run: Pick<Run, "_id" | "location_id" | "location_name">) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ run_id: string }>(`runs/${encodeURIComponent(run._id)}/restart`, { method: "POST" });
      setNotice(`New run started for ${run.location_name}.`);
      await load();
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

  const defaultLogId = detail?.jobs.findLast((job) => !!job.log_file)?.id ?? detail?.jobs[0]?.id;

  return (
    <>
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

      <section className="panel">
        <div className="section-heading">
          <div><p className="eyebrow">Edition pipeline</p><h2>Run orchestration</h2><p>Manually start collection, authoring, then front page and email preview publication. Email is not sent.</p></div>
          <button disabled={busy || !locations.length}
            onClick={() => void act("Started a run for every location.", () => api("ingestion", { method: "POST" }))}>
            Start collection for all locations
          </button>
        </div>
        <div className="operations-toolbar"><span>{health?.queue.running ?? 0} jobs running / {health?.queue.pending ?? 0} waiting</span><Link href="/health">View visual health &amp; trends &rarr;</Link></div>
        <div className="location-grid">
          {health?.locations.map((row) => {
            const running = ACTIVE.includes(row.stage);
            const badge = runBadge(row.stage, row.diagnostics, row.level);
            const coverage = locations.find((location) => location.id === row.location_id)?.source_coverage;
            return <article className="run-card" key={row.location_id}>
              <div className="section-heading"><h3>{row.location_name}</h3><span className={`status-badge tone-${badge.tone}`}>{badge.label}</span></div>
              <ol className="pipeline-steps" aria-label={`${row.location_name} pipeline`}>
                {["Collect", "Author", "Front page & email"].map((step, index) => {
                  const stage = stageIndex(row.stage);
                  return <li key={step} className={stage > index ? "complete" : stage === index ? "current" : ""} aria-current={stage === index ? "step" : undefined}>{step}</li>;
                })}
              </ol>
              <div className="run-counts"><span><strong>{row.sources.completed}/{row.sources.total}</strong> sources completed</span><span><strong>{row.published_items ?? "-"}</strong> published</span><span><strong>{row.held ?? "-"}</strong> held</span></div>
              <p className="chart-caption">Last started: {time(row.started_at)}</p>
              {coverage && <details className="location-settings"><summary>Location resolved / sources {coverage.status.replaceAll("_", " ")}</summary>
                  <p>{coverage.area}</p><ul>{coverage.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul><Link href="/sources">Review source coverage</Link>
                </details>}
              {running && <RunIssues diagnostics={row.diagnostics} compact />}
              {(row.error || row.failed_sources.length > 0 || row.model_errors.length > 0) && <p className="stage-error">
                {[row.error, ...row.model_errors, ...row.failed_sources.map((source) => `${source.name}: ${source.error ?? "failed"}`)].filter(Boolean).join("; ")}
              </p>}
              <div className="card-actions">
                  <button disabled={busy || running}
                    onClick={() => void act(`Started ${row.location_name}.`, () =>
                      api(`locations/${encodeURIComponent(row.location_id)}/ingestion`, { method: "POST" }))}>{running ? "Run open" : "Start pipeline (collection)"}</button>
                  {row.run_id && stageAction(row.run_id, row.stage)}
                  {row.run_id && <button className="secondary" onClick={() => void openRun(row.run_id!, row.location_id)}>Inspect run</button>}
                  {row.run_id && CANCELLABLE.includes(row.stage) && <button className="secondary" disabled={busy} onClick={() => cancelSelected({ _id: row.run_id!, location_name: row.location_name })}>Cancel run</button>}
                  {row.run_id && !running && <button className="secondary" disabled={busy} onClick={() => void restartSelected({ _id: row.run_id!, location_id: row.location_id, location_name: row.location_name })}>Restart run</button>}
              </div>
              <details className="location-settings"><summary>Location actions</summary><div className="card-actions">
                  <Link href="/sources">Inspect connectors &amp; links</Link>
                  <button className="secondary" disabled={busy}
                    onClick={() => window.confirm(`Remove ${row.location_name}?`) && void act(`Removed ${row.location_name}.`, () =>
                      api(`locations/${encodeURIComponent(row.location_id)}`, { method: "DELETE" }))}>Remove</button>
              </div></details>
            </article>;
          })}
          {health && !health.locations.length && <p>No locations onboarded yet.</p>}
        </div>
      </section>

      {detail && (
        <section className="panel">
          <div className="section-heading">
            <h2>{detail.run.location_name} · {stageLabel(detail.run.status)} · {detail.run.window.join(" to ")}</h2>
            <div className="card-actions">
              {stageAction(detail.run._id, detail.run.status)}
              {CANCELLABLE.includes(detail.run.status) && <button className="secondary" disabled={busy} onClick={() => cancelSelected(detail.run)}>Cancel run</button>}
              {["published", "failed", "cancelled"].includes(detail.run.status) && <button className="secondary" disabled={busy || recent.some((item) => item.location_id === detail.run.location_id && ACTIVE.includes(item.status))} onClick={() => void restartSelected(detail.run)}>Restart run</button>}
              <button className="secondary" onClick={() => { setDetail(null); window.history.replaceState(null, "", "/"); }}>Close</button>
            </div>
          </div>
          <ol className="pipeline-steps" aria-label="Run stages">
            {["Collect", "Author", "Front page & email"].map((step, index) => {
              const stage = stageIndex(detail.run.status);
              const active = ACTIVE.includes(detail.run.status);
              return <li key={step} className={stage > index ? "complete" : stage === index ? active ? "current" : detail.run.status === "published" ? "complete" : "stopped" : ""}>{step}</li>;
            })}
          </ol>
          <p className="chart-caption">Started {time(detail.run.created_at)} · {detail.run.trigger.kind} by {detail.run.trigger.by} · Finished {time(detail.run.completed_at)} · Run ID {detail.run._id}</p>
          {detail.run.error && <p className="alert">{detail.run.error}</p>}
          {ACTIVE.includes(detail.run.status) && detail.health?.diagnostics && detail.health.diagnostics.issues.length > 0 && <>
            <h3>Why this run is {stalled(detail.health.diagnostics) ? "stalled" : "still running"}</h3>
            <RunIssues diagnostics={detail.health.diagnostics} />
          </>}
          <h3>Run log</h3>
          <div className="job-log-list">{detail.jobs.map((job) =>
            <JobLog key={job.id} job={job} source={detail.run.sources.find((source) => source.job_id === job.id)}
              initiallyOpen={job.id === defaultLogId} />
          )}</div>
          {!detail.jobs.length && <p>No work has been queued for this run.</p>}
          <h3>Stories</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Title</th><th>Source</th><th>Tier</th><th>Outcome</th><th>Held because</th><th /></tr></thead>
            <tbody>{detail.stories.map((story) => (
              <tr key={story.story_id}>
                <td>{story.title ?? story.story_id}</td><td>{story.source_id}</td><td>{story.tier}</td>
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

      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">Pipeline history</p><h2>Recent runs</h2><p>Select an attempt to inspect its stages and per-job logs.</p></div></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Location</th><th>Started</th><th>Trigger</th><th>Status</th><th>Result</th><th>Actions</th></tr></thead>
          <tbody>{recent.map((run) => { const badge = runBadge(run.status, run.diagnostics, run.status); return <tr key={run._id} className={detail?.run._id === run._id ? "current" : ""}>
            <td>{run.location_name}</td><td>{time(run.created_at)}</td><td>{run.trigger.kind} · {run.trigger.by}</td>
            <td><span className={`status-badge tone-${badge.tone}`}>{badge.label}</span></td>
            <td>{run.published ? `${run.published.items} published · ${run.published.held} held`
              : ACTIVE.includes(run.status) ? run.diagnostics?.issues.find((issue) => issue.severity !== "info")?.message ?? "—"
                : run.status === "failed" && run.error ? run.error : "—"}</td>
            <td><div className="card-actions"><button className="secondary" onClick={() => void openRun(run._id, run.location_id)}>Inspect</button>
              {stageAction(run._id, run.status)}
              {CANCELLABLE.includes(run.status) && <button className="secondary" disabled={busy} onClick={() => cancelSelected(run)}>Cancel</button>}
              {["published", "failed", "cancelled"].includes(run.status) && <button className="secondary" disabled={busy || recent.some((item) => item.location_id === run.location_id && ACTIVE.includes(item.status))} onClick={() => void restartSelected(run)}>Restart</button>}
            </div></td>
          </tr>; })}</tbody>
        </table></div>
        {!recent.length && <p>No pipeline runs yet.</p>}
      </section>

      <LocationOnboarding busy={busy} enrolled={locations.map((location) => location.id)}
        onAdd={(place) => act(`Added ${place.name}. Review its links on Connectors & links.`, () => api("locations", {
          method: "POST", body: JSON.stringify({ place_id: place.id }),
        }))} />

    </>
  );
}
