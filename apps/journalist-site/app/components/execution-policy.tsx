"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import type { RunOptions } from "@/pipeline/core/run-values";
import type { ExecutionBinding } from "@/pipeline/accounts/execution";

export function RunExecutionSummary({ run }: { run?: { execution?: ExecutionBinding; trigger?: { by: string } } }) {
  if (!run) return null;
  const binding = run.execution;
  if (!binding) return <p className="notice">Legacy run: no credential sponsor is bound. Paid work is blocked until explicit owner recovery.</p>;
  return <aside className="notice" aria-label="Whose keys this run uses">
    <p>Started by <strong>{binding.sponsorEmail ?? run.trigger?.by ?? binding.sponsorId}</strong> · {binding.source === "environment" ? "deployment default keys" : "their own API keys"} · API settings version {binding.credentialVersion}</p>
  </aside>;
}

export type RunPermission = { canSpend: boolean; canRestart: boolean; restartReason: string | null; canReconnect: boolean; canClaim: boolean; reason: string | null; paused: string | null };
export type ExecutionPolicy = {
  principal: { id: string; email: string; role: "owner" | "editor" };
  reasons: string[]; editionReasons: string[]; mapReasons: string[]; canStart: boolean; canStartEdition: boolean; canStartMap: boolean; permissions: Record<string, RunPermission>;
  blocker: { id: string; locationId: string; locationName: string; status: string; paused: string | null } | null;
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
  if (policy.blocker) reasons.push(`Newsroom slot held by ${policy.blocker.locationName} (${policy.blocker.paused ? "paused" : policy.blocker.status.replaceAll("_", " ")}). Open /locations/${encodeURIComponent(policy.blocker.locationId)}?tab=edition&run=${policy.blocker.id}; finish or cancel it first.`);
  return reasons.join(" ") || null;
}
export function useExecutionPolicy(options?: RunOptions | null) {
  const serialized = options ? JSON.stringify(options) : "";
  const [result, setResult] = useState<{ serialized: string; policy?: ExecutionPolicy; error?: string } | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const policy = await adminApi<ExecutionPolicy>(`execution${serialized ? `?options=${encodeURIComponent(serialized)}` : ""}`, { signal });
      if (!signal?.aborted) setResult({ serialized, policy });
    } catch (cause) { if (!signal?.aborted) setResult({ serialized, error: cause instanceof Error ? cause.message : String(cause) }); }
  }, [serialized]);
  useEffect(() => {
    const controller = new AbortController();
    const changed = () => void refresh(controller.signal);
    changed();
    const timer = window.setInterval(changed, 10000);
    window.addEventListener("newsbee:runs-changed", changed);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("newsbee:runs-changed", changed); };
  }, [refresh]);
  return { policy: result?.serialized === serialized ? result.policy ?? null : null, error: result?.serialized === serialized ? result.error ?? "" : "", refresh };
}
export function ExecutionNotice({ policy, error, runId, refresh }: { policy: ExecutionPolicy | null; error?: string; runId?: string; refresh?: () => Promise<void> }) {
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
  return <section className="notice" aria-label="Execution access">
    {error && <p role="alert">{error}</p>}
    {!policy && !error && <p role="status">Checking execution access...</p>}
    {policy?.blocker && <p>Newsroom slot held by <Link href={`/locations/${encodeURIComponent(policy.blocker.locationId)}?tab=edition&run=${policy.blocker.id}`}>{policy.blocker.locationName}</Link>: {policy.blocker.paused ? "paused" : policy.blocker.status.replaceAll("_", " ")}. Queued and editor-waiting work also holds the slot.</p>}
    {!!policy?.reasons.length && <p>{policy.reasons.join(" ")} <Link href="/account">My API settings</Link></p>}
    <p>{policy?.principal.role === "owner" ? "The configured owner may use deployment defaults or personal API keys." : "Your runs require your own API keys from Account & API settings; deployment keys are owner-only."} Provider-backed actions stay blocked until their required credentials are configured.</p>
    {permission?.reason && <p>{permission.reason}</p>}
    {permission?.restartReason && permission.restartReason !== permission.reason && <p>Restart: {permission.restartReason}</p>}
    {permission?.canReconnect && <button className="secondary" disabled={busy} onClick={() => void reconnect("reconnect")}>Reconnect this run to my current API settings</button>}
    {permission?.canClaim && <button className="secondary" disabled={busy} onClick={() => void reconnect("claim")}>Owner: explicitly claim this legacy run</button>}
    {actionError && <p role="alert">{actionError}</p>}
  </section>;
}
