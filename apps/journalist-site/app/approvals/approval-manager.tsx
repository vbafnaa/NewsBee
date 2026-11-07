"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { adminApi } from "@/lib/admin-client";
import type { ApprovalView } from "@/pipeline/accounts/execution";

export default function ApprovalManager() {
  const [approvals, setApprovals] = useState<ApprovalView[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const data = await adminApi<{ approvals: ApprovalView[] }>("approvals");
      setApprovals(data.approvals); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, [load]);
  async function decide(id: string, action: "approved" | "rejected" | "revoked") {
    setBusy(true); setError(""); setNotice("");
    try {
      await adminApi("approvals", { method: "POST", body: JSON.stringify({ id, action }) });
      setNotice(action === "approved" ? "Approved only this final-run plan. The requester must explicitly start it from its location pipeline."
        : action === "rejected" ? "Request rejected." : "Admin backup revoked. Already-sent requests cannot be recalled.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const pending = approvals?.filter((approval) => approval.status === "requested") ?? [];
  function cards(rows: ApprovalView[]) {
    return rows.map((approval) => <article className="panel" key={approval._id}>
      <h3>{approval.plan.locationId} / {approval.plan.kind}</h3>
      <p>Sponsor {approval.sponsorEmail} / <strong>{approval.status}{approval.staleReason ? " · stale" : ""}</strong> / final / API version {approval.plan.credentialVersion} / {approval.plan.source}</p>
      <p>Admin LLM backup only for this immutable plan. No Admin search or integration credentials. Requested {new Date(approval.createdAt * 1000).toLocaleString()}.</p>
      {approval.staleReason && <p className="alert">{approval.staleReason}</p>}
      {approval.targetRunId && <p>Reconnect existing run {approval.targetRunId}; not approval for a new run.</p>}
      <details><summary>Immutable plan and budgets</summary><pre>{JSON.stringify(approval.plan, null, 2)}</pre></details>
      {approval.status === "requested" && <>
        <button disabled={busy || Boolean(approval.staleReason)} onClick={() => void decide(approval._id, "approved")}>Approve Admin LLM backup</button>{" "}
        <button className="secondary" disabled={busy} onClick={() => void decide(approval._id, "rejected")}>Reject</button>
      </>}
      {approval.status === "approved" && <button className="secondary" disabled={busy} onClick={() => void decide(approval._id, "revoked")}>Revoke Admin backup</button>}
      <p><Link href={`/locations/${encodeURIComponent(approval.plan.locationId)}?tab=runs${approval.runId || approval.targetRunId ? `&run=${encodeURIComponent((approval.runId ?? approval.targetRunId)!)}` : ""}`}>Open location pipeline</Link></p>
    </article>);
  }
  return <>
    <p className="alert">Admin tokens are for final runs only, never training or tests. Personal models are tried first; the owner's fixed OpenAI endpoint and model are the only backup. Decisions do not start pipelines or reserve the newsroom slot.</p>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!approvals && !error && <p role="status">Loading approval inbox...</p>}
    <section className="panel"><h2>Pending requests ({pending.length})</h2>
      {approvals && !pending.length && <p>No pending requests. Editors request backup beside their configured location pipeline options.</p>}
      {cards(pending)}
    </section>
    <details className="panel"><summary>Reviewed requests ({approvals?.filter((approval) => approval.status !== "requested").length ?? 0})</summary>{cards(approvals?.filter((approval) => approval.status !== "requested") ?? [])}</details>
  </>;
}
