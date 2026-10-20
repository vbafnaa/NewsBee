"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { adminApi as api } from "@/lib/admin-client";
import LocationOnboarding from "./location-onboarding";

type System = { fscskey: string; name: string; website: string | null };
type Government = { status?: string; platform?: string | null; tenant?: string | null };
type Location = { id: string; name: string; systems: System[]; government: Government | null };
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
};
type Health = {
  scheduler: { seconds_since_tick: number | null; status: string };
  queue: Record<string, number>;
  model: { provider: string | null; name: string | null; status: string; detail?: string; providers?: Array<{ name: string; model: string | null; status: string }> } | null;
  status: string;
  totals: Record<string, number>;
  locations: LocationHealth[];
};
type RunSource = { source_id: string; name: string; status: string; result_status: string | null; detail: string | null; event_count: number; shortlisted: number; error: string | null };
type Story = { story_id: string; source_id: string; tier: string; disposition: string; title: string | null; reasons: string[] };
type Job = { id: string; kind: string; status: string; attempts: number; error: string | null; log_file?: string | null; log_error?: string | null };
type Run = { _id: string; location_id: string; location_name: string; status: string; created_at: number; completed_at: number | null; trigger: { by: string; kind: string }; published: { items: number; held: number } | null };
type RunDetail = {
  run: Run & { draft_id: string | null; window: [string, string]; sources: RunSource[]; error: string | null };
  stories: Story[];
  jobs: Job[];
};
type Withdrawal = { story_id: string; reason: string; created_at: number };

