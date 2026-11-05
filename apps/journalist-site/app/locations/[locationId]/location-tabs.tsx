"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import Dashboard from "../../dashboard";
import LocationDetail from "./location-detail";
import SourceMapManager from "./source-map-manager";
import RunItems from "./run-items";
import InboxView from "../../inbox/inbox-view";
import NeighbourStoryReview from "../../neighbour-stories/neighbour-story-review";
import RemembranceReview from "../../remembrance/remembrance-review";
import AlertsList from "../../alerts/alerts-list";
import { WINDOWS } from "@/pipeline/sourcemap/windows";

const TABS = [["overview", "Desk overview"], ["review", "Review inputs"], ["runs", "Pipeline & logs"], ["editions", "Editions"], ["settings", "Location details"]] as const;
type Run = { _id: string; edition_id?: string | null; status: string; created_at: number; completed_at: number | null; error?: string | null; published?: { items: number; held: number } | null };

export default function LocationTabs({ locationId, tab, name }: { locationId: string; tab: string; name: string }) {
  const base = `/locations/${encodeURIComponent(locationId)}`;
  const source = `/source-map?location=${encodeURIComponent(locationId)}`;
  return <>
    <p className="breadcrumbs"><Link href="/dashboard">Newsroom</Link> / <Link href="/locations">Location workspaces</Link> / {name}</p>
    <div className="workspace-banner"><div><p className="eyebrow">Community desk</p><h2>{name}</h2></div><div className="card-actions"><Link href={source}>Source map · internal</Link><a href={`/reader?location=${encodeURIComponent(locationId)}`}>Latest newsletter</a></div></div>
    <nav className="tabs workspace-tabs" aria-label="Location workflow">{TABS.map(([id, label]) => <Link key={id} href={`${base}?tab=${id}`} aria-current={tab === id ? "page" : undefined}>{label}</Link>)}</nav>
    {tab === "overview" && <>
      <div className="workflow-grid">
        <Link className="workflow-card" href={`${base}?tab=review`}><span className="eyebrow">01 · Prepare</span><strong>Review inputs</strong><small>Approve reader stories and sources; resolve alerts</small></Link>
        <Link className="workflow-card" href={`${base}?tab=runs`}><span className="eyebrow">02 · Produce</span><strong>Run the pipeline</strong><small>Collect, start authoring, review drafts, then publish</small></Link>
        <Link className="workflow-card" href={`${base}?tab=editions`}><span className="eyebrow">03 · Understand</span><strong>Review editions</strong><small>Open the result and trace its editorial decisions</small></Link>
      </div>
      <EditionList locationId={locationId} compact />
      <h2>Needs attention in this location</h2><AlertsList locationId={locationId} />
    </>}
    {tab === "review" && <>
      <section className="panel review-guide"><h2>Prepare the next collection</h2><p>Approve source suggestions and reader stories before starting collection: they feed the next pipeline run, not a run that has already collected its inputs. Held drafts and problem reports link back to the run where an editor can act.</p><div className="card-actions"><Link href={source}>Review source network</Link><Link className="button" href={`${base}?tab=runs`}>Continue to pipeline</Link></div></section>
      <InboxView locationId={locationId} />
      <div id="reader-stories"><NeighbourStoryReview locationId={locationId} /></div>
      <div id="family-notices"><RemembranceReview locationId={locationId} /></div>
      <h2>Source and pipeline alerts</h2><AlertsList locationId={locationId} />
    </>}
    {tab === "runs" && <>
      <section className="panel review-guide"><h2>One click, or stage by stage</h2><p>Autopilot runs discovery, collection, authoring and publishing with no stops. Manual mode stops after collection and after writing, for debugging one stage. Email is not sent.</p><div className="card-actions"><Link href={`${base}?tab=review`}>Review inputs</Link><Link href={`${source}&mode=edition`}>See the run funnel · internal</Link></div></section>
      <Dashboard locationId={locationId} /><RunItems locationId={locationId} /><LocationDetail locationId={locationId} view="history" />
    </>}
    {tab === "editions" && <EditionList locationId={locationId} />}
    {tab === "settings" && <>
      <LocationDetail locationId={locationId} view="profile" />
      <section className="panel"><h2>Source lookup windows</h2><p>Default reading windows by source type. Manage sources and change individual windows below. The separate <Link href={source}>password-protected source map</Link> is read-only.</p>
        <dl className="window-list">{Object.entries(WINDOWS).map(([id, value]) => <div key={id}><dt>{id.replaceAll("_", " ")}</dt><dd>{value.label}</dd></div>)}</dl>
      </section>
      <div id="source-settings"><SourceMapManager locationId={locationId} editable /></div>
    </>}
  </>;
}

function EditionList({ locationId, compact = false }: { locationId: string; compact?: boolean }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    adminApi<{ runs: Run[] }>(`runs?location=${encodeURIComponent(locationId)}&limit=${compact ? 1 : 50}`).then((data) => setRuns(data.runs))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [locationId, compact]);
  return <section className="panel"><h2>{compact ? "Latest production activity" : "Edition history"}</h2>
    <p>{compact ? "Continue the current run or review its output." : "Recent runs and their outputs. Open a published edition, or review the source and item decisions preserved for that run."}</p>
    {error && <p className="alert" role="alert">{error}</p>}
    {!runs && !error && <p role="status">Loading editions…</p>}
    {runs?.length === 0 && <p>No runs yet. Review inputs, then start your first collection.</p>}
    <ul className="edition-list">{runs?.map((run) => <li key={run._id}><div><strong>{new Date(run.created_at * 1000).toLocaleString()}</strong> <span className={`status-badge tone-${run.status === "failed" ? "failed" : run.status === "published" ? "ok" : "running"}`}>{run.status.replaceAll("_", " ")}</span>{run.published && <p>{run.published.items} published · {run.published.held} held</p>}{run.error && <p className="stage-error">{run.error}</p>}</div>
      <div className="card-actions"><Link href={`/locations/${encodeURIComponent(locationId)}?tab=runs&run=${encodeURIComponent(run._id)}`}>Controls, drafts & logs</Link><Link href={`/source-map?location=${encodeURIComponent(locationId)}&mode=edition&run=${encodeURIComponent(run._id)}`}>Decisions · internal</Link>{run.status === "published" && run.edition_id && <a href={`/reader?location=${encodeURIComponent(locationId)}&edition=${encodeURIComponent(run.edition_id)}`}>Read this edition</a>}</div>
    </li>)}</ul>
    {!compact && runs?.length === 50 && <p>Showing the latest 50 runs. Older runs remain accessible through pipeline run history.</p>}
    <div className="card-actions"><Link className="button secondary" href={`/locations/${encodeURIComponent(locationId)}?tab=runs`}>Open pipeline</Link>{compact && <Link href={`/locations/${encodeURIComponent(locationId)}?tab=editions`}>All recent editions</Link>}</div>
  </section>;
}
