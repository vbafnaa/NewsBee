"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";

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
type Place = { id: string; name: string; branch_count: number; system_count: number };
type RunSource = { source_id: string; name: string; status: string; result_status: string | null; detail: string | null; event_count: number; shortlisted: number; error: string | null };
type Story = { story_id: string; source_id: string; tier: string; disposition: string; title: string | null; reasons: string[] };
type Job = { id: string; kind: string; status: string; attempts: number; error: string | null };
type RunDetail = {
  run: { _id: string; location_id: string; location_name: string; status: string; draft_id: string | null; window: [string, string]; sources: RunSource[]; error: string | null };
  stories: Story[];
  jobs: Job[];
};
type Withdrawal = { story_id: string; reason: string; created_at: number };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/admin/${path}`, {
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
  return data as T;
}

const time = (value: number | null) => value ? new Date(value * 1000).toLocaleString() : "—";
const message = (caught: unknown) => caught instanceof Error ? caught.message : String(caught);

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [healthData, locationData] = await Promise.all([
        api<Health>("health"),
        api<{ locations: Location[] }>("locations"),
      ]);
      setHealth(healthData);
      setLocations(locationData.locations);
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
    } catch (caught) {
      setError(message(caught));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, [load]);

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

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setPlaces((await api<{ results: Place[] }>(`places?q=${encodeURIComponent(query)}`)).results);
    } catch (caught) {
      setError(message(caught));
    }
  }

  async function saveSources(event: FormEvent<HTMLFormElement>, location: Location) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const platform = String(form.get("platform") ?? "");
    const tenant = String(form.get("tenant") ?? "").trim();
    if (platform && !tenant) {
      setError("Enter the government platform tenant before saving.");
      return;
    }
    await act(`Saved source settings for ${location.name}.`, () =>
      api(`locations/${encodeURIComponent(location.id)}/sources`, {
        method: "PATCH",
        body: JSON.stringify({
          systems: location.systems.map((system) => ({
            fscskey: system.fscskey,
            website: String(form.get(`website-${system.fscskey}`) ?? "").trim() || null,
          })),
          government: platform ? { platform, tenant } : null,
        }),
      }));
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
          <h2>Health</h2>
          <button disabled={busy || !locations.length}
            onClick={() => void act("Started a run for every location.", () => api("ingestion", { method: "POST" }))}>
            Run all locations
          </button>
        </div>
        {health && (
          <p>
            Overall: <strong>{health.status}</strong>
            {" · "}Scheduler: <strong>{health.scheduler.status}</strong>
            {health.scheduler.seconds_since_tick !== null && ` (last tick ${health.scheduler.seconds_since_tick}s ago)`}
            {" · "}Model: <strong>{health.model ? `${health.model.status} (${health.model.provider}/${health.model.name})` : "not configured"}</strong>
            {health.model?.detail && health.model.status !== "ok" && ` — ${health.model.detail}`}
            {health.model?.providers && ` [${health.model.providers.map((item) => `${item.name}/${item.model}: ${item.status}`).join(", ")}]`}
            {" · "}Queue: {health.queue.pending} pending, {health.queue.running} running, {health.queue.failed} failed
            {" · "}Locations: {health.totals.ok} ok, {health.totals.warning} warning, {health.totals.failed} failed, {health.totals.never_run} never run
          </p>
        )}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Location</th><th>Health</th><th>Stage</th><th>Sources ok/failed/total</th><th>Published / held</th><th>Problems</th><th>Started</th><th /></tr></thead>
            <tbody>{health?.locations.map((row) => (
              <tr key={row.location_id}>
                <td>{row.location_name}</td>
                <td><span className={`state ${row.level === "ok" ? "active" : ""}`}>{row.level}</span></td>
                <td>{row.stage}</td>
                <td>{row.sources.completed}/{row.sources.failed}/{row.sources.total}</td>
                <td>{row.published_items ?? "—"} / {row.held ?? "—"}</td>
                <td>
                  {[row.error, ...row.model_errors, ...row.failed_sources.map((source) => `${source.name}: ${source.error ?? "failed"}`)]
                    .filter(Boolean).join("; ") || "—"}
                </td>
                <td>{time(row.started_at)}</td>
                <td>
                  <button className="secondary" disabled={busy}
                    onClick={() => void act(`Started ${row.location_name}.`, () =>
                      api(`locations/${encodeURIComponent(row.location_id)}/ingestion`, { method: "POST" }))}>Run</button>
                  {row.run_id && <button className="secondary" onClick={() => void openRun(row.run_id!, row.location_id)}>Details</button>}
                  <button className="secondary" disabled={busy}
                    onClick={() => void act(`Links for ${row.location_name} will be rediscovered on the next run.`, () =>
                      api(`locations/${encodeURIComponent(row.location_id)}/links`, { method: "DELETE" }))}>Refresh links</button>
                  <button className="secondary" disabled={busy}
                    onClick={() => window.confirm(`Remove ${row.location_name}?`) && void act(`Removed ${row.location_name}.`, () =>
                      api(`locations/${encodeURIComponent(row.location_id)}`, { method: "DELETE" }))}>Remove</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
          {health && !health.locations.length && <p>No locations onboarded yet.</p>}
        </div>
      </section>

      {detail && (
        <section className="panel">
          <div className="section-heading">
            <h2>{detail.run.location_name} · {detail.run.status} · {detail.run.window.join(" to ")}</h2>
            <button className="secondary" onClick={() => setDetail(null)}>Close</button>
          </div>
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
            <thead><tr><th>Job</th><th>Status</th><th>Attempts</th><th>Error</th></tr></thead>
            <tbody>{detail.jobs.map((job) => (
              <tr key={job.id}><td>{job.kind}</td><td>{job.status}</td><td>{job.attempts}</td><td>{job.error ?? "—"}</td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      <section className="panel">
        <div className="section-heading">
          <h2>Onboard a location</h2>
          <button className="secondary" disabled={busy}
            onClick={() => void act("Imported Census places and the IMLS library directory.", () =>
              api("directory", { method: "POST" }))}>
            {busy ? "Working…" : "Import Census places and libraries"}
          </button>
        </div>
        <form className="channel-form" onSubmit={(event) => void search(event)}>
          <label className="field">
            <span>Census place</span>
            <input value={query} minLength={2} required placeholder="Auburn, WA" onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div><button type="submit" className="secondary">Search</button></div>
        </form>
        {places && !places.length && <p>No matching places. Has the Census place list been imported?</p>}
        {places?.map((place) => (
          <p key={place.id}>
            {place.name} · {place.system_count} library system(s), {place.branch_count} branch(es){" "}
            <button disabled={busy || locations.some((location) => location.id === place.id)}
              onClick={() => void act(`Onboarded ${place.name}.`, () => api("locations", {
                method: "POST",
                body: JSON.stringify({ place_id: place.id }),
              }))}>
              {locations.some((location) => location.id === place.id) ? "Onboarded" : "Onboard"}
            </button>
          </p>
        ))}
      </section>

      <section className="panel">
        <h2>Location sources</h2>
        {locations.map((location) => (
          <details key={location.id}>
            <summary>{location.name}</summary>
            <form className="location" onSubmit={(event) => void saveSources(event, location)}>
              {location.systems.map((system) => (
                <label className="field" key={system.fscskey}>
                  <span>{system.name} <small>({system.fscskey})</small></span>
                  <input name={`website-${system.fscskey}`} type="url" inputMode="url" pattern="https://.*"
                    placeholder="https://library.example.org" defaultValue={system.website ?? ""} />
                </label>
              ))}
              <div className="government">
                <label className="field">
                  <span>Government platform</span>
                  <select name="platform" defaultValue={location.government?.platform ?? ""}>
                    <option value="">Disabled / none</option>
                    <option value="legistar">Legistar</option>
                    <option value="civicclerk">CivicClerk</option>
                  </select>
                </label>
                <label className="field">
                  <span>Platform tenant</span>
                  <input name="tenant" autoComplete="off" pattern="[a-z0-9][a-z0-9-]{0,62}"
                    defaultValue={location.government?.tenant ?? ""} placeholder="cityname" />
                </label>
              </div>
              <button className="secondary" type="submit" disabled={busy}>Save source settings</button>
            </form>
          </details>
        ))}
      </section>
    </>
  );
}
