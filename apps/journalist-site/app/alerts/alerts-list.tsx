"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";

type Alert = { id: string; severity: string; location_id: string | null; location_name: string | null; kind: string; message: string; fix: string; at: number | null; link: string };

/** What fixes each kind of alert, in the tab that owns it. */
function fixFor(alert: Alert): { label: string; href: string } | null {
  if (!alert.location_id) return alert.kind === "model" ? { label: "See model usage", href: "/health?view=usage" } : null;
  const base = `/locations/${encodeURIComponent(alert.location_id)}`;
  if (["source_blocked", "source_failing"].includes(alert.kind)) return { label: "Review the source", href: alert.link };
  if (["thin_sections", "discovery_failed", "stale_map"].includes(alert.kind)) return { label: "Refresh the source map", href: `${base}?tab=collect-sources` };
  if (["run_stuck", "job_retried"].includes(alert.kind)) return { label: "Open the run", href: alert.link };
  if (alert.kind === "local_drop") return { label: "See what changed", href: alert.link };
  return { label: "Open", href: alert.link };
}

/** A location's alerts. With `actions`, a failing or blocked source can also be paused from here. */
export default function AlertsList({ locationId, actions = false }: { locationId?: string; actions?: boolean }) {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => adminApi<{ alerts: Alert[] }>(`alerts${locationId ? `?location=${encodeURIComponent(locationId)}` : ""}`).then((data) => setAlerts(data.alerts))
    .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))), [locationId]);
  useEffect(() => { void load(); }, [load]);
  async function pause(alert: Alert) {
    const sourceId = alert.id.slice(`source:${alert.location_id}:`.length);
    setBusy(true); setError(""); setNotice("");
    try {
      await adminApi(`locations/${encodeURIComponent(alert.location_id!)}/source-map`, { method: "PATCH", body: JSON.stringify({ source_id: sourceId, status: "paused" }) });
      setNotice("Source paused. It won't be read until it's activated again in Sources.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  return <section className="panel">
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {alerts === null ? <p>Loading…</p> : !alerts.length ? <p>Nothing needs attention.</p> : <ul className="alert-list">{alerts.map((alert) => {
      const fix = fixFor(alert);
      return <li key={alert.id}>
        <span><span className={`status-badge tone-${alert.severity}`}>{alert.severity}</span> {!locationId && alert.location_name && <strong>{alert.location_name}: </strong>}{alert.message}</span>
        <span className="card-actions">
          {fix && <Link className="button secondary" href={fix.href}>{fix.label}</Link>}
          {actions && ["source_blocked", "source_failing"].includes(alert.kind) && alert.id.startsWith("source:") && <button type="button" className="secondary" disabled={busy} onClick={() => void pause(alert)}>Pause source</button>}
        </span>
      </li>;
    })}</ul>}
  </section>;
}
