"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import type { ApprovalView } from "@/pipeline/accounts/execution";
import type { RunOptions } from "@/pipeline/core/run-values";
import ExplainedButton from "./explained-button";

type Data = { approvals: ApprovalView[]; canRequest: boolean; requestReason: string | null };
export default function PipelineApprovals({ locationId, kind = "edition", options, targetRunId, onStarted }: {
  locationId?: string; kind?: "map" | "edition"; options?: RunOptions | null;
  targetRunId?: string; onStarted?: (runId: string) => Promise<void>;
}) {
  const query = targetRunId ? new URLSearchParams({ mine: "1", runId: targetRunId }).toString()
    : locationId && options ? new URLSearchParams({ mine: "1", locationId, kind, options: JSON.stringify(options) }).toString() : "";
  const [result, setResult] = useState<{ query: string; data?: Data; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!query) return;
    try {
      const data = await adminApi<Data>(`approvals?${query}`, { signal });
      if (!signal?.aborted) setResult({ query, data });
    } catch (cause) { if (!signal?.aborted) setResult({ query, error: cause instanceof Error ? cause.message : String(cause) }); }
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    setNotice(""); setActionError("");
    const changed = () => void load(controller.signal);
    changed();
    const timer = window.setInterval(changed, 10000);
    window.addEventListener("newsbee:runs-changed", changed);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("newsbee:runs-changed", changed); };
  }, [load]);
  const data = result?.query === query ? result.data : undefined;
  const error = result?.query === query ? result.error : undefined;
  const outstanding = data?.approvals.some((approval) => approval.matchesPlan && !approval.staleReason && !approval.runId && ["requested", "approved"].includes(approval.status));
  const current = data?.approvals.filter((approval) => approval.matchesPlan && !approval.staleReason && !approval.runId) ?? [];
  const approved = current.find((approval) => approval.status === "approved");
  const status = error ? "Unavailable"
    : !query ? "Configure run options"
    : !data ? "Checking requests..."
    : approved ? approved.canStart ? "Approved · ready to start" : "Approved · blocked"
    : current.some((approval) => approval.status === "requested") ? "Pending owner review"
    : data.approvals.some((approval) => !approval.runId && (approval.staleReason || !approval.matchesPlan) && ["requested", "approved"].includes(approval.status)) ? "Stale request · review"
    : data.canRequest ? "Request approval"
    : !targetRunId && options?.purpose !== "final" ? `${options?.purpose === "training" ? "Training" : "Test"} · not eligible`
    : "Request blocked";
  async function act(action: () => Promise<void>) {
    setBusy(true); setActionError(""); setNotice("");
    try { await action(); await load(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function request() {
    await adminApi("approvals", { method: "POST", body: JSON.stringify({ action: "request", locationId, kind, options, runId: targetRunId }) });
    setNotice("Requested owner approval for this exact final plan and API version. No slot reserved and no pipeline started.");
  }
  async function start(approval: ApprovalView) {
    const approvedOptions = { ...approval.plan.options, admin_approval_id: approval._id };
    const result = await adminApi<{ run_id: string }>(approval.targetRunId ? "execution"
      : `locations/${encodeURIComponent(approval.plan.locationId)}/${approval.plan.kind === "map" ? "map-run" : "ingestion"}`, {
      method: "POST", body: JSON.stringify(approval.targetRunId
        ? { action: "reconnect", runId: approval.targetRunId, approvalId: approval._id }
        : { options: approvedOptions, rebuild: approvedOptions.rebuild }),
    });
    setNotice(targetRunId ? "Reconnected only this approved final run." : "Explicitly started the exact approved final plan.");
    window.dispatchEvent(new Event("newsbee:runs-changed"));
    await onStarted?.(result.run_id);
  }
  return <section aria-label={`Admin backup ${targetRunId ? "reconnect" : kind}`}>
    <details className="location-settings">
    <summary>Admin backup · {targetRunId ? "Reconnect final run" : kind === "map" ? "Source map" : "Edition"} · {status}</summary>
    <div className="notice">
    <p>Final plan and API version only; no Admin search or integration keys. Approval never starts work automatically.</p>
    {!query && <p>Configure the run options above first.</p>}
    {query && !data && !error && <p role="status">Checking your requests...</p>}
    {data?.requestReason && <p>{data.requestReason}</p>}
    <ExplainedButton className="secondary" disabledReason={busy ? "An approval action is in progress." : !query ? "Configure the run options above first." : error ?? (!data ? "Checking your requests." : outstanding ? "A pending or approved request already covers this exact plan. Review its status below." : data.canRequest ? null : data.requestReason ?? "Approval request is unavailable. Reload the pipeline.")} onClick={() => void act(request)}>{targetRunId ? "Request fresh owner approval for reconnect" : `Request owner approval for ${kind === "map" ? "source map" : "edition"}`}</ExplainedButton>
    {data?.approvals.map((approval) => <article key={approval._id}>
      <p><strong>{approval.staleReason || !approval.matchesPlan ? "stale" : approval.status === "requested" ? "pending" : approval.status}</strong> · {approval.sponsorEmail} · API version {approval.plan.credentialVersion} · {approval.plan.source}</p>
      {(approval.staleReason || !approval.matchesPlan) && <p>{approval.staleReason ?? "Run options changed. Request fresh approval for the current plan."}</p>}
      <details><summary>Requested immutable plan and budgets</summary><pre>{JSON.stringify(approval.plan, null, 2)}</pre></details>
      {approval.status === "approved" && !approval.runId && <><ExplainedButton disabledReason={busy ? "An approval action is in progress." : approval.canStart ? null : approval.blockedReason ?? "Approved execution is unavailable. Reload the pipeline."} onClick={() => void act(() => start(approval))}>{targetRunId ? "Reconnect approved final run" : "Start this approved final run"}</ExplainedButton>
        {approval.blockedReason && <p>{approval.blockedReason}</p>}</>}
      {approval.runId && <p><Link href={`/locations/${encodeURIComponent(approval.plan.locationId)}?tab=runs&run=${encodeURIComponent(approval.runId)}`}>Open sponsored run</Link></p>}
    </article>)}
    </div>
    </details>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {actionError && <p role="alert">{actionError}</p>}
  </section>;
}
