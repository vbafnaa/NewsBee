"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import OwnershipTransfer from "./ownership-transfer";

type Support = { id: string; reason: string; enteredAt: number; expiresAt: number };
type AuditRecord = {
  kind: "access_policy" | "publication"; recordType?: "access" | "change";
  id: string; at: number; action: string; publicationId?: string;
  actor: { principalId: string; email: string; role?: string };
  target?: { principalId: string; email: string }; resourceId?: string;
  previousOwner?: { principalId: string; email: string }; formerOwnerMembership?: "retain" | "remove";
  reason?: string; detail?: string; entryIntegrity: boolean;
  integrityStatus?: "verified" | "mismatch" | "legacy_unknown";
  before?: { role: string; enabled: boolean; publicationIds: string[] } | null;
  after?: { role: string; enabled: boolean; publicationIds: string[] } | null;
};
type AuditPage = { records: AuditRecord[]; nextCursor: string | null; restoreEvidence?: Array<{
  action: string; atMilliseconds: number | null; owner?: { id: string | null; email: string | null };
  restoreId: string | null; epoch: number | null; archiveHash: string | null; governanceRollback: boolean | null;
  sourceCreatedAt: string | null; collections: string[]; detail?: string;
  result?: { collections: number | null; documents: number | null; artifactFiles: number | null };
}> };

async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method, cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail ?? "Governance request failed.");
  return data as T;
}