const time = (value: number | null) => value ? new Date(value * 1000).toLocaleString() : "—";
const message = (caught: unknown) => caught instanceof Error ? caught.message : String(caught);

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
    if (!detail || !["collecting", "authoring", "publishing"].includes(detail.run.status)) return;
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

  return (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      <section className="panel">
        <div className="section-heading">
          <div><p className="eyebrow">Edition pipeline</p><h2>Run orchestration</h2><p>Collect sources, write and validate stories, then publish to selected channels.</p></div>
          <button disabled={busy || !locations.length}
            onClick={() => void act("Started a run for every location.", () => api("ingestion", { method: "POST" }))}>
            Run all locations
          </button>
        </div>
        <div className="operations-toolbar"><span>{health?.queue.running ?? 0} jobs running / {health?.queue.pending ?? 0} waiting</span><Link href="/health">View visual health &amp; trends &rarr;</Link></div>
        <div className="location-grid">
          {health?.locations.map((row) => {
            const running = ["collecting", "authoring", "publishing"].includes(row.stage);
            return <article className="run-card" key={row.location_id}>
              <div className="section-heading"><h3>{row.location_name}</h3><span className={`status-badge tone-${running ? "running" : row.level}`}>{row.stage.replaceAll("_", " ")}</span></div>
              <ol className="pipeline-steps" aria-label={`${row.location_name} pipeline`}>
                {["Collect", "Author", "Publish"].map((step, index) => {
                  const stage = row.stage === "published" ? 3 : row.stage === "publishing" ? 2 : row.stage === "authoring" ? 1 : row.stage === "collecting" ? 0 : -1;
                  return <li key={step} className={stage > index ? "complete" : stage === index ? "current" : ""} aria-current={stage === index ? "step" : undefined}>{step}</li>;
                })}
              </ol>
              <div className="run-counts"><span><strong>{row.sources.completed}/{row.sources.total}</strong> sources completed</span><span><strong>{row.published_items ?? "-"}</strong> published</span><span><strong>{row.held ?? "-"}</strong> held</span></div>
              <p className="chart-caption">Last started: {time(row.started_at)}</p>
              {(row.error || row.failed_sources.length > 0 || row.model_errors.length > 0) && <p className="stage-error">
                {[row.error, ...row.model_errors, ...row.failed_sources.map((source) => `${source.name}: ${source.error ?? "failed"}`)].filter(Boolean).join("; ")}
              </p>}
              <div className="card-actions">
                  <button disabled={busy || running}
                    onClick={() => void act(`Started ${row.location_name}.`, () =>
                      api(`locations/${encodeURIComponent(row.location_id)}/ingestion`, { method: "POST" }))}>{running ? "Run in progress" : "Start run"}</button>
                  {row.run_id && <button className="secondary" onClick={() => void openRun(row.run_id!, row.location_id)}>Inspect run</button>}
                  {row.run_id && ["collecting", "authoring"].includes(row.stage) && <button className="secondary" disabled={busy} onClick={() => cancelSelected({ _id: row.run_id!, location_name: row.location_name })}>Cancel run</button>}
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

      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">Pipeline history</p><h2>Recent runs</h2><p>Select an attempt to inspect its stages, jobs and results.</p></div></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Location</th><th>Started</th><th>Trigger</th><th>Status</th><th>Result</th><th>Actions</th></tr></thead>
          <tbody>{recent.map((run) => <tr key={run._id} className={detail?.run._id === run._id ? "current" : ""}>
            <td>{run.location_name}</td><td>{time(run.created_at)}</td><td>{run.trigger.kind} · {run.trigger.by}</td>
            <td><span className={`status-badge tone-${["collecting", "authoring", "publishing"].includes(run.status) ? "running" : run.status}`}>{run.status}</span></td>
            <td>{run.published ? `${run.published.items} published · ${run.published.held} held` : "—"}</td>
            <td><div className="card-actions"><button className="secondary" onClick={() => void openRun(run._id, run.location_id)}>Inspect</button>
              {["collecting", "authoring"].includes(run.status) && <button className="secondary" disabled={busy} onClick={() => cancelSelected(run)}>Cancel</button>}
              {["published", "failed", "cancelled"].includes(run.status) && <button className="secondary" disabled={busy || recent.some((item) => item.location_id === run.location_id && ["collecting", "authoring", "publishing"].includes(item.status))} onClick={() => void restartSelected(run)}>Restart</button>}
            </div></td>
          </tr>)}</tbody>
        </table></div>
        {!recent.length && <p>No pipeline runs yet.</p>}
      </section>

      {detail && (
        <section className="panel">
          <div className="section-heading">
            <h2>{detail.run.location_name} · {detail.run.status} · {detail.run.window.join(" to ")}</h2>
            <div className="card-actions">
              {["collecting", "authoring"].includes(detail.run.status) && <button className="secondary" disabled={busy} onClick={() => cancelSelected(detail.run)}>Cancel run</button>}
              {["published", "failed", "cancelled"].includes(detail.run.status) && <button className="secondary" disabled={busy || recent.some((item) => item.location_id === detail.run.location_id && ["collecting", "authoring", "publishing"].includes(item.status))} onClick={() => void restartSelected(detail.run)}>Restart run</button>}
              <button className="secondary" onClick={() => { setDetail(null); window.history.replaceState(null, "", "/"); }}>Close</button>
            </div>
          </div>
          <ol className="pipeline-steps" aria-label="Run stages">
            {["Collect", "Author", "Publish"].map((step, index) => {
              const stage = detail.run.status === "published" ? 3 : detail.run.status === "publishing" ? 2 : detail.run.status === "authoring" || detail.run.draft_id ? 1 : 0;
              const active = ["collecting", "authoring", "publishing"].includes(detail.run.status);
              return <li key={step} className={stage > index ? "complete" : stage === index ? active ? "current" : detail.run.status === "published" ? "complete" : "stopped" : ""}>{step}</li>;
            })}
          </ol>
          <p className="chart-caption">Started {time(detail.run.created_at)} · {detail.run.trigger.kind} by {detail.run.trigger.by} · Finished {time(detail.run.completed_at)} · Run ID {detail.run._id}</p>
          {detail.run.error && <p className="alert">{detail.run.error}</p>}
          <h3>Sources</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Source</th><th>Status</th><th>Result</th><th>Events</th><th>Shortlisted</th><th>Detail</th></tr></thead>
            <tbody>{detail.run.sources.map((source) => (
              <tr key={source.source_id}>
                <td>{source.name}</td><td>{source.status}</td><td>{source.result_status ?? "—"}</td>
                <td>{source.event_count}</td><td>{source.shortlisted}</td><td>{source.error ?? source.detail ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table></div>
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
          <h3>Jobs</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Job</th><th>Status</th><th>Attempts</th><th>Error</th><th>Log</th></tr></thead>
            <tbody>{detail.jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.kind}</td><td>{job.status}</td><td>{job.attempts}</td>
                <td>{[job.error, job.log_error && `Log save failed: ${job.log_error}`].filter(Boolean).join("; ") || "—"}</td>
                <td>{job.log_file
                  ? <a href={`/api/admin/jobs/${encodeURIComponent(job.id)}/log`} target="_blank" rel="noreferrer">View log</a>
                  : "—"}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      <LocationOnboarding busy={busy} enrolled={locations.map((location) => location.id)}
        onAdd={(place) => act(`Added ${place.name}. Review its links on Connectors & links.`, () => api("locations", {
          method: "POST", body: JSON.stringify({ place_id: place.id }),
        }))} />

    </>
  );
}
