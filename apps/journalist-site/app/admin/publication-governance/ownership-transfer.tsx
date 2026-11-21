"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type Ownership = {
  revision: number;
  ownerId: string;
  candidates: Array<{ principalId: string; email: string }>;
};

export default function OwnershipTransfer({ publicationId }: { publicationId: string }) {
  const [ownership, setOwnership] = useState<Ownership | null>(null);
  const [successorId, setSuccessorId] = useState("");
  const [formerOwnerMembership, setFormerOwnerMembership] = useState<"" | "retain" | "remove">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const endpoint = `/api/admin/publications/${encodeURIComponent(publicationId)}/ownership`;

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(endpoint, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail ?? "Ownership could not be loaded");
    if (!signal?.aborted) setOwnership(data);
  }, [endpoint]);

  useEffect(() => {
    const controller = new AbortController();
    setOwnership(null); setSuccessorId(""); setFormerOwnerMembership(""); setReason(""); setError(""); setNotice("");
    void load(controller.signal).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ownership || !formerOwnerMembership) return;
    if (!window.confirm("Transfer this publication's ownership with the selected former-owner membership outcome? Content and releases are preserved.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: ownership.revision, successorId, formerOwnerMembership, reason }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? "Ownership transfer failed");
      setOwnership((current) => current ? { ...current, ownerId: data.ownerId, revision: data.revision } : current);
      setSuccessorId(""); setFormerOwnerMembership(""); setReason("");
      setNotice("Ownership transferred. Publication identity, content and releases are unchanged.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <details className="panel">
      <summary>Transfer ownership</summary>
      <p>Workspace owner only. First deliberately assign an enabled journalist or admin through Access policies. Resolve active work before transferring.</p>
      <button type="button" className="secondary" disabled={busy} onClick={() => {
        setBusy(true);
        void load().then(() => setError("")).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
      }}>Reload current ownership (keep form)</button>
      {ownership && <form onSubmit={submit}>
        <p>Current owner: {ownership.ownerId} · Lifecycle revision: {ownership.revision}</p>
        <fieldset disabled={busy}>
          <label>Assigned successor
            <select required value={successorId} onChange={(event) => setSuccessorId(event.target.value)}>
              <option value="">Choose an assigned successor</option>
              {ownership.candidates.filter((candidate) => candidate.principalId !== ownership.ownerId).map((candidate) =>
                <option key={candidate.principalId} value={candidate.principalId}>{candidate.email}</option>)}
            </select>
          </label>
          <label>Former owner's publication membership
            <select required value={formerOwnerMembership} onChange={(event) => {
              const value = event.target.value;
              if (value === "" || value === "retain" || value === "remove") setFormerOwnerMembership(value);
            }}>
              <option value="">Choose an explicit outcome</option>
              <option value="retain">Retain as an assigned journalist</option>
              <option value="remove">Remove publication membership</option>
            </select>
          </label>
          <label>Transfer reason
            <input required maxLength={150} value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <button type="submit" disabled={!successorId || successorId === ownership.ownerId || !formerOwnerMembership || !reason.trim()
            || !ownership.candidates.some((candidate) => candidate.principalId === successorId)}>Transfer ownership</button>
        </fieldset>
      </form>}
    </details>
  </>;
}
