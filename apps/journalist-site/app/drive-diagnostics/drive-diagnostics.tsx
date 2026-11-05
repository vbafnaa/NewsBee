"use client";

import { useEffect, useState } from "react";

type Diagnostics = {
  mode: "local" | "cloud";
  serviceAccountEmail: string | null;
  identityError: string | null;
  folderId: string | null;
  folder: {
    name?: string;
    mimeType?: string;
    driveId?: string;
    webViewLink?: string;
    capabilities?: { canAddChildren?: boolean };
  } | null;
  folderError: string | null;
};
type UploadResult = { uploaded: boolean; error: string | null; cleanupError: string | null };

export default function DriveDiagnostics() {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);

  useEffect(() => {
    fetch("/api/admin/drive-diagnostics", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Diagnostics request failed (${response.status})`);
        return response.json() as Promise<Diagnostics>;
      })
      .then(setDiagnostics)
      .catch((error) => setMessage(String(error)))
      .finally(() => setLoading(false));
  }, []);

  async function testUpload() {
    setRunning(true);
    setMessage("");
    setResult(null);
    try {
      const response = await fetch("/api/admin/drive-diagnostics", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? `Upload request failed (${response.status})`);
      setResult(data as UploadResult);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }

  return <section className="panel drive-diagnostics">
    <h2>Pipeline Drive destination</h2>
    {loading && <p>Checking Drive configuration...</p>}
    {diagnostics && <>
      {diagnostics.mode === "local" && <p>Local mode uses a filesystem folder rather than Google Drive.</p>}
      <dl>
        <dt>Service account</dt>
        <dd>{diagnostics.serviceAccountEmail ?? diagnostics.identityError ?? "Not configured"}</dd>
        <dt>Pipeline root folder (NEWSBEE_PIPELINE_DRIVE_FOLDER_ID)</dt>
        <dd><code>{diagnostics.folderId ?? "Not configured"}</code></dd>
        <dt>Folder name</dt>
        <dd>{diagnostics.folder?.name ?? diagnostics.folderError ?? "Unavailable"}</dd>
        <dt>Shared Drive ID</dt>
        <dd>{diagnostics.folder?.driveId ?? "None reported — this may be in My Drive"}</dd>
        <dt>Can add files/folders</dt>
        <dd>{diagnostics.folder?.capabilities?.canAddChildren === undefined
          ? "Unknown" : diagnostics.folder.capabilities.canAddChildren ? "Yes" : "No"}</dd>
      </dl>
      {diagnostics.folder?.webViewLink && <p><a href={diagnostics.folder.webViewLink}
        target="_blank" rel="noopener noreferrer">Open folder in Google Drive</a></p>}
      <p>Job logs are stored under this root in <code>.newsbee-pipeline/logs/</code>. A folder
        shared from someone&apos;s My Drive does not grant storage quota to a service account;
        use a Shared Drive and give this account Contributor access or higher.</p>
      <button type="button" onClick={testUpload} disabled={running || diagnostics.mode !== "cloud" || !diagnostics.folderId}>
        {running ? "Testing upload..." : "Create and remove a test file"}
      </button>
      <p>The test writes a small text file in the configured root using the pipeline upload path,
        then tries to remove it, including if the upload fails.</p>
    </>}
    {result && <div role="status" className={result.uploaded && !result.cleanupError ? "notice" : "alert"}>
      <p>{result.uploaded ? "Upload succeeded." : `Upload failed: ${result.error}`}</p>
      <p>{result.cleanupError ? `Cleanup failed: ${result.cleanupError}` : "No test file remains."}</p>
    </div>}
    {message && <p role="alert" className="alert">{message}</p>}
  </section>;
}
