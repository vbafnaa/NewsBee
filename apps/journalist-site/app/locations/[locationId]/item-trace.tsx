"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import type { EvidencePacket } from "@/pipeline/editions/evidence";
import type { ImageResult } from "@/pipeline/images/pipeline";
import StoryReview, { type StoryReviewValue } from "./story-review";

type Trace = {
  item: { _id: string; run_id: string; source_id: string; source_name: string; title: string; url: string | null; event_date: string | null; status: string; reason: string | null; step: string; section?: string | null; rank?: number | null; score?: number | null; why?: string | null; merge_group?: string | null; story_id?: string | null; locality?: unknown; facts: Record<string, unknown> | null; evidence?: EvidencePacket;
    replication?: { copies: number; sources: number; independent: number; publishers: string[] }; pre_rank?: { score: number; civic: number; appeal: number; special: number; rules: string[] } };
  window: string | null;
  source: { name: string; url: string | null; reader: string; found_by: { method: string; detail: string }; status: string; inside_area: boolean; section: string } | null;
  siblings: Array<{ _id: string; title: string; source_name: string; status: string }>;
  details: Record<string, unknown> | null;
  floor: { withholdNames: boolean; reason: string | null; blockAddresses: boolean; suicide: boolean } | null;
  writing: { disposition: string; draft: { headline: string; summary: string } | null; errors: string[]; error: string | null; attempts: number; rejected_first: { draft: unknown; errors: string[] } | null; ranking: Record<string, unknown> | null } | null;
  text_excerpt: string | null;
  overrides: { include?: string[]; exclude?: string[]; pin?: string[] };
  image?: ImageResult | null;
  image_shadow?: ImageResult | null;
  image_agent?: Record<string, unknown> | null;
};

const show = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);

