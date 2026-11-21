"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import type { NewsroomDirectoryEntry } from "@/pipeline/orchestration/output-channels";

export default function NewsroomManagement() {
  const [directory, setDirectory] = useState<NewsroomDirectoryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<NewsroomDirectoryEntry | null>(null);
  const load = useCallback(async () => {
    const data = await adminApi<{ directory: NewsroomDirectoryEntry[] }>("output-channels");
    setDirectory(data.directory);
  }, []);
  useEffect(() => { void load().catch((cause: Error) => setError(cause.message)); }, [load]);
  async function changeArchive(channel: NewsroomDirectoryEntry) {
    setBusy(true); setError(""); setNotice("");
    try {
      await adminApi("output-channels", {
        method: channel.archivedAt === null ? "DELETE" : "PATCH",
        body: JSON.stringify({ id: channel.id, lifecycleRevision: channel.lifecycleRevision,
          ...(channel.archivedAt === null ? {} : { action: "restore" }) }),
      });
      setSelected(null);
      setNotice(`${channel.name} ${channel.archivedAt === null ? "archived" : "restored"}. Published history retained.`);
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      try { await load(); setSelected(null); }
      catch (reload) { setError(`${message} Reload failed: ${reload instanceof Error ? reload.message : String(reload)}`); return; }
      setError(message);
    } finally { setBusy(false); }
  }
  const current = directory?.filter((channel) => channel.archivedAt === null) ?? [];
  const archived = directory?.filter((channel) => channel.archivedAt !== null) ?? [];
  const rows = (channels: NewsroomDirectoryEntry[]) => channels.map((channel) => <li className="location-directory-row" key={channel.id}>
      <div className="location-directory-copy">
        <h3>{channel.name}</h3>
        <p>{channel.archivedAt !== null ? "Archived" : channel.enabled ? "Active" : "Disabled"} · {channel.selectedLocationIds.length} communities · {channel.accessMode === "direct" ? "Direct access" : "Inspection only · no membership"}</p>
        {selected?.id === channel.id && <div role="group" aria-label={`Confirm archive change for ${channel.name}`}>
          <p>{channel.archivedAt === null
            ? "Archive stops future publishing without deleting editions, release pointers, assignments or audit history. Previously public editions remain readable. This can be reversed."
            : "Restore retains assignments and history and returns the newsroom to its pre-archive enabled or disabled state. It does not restart work."}</p>
          <button disabled={busy} onClick={() => void changeArchive(channel)}>{channel.archivedAt === null ? "Confirm archive" : "Confirm restore"}</button>
          <button className="secondary" disabled={busy} onClick={() => setSelected(null)}>Cancel</button>
        </div>}
      </div>
      <div className="location-directory-actions">
        <Link className="button secondary" href={`/newsroom/${encodeURIComponent(channel.id)}`}>{channel.archivedAt !== null ? "Inspect retained newsroom" : channel.accessMode === "direct" ? "Open newsroom" : "Inspect newsroom"}</Link>
        <Link href={`/admin/access?publicationId=${encodeURIComponent(channel.id)}`}>People &amp; assignments</Link>
        <Link href={`/admin/publication-governance?publicationId=${encodeURIComponent(channel.id)}`}>Activity & governance</Link>
        <details>
          <summary>Maintenance</summary>
          <p><Link href={`/admin/publications/${encodeURIComponent(channel.id)}`}>Delivery &amp; storage</Link></p>
          <button className="secondary" disabled={busy} onClick={() => setSelected(channel)}>{channel.archivedAt === null ? "Archive newsroom" : "Restore newsroom"}</button>
        </details>
      </div>
    </li>);
  return <section className="panel" aria-labelledby="newsroom-directory-title">
    <div className="section-heading"><h2 id="newsroom-directory-title">Newsroom directory</h2>
      <button className="secondary" disabled={busy} onClick={() => void load().then(() => setError("")).catch((cause: Error) => setError(cause.message))}>Refresh directory</button>
    </div>
    <p>Global management does not grant editorial membership. Inspection is read-only unless deliberate support is entered.</p>
    {error && <p className="alert" role="alert">{error} <button disabled={busy} onClick={() => void load().then(() => setError("")).catch((cause: Error) => setError(cause.message))}>Reload directory</button></p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!directory && !error && <p role="status">Loading newsrooms...</p>}
    {directory?.length === 0 && <p>No newsrooms yet. Create one below.</p>}
    {directory && directory.length > 0 && current.length === 0 && <p>No current newsrooms. Archived destinations are retained below.</p>}
    {current.length > 0 && <ul className="location-directory-list" aria-label="Current newsrooms">{rows(current)}</ul>}
    {archived.length > 0 && <details open={selected?.archivedAt != null}>
      <summary>Archived newsrooms &amp; legacy destinations ({archived.length})</summary>
      <p>Retained history and maintenance only. Restore is deliberate and does not restart work.</p>
      <ul className="location-directory-list" aria-label="Archived newsrooms and legacy destinations">{rows(archived)}</ul>
    </details>}
  </section>;
}
