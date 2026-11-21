"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApi, withPublication } from "@/lib/admin-client";
import { usePublicationScope } from "../components/publication-scope";

type Held = { id: string; run_id: string | null; run_status: string; draft_id?: string; draft_title?: string; presentation_story_id?: string | null; location_id: string; location_name: string; story_id: string; title: string; section: string | null; reasons: string[]; floor: string | null };
type Suggestion = { _id: string; location_id: string; location_name: string; name: string; url: string; section: string; why: string | null; submitted_at: string };
type Report = { _id: string; location_id: string; headline: string | null; message: string; submitted_at: string; story_id: string | null; edition_id: string | null };
type SourceFeedback = { _id: string; publication_id: string; publication_name: string; location_id: string; location_name: string; source_id: string; source_name_snapshot: string; source_url_snapshot: string | null; category: string; message: string; submitted_at: string };
type Inbox = { counts: Record<string, number>; held: Held[]; suggestions: Suggestion[]; source_feedback: SourceFeedback[]; reports: Report[] };

type Part = "held" | "suggestions" | "source-feedback" | "reports";

/** In a location's workspace, `only` shows the parts that belong to that tab. */
export default function InboxView({ locationId, only }: { locationId?: string; only?: Part[] }) {
  const shows = (part: Part) => !only || only.includes(part);
  // Inside a newsroom every call is scoped to it, and links stay in the journalist workspace.
  const scope = usePublicationScope();
  const api = <T,>(path: string, init?: RequestInit) => adminApi<T>(withPublication(path, scope?.publicationId), init);
  const sourceMapHref = (location: string) => scope ? `${scope.base}/source-map?location=${encodeURIComponent(location)}` : `/source-map?location=${encodeURIComponent(location)}`;
  const heldHref = (item: Held) => item.draft_id && scope
    ? `${scope.base}/editions/${encodeURIComponent(item.draft_id)}${item.presentation_story_id ? `#edition-story-${encodeURIComponent(item.presentation_story_id)}` : ""}`
    : item.run_id ? `/locations/${encodeURIComponent(item.location_id)}?tab=edition&run=${encodeURIComponent(item.run_id)}` : null;
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setData(await adminApi<Inbox>(withPublication(`inbox${locationId ? `?location=${encodeURIComponent(locationId)}` : ""}`, scope?.publicationId))); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [locationId, scope?.publicationId]);
  useEffect(() => { void load(); }, [load]);
  async function act(label: string, action: () => Promise<unknown>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); setNotice(label); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!data && !error && <p role="status">Loading editorial inbox…</p>}
    {data && !only && <p className="chart-caption">Recent held stories (14 days), up to 200 submissions and suggestions per category, and 100 open reports. Counts reflect this review window.</p>}
    {data && !only && <div className="strip">
      {[["Held stories", data.counts.held_stories, "#held"], ["Source suggestions", data.counts.suggestions, "#suggestions"], ["Publication source feedback", data.counts.source_feedback, "#source-feedback"], ["Problem reports", data.counts.reports, "#reports"], ["Reader stories", data.counts.reader_stories, "#reader-stories"], ["Family notices", data.counts.family_notices, "#family-notices"]].map(([label, count, href]) =>
        <a key={String(label)} className={`strip-card${Number(count) ? " warn" : ""}`} href={String(href)}><small>{label}</small><strong>{count}</strong></a>)}
    </div>}
    {shows("held") && <section className="panel" id="held"><h2>Held stories</h2><p>{scope ? "Stories held by writing or rule checks in this newsroom's open drafts. Open one in the editor to fix it, include it or leave it out." : "Review writing and rule checks in the run inspector. Rewrite, force in or out, or leave held."}</p>
      {data && !data.held.length ? <p>None.</p> : <ul className="alert-list">{data?.held.map((item) => <li key={item.id}>
        <span><strong>{item.location_name}:</strong> {item.title} {item.section && <small>· {item.section.replaceAll("_", " ")}</small>}</span>
        <small>{item.floor ? `Floor: ${item.floor}. ` : ""}{item.reasons.join(", ") || "no reason recorded"}</small>
        <div className="card-actions">
          {heldHref(item) && <Link className="button secondary" href={heldHref(item)!}>{item.draft_id ? "Open in the editor" : "Inspect run"}</Link>}
          {!item.draft_id && item.run_id && ["awaiting_finish", "authoring"].includes(item.run_status) && <button type="button" className="secondary" disabled={busy} onClick={() => void act("Rewriting the story; check the run in a minute.", () => adminApi(`runs/${encodeURIComponent(item.run_id!)}/actions`, { method: "POST", body: JSON.stringify({ action: "rewrite", story_id: item.story_id }) }))}>Extract details and rewrite</button>}
        </div>
      </li>)}</ul>}
    </section>}
    {shows("source-feedback") && <section className="panel" id="source-feedback"><h2>Publication source feedback</h2><p>Acknowledge or reject the feedback here. Source status changes remain explicit actions in the source map.</p>
      {data && !data.source_feedback.length ? <p>None.</p> : <ul className="alert-list">{data?.source_feedback.map((item) => <li key={item._id}>
        <span><strong>{item.publication_name} · {item.location_name}:</strong> {item.source_url_snapshot
          ? <a href={item.source_url_snapshot} target="_blank" rel="noopener noreferrer">{item.source_name_snapshot}</a>
          : item.source_name_snapshot} <small>· {item.category.replaceAll("_", " ")}</small></span>
        <small>{item.message}</small>
        <div className="card-actions">
          <Link className="button secondary" href={sourceMapHref(item.location_id)}>Review source map</Link>
          <button type="button" disabled={busy} onClick={() => {
            const reason = window.prompt("Review note (optional). Acknowledging does not change the source.");
            if (reason === null) return;
            void act("Feedback acknowledged; source change pending. Update the source map separately if needed.", () => api("suggestions", { method: "POST", body: JSON.stringify({ id: item._id, decision: "approved", reason }) }));
          }}>Acknowledge feedback</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => { const reason = window.prompt("Review note (optional)"); if (reason === null) return; void act("Feedback rejected; source unchanged.", () => api("suggestions", { method: "POST", body: JSON.stringify({ id: item._id, decision: "rejected", reason }) })); }}>Reject</button>
        </div>
      </li>)}</ul>}
    </section>}
    {shows("suggestions") && <section className="panel" id="suggestions"><h2>Reader source suggestions</h2><p>Approval checks site access and readability, then pins the source.</p>
      {data && !data.suggestions.length ? <p>None.</p> : <ul className="alert-list">{data?.suggestions.map((item) => <li key={item._id}>
        <span><strong>{item.location_name}:</strong> <a href={item.url} target="_blank" rel="noopener noreferrer">{item.name}</a> <small>· {item.section.replaceAll("_", " ")}</small></span>
        {item.why && <small>{item.why}</small>}
        <div className="card-actions">
          <button type="button" disabled={busy} onClick={() => void act(`Added ${item.name} to the source map.`, () => api("suggestions", { method: "POST", body: JSON.stringify({ id: item._id, decision: "approved" }) }))}>Approve</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => { const reason = window.prompt("Reason (optional)"); if (reason === null) return; void act("Suggestion rejected.", () => api("suggestions", { method: "POST", body: JSON.stringify({ id: item._id, decision: "rejected", reason }) })); }}>Reject</button>
        </div>
      </li>)}</ul>}
    </section>}
    {shows("reports") && <section className="panel" id="reports"><h2>Problem reports</h2><p>Readers&rsquo; reports about a published story. Withdraw or correct the story from its run, then mark the report resolved.</p>
      {data && !data.reports.length ? <p>None.</p> : <ul className="alert-list">{data?.reports.map((item) => <li key={item._id}>
        <span><strong>{item.headline ?? "A story"}</strong> <small>· {new Date(item.submitted_at).toLocaleString()}</small></span>
        <small>{item.message}</small>
        <div className="card-actions">
          {item.edition_id && !scope && <Link className="button secondary" href={`/locations/${encodeURIComponent(item.location_id)}?tab=edition&run=${encodeURIComponent(item.edition_id)}`}>Open the edition&rsquo;s run</Link>}
          {scope && <Link className="button secondary" href={`${scope.base}/editions`}>Find the edition</Link>}
          <button type="button" className="secondary" disabled={busy} onClick={() => void act("Report resolved.", () => api("reports", { method: "POST", body: JSON.stringify({ id: item._id }) }))}>Mark resolved</button>
        </div>
      </li>)}</ul>}
    </section>}
  </>;
}
