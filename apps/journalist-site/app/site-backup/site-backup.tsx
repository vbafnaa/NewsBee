"use client";

import { useRef, useState, type FormEvent } from "react";

const CONFIRMATION = "REPLACE ALL SITE DATA";
const MAX_BACKUP_BYTES = 250 * 1024 * 1024;

export default function SiteBackup() {
  const [file, setFile] = useState<File | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function download() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/site-backup", { cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(body.detail ?? "Could not download the backup.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `newsbee-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Backup downloaded. Store it securely; it contains the site's complete database content.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || confirmation !== CONFIRMATION || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error("The backup exceeds the 250 MB limit.");
      const text = await file.text();
      let archive: unknown;
      try { archive = JSON.parse(text); }
      catch { throw new Error("The selected file is not valid JSON."); }
      const response = await fetch("/api/admin/site-backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: confirmation, archive }),
      });
      const body = await response.json().catch(() => ({})) as { detail?: string; collections?: number; documents?: number; artifactFiles?: number };
      if (!response.ok) throw new Error(body.detail ?? "Could not import the backup.");
      setNotice(`Import complete: ${body.documents?.toLocaleString() ?? 0} document(s) across ${body.collections?.toLocaleString() ?? 0} collection(s), and ${body.artifactFiles?.toLocaleString() ?? 0} artifact file(s).`);
      setFile(null);
      setConfirmation("");
      formRef.current?.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="panel" aria-labelledby="backup-export">
      <h2 id="backup-export">Export site data</h2>
      <p>Downloads one JSON archive containing all non-system MongoDB collections and the app-managed Drive artifacts (including published files and pipeline artifacts). File contents are embedded using Base64 so the archive is self-contained.</p>
      <button type="button" disabled={busy} onClick={() => void download()}>{busy ? "Working…" : "Download complete backup"}</button>
    </section>
    <section className="panel" aria-labelledby="backup-import">
      <h2 id="backup-import">Import a site backup</h2>
      <p>Import replaces all non-system MongoDB data and files inside the configured Newsbee artifact roots. This cannot be undone. Only import a trusted archive, and download a backup of this stack first.</p>
      <form ref={formRef} onSubmit={upload}>
        <label className="field">Single JSON backup file
          <input type="file" accept=".json,application/json" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(""); setNotice(""); }} />
        </label>
        <p>Maximum archive size: 250 MB. Do not edit the file between export and import.</p>
        <label className="field">To confirm replacement, type <code>{CONFIRMATION}</code>
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" disabled={busy} />
        </label>
        <button type="submit" disabled={busy || !file || confirmation !== CONFIRMATION}>{busy ? "Replacing site data…" : "Replace all site data"}</button>
      </form>
    </section>
    <section className="panel">
      <h2>Not included</h2>
      <p>Environment variables and secrets (MongoDB connection settings, API keys, OAuth and Google service-account credentials), external account permissions, and remote services themselves are not exported. Configure those separately on the destination stack. Google Drive artifacts are copied into the archive, but restoring them requires the destination stack's Drive credentials and configured folders.</p>
      <p>Keep backups private: database content may include unpublished editorial work, account records, and personal data.</p>
    </section>
  </>;
}
