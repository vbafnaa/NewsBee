"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import ItemTrace from "./item-trace";
import StoryReview, { type StoryReviewValue } from "./story-review";
import { useExecutionPolicy } from "../../components/execution-policy";

type Copy = { _id: string; source_id: string; source_name: string; status: string; reason: string | null; step: string; event_date: string | null };
type Group = {
  key: string; url: string | null; title: string; event_date: string | null; item_id: string; status: string; step: string; reason: string | null;
  section: string | null; rank: number | null; score: number | null; why: string | null; copies: number; sources: number; source_names: string[]; items: Copy[];
  replication: { copies: number; sources: number; independent: number; publishers: string[] } | null; pre_rank: number | null; review: StoryReviewValue;
  crawl_depth: number | null; found_on: string | null;
};
type Source = { source_id: string; name: string; url: string | null; collection: string | null; detail: string | null; found: number; kept: number; dropped: number; published: number; reasons: Array<{ reason: string; count: number }> };
type Summary = { items: number; links: number; repeated_links: number; repeated_copies: number; merged_into_stories: number; repeats_of_printed: number; title_rejected: number; by_status: Record<string, number>; reviewed: { accept: number; reject: number }; truncated: boolean };
type Page = { summary: Summary; sources: Source[]; total: number; offset: number; groups: Group[] };

const PAGE = 100;
const label = (value: string) => value.replace(/_/g, " ");

/** Everything the selected run pulled: one row per link with its copies, each traceable and reviewable, and what each source found. */
export default function RunItems({ locationId }: { locationId: string }) {
  const [runId, setRunId] = useState<string | null>(null);
  useEffect(() => {
    setRunId(new URLSearchParams(window.location.search).get("run"));
    const inspect = (event: Event) => setRunId((event as CustomEvent<{ runId: string }>).detail.runId);
    window.addEventListener("newsbee:inspect-run", inspect);
    return () => window.removeEventListener("newsbee:inspect-run", inspect);
  }, []);
  if (!runId) return <section className="panel"><h2>Stories pulled</h2><p>Inspect a run to see every story it pulled.</p></section>;
  return <RunStoryItems key={runId} locationId={locationId} runId={runId} />;
}

