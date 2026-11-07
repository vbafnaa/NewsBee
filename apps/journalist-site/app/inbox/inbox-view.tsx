"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";

type Held = { id: string; run_id: string; run_status: string; location_id: string; location_name: string; story_id: string; title: string; section: string | null; reasons: string[]; floor: string | null };
type Suggestion = { _id: string; location_id: string; location_name: string; name: string; url: string; section: string; why: string | null; submitted_at: string };
type Report = { _id: string; location_id: string; headline: string | null; message: string; submitted_at: string; story_id: string | null; edition_id: string | null };
type Inbox = { counts: Record<string, number>; held: Held[]; suggestions: Suggestion[]; reports: Report[] };

export default function InboxView({ locationId }: { locationId?: string }) {
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setData(await adminApi<Inbox>(`inbox${locationId ? `?location=${encodeURIComponent(locationId)}` : ""}`)); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [locationId]);
  useEffect(() => { void load(); }, [load]);
  async function act(label: string, action: () => Promise<unknown>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); setNotice(label); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!data && !error && <p role="status">Loading editorial inbox…</p>}
    {data && <p className="chart-caption">Recent held stories (14 days), up to 200 submissions and suggestions per category, and 100 open reports. Counts reflect this review window.</p>}
    {data && <div className="strip">
      {[["Held stories", data.counts.held_stories, "#held"], ["Source suggestions", data.counts.suggestions, "#suggestions"], ["Problem reports", data.counts.reports, "#reports"], ["Reader stories", data.counts.reader_stories, "#reader-stories"], ["Family notices", data.counts.family_notices, "#family-notices"]].map(([label, count, href]) =>
        <a key={String(label)} className={`strip-card${Number(count) ? " warn" : ""}`} href={String(href)}><small>{label}</small><strong>{count}</strong></a>)}
    </div>}
    <section className="panel" id="held"><h2>Held stories</h2><p>Review writing and rule checks in the run inspector. Rewrite, force in or out, or leave held.</p>
      {data && !data.held.length ? <p>None.</p> : <ul className="alert-list">{data?.held.map((item) => <li key={item.id}>
        <span><strong>{item.location_name}:</strong> {item.title} {item.section && <small>· {item.section.replaceAll("_", " ")}</small>}</span>
        <small>{item.floor ? `Floor: ${item.floor}. ` : ""}{item.reasons.join(", ") || "no reason recorded"}</small>
        <div className="card-actions">
          <Link className="button secondary" href={`/locations/${encodeURIComponent(item.location_id)}?tab=runs&run=${encodeURIComponent(item.run_id)}`}>Inspect run</Link>
          {["awaiting_finish", "authoring"].includes(item.run_status) && <button type="button" className="secondary" disabled={busy} onClick={() => void act("Rewriting the story; check the run in a minute.", () => adminApi(`runs/${encodeURIComponent(item.run_id)}/actions`, { method: "POST", body: JSON.stringify({ action: "rewrite", story_id: item.story_id }) }))}>Extract details and rewrite</button>}
        </div>
      </li>)}</ul>}
    </section>
    <section className="panel" id="suggestions"><h2>Reader source suggestions</h2><p>Approval checks site access and readability, then pins the source.</p>
      {data && !data.suggestions.length ? <p>None.</p> : <ul className="alert-list">{data?.suggestions.map((item) => <li key={item._id}>
        <span><strong>{item.location_name}:</strong> <a href={item.url} target="_blank" rel="noopener noreferrer">{item.name}</a> <small>· {item.section.replaceAll("_", " ")}</small></span>
        {item.why && <small>{item.why}</small>}
        <div className="card-actions">
          <button type="button" disabled={busy} onClick={() => void act(`Added ${item.name} to the source map.`, () => adminApi("suggestions", { method: "POST", body: JSON.stringify({ id: item._id, decision: "approved" }) }))}>Approve</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => { const reason = window.prompt("Reason (optional)") ?? undefined; void act("Suggestion rejected.", () => adminApi("suggestions", { method: "POST", body: JSON.stringify({ id: item._id, decision: "rejected", reason }) })); }}>Reject</button>
        </div>
      </li>)}</ul>}
    </section>
    <section className="panel" id="reports"><h2>Problem reports</h2><p>Readers&rsquo; reports about a published story. Withdraw or correct the story from its run, then mark the report resolved.</p>
      {data && !data.reports.length ? <p>None.</p> : <ul className="alert-list">{data?.reports.map((item) => <li key={item._id}>
        <span><strong>{item.headline ?? "A story"}</strong> <small>· {new Date(item.submitted_at).toLocaleString()}</small></span>
        <small>{item.message}</small>
        <div className="card-actions">
          {item.edition_id && <Link className="button secondary" href={`/locations/${encodeURIComponent(item.location_id)}?tab=runs&run=${encodeURIComponent(item.edition_id)}`}>Open the edition&rsquo;s run</Link>}
          <button type="button" className="secondary" disabled={busy} onClick={() => void act("Report resolved.", () => adminApi("reports", { method: "POST", body: JSON.stringify({ id: item._id }) }))}>Mark resolved</button>
        </div>
      </li>)}</ul>}
    </section>
  </>;
}
