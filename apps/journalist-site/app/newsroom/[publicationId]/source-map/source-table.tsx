"use client";

import { useEffect, useMemo, useState } from "react";
import { adminApi, withPublication } from "@/lib/admin-client";
import { AddSource, ReviewCells } from "@/app/locations/[locationId]/source-map-manager";
import { Icon, StatusPill } from "../../newsroom-ui";

type Review = Parameters<typeof ReviewCells>[0]["source"]["review"];
type Row = {
  _id: string; source_id: string; location_id: string; review?: Review; name: string; url: string | null; section: string; status: string; link_only?: boolean;
  health: { last_run_at: number | null; last_status: string | null; consecutive_failures: number; items_found: number; items_published: number };
};
type Data = { sections: Array<{ id: string; label: string }>; sources: Row[]; systems?: Parameters<typeof AddSource>[0]["systems"] };
type Health = "healthy" | "review" | "failing" | "paused" | "rejected" | "link_only";
const LABELS: Record<Health, string> = { healthy: "Healthy", review: "Needs review", failing: "Failing", paused: "Paused", rejected: "Rejected", link_only: "Link only" };
const TONES: Record<Health, "ok" | "warning" | "failed" | "muted"> = { healthy: "ok", review: "warning", failing: "failed", paused: "muted", rejected: "muted", link_only: "muted" };

function health(row: Row): Health {
  if (row.link_only) return "link_only";
  if (row.status === "rejected") return "rejected";
  if (row.status === "paused" || row.status === "dormant") return "paused";
  if (row.status === "proposed") return "review";
  return row.health.consecutive_failures > 0 || (row.health.last_status && row.health.last_status !== "ingested") ? "failing" : "healthy";
}
function ago(seconds: number | null) {
  if (!seconds) return "Not yet";
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60));
  return minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} hours ago` : `${Math.round(minutes / 1440)} days ago`;
}

/**
 * Current sources (frame 06): the community's one shared source list. Each row can be accepted or rejected with a
 * reason inline, and new sources are added below. Same scoped API as before; every change is checked on the server.
 */
export default function SourceTable({ publicationId, locationId }: { publicationId: string; locationId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"" | Health>("");
  useEffect(() => {
    const controller = new AbortController();
    const path = withPublication(`locations/${encodeURIComponent(locationId)}/source-map`, publicationId);
    adminApi<Data>(path, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setData(result); setError(""); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [publicationId, locationId, reload]);
  const saved = (id: string, change: { status: string; review: Review }) => setData((current) => current && {
    ...current, sources: current.sources.map((row) => row._id === id ? { ...row, status: change.status, review: change.review } : row),
  });
  const sections = useMemo(() => new Map((data?.sections ?? []).map((section) => [section.id, section.label])), [data]);
  const rows = (data?.sources ?? []).map((row) => ({ row, state: health(row) }))
    .filter(({ row, state }) => (!filter || state === filter) && (!query.trim() || `${row.name} ${row.url ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())));
  return <><div className="jw-card jw-table-card">
    <div className="jw-table-tools">
      <label className="jw-search"><span className="visually-hidden">Search source map</span><Icon name="search" size={16} />
        <input type="search" placeholder="Search source map…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <label className="jw-filter"><span className="visually-hidden">Filter by status</span>
        <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
          <option value="">Filter</option>{(Object.keys(LABELS) as Health[]).map((key) => <option key={key} value={key}>{LABELS[key]}</option>)}
        </select></label>
    </div>
    {error && <p className="alert" role="alert">{error}</p>}
    {!data && !error && <p className="jw-table-empty" role="status">Loading sources…</p>}
    {data && <div className="jw-table-scroll"><table className="jw-table">
      <thead><tr><th scope="col">Source</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Last collected</th><th scope="col">Stories</th><th scope="col">Decision</th><th scope="col">Reasoning</th></tr></thead>
      <tbody>{rows.map(({ row, state }) => <tr key={row._id}>
        <td>{row.url ? <a href={row.url} target="_blank" rel="noopener noreferrer">{row.name}</a> : <strong>{row.name}</strong>}</td>
        <td>{sections.get(row.section) ?? row.section}</td>
        <td><StatusPill status={TONES[state]}>{LABELS[state]}</StatusPill></td>
        <td>{ago(row.health.last_run_at)}</td>
        <td>{row.health.items_found || "—"}</td>
        <ReviewCells source={row} canLabel onSaved={saved} />
      </tr>)}</tbody>
    </table></div>}
    {data && !rows.length && <p className="jw-table-empty">{data.sources.length ? "No sources match." : "No sources yet."}</p>}
    {data && <div className="jw-table-foot"><small>{rows.length} of {data.sources.length} sources</small></div>}
  </div>
  {notice && <p role="status">{notice}</p>}
  {data && <AddSource locationId={locationId} sections={data.sections} systems={data.systems ?? []}
    onAdded={(message) => { setNotice(message); setReload((value) => value + 1); }} />}
  </>;
}
