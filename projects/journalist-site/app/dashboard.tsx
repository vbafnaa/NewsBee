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
type AdminAccount = { email: string; enabled: boolean };

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
  const [adminAccounts, setAdminAccounts] = useState<AdminAccount[]>([]);
  const [adminAccountsLoaded, setAdminAccountsLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [locationData, jobData, channelData, adminData] = await Promise.all([
        request<{ locations: Location[] }>("locations"),
        request<{ jobs: Job[] }>("jobs"),
        request<{ channels: Channel[] }>("channels"),
        fetch("/api/journalist-admins", { cache: "no-store" }).then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
          return data as { accounts: AdminAccount[] };
        }),
      ]);
      setLocations(locationData.locations);
      setJobs(jobData.jobs);
      setChannels(channelData.channels);
      setAdminAccounts(adminData.accounts);
      setAdminAccountsLoaded(true);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
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

  async function addAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/journalist-admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(formData.get("admin-email") ?? "") }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
      setNotice(`Admin access enabled for ${data.account.email}.`);
      form.reset();
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
            <h2>Administrator access</h2>
            <p>Only listed accounts can sign in to this journalist workspace.</p>
          </div>
        </div>
        <form className="admin-form" onSubmit={(event) => void addAdmin(event)}>
          <label className="field" htmlFor="admin-email">
            <span>Google account email</span>
            <input id="admin-email" name="admin-email" type="email" autoComplete="email"
              placeholder="editor@example.com" required maxLength={254} />
          </label>
          <button type="submit" disabled={busy}>Add administrator</button>
        </form>
        <div className="admin-list">
          {adminAccounts.map((account) => (
            <div className="admin-row" key={account.email}>
              <span>{account.email}</span>
              <span className={account.enabled ? "state active" : "state"}>
                {account.enabled ? "Can sign in" : "Disabled"}
              </span>
            </div>
          ))}
          {adminAccounts.length === 0 && (
            <p>{adminAccountsLoaded ? "No administrator accounts found." : "Loading administrator accounts..."}</p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Input sources</h2>
            <p>HTTPS library websites and supported local-government meeting platforms.</p>
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
