"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import LocationOnboarding from "../location-onboarding";
import type { CurrentRun } from "@/pipeline/orchestration/runs";
import { CurrentRuns } from "./current-runs";
import type { LocationReadinessRow } from "@/pipeline/communities/readiness";
import { ExecutionNotice, useExecutionPolicy } from "../components/execution-policy";
import type { NewsroomDirectoryEntry } from "@/pipeline/orchestration/output-channels";

type Location = { id: string; name: string; state: string; readiness: LocationReadinessRow | null; removal_pending?: boolean; source_coverage?: { status: string } };
type OverviewLocation = {
  location_id: string;
  location_name: string;
  state: string;
  readiness: LocationReadinessRow | null;
  removal_pending?: boolean;
  source_coverage?: { status: string } | null;
};
type QueueItem = {
  id: string;
  kind: "location_readiness" | "held_quality" | "alert";
  location_id: string | null;
  location_name: string | null;
  title: string;
  detail: string;
  diagnostics?: string;
  href: string;
  demand: number;
  state?: "available" | "requested" | "preparing" | "ready" | "blocked";
  can_mark_ready?: boolean;
  missing_prerequisites?: string[];
  coverage_requests?: Array<{ publication_name: string; href: string }>;
  affected_sources?: Array<{ label: string; href: string }>;
};
export default function LocationDirectory({ owner = false, requested }: { owner?: boolean; requested?: { id: string; name: string } }) {
  const execution = useExecutionPolicy();
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [currentRuns, setCurrentRuns] = useState<CurrentRun[] | null>(null);
  const [runsError, setRunsError] = useState("");
  const [query, setQuery] = useState("");
  const [newsrooms, setNewsrooms] = useState<NewsroomDirectoryEntry[] | null>(null);
  const [directoryError, setDirectoryError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    try {
      const overview = await adminApi<{ work_queue: QueueItem[]; locations: OverviewLocation[] }>("overview");
      setLocations(overview.locations.map((location) => ({
        id: location.location_id,
        name: location.location_name,
        state: location.state,
        readiness: location.readiness,
        removal_pending: location.removal_pending,
        source_coverage: location.source_coverage ?? undefined,
      })));
      setQueue(overview.work_queue);
      setError("");
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await adminApi<{ runs: CurrentRun[] }>("current-runs", { signal });
      if (!signal?.aborted) { setCurrentRuns(result.runs); setRunsError(""); }
    } catch (cause) {
      if (!signal?.aborted) setRunsError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    void adminApi<{ directory: NewsroomDirectoryEntry[] }>("output-channels")
      .then((data) => { setNewsrooms(data.directory); setDirectoryError(""); })
      .catch((cause: Error) => setDirectoryError(cause.message));
  }, []);
  useEffect(() => {
    const removed = new URLSearchParams(window.location.search).get("removed");
    if (removed) setNotice(`Removed ${removed} and its tracked generated files. Shared and retained reader data were not deleted.`);
    void load();
  }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    void loadRuns(controller.signal);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void loadRuns(controller.signal); }, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [loadRuns]);
  async function transition(item: QueueItem, state: "preparing" | "ready" | "blocked") {
    if (!item.location_id) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await adminApi(`locations/${encodeURIComponent(item.location_id)}/readiness`, {
        method: "PATCH",
        body: JSON.stringify({ state, reason: reasons[item.id]?.trim() || null }),
      });
      setNotice(`${item.location_name ?? "Location"} is now ${state}.`);
      setReasons((current) => ({ ...current, [item.id]: "" }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const readyCount = locations?.filter((location) => location.readiness?.state === "ready").length ?? 0;
  const preparingCount = (locations?.filter((location) => location.readiness?.state === "preparing").length ?? 0)
    + (queue?.filter((item) => item.kind === "location_readiness" && item.state === "requested").length ?? 0);
  const blockedCount = locations?.filter((location) => location.readiness?.state === "blocked").length ?? 0;
  const metric = (count: number) => error ? "Unavailable" : locations && queue ? count : "Loading";
  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="panel" aria-labelledby="location-directory-title">
      <div className="section-heading"><h2 id="location-directory-title">Location directory</h2><Link href="#onboarding">Add a location</Link></div>
      <label className="field">Find a location<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by location" /></label>
      {directoryError && <p className="alert" role="alert">Newsroom assignments unavailable: {directoryError}</p>}
      {!locations && !error && <p role="status">Loading locations...</p>}
      {error && <button className="secondary" onClick={() => void load()}>Reload locations</button>}
      <ul className="location-directory-list">{locations?.filter((location) => location.name.toLowerCase().includes(query.toLowerCase())).map((location) => {
        const assigned = newsrooms?.filter((newsroom) => newsroom.archivedAt === null && newsroom.enabled && newsroom.selectedLocationIds.includes(location.id));
        const ready = location.readiness?.state === "ready";
        const path = `/locations/${encodeURIComponent(location.id)}`;
        return <li className="location-directory-row" key={location.id}>
          <div className="location-directory-copy">
            <h3><Link href={path}>{location.name}</Link></h3>
            <p>Source map: {location.readiness ? `${location.readiness.active_source_count} active sources` : "not assessed"} · {location.source_coverage?.status?.replaceAll("_", " ") ?? "coverage not assessed"}</p>
            <p>Assignment readiness: <strong>{location.readiness?.state ?? "unavailable"}</strong> · {assigned ? `${assigned.length} active newsroom${assigned.length === 1 ? "" : "s"}` : directoryError ? "assignments unavailable" : "loading assignments"}</p>
            {assigned?.length ? <p>{assigned.map((newsroom, index) => <span key={newsroom.id}>{index > 0 && "; "}
              <Link href={`/admin/publications/${encodeURIComponent(newsroom.id)}`}>{newsroom.name} · Manage community coverage</Link>
              {" · "}<Link href={`/admin/access?publicationId=${encodeURIComponent(newsroom.id)}`}>Assign journalists</Link>
            </span>)}</p> : null}
            {location.removal_pending && <p className="alert">Removal incomplete{owner ? <> - <Link href={`${path}?tab=settings#remove-location`}>retry cleanup</Link></> : " - contact the owner"}</p>}
            <details><summary>Readiness details & controls</summary>
              <p>{location.readiness?.missing_prerequisites.join(" ") || (ready ? "Ready for newsroom coverage."
                : location.readiness?.state === "blocked" ? "Preparation is explicitly blocked. Resume with a reason in the readiness queue."
                  : location.readiness?.can_mark_ready ? "Usable source-map links are available. Mark Ready in the readiness queue." : "Readiness evidence unavailable.")}</p>
              <Link href={`${path}?tab=settings#location-evidence`}>Inspect evidence & activity</Link>
              {ready && <>
                <label className="field">Suspension reason<input maxLength={500} value={reasons[`readiness:${location.id}`] ?? ""} placeholder="Required to suspend future work"
                  onChange={(event) => setReasons((current) => ({ ...current, [`readiness:${location.id}`]: event.target.value }))} /></label>
                <p>Existing Reader releases remain available.</p>
                <button type="button" className="secondary" disabled={busy || !reasons[`readiness:${location.id}`]?.trim()}
                  onClick={() => void transition({ id: `readiness:${location.id}`, location_id: location.id, location_name: location.name, kind: "location_readiness", title: location.name, detail: "", href: "", demand: 0 }, "blocked")}>Suspend future work</button>
              </>}
            </details>
          </div>
          <div className="location-directory-actions">
            <Link className="button secondary" href={`${path}?tab=sources`}>Manage sources</Link>
            <Link href={`${path}/source-map`}>Inspect source map (read-only)</Link>
            <Link href={path}>Activity & evidence</Link>
            {ready && assigned?.length === 0 && <><p>Ready source maps are shared by location. Add this community to an existing newsroom&apos;s allowed communities and edition coverage, or create a newsroom. This does not assign journalists.</p><Link href="/admin/publications">Create or configure newsroom coverage</Link></>}
          </div>
        </li>;
      })}</ul>
      {locations?.length === 0 && <p>No locations onboarded. Add your first community below.</p>}
      {locations && locations.length > 0 && !locations.some((location) => location.name.toLowerCase().includes(query.toLowerCase())) && <p>No locations match this search.</p>}
    </section>
    <section className="admin-readiness-summary" aria-label="Location readiness summary">
      <article><span className="status-dot tone-ok" aria-hidden="true" /><strong>{metric(readyCount)}</strong><small>Ready</small></article>
      <article><span className="status-dot tone-warning" aria-hidden="true" /><strong>{metric(preparingCount)}</strong><small>Preparing</small></article>
      <article><span className="status-dot tone-failed" aria-hidden="true" /><strong>{metric(blockedCount)}</strong><small>Blocked</small></article>
      <article><span className="status-dot" aria-hidden="true" /><strong>{metric(queue?.length ?? 0)}</strong><small>Need attention</small></article>
    </section>
    <ExecutionNotice policy={execution.policy} error={execution.error} compact />
    <section className="panel admin-readiness-queue" aria-labelledby="operations-queue-title">
      <div className="section-heading">
        <h2 id="operations-queue-title">Actionable exceptions</h2>
        <span>{queue?.length ?? 0} items</span>
      </div>
      {!queue && !error && <p role="status">Loading prioritized work…</p>}
      {queue?.length === 0 && <p>No location preparation, source, quality, or provider work needs attention.</p>}
      <details open={queue && queue.length > 0 && queue.length <= 5 || undefined}><summary>Requests, readiness and source exceptions ({queue?.length ?? 0})</summary>
      <ol className="location-directory-list">
        {queue?.map((item) => <li className="location-directory-row" key={item.id}>
          <div className="location-directory-copy">
            <p className="eyebrow">{item.kind.replaceAll("_", " ")}{item.demand ? ` · ${item.demand} reader ${item.demand === 1 ? "request" : "requests"}` : ""}</p>
            <h3>{item.title}</h3>
            <p>{item.detail}</p>
            {item.diagnostics && <details><summary>Discovery diagnostics</summary><p>{item.diagnostics}</p></details>}
            {item.coverage_requests?.length ? <p>Requested by {item.coverage_requests.map((request, index) => <span key={request.href}>
              {index > 0 && ", "}<Link href={request.href}>{request.publication_name}</Link>
            </span>)}</p> : null}
            {item.affected_sources?.length ? <details><summary>{item.affected_sources.length} affected sources</summary><ul>
              {item.affected_sources.map((source) => <li key={source.href}><Link href={source.href}>{source.label}</Link></li>)}
            </ul></details> : null}
            {item.kind === "location_readiness" && item.location_id && item.state !== "requested" && <>
              <label className="field">Transition note
                <input value={reasons[item.id] ?? ""} maxLength={500}
                  onChange={(event) => setReasons((current) => ({ ...current, [item.id]: event.target.value }))}
                  placeholder={item.state === "blocked" ? "What changed?" : "Required when blocking"} />
              </label>
              {item.missing_prerequisites?.length ? <ul className="chart-caption">{[...new Set(item.missing_prerequisites)].filter((reason) => !item.detail.includes(reason)).map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
            </>}
          </div>
          <div className="location-directory-actions">
            <Link className="button secondary" href={item.href}>{item.state === "requested" ? "Open onboarding" : "Review"}</Link>
            {item.kind === "location_readiness" && item.location_id && item.state === "blocked" &&
              <button type="button" disabled={busy || !reasons[item.id]?.trim()} onClick={() => void transition(item, item.can_mark_ready ? "ready" : "preparing")}>{item.can_mark_ready ? "Resume readiness" : "Resume preparation"}</button>}
            {item.kind === "location_readiness" && item.location_id && item.state === "preparing" && <>
              <button type="button" className="secondary" disabled={busy || !(reasons[item.id]?.trim())} onClick={() => void transition(item, "blocked")}>Mark blocked</button>
              <button type="button" disabled={busy || !item.can_mark_ready} onClick={() => void transition(item, "ready")}>Mark ready</button>
            </>}
          </div>
        </li>)}
      </ol>
      </details>
    </section>
    <details className="panel"><summary>Run diagnostics</summary><CurrentRuns runs={currentRuns} error={runsError} onRefresh={() => { void loadRuns(); }} /></details>
    <div id="onboarding"><details key={requested?.id ?? "search"} open={Boolean(requested)}>
      <summary>Add a location</summary>
      <LocationOnboarding requested={requested} busy={busy} enrolled={locations?.map((location) => location.id) ?? []} onAdd={async (place) => {
        setBusy(true); setError(""); setNotice("");
        try {
          await adminApi("locations", { method: "POST", body: JSON.stringify({ place_id: place.id }) });
          setNotice(`Added ${place.name}. Open its workspace to manage sources, collect stories, publish editions, and make videos.`);
          await load();
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setBusy(false); }
      }} />
    </details></div>
  </>;
}
