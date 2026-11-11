import Link from "next/link";
import type { CurrentRun } from "@/pipeline/orchestration/runs";

export function CurrentRuns({ runs, error, onRefresh }: { runs: CurrentRun[] | null; error: string; onRefresh: () => void }) {
  return <section className="panel current-runs" aria-label="Current runs">
    <div className="section-heading">
      <h2>Current runs{runs ? ` (${runs.length})` : ""}</h2>
      <button type="button" className="secondary" onClick={onRefresh}>Refresh runs</button>
    </div>
    {error && <p className="alert" role="alert">Could not refresh runs: {error}</p>}
    {!runs && !error && <p role="status">Loading runs…</p>}
    {runs?.length === 0 && <p>No runs in progress.</p>}
    {runs && runs.length > 0 && <ul className="location-directory-list">{runs.map((run) => {
      const kind = run.kind === "map" ? "Source map" : "Edition";
      const tab = run.kind === "map" ? "collect-sources" : "edition";
      const href = `/locations/${encodeURIComponent(run.location_id)}?tab=${tab}&run=${encodeURIComponent(run._id)}`;
      const started = new Date(run.created_at * 1000);
      return <li className="location-directory-row" key={run._id}>
        <div className="location-directory-copy">
          <p className="eyebrow">{kind}</p>
          <h3><Link href={href}>{run.location_name}</Link></h3>
          <small>Started <time dateTime={started.toISOString()}>{started.toLocaleString()}</time></small>
        </div>
        <div className="location-directory-actions">
          <span className="status-badge">{run.execution_blocked ? "Paused · " : ""}{run.status.replaceAll("_", " ")}</span>
          <Link className="button secondary" href={href}>View run</Link>
        </div>
      </li>;
    })}</ul>}
  </section>;
}
