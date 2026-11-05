"use client";

import { useMemo, useState } from "react";
import Funnel, { type FunnelStep } from "./funnel";

export type MapItem = { id: string; title: string; url: string | null; event_date: string | null; status: string; reason: string | null; step: string; section: string | null; rank: number | null; score: number | null; why: string | null; story_id: string | null };
export type MapSource = { source_id: string; name: string; url: string | null; type: string; type_label: string; found_by: string; found_by_detail: string; status: string; stale: boolean; last_new_item_day: string | null; window: string; run_status: string | null; run_detail: string | null; collected: boolean; items_pulled: number; items_kept: number; items_published: number; items: MapItem[]; link_only: boolean };
export type EditionMap = { _id: string; run_id: string; edition_id?: string | null; location_name: string; status: string; window: [string, string]; published_at: number | null; funnel: FunnelStep[]; sections: Array<{ id: string; label: string; sources: MapSource[]; published: number; candidates: number }>; held_by_floor: number };

const STEP_STATUS: Record<string, (item: MapItem) => boolean> = {
  collected: () => true,
  local: (item) => !["reader", "locality", "editor"].includes(item.step) || item.status !== "dropped",
  merged: (item) => (!["reader", "locality", "editor"].includes(item.step) || item.status !== "dropped") && item.step !== "merge",
  new: (item) => (!["reader", "locality", "editor"].includes(item.step) || item.status !== "dropped") && !["merge", "ledger"].includes(item.step),
  candidates: (item) => ["candidate", "published", "held"].includes(item.status) || (item.status === "not_selected" && item.step === "authoring"),
  published: (item) => item.status === "published",
};
const STATUS_LABEL: Record<string, string> = { published: "Published", candidate: "Candidate", pooled: "Ranked", not_selected: "Not selected", dropped: "Left out", held: "Held", collected: "Collected" };

/** Internal edition decisions, including recorded ranks and editorial explanations. */
export default function EditionMapView({ map, internal = false, onTrace }: { map: EditionMap; internal?: boolean; onTrace?: (itemId: string) => void }) {
  const [section, setSection] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [found, setFound] = useState("");
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<string | null>(null);
  const types = useMemo(() => [...new Set(map.sections.flatMap((item) => item.sources.map((source) => source.type_label)))].sort(), [map]);
  const methods = useMemo(() => [...new Set(map.sections.flatMap((item) => item.sources.map((source) => source.found_by)))].sort(), [map]);
  const text = query.trim().toLowerCase();
  const itemMatches = (item: MapItem, sourceName = "") => (!status || item.status === status) && (!text || item.title.toLowerCase().includes(text) || sourceName.toLowerCase().includes(text)) && (!step || (STEP_STATUS[step]?.(item) ?? true));
  const sections = map.sections.filter((item) => !section || item.id === section).map((item) => ({
    ...item,
    sources: item.sources.filter((source) => (!type || source.type_label === type) && (!found || source.found_by === found)
      && (step !== "returning" || source.items_pulled > 0)
      && ((!status && (!step || ["sources", "returning"].includes(step)) && (!text || source.name.toLowerCase().includes(text))) || source.items.some((entry) => itemMatches(entry, source.name)))),
  })).filter((item) => item.sources.length);
  return <>
    <Funnel steps={map.funnel} selected={step} onSelect={setStep} />
    <p className="chart-caption">Funnel totals count distinct stories after merging; rows show the contributing source items. Stage filters use recorded final outcomes, not a replay of every intermediate state. Snapshots show up to 60 items per source. Open the run&rsquo;s item explorer for a full search and editorial overrides.</p>
    <button className="secondary" type="button" onClick={() => { setSection(""); setType(""); setStatus(""); setFound(""); setQuery(""); setStep(null); }}>Clear all filters</button>
    {map.held_by_floor > 0 && <p className="chart-caption">{map.held_by_floor} item{map.held_by_floor === 1 ? " was" : "s were"} held to protect a minor or a victim and {map.held_by_floor === 1 ? "is" : "are"} not listed.</p>}
    <div className="filters">
      <label>Section<select value={section} onChange={(event) => setSection(event.target.value)}><option value="">All</option>{map.sections.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Source type<select value={type} onChange={(event) => setType(event.target.value)}><option value="">All</option>{types.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All</option>{Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>How found<select value={found} onChange={(event) => setFound(event.target.value)}><option value="">All</option>{methods.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Search<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Headline or source" /></label>
    </div>
    {sections.map((item) => <section key={item.id}>
      <h3>{item.label} <small>· {item.published} published · {item.candidates} candidates · {item.sources.length} sources</small></h3>
      {item.sources.map((source) => <details key={source.source_id} id={source.source_id} className={`map-source${source.stale ? " stale" : ""}`}>
        <summary>
          <strong>{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a> : source.name}</strong>
          <small>{source.type_label} · {source.found_by}{source.link_only ? " · link only" : ""}{source.stale ? ` · quiet${source.last_new_item_day ? ` since ${source.last_new_item_day}` : ""}` : ""}</small>
          <small>{source.items_pulled} pulled · {source.items_kept} kept · {source.items_published} published</small>
          {internal && source.run_status && source.run_status !== "ingested" && <span className="status-badge tone-warning">{source.run_status}</span>}
        </summary>
        <p className="chart-caption">Window: {source.window}.{source.found_by_detail ? ` ${source.found_by_detail}.` : ""}{internal && source.run_detail ? ` Last run: ${source.run_detail}` : ""}</p>
        <ul className="map-items">{source.items.filter((entry) => itemMatches(entry, source.name)).map((entry) => <li key={entry.id}>
          <span className={`item-status ${entry.status}`}>{STATUS_LABEL[entry.status] ?? entry.status}</span>{" "}
          {entry.url ? <a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.title}</a> : entry.title}
          {entry.rank !== null && <small> · #{entry.rank} in section{entry.score !== null ? `, score ${entry.score}` : ""}</small>}
          {entry.reason && <small> · {entry.reason}</small>}
          {entry.why && internal && <small> · {entry.why}</small>}
          {internal && onTrace && <> <button type="button" className="run-inspect-link" onClick={() => onTrace(entry.id)}>Trace</button></>}
        </li>)}</ul>
        {source.items_pulled > source.items.length && <p className="chart-caption">Showing a limited snapshot; held safety items are also omitted. Use run controls and the item explorer to inspect all recorded items.</p>}
      </details>)}
    </section>)}
    {!sections.length && <p>No sources match these filters.</p>}
  </>;
}