function RunStoryItems({ locationId, runId }: { locationId: string; runId: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [decision, setDecision] = useState("");
  const [reason, setReason] = useState("");
  const [source, setSource] = useState("");
  const [offset, setOffset] = useState(0);
  const [trace, setTrace] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  const { policy } = useExecutionPolicy();
  const load = useCallback(async () => {
    const id = ++requestId.current;
    const params = new URLSearchParams({ q: query, status, decision, reason, source, offset: String(offset), limit: String(PAGE) });
    try {
      const result = await adminApi<Page>(`runs/${encodeURIComponent(runId)}/pulled?${params}`);
      if (id !== requestId.current) return;
      setPage(result); setError("");
    } catch (cause) { if (id === requestId.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [runId, query, status, decision, reason, source, offset]);
  useEffect(() => {
    setPage(null);
    void load();
    return () => { requestId.current += 1; };
  }, [load]);
  useEffect(() => { setOffset(0); }, [query, status, decision, reason, source]);
  useEffect(() => { setTrace(null); }, [query, status, decision, reason, source, offset]);
  async function reassemble() {
    if (!runId || !window.confirm("Throw away this run's ranking and drafts and assemble again from the collected items?")) return;
    setBusy(true);
    try { await adminApi(`runs/${encodeURIComponent(runId)}/actions`, { method: "POST", body: JSON.stringify({ action: "reassemble" }) }); window.dispatchEvent(new Event("newsbee:runs-changed")); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  const summary = page?.summary;
  const reviewed = summary ? summary.reviewed.accept + summary.reviewed.reject : 0;
  return <section className="panel" id="run-items">
    <div className="section-heading"><div><h2>Stories pulled in this run</h2>
      <p>{summary ? [
        `${summary.items} items from ${page!.sources.length} sources`, `${summary.links} distinct links`,
        `${summary.repeated_links} links pulled more than once (${summary.repeated_copies} extra copies)`,
        `${summary.merged_into_stories} merged into another story`, `${summary.repeats_of_printed} repeats of printed stories`,
        `${summary.title_rejected} rejected for their title`,
        Object.entries(summary.by_status).map(([key, value]) => `${value} ${label(key)}`).join(", "),
        `reviewed: ${summary.reviewed.accept} accepted, ${summary.reviewed.reject} rejected`,
      ].join(" · ") : "Loading…"}{summary?.truncated && " · Only the first 8,000 items are shown."}</p></div>
      <div className="card-actions">
        {reviewed ? <>
          <a className="button secondary" href={`/api/admin/runs/${encodeURIComponent(runId)}/story-reviews/export`}>Export this run's reviews (CSV)</a>
          <a className="button secondary" href={`/api/admin/runs/${encodeURIComponent(runId)}/story-reviews/export?format=jsonl`} title="Every detail of each reviewed story, one JSON object per line">JSONL</a>
        </> : <button type="button" className="secondary" disabled title="Accept or reject a story first">Export this run's reviews (CSV)</button>}
        <a className="button secondary" href={`/api/admin/locations/${encodeURIComponent(locationId)}/story-reviews/export`}>Export all reviews for this location</a>
        <a className="button secondary" href={`/api/admin/locations/${encodeURIComponent(locationId)}/story-reviews/export?format=jsonl`} title="Every detail of each reviewed story, one JSON object per line">JSONL</a>
        <button type="button" className="secondary" disabled={busy || !policy?.permissions[runId]?.canSpend} onClick={() => void reassemble()}>Reassemble and rewrite</button>
      </div></div>
    {error && <p className="alert" role="alert">{error}</p>}

    {page && <details className="pulled-sources">
      <summary>What each source found ({page.sources.length} sources)</summary>
      <div className="table-wrap"><table>
        <thead><tr><th>Source</th><th>Found</th><th>Kept</th><th>Left out</th><th>Published</th><th>Main reasons left out</th><th>Collection</th></tr></thead>
        <tbody>{page.sources.map((row) => <tr key={row.source_id}>
          <td><button type="button" className="run-inspect-link" title="Show this source's stories" onClick={() => setSource(row.source_id)}>{row.name}</button>{row.url && <> <a href={row.url} target="_blank" rel="noopener noreferrer"><small>site</small></a></>}</td>
          <td>{row.found}</td><td>{row.kept}</td><td>{row.dropped}</td><td>{row.published}</td>
          <td><small>{row.reasons.map((item) => `${item.count} ${item.reason}`).join(" · ") || "—"}</small></td>
          <td><small>{[row.collection && label(row.collection), row.detail].filter(Boolean).join(": ") || "—"}</small></td>
        </tr>)}</tbody>
      </table></div>
    </details>}

    <div className="filters">
      <label>Search<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Headline or link" /></label>
      <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All</option>{["published", "candidate", "held", "pooled", "not_selected", "collected", "dropped"].map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
      <label>Review<select value={decision} onChange={(event) => setDecision(event.target.value)}><option value="">All</option><option value="unreviewed">Not reviewed</option><option value="accept">Accepted</option><option value="reject">Rejected</option></select></label>
      <label>Reason contains<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="undated, title, not local…" /></label>
      <label>Source<select value={source} onChange={(event) => setSource(event.target.value)}><option value="">All</option>{page?.sources.map((row) => <option key={row.source_id} value={row.source_id}>{row.name}</option>)}</select></label>
    </div>
    {trace && <ItemTrace runId={runId} itemId={trace} onClose={() => setTrace(null)} onChanged={() => void load()}
      review={page?.groups.find((group) => group.items.some((copy) => copy._id === trace))?.review ?? null} />}
    <p><small>{page ? `${page.total} links match` : ""}</small></p>
    <div className="table-wrap"><table>
      <thead><tr><th>Status</th><th>Story</th><th>Sources</th><th>Section</th><th>Rank</th><th>Why</th><th>Review</th><th /></tr></thead>
      <tbody>{page?.groups.map((group) => <tr key={group.key}>
        <td><span className={`item-status ${group.status}`}>{label(group.status)}</span></td>
        <td>{group.url ? <a href={group.url} target="_blank" rel="noopener noreferrer">{group.title}</a> : group.title}{group.event_date && <small> · {group.event_date}</small>}
          {group.copies > 1 && <details><summary><small>{group.copies} copies of this link from {group.sources} source{group.sources === 1 ? "" : "s"}</small></summary>
            <ul>{group.items.map((copy) => <li key={copy._id}><small>{copy.source_name} · {label(copy.status)}{copy.reason ? `: ${copy.reason}` : ""} </small><button type="button" className="run-inspect-link" onClick={() => setTrace(copy._id)}>Trace</button></li>)}</ul>
          </details>}
          {group.replication && group.replication.copies > 1 && <div><small>Story reported {group.replication.copies} times by {group.replication.independent} independent publisher{group.replication.independent === 1 ? "" : "s"}</small></div>}
          {(group.crawl_depth ?? 1) > 1 && <div><small>Found {group.found_on ? `on a ${group.found_on.replace(/^listing link /, "listing page ")}` : "on a listing page"} · depth {group.crawl_depth}</small></div>}</td>
        <td><small>{group.source_names.join(", ")}</small></td>
        <td><small>{group.section ? label(group.section) : "—"}</small></td>
        <td>{group.rank ?? "—"}{group.score !== null && <small> ({group.score})</small>}{group.pre_rank !== null && <div><small>pre-rank {group.pre_rank}</small></div>}</td>
        <td><small>{group.reason ?? group.why ?? group.step}</small></td>
        <td><StoryReview key={`${group.key}:${group.review?.at ?? "none"}`} runId={runId} itemId={group.item_id} review={group.review} section={group.section} onSaved={() => void load()} /></td>
        <td><button type="button" className="run-inspect-link" onClick={() => setTrace(group.item_id)}>Trace</button></td>
      </tr>)}</tbody>
    </table></div>
    {page && <div className="card-actions">
      <button type="button" className="secondary" disabled={page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset - PAGE))}>Previous</button>
      <small>{page.total ? `${page.offset + 1}–${page.offset + page.groups.length} of ${page.total}` : "No matching links"}</small>
      <button type="button" className="secondary" disabled={page.offset + page.groups.length >= page.total} onClick={() => setOffset(page.offset + PAGE)}>Next</button>
    </div>}
  </section>;
}