/** One item from source to story, with the actions that change its outcome. */
export default function ItemTrace({ runId, itemId, onClose, onChanged, review }: { runId: string; itemId: string; onClose: () => void; onChanged?: () => void; review?: StoryReviewValue }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try { setTrace(await adminApi<Trace>(`runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(itemId)}`)); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [runId, itemId]);
  useEffect(() => { void load(); }, [load]);
  async function act(label: string, body: Record<string, unknown>) {
    setError(""); setNotice("");
    try { await adminApi(`runs/${encodeURIComponent(runId)}/actions`, { method: "POST", body: JSON.stringify(body) }); setNotice(label); await load(); onChanged?.(); window.dispatchEvent(new Event("newsbee:runs-changed")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  const item = trace?.item;
  const on = (kind: "include" | "exclude" | "pin") => Boolean(item && trace?.overrides[kind]?.includes(item._id));
  return <section className="panel" aria-label="Item trace">
    <div className="section-heading"><h2>Item trace</h2><button type="button" className="secondary" onClick={onClose}>Close</button></div>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!trace || !item ? <p>Loading…</p> : <>
      <dl className="trace">
        <dt>Item</dt><dd>{item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a> : item.title}{item.event_date && ` · ${item.event_date}`}</dd>
        <dt>Outcome</dt><dd><span className={`item-status ${item.status}`}>{item.status.replace(/_/g, " ")}</span> at the {item.step} step{item.reason ? `: ${item.reason}` : ""}</dd>
        {review !== undefined && <><dt>Editor review</dt><dd><StoryReview key={`${item._id}:${review?.at ?? "none"}`} runId={runId} itemId={item._id} review={review} onSaved={() => onChanged?.()} /></dd></>}
        <dt>Source</dt><dd>{trace.source ? <>{trace.source.url ? <a href={trace.source.url} target="_blank" rel="noopener noreferrer">{trace.source.name}</a> : trace.source.name} · {trace.source.reader} · found by {trace.source.found_by.method} ({trace.source.found_by.detail}) · {trace.source.status}{trace.source.inside_area ? " · inside the area" : ""}</> : item.source_name}</dd>
        <dt>Window</dt><dd>{trace.window ?? "—"}</dd>
        <dt>Locality</dt><dd><pre>{item.locality ? show(item.locality) : item.facts?.locality ? show(item.facts.locality) : item.facts?.needs_locality ? "Not checked yet" : "—"}</pre></dd>
        <dt>Merge group</dt><dd>{item.merge_group ?? "—"}{trace.siblings.length > 0 && <ul>{trace.siblings.map((sibling) => <li key={sibling._id}>{sibling.title} <small>· {sibling.source_name} · {sibling.status}</small></li>)}</ul>}</dd>
        <dt>Replication</dt><dd>{item.replication ? `${item.replication.copies} cop${item.replication.copies === 1 ? "y" : "ies"} passed the checks, from ${item.replication.sources} source${item.replication.sources === 1 ? "" : "s"} and ${item.replication.independent} independent publisher${item.replication.independent === 1 ? "" : "s"}${item.replication.publishers.length ? ` (${item.replication.publishers.join(", ")})` : ""}` : "Not counted (left out before merging, or an older run)"}</dd>
        <dt>Section and rank</dt><dd>{item.section?.replace(/_/g, " ") ?? "—"}{item.rank ? ` · #${item.rank}` : ""}{item.score !== null && item.score !== undefined ? ` · score ${item.score}` : ""}{item.why ? ` · ${item.why}` : ""}</dd>
        <dt>Pre-ranker</dt><dd>{item.pre_rank ? <>{item.pre_rank.score} of 18 (civic {item.pre_rank.civic}, appeal {item.pre_rank.appeal}, special {item.pre_rank.special}){item.pre_rank.rules.length > 0 && <ul>{item.pre_rank.rules.map((rule) => <li key={rule}><small>{rule}</small></li>)}</ul>}</> : "Not rated (outside the ranked shortlist, or an older run)"}</dd>
        <dt>Source evidence</dt><dd>{item.evidence ? <>
          <p>Text: {item.evidence.text_quality} · extraction: {item.evidence.extraction.replaceAll("_", " ")}. Text volume is not a factual-quality score.</p>
          {item.evidence.extraction_error && <p className="alert">{item.evidence.extraction_error}</p>}
          {item.evidence.missing.length > 0 && <p>Not established in structured details: {item.evidence.missing.join(", ")}.</p>}
          {!item.evidence.sources.length && <p>No source URL available for enrichment.</p>}
          {item.evidence.facts?.map((fact, index) => <details key={`fact:${index}`}>
            <summary>{fact.field.replaceAll("_", " ")}: {fact.value}</summary>
            <blockquote>{fact.quote}</blockquote>
            <p>{fact.source_urls.length ? fact.source_urls.join(" · ") : "Supported by the collected title/description; no matching retrieved passage."}</p>
          </details>)}
          {item.evidence.sources.map((source, index) => <details key={`${source.url}:${index}`}>
            <summary>{source.status}: {source.final_url ?? source.url}</summary>
            {source.reason && <p>{source.reason}</p>}
            {source.fetched_at && <p>Fetched: {source.fetched_at}{source.truncated ? " (text capped)" : ""}</p>}
            {source.content_hash && <p>Content SHA-256: <code>{source.content_hash}</code></p>}
            {source.passages.map((passage, position) => <blockquote key={position}>{passage}</blockquote>)}
          </details>)}
        </> : "Not enriched (older run or outside the ranked shortlist)"}</dd>
        <dt>Details</dt><dd><pre>{trace.details ? show(trace.details) : "—"}</pre></dd>
        <dt>Floor</dt><dd>{trace.floor ? [trace.floor.reason ? `names withheld (${trace.floor.reason})` : null, trace.floor.blockAddresses ? "block-level places" : null, trace.floor.suicide ? "no method details, 988 line" : null].filter(Boolean).join(", ") || "No floor rule applies" : "—"}</dd>
        <dt>Writing</dt><dd>{trace.writing ? <><strong>{trace.writing.disposition}</strong> after {trace.writing.attempts} attempt(s){trace.writing.errors.length ? ` · ${trace.writing.errors.join(", ")}` : ""}{trace.writing.error ? ` · ${trace.writing.error}` : ""}
          {trace.writing.draft && <><p><strong>{trace.writing.draft.headline}</strong></p><p>{trace.writing.draft.summary}</p></>}
          {trace.writing.rejected_first && <details><summary>First draft (rejected)</summary><pre>{show(trace.writing.rejected_first)}</pre></details>}</> : "Not written"}</dd>
        <dt>Source text</dt><dd>{trace.text_excerpt ? <details><summary>Stored text (first 1,200 characters)</summary><pre>{trace.text_excerpt}</pre></details> : "None stored"}</dd>
        <dt>Image</dt><dd>{trace.image ? <>
          <strong>{trace.image.status.replace(/_/g, " ")}</strong>: {trace.image.reason.replace(/_/g, " ")}
          <p>{trace.image.stages.join(" → ")}</p>
          {trace.image.agent && <p>Visual review: {trace.image.agent.mode} · {trace.image.agent.calls ?? 0} model call attempts{trace.image.agent.reason ? ` · ${trace.image.agent.reason}` : ""}</p>}
          {trace.image.image && <p><a href={trace.image.image.image_source_url} target="_blank" rel="noopener noreferrer">Photo source</a>
            {trace.image.image.image_credit && ` · ${trace.image.image.image_credit}`}{trace.image.image.image_date && ` · Taken ${trace.image.image.image_date}`}
            {trace.image.image.image_license_url && <> · <a href={trace.image.image.image_license_url} target="_blank" rel="noopener noreferrer">{trace.image.image.image_license}</a></>}</p>}
          {trace.image.candidates.length > 0 && <details><summary>Photo candidates ({trace.image.candidates.length})</summary><ul>{trace.image.candidates.map((candidate, index) => <li key={index}>{candidate.title}: {candidate.reason.replace(/_/g, " ")}</li>)}</ul></details>}
        </> : "Image stage has not run."}</dd>
        {trace.image_shadow && <><dt>Photo comparison</dt><dd>{trace.image_shadow.status}: {trace.image_shadow.reason.replaceAll("_", " ")}</dd></>}
        {trace.image_agent && <><dt>Photo editor trace</dt><dd><details><summary>Plan, searches, quality findings and rejection reasons</summary><pre>{show(trace.image_agent)}</pre></details></dd></>}
      </dl>
      <div className="card-actions">
        <button type="button" className="secondary" onClick={() => void act(on("include") ? "No longer forced in." : "Forced in: reassemble to apply.", { action: "include", item_id: item._id, on: !on("include") })}>{on("include") ? "Undo force in" : "Force in"}</button>
        <button type="button" className="secondary" onClick={() => void act(on("exclude") ? "No longer excluded." : "Excluded: reassemble to apply.", { action: "exclude", item_id: item._id, on: !on("exclude") })}>{on("exclude") ? "Undo exclude" : "Exclude"}</button>
        <button type="button" className="secondary" onClick={() => void act(on("pin") ? "Unpinned." : "Pinned to the top of its section: reassemble to apply.", { action: "pin", item_id: item._id, on: !on("pin") })}>{on("pin") ? "Unpin" : "Pin to top"}</button>
        {item.story_id && <button type="button" className="secondary" onClick={() => void act("Extracting details and rewriting.", { action: "rewrite", story_id: item.story_id })}>Extract details and rewrite</button>}
        <button type="button" className="secondary" onClick={() => void act("Collecting this source again.", { action: "recollect", source_id: item.source_id })}>Collect this source again</button>
      </div>
    </>}
  </section>;
}
