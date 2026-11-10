"use client";

import { useState } from "react";
import { adminApi } from "@/lib/admin-client";

export default function LocationRemoval({ locationId, name, pending = false }: { locationId: string; name: string; pending?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <section className="panel" id="remove-location" aria-labelledby="remove-location-heading">
    <h2 id="remove-location-heading">Remove location and generated files</h2>
    <p>Remove <strong>{name}</strong> from the admin workspace and published reader directory. This cannot be undone.</p>
    <p>Deletes this location&apos;s source settings, discovery state, collected items, pipeline jobs and run history, drafts, editions, withdrawals and source suggestions.
      Also deletes its known generated edition JSON, source snapshots, email previews and job logs in the currently configured reader and pipeline folders.</p>
    <p>Keeps shared folders (including empty location folders), other locations, shared caches and configuration, geographic/library directories,
      reader submissions, problem reports, subscriptions, interest and usage/model history.
      Untracked files and files in old or unconfigured folders are not purged. The location may still appear in geographic search.</p>
    <p>Cancel active runs in <a href={`/locations/${encodeURIComponent(locationId)}?tab=edition`}>Collect stories</a> or <a href={`/locations/${encodeURIComponent(locationId)}?tab=collect-sources`}>Collect sources</a> first and wait for any executing worker to finish.
      A run already publishing must finish. No email is sent.</p>
    {pending && <p className="alert" role="alert">Removal is incomplete. This workspace is retained for cleanup only, not new runs or source edits. Retry below to finish; already deleted files are safe to retry.</p>}
    {error && <p className="alert" role="alert">{error}</p>}
    {!confirming ? <button className="secondary" type="button" onClick={() => setConfirming(true)}>
      {pending ? "Retry location removal…" : "Remove this location…"}
    </button> : <form onSubmit={async (event) => {
      event.preventDefault();
      if (busy || confirmation !== locationId) return;
      setBusy(true); setError("");
      try {
        await adminApi(`locations/${encodeURIComponent(locationId)}`, { method: "DELETE" });
        window.location.assign(`/locations?removed=${encodeURIComponent(name)}`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      }
    }}>
      <label className="field">Type the location ID <code>{locationId}</code> to confirm
        <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" disabled={busy} />
      </label>
      <div className="card-actions">
        <button type="submit" disabled={busy || confirmation !== locationId}>{busy ? "Removing location and files…" : "Permanently remove location and files"}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => { setConfirming(false); setConfirmation(""); }}>Keep location</button>
      </div>
    </form>}
  </section>;
}
