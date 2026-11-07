"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import LocationRemoval from "./location-removal";
import { RunExecutionSummary } from "../../components/execution-policy";
import type { ExecutionBinding } from "@/pipeline/accounts/execution";

type Location = { id: string; name: string; state: string; removal_pending?: boolean; directory_edition?: string; systems?: { name: string; website?: string | null }[];
  government?: { status?: string; platform?: string | null } | null;
  source_coverage?: { status: string; gaps?: string[] } };
type Run = { _id: string; execution?: ExecutionBinding; status: string; created_at: number; completed_at: number | null;
  kind?: string; trigger: { by: string; kind: string }; published?: { items: number; held: number } | null;
  error?: string | null; diagnostics?: { issues: { message: string; severity: string }[] } | null };
const PAGE_SIZE = 50;
const time = (value: number | null) => value ? new Date(value * 1000).toLocaleString() : "—";

export default function LocationDetail({ locationId, view = "history", owner = false }: { locationId: string; view?: "history" | "profile"; owner?: boolean }) {
  const [location, setLocation] = useState<Location | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const loadPage = useCallback(async (offset: number) => {
    setBusy(true);
    try {
      const page = await adminApi<{ runs: Run[]; hasMore: boolean }>(
        `runs?location=${encodeURIComponent(locationId)}&limit=${PAGE_SIZE}&offset=${offset}`,
      );
      setRuns((previous) => offset === 0 ? page.runs : [...previous, ...page.runs]);
      setHasMore(page.hasMore);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setLoaded(true);
    }
  }, [locationId]);

  useEffect(() => {
    let active = true;
    adminApi<{ location: Location }>(`locations/${encodeURIComponent(locationId)}`)
      .then((result) => { if (active) setLocation(result.location); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    if (view === "history") void loadPage(0);
    return () => { active = false; };
  }, [locationId, loadPage, view]);

  useEffect(() => {
    const refresh = () => { void loadPage(0); };
    window.addEventListener("newsbee:runs-changed", refresh);
    return () => window.removeEventListener("newsbee:runs-changed", refresh);
  }, [loadPage]);

  return <>
    {error && <p role="alert" className="alert">{error}</p>}
    {view === "profile" && <section className="panel">
      <h2>{location?.name ?? "Loading location…"}</h2>
      {location && <dl>
        <dt>Location ID</dt><dd><code>{location.id}</code></dd>
        <dt>State</dt><dd>{location.state}</dd>
        <dt>Directory edition</dt><dd>{location.directory_edition ?? "—"}</dd>
        <dt>Library systems</dt><dd>{location.systems?.length ? <ul>{location.systems.map((system, index) =>
          <li key={index}>{system.website ? <a href={system.website} target="_blank" rel="noopener noreferrer">{system.name}</a> : system.name}</li>)}</ul> : "None"}</dd>
        <dt>Government source</dt><dd>{location.government?.status ?? "None"}{location.government?.platform && ` · ${location.government.platform}`}</dd>
        <dt>Source coverage</dt><dd>{location.source_coverage?.status?.replaceAll("_", " ") ?? "Not assessed"}</dd>
        <dt>Manage</dt><dd><a href={`/locations/${encodeURIComponent(locationId)}?tab=sources`}>Source map</a></dd>
      </dl>}
      {location?.source_coverage?.gaps?.length ? <ul>{location.source_coverage.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul> : null}
    </section>}
    {owner && view === "profile" && location && <LocationRemoval locationId={locationId} name={location.name} pending={location.removal_pending} />}
    {view === "history" && <section className="panel">
      <h2>Run history</h2>
      {runs.length === 0 && loaded && !busy && !error && <p>No runs for this location yet.</p>}
      <ol className="location-run-history">
        {runs.map((run) => <li key={run._id}>
          <div><button className="run-inspect-link" type="button" onClick={() => window.dispatchEvent(new CustomEvent("newsbee:inspect-run", { detail: { runId: run._id } }))}>
            {time(run.created_at)} · Inspect run</button> <span className="status-badge">{run.status.replaceAll("_", " ")}</span></div>
          <p className="chart-caption">{run.kind === "map" ? "Source map run · " : ""}{run.trigger.kind} by {run.trigger.by} · Finished: {time(run.completed_at)}
            {run.published && ` · ${run.published.items} published, ${run.published.held} held`}</p>
          <RunExecutionSummary run={run} />
          {run.error && <p className="stage-error">{run.error}</p>}
          {run.diagnostics?.issues?.filter((issue) => issue.severity !== "info").map((issue, index) =>
            <p className="stage-error" key={index}>{issue.message}</p>)}
        </li>)}
      </ol>
      {hasMore && <button type="button" className="secondary" disabled={busy} onClick={() => void loadPage(runs.length)}>
        {busy ? "Loading…" : "Load older runs"}
      </button>}
      {busy && !hasMore && <p>Loading runs…</p>}
    </section>}
  </>;
}
