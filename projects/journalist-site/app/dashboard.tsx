"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";

type System = { fscskey: string; name: string; website: string | null };
type Government = { status?: string; platform?: string | null; tenant?: string | null };
type Location = { id: string; name: string; systems: System[]; government: Government | null };
type Job = {
  id: string;
  kind: string;
  location_id: string;
  status: string;
  attempts: number;
  created_at: number;
  error: string | null;
};
type Channel = { id: string; name: string; url: string; enabled: boolean; mode: string };
type ConfiguredSource = {
  id: string;
  category: string;
  name: string;
  location: string;
  url?: string;
  platform?: string;
  tenant?: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/admin/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
  return data as T;
}

function date(value: number) {
  return new Date(value * 1000).toLocaleString();
}

export default function Dashboard() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [configuredSources, setConfiguredSources] = useState<ConfiguredSource[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      request<{ locations: Location[] }>("locations"),
      request<{ jobs: Job[] }>("jobs"),
      request<{ channels: Channel[] }>("channels"),
      fetch("/api/source-configs", { cache: "no-store" }).then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
        return data as { sources: ConfiguredSource[] };
      }),
    ]);

    const failures: string[] = [];
    const recordFailure = (label: string, result: PromiseSettledResult<unknown>) => {
      if (result.status === "rejected") {
        failures.push(`${label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    };

    if (results[0].status === "fulfilled") setLocations(results[0].value.locations);
    else recordFailure("Locations", results[0]);
    if (results[1].status === "fulfilled") setJobs(results[1].value.jobs);
    else recordFailure("Jobs", results[1]);
    if (results[2].status === "fulfilled") setChannels(results[2].value.channels);
    else recordFailure("Channels", results[2]);
    if (results[3].status === "fulfilled") setConfiguredSources(results[3].value.sources);
    else recordFailure("Source configs", results[3]);

    setError(failures.length ? `Some dashboard data could not be loaded. ${failures.join("; ")}` : "");
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function trigger(path: string) {
    setBusy(true);
    setNotice("");
    try {
      const result = await request<{ jobs?: { job_id: string }[]; job_id?: string }>(
        path,
        { method: "POST" },
      );
      const count = result.jobs?.length ?? (result.job_id ? 1 : 0);
      setNotice(`Queued ingestion for ${count} location${count === 1 ? "" : "s"}.`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
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
    setBusy(true);
    setNotice("");
    try {
      await request(`locations/${encodeURIComponent(location.id)}/sources`, {
        method: "PATCH",
        body: JSON.stringify({
          systems: location.systems.map((system) => ({
            fscskey: system.fscskey,
            website: String(form.get(`website-${system.fscskey}`) ?? "").trim() || null,
          })),
          government: platform ? { platform, tenant } : null,
        }),
      });
      setNotice(`Saved source settings for ${location.name}.`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Configured sources</h2>
            <p>Loaded from the MongoDB <code>source_configs</code> collection.</p>
          </div>
        </div>
        {configuredSources === null ? <p>Source list could not be loaded.</p> :
          configuredSources.length === 0 ? <p>No source entries found in MongoDB.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Source</th><th>Type</th><th>Location</th><th>Details</th></tr></thead>
                <tbody>{configuredSources.map((source) => (
                  <tr key={source.id}>
                    <td>{source.name}</td>
                    <td>{source.category}</td>
                    <td>{source.location}</td>
                    <td>
                      {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a> : null}
                      {source.platform ? <span>{source.platform}{source.tenant ? ` (${source.tenant})` : ""}</span> : null}
                      {!source.url && !source.platform ? "—" : null}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Onboarded location settings</h2>
            <p>Manage library websites and supported local-government platforms for onboarded locations.</p>
          </div>
          <button disabled={busy || locations.length === 0} onClick={() => void trigger("ingestion")}>
            Run all locations
          </button>
        </div>
        {locations.length === 0 ? <p>No locations onboarded yet.</p> : locations.map((location) => (
          <form className="location" key={location.id} onSubmit={(event) => void saveSources(event, location)}>
            <div className="section-heading">
              <h3>{location.name}</h3>
              <button className="secondary" type="button" disabled={busy}
                onClick={() => void trigger(`locations/${encodeURIComponent(location.id)}/ingestion`)}>
                Run now
              </button>
            </div>
            {location.systems.map((system) => (
              <label className="field" key={system.fscskey}>
                <span>{system.name} <small>({system.fscskey})</small></span>
                <input name={`website-${system.fscskey}`} type="url" inputMode="url"
                  placeholder="https://library.example.org" defaultValue={system.website ?? ""}
                  pattern="https://.*" />
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
        ))}
      </section>

      <section className="panel">
        <h2>Output channels</h2>
        {channels.map((channel) => (
          <div className="channel" key={channel.id}>
            <div>
              <strong>{channel.name}</strong>
              <p>{channel.mode === "automatic" ? "Published automatically after authoring" : channel.mode}</p>
            </div>
            <a href={channel.url} target="_blank" rel="noreferrer">{channel.url}</a>
            <span className={channel.enabled ? "state active" : "state"}>{channel.enabled ? "Enabled" : "Disabled"}</span>
          </div>
        ))}
        <p className="muted">The reader channel currently follows the backend’s automatic publishing policy.</p>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Recent work</h2>
            <p>Refreshes automatically every 30 seconds.</p>
          </div>
          <button className="secondary" onClick={() => void load()}>Refresh</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Created</th><th>Location</th><th>Job</th><th>Status</th><th>Attempts</th><th>Latest error</th></tr></thead>
            <tbody>{jobs.map((job) => (
              <tr key={job.id}>
                <td>{date(job.created_at)}</td>
                <td>{job.location_id}</td>
                <td>{job.kind}</td>
                <td>{job.status}</td>
                <td>{job.attempts}</td>
                <td>{job.error ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table>
          {jobs.length === 0 && <p>No jobs recorded yet.</p>}
        </div>
      </section>
    </>
  );
}