export default function GovernancePanel({ owner, publications, initialPublicationId }: {
  owner: boolean; publications: Array<{ id: string; name: string; accessMode?: "direct" | "inspection" }>; initialPublicationId?: string;
}) {
  const [publicationId, setPublicationId] = useState(publications.some((item) => item.id === initialPublicationId) ? initialPublicationId! : publications[0]?.id ?? "");
  const direct = publications.find((item) => item.id === publicationId)?.accessMode === "direct";
  const [support, setSupport] = useState<Support | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [audit, setAudit] = useState<AuditPage | null>(null);
  const [auditError, setAuditError] = useState("");
  const [auditBusy, setAuditBusy] = useState(false);
  const [filters, setFilters] = useState({ publicationId: "", actorId: "", targetId: "", action: "", from: "", to: "", kind: "" });
  const supportVersion = useRef(0);
  const auditVersion = useRef(0);
  const appliedFilters = useRef(filters);
  const supportUrl = `/api/admin/publications/${encodeURIComponent(publicationId)}/support`;
  const load = useCallback(async () => {
    const version = ++supportVersion.current;
    setLoaded(false);
    setSupport(null);
    if (!publicationId || direct) { setLoaded(true); return; }
    try {
      const access = await api<{ support: Support | null }>(`/api/admin/publications/${encodeURIComponent(publicationId)}/support`);
      if (version !== supportVersion.current) return;
      setSupport(access.support);
      setLoaded(true);
    } catch (failure) { if (version === supportVersion.current) throw failure; }
  }, [publicationId, direct]);
  useEffect(() => {
    load().catch((failure) => setError(failure.message));
    return () => { supportVersion.current += 1; };
  }, [load]);
  const loadAudit = useCallback(async (cursor?: string) => {
    const version = ++auditVersion.current;
    const requestedFilters = cursor ? appliedFilters.current : filters;
    setAuditBusy(true);
    setAuditError("");
    try {
      const query = new URLSearchParams({ limit: "30" });
      for (const [key, value] of Object.entries(requestedFilters)) if (value) {
        query.set(key, key === "from" || key === "to" ? String(new Date(value).getTime()) : value);
      }
      if (cursor) query.set("cursor", cursor);
      const next = await api<AuditPage>(`/api/admin/audit?${query}`);
      if (version !== auditVersion.current) return;
      appliedFilters.current = requestedFilters;
      setAudit(next);
    } catch (failure) { if (version === auditVersion.current) setAuditError((failure as Error).message); }
    finally { if (version === auditVersion.current) setAuditBusy(false); }
  }, [filters]);
  // Filter changes are explicit; audit browsing itself must not generate publication-read audit events.
  useEffect(() => { if (owner) void loadAudit(); }, [owner]); // eslint-disable-line react-hooks/exhaustive-deps
  async function mutate(operation: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await operation();
      await load();
      if (owner) await loadAudit();
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <section className="panel">
      <label className="field">Publication<select value={publicationId} disabled={busy} onChange={(event) => {
        setPublicationId(event.target.value); setError(""); setReason("");
      }}>
        {publications.map((publication) => <option key={publication.id} value={publication.id}>{publication.name}</option>)}
      </select></label>
      {publicationId && <div className="card-actions"><Link href={`/newsroom/${encodeURIComponent(publicationId)}`}>{direct ? "Open newsroom" : "Inspect newsroom"}</Link><Link href={`/admin/access?publicationId=${encodeURIComponent(publicationId)}`}>Manage journalists</Link></div>}
      <h2>Publication-bound support</h2>
      <p>Support writes are audited and expire after 30 minutes.</p>
      {direct ? <p role="status">You have direct newsroom access. Support elevation is not needed.</p> : support ? <div role="status">
        <p>Support reason: {support.reason}</p>
        <p>Entered {new Date(support.enteredAt).toLocaleString()}; expires {new Date(support.expiresAt).toLocaleString()}.</p>
        <button disabled={busy || !loaded} onClick={() => void mutate(() => api(supportUrl, "DELETE"))}>Exit support</button>
      </div> : <form onSubmit={(event) => {
        event.preventDefault();
        void mutate(() => api(supportUrl, "POST", { reason }));
      }}>
        <label className="field">Support reason<textarea value={reason} minLength={10} maxLength={300} required disabled={busy || !loaded}
          onChange={(event) => setReason(event.target.value)} /></label>
        <button disabled={busy || !loaded || !publicationId}>Enter support for this publication</button>
      </form>}
      {error && <p className="alert" role="alert">{error}</p>}
      {!loaded && publicationId && <button className="secondary" disabled={busy} onClick={() => load().catch((failure) => setError(failure.message))}>Reload governance</button>}
    </section>
    {owner && publicationId && <OwnershipTransfer key={publicationId} publicationId={publicationId} />}
    {owner && auditError && <p className="alert" role="alert">{auditError}</p>}
    {owner && audit?.records.some((record) => !record.entryIntegrity) && <p className="alert" role="alert">Some audit entries could not be verified. Open Audit history for details.</p>}
    {owner && <details className="panel">
      <summary>Audit history</summary>
      <p>Historical actor and target snapshots; times shown from epoch milliseconds. Checksums verify each entry only—not a global chain or completeness.</p>
      <form onSubmit={(event) => { event.preventDefault(); void loadAudit(); }}>
        <div className="form-grid">
          {(["publicationId", "actorId", "targetId", "action"] as const).map((key) => <label className="field" key={key}>{key}
            <input maxLength={200} value={filters[key]} onChange={(event) => setFilters({ ...filters, [key]: event.target.value })} /></label>)}
          {(["from", "to"] as const).map((key) => <label className="field" key={key}>{key}<input type="datetime-local" value={filters[key]}
            onChange={(event) => setFilters({ ...filters, [key]: event.target.value })} /></label>)}
          <label className="field">Record kind<select value={filters.kind} onChange={(event) => setFilters({ ...filters, kind: event.target.value })}>
            <option value="">All</option><option value="access_policy">Account access</option><option value="publication">Publication access and changes</option>
          </select></label>
        </div>
        <button disabled={auditBusy}>Apply filters</button>
      </form>
      {auditBusy && <p role="status">Loading audit history...</p>}
      <ul>{audit?.records.map((record) => <li key={`${record.kind}:${record.id}`}>
        <p><time dateTime={new Date(record.at).toISOString()}>{new Date(record.at).toLocaleString()}</time> · {record.kind}{record.recordType ? ` / ${record.recordType}` : ""} · {record.action}</p>
        <p>Actor: {record.actor.email} ({record.actor.principalId}){record.target && ` · Target: ${record.target.email} (${record.target.principalId})`}</p>
        {record.publicationId && <p>Publication: {record.publicationId}{record.resourceId && ` · Resource: ${record.resourceId}`}</p>}
        {record.previousOwner && <p>Previous owner: {record.previousOwner.email} ({record.previousOwner.principalId}); membership {record.formerOwnerMembership ?? "not recorded"}</p>}
        {(record.reason || record.detail) && <p>{record.reason ?? record.detail}</p>}
        {record.before && <p>Before: {record.before.role}, {record.before.enabled ? "enabled" : "disabled"}; assigned {record.before.publicationIds.join(", ") || "none"}</p>}
        {record.after && <p>After: {record.after.role}, {record.after.enabled ? "enabled" : "disabled"}; assigned {record.after.publicationIds.join(", ") || "none"}</p>}
        <p>Entry checksum: {record.integrityStatus === "legacy_unknown" ? "Unknown (legacy entry has no checksum)" : record.entryIntegrity ? "verified" : "not verified"}</p>
      </li>)}</ul>
      {audit && !audit.records.length && <p>No matching evidence.</p>}
      {audit?.nextCursor && <button className="secondary" disabled={auditBusy} onClick={() => void loadAudit(audit.nextCursor!)}>Load next 30</button>}
      <h3>Latest 20 restore evidence entries</h3>
      <p>This separate, bounded view is not exhaustive and is not included in account/publication cursor pagination. Restore dates are normalized separately from BSON/ISO timestamps. No restore action is available here.</p>
      <ul>{audit?.restoreEvidence?.map((record, index) => <li key={`${record.restoreId}:${record.action}:${index}`}>
        <p>{record.atMilliseconds === null ? "Unknown timestamp" : new Date(record.atMilliseconds).toLocaleString()} · {record.action}</p>
        {record.owner && <p>Owner: {record.owner.email} ({record.owner.id})</p>}
        <p>Restore: {record.restoreId ?? "not recorded"} · epoch {record.epoch ?? "not recorded"} · governance rollback {record.governanceRollback === null ? "not recorded" : record.governanceRollback ? "yes" : "no"}</p>
        {record.archiveHash && <p>Archive SHA256: <code>{record.archiveHash}</code></p>}
        {record.sourceCreatedAt && <p>Source created: {record.sourceCreatedAt}</p>}
        <p>Collections: {record.collections.join(", ") || "not recorded"}</p>
        {record.result && <p>Result: {record.result.collections ?? "?"} collections, {record.result.documents ?? "?"} documents, {record.result.artifactFiles ?? "?"} artifact files</p>}
        {record.detail && <p>{record.detail}</p>}
      </li>)}</ul>
      {audit && !audit.restoreEvidence?.length && <p>No restore evidence recorded.</p>}
    </details>}
  </>;
}
