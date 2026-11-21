"use client";
import { useEffect, useState } from "react";
import { EMAIL_UNAVAILABLE } from "../../../../shared/email-availability";
type Summary = { configured: boolean; provider: string | null; active: number; pending: number; unsubscribed: number; queued: number; sent: number; failed: number;
  failures: { id: string; kind: string; error: string; attempts: number }[]; previews: { to: string; subject: string; text: string }[];
  publication: {
    subscriptions: Record<string, number>;
    campaigns: number;
    deliveries: Record<string, number>;
    localOutbox: number;
  };
  releaseVideo: {
    desktop: { state: "configured" | "not_configured" | "error"; detail: string | null };
    total: number;
    recent: number;
    statuses: Record<string, number>;
    providers: Record<string, number>;
    funding: Record<string, number>;
    auditEvents: number;
  };
};
const usageCounts = (value: Record<string, number>) => {
  const rows = Object.entries(value);
  return rows.length ? rows.map(([key, count]) => `${key}: ${count}`).join(" · ") : "None";
};
export default function NewsletterDelivery({ videoOnly = false }: { videoOnly?: boolean }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/newsletter", { signal: controller.signal }).then(async (response) => {
      const result = await response.json(); if (!response.ok) throw new Error(result.detail ?? "Could not load delivery status.");
      setSummary(result);
    }).catch((error) => { if (!controller.signal.aborted) setMessage(error.message); });
    return () => controller.abort();
  }, []);
  return <section className="workspace-panel">
    {!videoOnly && <p id="newsletter-unavailable" role="status">{EMAIL_UNAVAILABLE}</p>}
    {message && <p className="alert" role="alert">{message}</p>}
    {!message && !summary && <p role="status">{videoOnly ? "Loading video diagnostics..." : "Loading historical delivery status..."}</p>}
    {!videoOnly && summary && <p>Historical delivery and audience totals. Community preference capture remains available.</p>}
    {summary && <>
      <section className="panel">
        <div className="section-heading"><span className="eyebrow">Release video</span><h2>Desktop Video readiness and usage</h2></div>
        <p><strong>Desktop Video {summary.releaseVideo.desktop.state === "configured"
          ? "configured"
          : summary.releaseVideo.desktop.state === "error"
            ? "configuration error"
            : "not configured"}</strong></p>
        {summary.releaseVideo.desktop.detail && <p className="alert">{summary.releaseVideo.desktop.detail}</p>}
        <p>Non-secret operational totals only. Credential values, credential owner IDs, and credential versions are never returned here.</p>
        <div className="metric-grid">
          <section className="metric-card"><span className="eyebrow">Total release jobs</span><strong>{summary.releaseVideo.total}</strong></section>
          <section className="metric-card"><span className="eyebrow">Created in 30 days</span><strong>{summary.releaseVideo.recent}</strong></section>
          <section className="metric-card"><span className="eyebrow">Usage audit events</span><strong>{summary.releaseVideo.auditEvents}</strong></section>
        </div>
        <p><strong>Providers:</strong> {usageCounts(summary.releaseVideo.providers)}</p>
        <p><strong>Funding:</strong> {usageCounts(summary.releaseVideo.funding)}</p>
        <p><strong>Status:</strong> {usageCounts(summary.releaseVideo.statuses)}</p>
      </section>
      {!videoOnly && <>
      <div className="section-heading"><span className="eyebrow">Community audience</span><h2>Community and location editions</h2></div>
      <div className="metric-grid">{(["active", "pending", "unsubscribed", "queued", "sent", "failed"] as const).map((key) => <section key={key} className="metric-card"><span className="eyebrow">{key === "pending" ? "Awaiting confirmation" : key}</span><strong>{summary[key]}</strong></section>)}</div>
      <p>Existing subscriptions, consent, and delivery history are retained. Nothing is sent or activated, including when provider credentials are configured.</p>
      <p>Historical records only. Email sending, retries and previews are unavailable. No delivery schedule is configured.</p>
      {summary.failures.length > 0 && <section className="panel"><h2>Deliveries needing review</h2><ul>{summary.failures.map((job) => <li key={job.id}>{job.kind}: {job.error} ({job.attempts} attempts)</li>)}</ul><p>Check the provider receipt before resending a delivery whose safe retry window expired.</p></section>}
      <section className="panel">
        <span className="eyebrow">Publication audience</span>
        <h2>Publication releases</h2>
        <p>Publication subscriptions are confirmed and managed separately. Their campaigns can select only immutable releases for the explicitly chosen publication; they never send community editions.</p>
        <div className="metric-grid">
          <section className="metric-card"><span className="eyebrow">Active</span><strong>{summary.publication.subscriptions.active ?? 0}</strong></section>
          <section className="metric-card"><span className="eyebrow">Awaiting confirmation</span><strong>{summary.publication.subscriptions.pending ?? 0}</strong></section>
          <section className="metric-card"><span className="eyebrow">Suppressed / unsubscribed</span><strong>{(summary.publication.subscriptions.suppressed ?? 0) + (summary.publication.subscriptions.unsubscribed ?? 0)}</strong></section>
          <section className="metric-card"><span className="eyebrow">Campaigns</span><strong>{summary.publication.campaigns}</strong></section>
          <section className="metric-card"><span className="eyebrow">Accepted</span><strong>{summary.publication.deliveries.accepted ?? 0}</strong></section>
          <section className="metric-card"><span className="eyebrow">Needs review / retry</span><strong>{(summary.publication.deliveries.unknown ?? 0) + (summary.publication.deliveries.retryable_failed ?? 0) + (summary.publication.deliveries.permanent_failed ?? 0)}</strong></section>
          <section className="metric-card"><span className="eyebrow">Local fake outbox</span><strong>{summary.publication.localOutbox}</strong></section>
        </div>
        <p>Review historical campaigns from the release in <a href="/publishing">Publishing channels</a>. New confirmation signup, previews, campaign creation, sending, and retries are disabled. Community and publication consent remain separate.</p>
      </section>
      </>}
    </>}
  </section>;
}
