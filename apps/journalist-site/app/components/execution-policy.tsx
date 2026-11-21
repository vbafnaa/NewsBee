"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import type { RunOptions } from "@/pipeline/core/run-values";
import type { ExecutionBinding } from "@/pipeline/accounts/execution";

export function RunExecutionSummary({ run }: { run?: { execution?: ExecutionBinding; trigger?: { by: string } } }) {
  if (!run) return null;
  const binding = run.execution;
  if (!binding) return <p className="notice">Legacy run: no credential sponsor is bound. Paid work is blocked until explicit owner recovery.</p>;
  return <aside className="notice" aria-label="Run execution funding">
    <p>Started by <strong>{binding.sponsorEmail ?? run.trigger?.by ?? binding.sponsorId}</strong> · {binding.source === "platform"
      ? "Newsbee-managed providers"
      : `${binding.source === "environment" ? "deployment default keys" : "their own API keys"} · API settings version ${binding.credentialVersion}`}</p>
  </aside>;
}

export type RunPermission = { canSpend: boolean; canRestart: boolean; restartReason: string | null; canReconnect: boolean; canClaim: boolean; reason: string | null; paused: string | null };
export type ExecutionPolicy = {
  credentialSource?: "personal" | "environment" | "platform" | null;
  principal: { id: string; email: string; role: "owner" | "editor" };
  reasons: string[]; editionReasons: string[]; mapReasons: string[]; canStart: boolean; canStartEdition: boolean; canStartMap: boolean; permissions: Record<string, RunPermission>;
  blocker: {
    id: string; locationId: string; locationName: string; status: string; paused: string | null;
    kind: "run" | "publication_child" | "publication_generation" | "inactive_publication_generation";
    publicationGenerationId: string | null; href: string | null;
  } | null;
};
export function executionDisabledReason(policy: ExecutionPolicy | null, error: string | undefined, action: "edition" | "map" | "restart" | "spend", runId?: string): string | null {
  if (error) return `Execution readiness unavailable: ${error}`;
  if (!policy) return "Checking execution access. Wait for readiness to load.";
  if (action === "restart" || action === "spend") {
    const permission = runId ? policy.permissions[runId] : undefined;
    if (!permission) return "Run access is unavailable. Reload the location pipeline.";
    return action === "restart" ? permission.canRestart ? null : permission.restartReason ?? "Only a completed, failed or cancelled run can be restarted."
      : permission.canSpend ? null : permission.reason ?? "Paid work is unavailable for this run. Inspect its execution notice.";
  }
  const reasons = [...(action === "map" ? policy.mapReasons : policy.editionReasons)];
  if (policy.blocker) reasons.push(`Newsroom slot held by ${policy.blocker.locationName} (${policy.blocker.paused ? "paused" : policy.blocker.status.replaceAll("_", " ")}). ${policy.blocker.href ? `Open ${policy.blocker.href}; finish or cancel it first.` : "Combined draft context is unavailable. Ask the workspace operator to inspect its parent generation."}`);
  return reasons.join(" ") || null;
}
export function useExecutionPolicy(options?: RunOptions | null, runId?: string | null) {
  const serialized = options ? JSON.stringify(options) : "";
  const identity = JSON.stringify([serialized, runId ?? null]);
  const requestId = useRef(0);
  const [result, setResult] = useState<{ identity: string; policy?: ExecutionPolicy; error?: string } | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const id = ++requestId.current;
    const params = new URLSearchParams();
    if (serialized) params.set("options", serialized);
    if (runId) params.set("run", runId);
    try {
      const policy = await adminApi<ExecutionPolicy>(`execution${params.size ? `?${params}` : ""}`, { signal });
      if (!signal?.aborted && id === requestId.current) setResult({ identity, policy });
    } catch (cause) { if (!signal?.aborted && id === requestId.current) setResult({ identity, error: cause instanceof Error ? cause.message : String(cause) }); }
  }, [serialized, runId, identity]);
  useEffect(() => {
    const controller = new AbortController();
    const changed = () => void refresh(controller.signal);
    changed();
    const timer = window.setInterval(changed, 10000);
    window.addEventListener("newsbee:runs-changed", changed);
    return () => { controller.abort(); requestId.current += 1; window.clearInterval(timer); window.removeEventListener("newsbee:runs-changed", changed); };
  }, [refresh]);
  return { policy: result?.identity === identity ? result.policy ?? null : null, error: result?.identity === identity ? result.error ?? "" : "", refresh };
}
export function ExecutionNotice({ policy, error, runId, refresh, compact = false }: { policy: ExecutionPolicy | null; error?: string; runId?: string; refresh?: () => Promise<void>; compact?: boolean }) {
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const permission = runId ? policy?.permissions[runId] : null;
  async function reconnect(action: "reconnect" | "claim") {
    setBusy(true); setActionError("");
    try {
      await adminApi("execution", { method: "POST", body: JSON.stringify({ action, runId }) });
      await refresh?.();
      window.dispatchEvent(new Event("newsbee:runs-changed"));
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  if (compact && policy && !error && !policy.blocker && !policy.reasons.length && !permission?.reason
    && !permission?.restartReason && !permission?.canReconnect && !permission?.canClaim && !actionError) return null;
  return <section className="notice" aria-label="Execution access">
    {error && <p role="alert">{error}</p>}
    {!policy && !error && <p role="status">Checking execution access...</p>}
    {policy?.blocker && <p>Newsroom slot held by {policy.blocker.href ? <Link href={policy.blocker.href}>{policy.blocker.locationName}</Link> : policy.blocker.locationName}: {policy.blocker.paused ? "paused" : policy.blocker.status.replaceAll("_", " ")}. Queued and editor-waiting work also holds the slot.{!policy.blocker.href && " Combined draft context is unavailable. Ask the workspace operator to inspect its parent generation."}</p>}
    {!!policy?.reasons.length && <p>{policy.reasons.join(" ")} Ask the workspace operator to check deployment provider settings.</p>}
    {!compact && <p>New manual runs use Newsbee-managed model and search providers. Journalists do not need personal API keys; run budgets and deployment provider policy still gate every provider-backed action.</p>}
    {permission?.reason && <p>{permission.reason}</p>}
    {permission?.restartReason && permission.restartReason !== permission.reason && <p>Restart: {permission.restartReason}</p>}
    {permission?.canReconnect && <button className="secondary" disabled={busy} onClick={() => void reconnect("reconnect")}>Reconnect this run to current execution settings</button>}
    {permission?.canClaim && <button className="secondary" disabled={busy} onClick={() => void reconnect("claim")}>Owner: explicitly claim this legacy run</button>}
    {actionError && <p role="alert">{actionError}</p>}
  </section>;
}
