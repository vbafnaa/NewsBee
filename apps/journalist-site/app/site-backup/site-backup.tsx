"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { BACKUP_CHUNK_BYTES, BACKUP_MAX_BYTES, BACKUP_STREAM_TYPE, backupResponseError, readBackupTransfer } from "@/lib/site-backup-transfer";

const CONFIRMATION = "REPLACE ALL SITE DATA";
const GOVERNANCE_CONFIRMATION = "ROLL BACK ACCOUNTS AND GOVERNANCE";
type MaintenanceStatus = {
  phase: string; writers: string[]; error?: string; restoreId?: string;
  evidence?: { action: string; at: string; restoreId?: string }[];
};

export default function SiteBackup() {
  const [file, setFile] = useState<File | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [confirmation, setConfirmation] = useState("");
  const [governanceConfirmation, setGovernanceConfirmation] = useState("");
  const [maintenance, setMaintenance] = useState<MaintenanceStatus | null>(null);
  const [activity, setActivity] = useState<"export" | "import" | null>(null);
  const busy = activity !== null;
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const restoreReady = maintenance && ["draining", "failed", "restored"].includes(maintenance.phase) && !maintenance.writers.length;

  async function refreshMaintenance() {
    const response = await fetch("/api/admin/site-backup?maintenance", { cache: "no-store" });
    if (!response.ok) throw new Error(await backupResponseError(response));
    setMaintenance(await response.json() as MaintenanceStatus);
  }
  useEffect(() => { void refreshMaintenance().catch((cause: unknown) => setError(String(cause))); }, []);

  async function changeMaintenance(action: "close" | "open") {
    setError("");
    try {
      const response = await fetch("/api/admin/site-backup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maintenance: action }),
      });
      if (!response.ok) throw new Error(await backupResponseError(response));
      setMaintenance(await response.json() as MaintenanceStatus);
      setNotice(action === "close" ? "Maintenance closed and prior sessions revoked. Sign in again through the configured owner's Google account before refreshing, uploading or restoring. Then refresh until all writers have drained."
        : "Maintenance deliberately reopened. Sign in again before continuing normal work.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function download() {
    if (busy) return;
    setActivity("export");
    setProgress("Starting export...");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/site-backup", {
        cache: "no-store", headers: { Accept: BACKUP_STREAM_TYPE }, signal: AbortSignal.timeout(295_000),
      });
      const parts: string[] = [];
      await readBackupTransfer(response, setProgress, (data) => { parts.push(data); });
      if (!parts.length) throw new Error("The server returned an empty backup.");
      const blob = new Blob(parts, { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `newsbee-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Backup downloaded. Store it securely; it contains the site's complete database content.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setActivity(null); setProgress(""); }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || confirmation !== CONFIRMATION || governanceConfirmation !== GOVERNANCE_CONFIRMATION || !restoreReady || busy) return;
    setActivity("import");
    setProgress("Preparing upload...");
    setError("");
    setNotice("");
    try {
      if (file.size > BACKUP_MAX_BYTES) throw new Error("The backup exceeds the 250 MB limit.");
      const started = await fetch("/api/admin/site-backup/upload", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bytes: file.size }), signal: AbortSignal.timeout(60_000),
      });
      if (!started.ok) throw new Error(await backupResponseError(started));
      const { uploadId } = await started.json() as { uploadId: string };
      for (let offset = 0, part = 0; offset < file.size; offset += BACKUP_CHUNK_BYTES, part += 1) {
        setProgress(`Uploading backup: ${Math.floor(offset / file.size * 100)}%`);
        const chunk = await fetch(`/api/admin/site-backup/upload?id=${encodeURIComponent(uploadId)}&part=${part}`, {
          method: "PUT", headers: { "Content-Type": "application/octet-stream" },
          body: file.slice(offset, offset + BACKUP_CHUNK_BYTES), signal: AbortSignal.timeout(60_000),
        });
        if (!chunk.ok) throw new Error(await backupResponseError(chunk));
      }
      setProgress("Upload complete. Validating before replacement...");
      const response = await fetch("/api/admin/site-backup", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: BACKUP_STREAM_TYPE },
        body: JSON.stringify({ confirm: confirmation, governanceConfirmation, uploadId }),
        signal: AbortSignal.timeout(295_000),
      });
      const body = await readBackupTransfer(response, setProgress);
      if (!body) throw new Error("The server did not confirm that the import completed.");
      setNotice(`Snapshot replaced: ${body.documents.toLocaleString()} document(s) across ${body.collections.toLocaleString()} collection(s), and ${body.artifactFiles.toLocaleString()} artifact file(s). Maintenance remains CLOSED. Sign in again with the configured owner's Google account, inspect restore evidence, then deliberately reopen.`);
      setMaintenance(null);
      setFile(null);
      setConfirmation("");
      formRef.current?.reset();
    } catch (cause) {
      setMaintenance(null);
      setError(`${cause instanceof Error ? cause.message : String(cause)} Maintenance does not automatically reopen. If replacement started, data may be incomplete. Sign in with the configured owner's Google account, inspect the recovery state and restore a known-good backup before reopening.`);
    } finally { setActivity(null); setProgress(""); }
  }

  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {busy && <p className="notice" role="status">{progress}</p>}
    <section className="panel" aria-labelledby="restore-maintenance">
      <h2 id="restore-maintenance">Owner-controlled maintenance</h2>
      <p>Stop older deployments, local scripts and external database writers first. Close admission, then wait for active workers, provider deliveries and writes to drain. Unknown or crashed writers are not assumed safe just because their lease expired.</p>
      <p role="status">State: {maintenance?.phase ?? "not loaded"}; tracked writers: {maintenance?.writers.length ?? "unknown"}.</p>
      {maintenance?.error && <p className="alert" role="alert">{maintenance.error}</p>}
      {maintenance?.restoreId && <p>Restore reference: <code>{maintenance.restoreId}</code></p>}
      <button type="button" disabled={busy} onClick={() => void refreshMaintenance().catch((cause: unknown) => setError(String(cause)))}>Refresh maintenance and evidence</button>{" "}
      <button type="button" disabled={busy || maintenance?.phase !== "open"} onClick={() => void changeMaintenance("close")}>Close admission for maintenance</button>{" "}
      <button type="button" disabled={busy || !maintenance || !["draining", "restored"].includes(maintenance.phase) || Boolean(maintenance.writers.length)} onClick={() => void changeMaintenance("open")}>Deliberately reopen site</button>
      <p>A failed or interrupted restore stays closed. Failed replacements require a successful known-good restore; an interrupted process must be investigated before recovery. The configured owner can sign in through Google even if account collections were only partially restored.</p>
      <p><a href="/login">Sign in again with the configured owner&apos;s Google account</a>, then return to Import and export.</p>
      {maintenance?.evidence?.map((event, index) => <p key={`${event.at}-${index}`}><code>{event.at}</code> {event.action} {event.restoreId}</p>)}
    </section>
    <section className="panel" aria-labelledby="backup-export">
      <h2 id="backup-export">Export site data</h2>
      <p>Downloads one JSON archive containing site MongoDB collections and app-managed artifacts, including governance. Deployment maintenance authority, independent restore evidence and temporary uploads are excluded. File contents are embedded using Base64.</p>
      <button type="button" disabled={busy} onClick={() => void download()}>{activity === "export" ? "Exporting…" : "Download complete backup"}</button>
    </section>
    <section className="panel" aria-labelledby="backup-import">
      <h2 id="backup-import">Import a site backup</h2>
      <p>Import replaces all non-system MongoDB data and files inside the configured Newsbee artifact roots. This cannot be undone. Only import a trusted archive, and download a backup of this stack first.</p>
      <p>This is a FULL governance rollback: accounts, roles, passwords, memberships, publication ownership and normal audit history are replaced. All existing sessions and outstanding setup/recovery links are revoked independently of the snapshot. Restored in-flight work is blocked, not automatically restarted. Independent restore evidence survives.</p>
      <form ref={formRef} onSubmit={upload}>
        <label className="field">Single JSON backup file
          <input type="file" accept=".json,application/json" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(""); setNotice(""); }} />
        </label>
        <p>Maximum archive size: 250 MB. Uploads use 1 MB chunks and are validated on the server before replacement. Temporary uploads expire after one hour. Do not edit the file between export and import.</p>
        <label className="field">To confirm replacement, type <code>{CONFIRMATION}</code>
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" disabled={busy} />
        </label>
        <label className="field">Separately confirm governance rollback by typing <code>{GOVERNANCE_CONFIRMATION}</code>
          <input value={governanceConfirmation} onChange={(event) => setGovernanceConfirmation(event.target.value)} autoComplete="off" disabled={busy} />
        </label>
        <button type="submit" disabled={busy || !file || !restoreReady || confirmation !== CONFIRMATION || governanceConfirmation !== GOVERNANCE_CONFIRMATION}>{activity === "import" ? "Importing…" : "Replace all site data; keep maintenance closed"}</button>
      </form>
    </section>
    <section className="panel">
      <h2>Not included</h2>
      <p>Environment variables and secrets (MongoDB connection settings, API keys, OAuth and Google service-account credentials), external account permissions, and remote services themselves are not exported. Configure those separately on the destination stack. Google Drive artifacts are copied into the archive, but restoring them requires the destination stack's Drive credentials and configured folders.</p>
      <p>Keep backups private: database content may include unpublished editorial work, account records, and personal data.</p>
    </section>
  </>;
}
