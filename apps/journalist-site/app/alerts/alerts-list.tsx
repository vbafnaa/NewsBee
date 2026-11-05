"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";

type Alert = { id: string; severity: string; location_id: string | null; location_name: string | null; kind: string; message: string; fix: string; at: number | null; link: string };

export default function AlertsList({ locationId }: { locationId?: string }) {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState("");
  const [location, setLocation] = useState<string | null>(null);
  useEffect(() => {
    const value = locationId ?? new URLSearchParams(window.location.search).get("location");
    setLocation(value);
    adminApi<{ alerts: Alert[] }>(`alerts${value ? `?location=${encodeURIComponent(value)}` : ""}`).then((data) => setAlerts(data.alerts)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [locationId]);
  return <section className="panel">
    {error && <p className="alert" role="alert">{error}</p>}
    {location && !locationId && <p><Link href={`/locations/${encodeURIComponent(location)}?tab=review`}>Open location workspace</Link> · <Link href="/alerts">Show all locations</Link></p>}
    {alerts === null ? <p>Loading…</p> : !alerts.length ? <p>No open alerts.</p> : <ul className="alert-list">{alerts.map((alert) => <li key={alert.id}>
      <span><span className={`status-badge tone-${alert.severity}`}>{alert.severity}</span> {alert.location_name && <strong>{alert.location_name}: </strong>}{alert.message}</span>
      <small>{alert.kind.replaceAll("_", " ")}{alert.at ? ` · ${new Date(alert.at * 1000).toLocaleString()}` : ""} · {alert.fix} <Link href={alert.link}>Open</Link></small>
    </li>)}</ul>}
  </section>;
}
