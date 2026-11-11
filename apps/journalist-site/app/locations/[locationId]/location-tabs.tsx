"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import Dashboard from "../../dashboard";
import LocationDetail from "./location-detail";
import SourceRuns from "../../source-map/source-runs";
import SourceMapManager from "./source-map-manager";
import RunItems from "./run-items";
import InboxView from "../../inbox/inbox-view";
import NeighbourStoryReview from "../../neighbour-stories/neighbour-story-review";
import RemembranceReview from "../../remembrance/remembrance-review";
import PhotoSupplyManager from "./photo-supply-manager";
import AlertsList from "../../alerts/alerts-list";
import { WINDOWS } from "@/pipeline/sourcemap/windows";
import { LOCATION_TABS } from "./tabs";

/** Production steps and reader tools for one location. */
type Run = { _id: string; kind?: string; isolated?: boolean; edition_id?: string | null; status: string; created_at: number; completed_at: number | null };
type MapState = {
  sources: number; read: number; proposed: number; unreviewed: number; lastMap: Run | null; lastEdition: Run | null; refreshedAt: number | null;
  /** Test mode: source runs keep their results to themselves (NEWSBEE_SOURCE_RUNS_ISOLATED). */
  isolated: boolean;
  /** Editions read only sources a person accepted (NEWSBEE_PROPOSED_UNTIL_APPROVED). */
  acceptedOnly: boolean;
};
/** A finished edition: built (waiting to be published) or published; `live` is the one the reader shows. */
export type FinishedEdition = {
  id: string; run_id: string; status: "built" | "published"; live: boolean; built_at: number | null; published_at: number | null;
  first_published_at: number | null; published_by: string | null; window: [string, string]; headline: string | null; items: number; held: number;
};

const OPEN = ["mapping", "collecting", "awaiting_authoring", "authoring", "awaiting_finish", "finishing", "publishing"];
const tone = (status: string) => status === "failed" ? "failed" : ["published", "built", "mapped"].includes(status) ? "ok" : "running";
const when = (value: number | null | undefined) => value ? new Date(value * 1000).toLocaleString() : "never";
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** How far along each step is: the source map's last refresh and review, and the latest edition. */
function useMapState(locationId: string) {
  const [state, setState] = useState<MapState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = () => Promise.all([
      adminApi<{ sources: Array<{ status: string; link_only?: boolean; review?: { decision: string | null } }>; discovery: Array<{ last_run_at?: number }> }>(`locations/${encodeURIComponent(locationId)}/source-map`),
      adminApi<{ runs: Run[] }>(`runs?location=${encodeURIComponent(locationId)}&limit=50`),
      adminApi<{ isolated?: boolean; proposed_until_approved?: boolean }>("run-options").catch(() => ({ isolated: false, proposed_until_approved: false })),
    ]).then(([map, history, modes]) => {
      if (!live) return;
      const sources = map.sources.filter((source) => source.status !== "rejected");
      // Link-only sources are never read, so they don't wait on a review.
      const proposed = sources.filter((source) => source.status === "proposed" && !source.link_only);
      const lastMap = history.runs.find((run) => run.kind === "map") ?? null;
      // A test-mode run leaves the source map as it was, so it isn't when the map last changed.
      const lastWrite = history.runs.find((run) => run.kind === "map" && !run.isolated && run.status === "mapped") ?? null;
      const methodsRan = Math.max(0, ...map.discovery.map((state) => state.last_run_at ?? 0));
      setState({
        sources: sources.length,
        read: sources.filter((source) => ["active", "pinned"].includes(source.status) && !source.link_only).length,
        proposed: proposed.length,
        unreviewed: proposed.filter((source) => !source.review?.decision).length,
        lastMap,
        // Before map runs, discovery ran inside editions: its methods' last run is when the map last changed.
        refreshedAt: lastWrite?.completed_at ?? (methodsRan || null),
        isolated: Boolean(modes.isolated),
        acceptedOnly: Boolean(modes.proposed_until_approved),
        lastEdition: history.runs.find((run) => run.kind !== "map") ?? null,
      });
    }).catch((cause: unknown) => { if (live) setError(errorText(cause)); });
    void load();
    window.addEventListener("newsbee:runs-changed", load);
    return () => { live = false; window.removeEventListener("newsbee:runs-changed", load); };
  }, [locationId]);
  return { state, error };
}

/** The location's finished editions, reloaded when a run or a publish changes them. */
function useEditions(locationId: string) {
  const [editions, setEditions] = useState<FinishedEdition[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => adminApi<{ editions: FinishedEdition[] }>(`locations/${encodeURIComponent(locationId)}/editions`)
    .then((data) => { setEditions(data.editions); setError(""); }).catch((cause: unknown) => setError(errorText(cause))), [locationId]);
  useEffect(() => {
    void load();
    window.addEventListener("newsbee:runs-changed", load);
    return () => window.removeEventListener("newsbee:runs-changed", load);
  }, [load]);
  return { editions, error, reload: load };
}

/** What a source run changes, in one line, under the current settings. */
function SourcesGuide({ state }: { state: MapState }) {
  return <p className="chart-caption">
    {state.read} sources read{state.proposed ? ` · ${state.proposed} proposed${state.unreviewed ? `, ${state.unreviewed} to review` : ""}` : ""} · map changed {when(state.refreshedAt)}
    {state.isolated ? " · test mode: runs don't change All sources" : ""}{state.acceptedOnly ? " · editions read accepted sources only" : ""}
  </p>;
}

export default function LocationTabs({ locationId, tab, name, owner = false, runId = null }: {
  locationId: string; tab: string; name: string; owner?: boolean; runId?: string | null;
}) {
  const base = `/locations/${encodeURIComponent(locationId)}`;
  const { state, error } = useMapState(locationId);
  const finished = useEditions(locationId);
  const waiting = finished.editions?.filter((edition) => edition.status === "built").length ?? 0;
  const live = finished.editions?.find((edition) => edition.live) ?? null;
  return <>
    <div className="card-actions workspace-links"><Link href={`${base}/source-map`}>Source map</Link><a href={`/reader?location=${encodeURIComponent(locationId)}`}>Reader</a></div>
    <nav className="tabs workspace-tabs" aria-label="Location workflow">{LOCATION_TABS.map(([id, label]) => <Link key={id} href={`${base}?tab=${id}`} aria-current={tab === id ? "page" : undefined}>{label}{id === "published" && waiting ? ` (${waiting})` : ""}</Link>)}</nav>
    {error && <p className="alert" role="alert">{error}</p>}
    {tab === "overview" && <>
      <div className="step-grid">
        <section className="panel step-card"><p className="eyebrow">Step 1</p><h2>Sources</h2>
          {!state ? <p role="status">Loading…</p> : <>
            <p>{state.sources} in list · {state.read} read{state.unreviewed ? ` · ${state.unreviewed} to review` : ""}</p>
            <Link className="button" href={`${base}?tab=sources`}>{state.unreviewed ? "Review sources" : "View sources"}</Link>
          </>}
        </section>
        <section className="panel step-card"><p className="eyebrow">Step 2</p><h2>Collect sources</h2>
          {!state ? <p role="status">Loading…</p> : <>
            <p>{state.lastMap ? <><span className={`status-badge tone-${tone(state.lastMap.status)}`}>{state.lastMap.status === "mapped" ? "ready for review" : state.lastMap.status.replaceAll("_", " ")}</span> {when(state.lastMap.created_at)}</> : "No source collection runs yet."}</p>
            <Link className="button" href={`${base}?tab=collect-sources`}>{state.lastMap && OPEN.includes(state.lastMap.status) ? "Continue" : "Collect sources"}</Link>
          </>}
        </section>
        <section className="panel step-card"><p className="eyebrow">Step 3</p><h2>Collect stories</h2>
          {!state ? <p role="status">Loading…</p> : <>
            <p>{state.lastEdition ? <><span className={`status-badge tone-${tone(state.lastEdition.status)}`}>{state.lastEdition.status === "built" ? "ready to publish" : state.lastEdition.status.replaceAll("_", " ")}</span> {when(state.lastEdition.created_at)}</> : "No editions yet."}</p>
            <Link className="button" href={`${base}?tab=edition`}>{state.lastEdition && OPEN.includes(state.lastEdition.status) ? "Continue" : "Collect stories"}</Link>
          </>}
        </section>
        <section className="panel step-card"><p className="eyebrow">Step 4</p><h2>Publish</h2>
          <p>{waiting ? `${waiting} ready to publish` : live ? `Live: ${when(live.published_at)}` : "Nothing published yet."}</p>
          <Link className="button" href={`${base}?tab=published`}>{waiting ? "Review and publish" : "Open"}</Link>
        </section>
      </div>
      <h2>Needs attention</h2><AlertsList locationId={locationId} actions />
    </>}
    {tab === "collect-sources" && <>
      {state && <SourcesGuide state={state} />}
      <h2>Collect sources</h2>
      {runId && <Dashboard locationId={locationId} kind="map" inspectorOnly />}
      <SourceRuns locationId={locationId} runId={runId} canEdit locations={[]} routeFor={(_, run) => `${base}?${new URLSearchParams({ tab: "collect-sources", ...(run ? { run } : {}) })}`} />
    </>}
    {tab === "sources" && <>
      <h2>All sources</h2>
      <div id="source-settings"><SourceMapManager locationId={locationId} editable /></div>
      <InboxView locationId={locationId} only={["suggestions"]} />
      <details className="panel"><summary>Default lookup windows</summary>
        <dl className="window-list">{Object.entries(WINDOWS).map(([id, value]) => <div key={id}><dt>{id.replaceAll("_", " ")}</dt><dd>{value.label}</dd></div>)}</dl>
      </details>
    </>}
    {tab === "edition" && <>
      {state && (!state.sources || state.unreviewed > 0) && <p className="notice" role="status">
        {!state.sources ? <>No sources yet. <Link href={`${base}?tab=sources`}>Start with sources</Link>.</>
          : <>{state.unreviewed} sources to review (not read until accepted). <Link href={`${base}?tab=sources`}>Review</Link></>}
      </p>}
      <p className="chart-caption">Collects source items, ranks and writes stories, then prepares the edition front page and email. Review held stories and reader submissions here; publish the finished edition in <Link href={`${base}?tab=published`}>Publish</Link>.</p>
      <Dashboard locationId={locationId} owner={owner} kind="edition" />
      <RunItems locationId={locationId} />
      <InboxView locationId={locationId} only={["held"]} />
      <div id="reader-stories"><NeighbourStoryReview locationId={locationId} /></div>
      <div id="family-notices"><RemembranceReview locationId={locationId} /></div>
      <PhotoSupplyManager locationId={locationId} />
      <LocationDetail locationId={locationId} view="history" kind="edition" />
    </>}
    {tab === "published" && <>
      <PublishList locationId={locationId} {...finished} />
      <InboxView locationId={locationId} only={["reports"]} />
    </>}
    {tab === "settings" && <LocationDetail locationId={locationId} view="profile" owner={owner} />}
  </>;
}

/** Every finished edition: review it, publish it, or make an earlier one live again. */
function PublishList({ locationId, editions, error, reload }: { locationId: string; editions: FinishedEdition[] | null; error: string; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const base = `/locations/${encodeURIComponent(locationId)}`;
  async function publish(edition: FinishedEdition) {
    if (!window.confirm(edition.status === "built" ? "Publish this edition to the reader?" : "Make this edition live again?")) return;
    setBusy(edition.id); setFailure(""); setNotice("");
    try {
      await adminApi(`locations/${encodeURIComponent(locationId)}/editions/${encodeURIComponent(edition.id)}/publish`, { method: "POST" });
      setNotice("Published.");
      await reload();
      window.dispatchEvent(new Event("newsbee:runs-changed"));
    } catch (cause) { setFailure(errorText(cause)); }
    finally { setBusy(null); }
  }
  return <section className="panel"><h2>Editions</h2>
    {(error || failure) && <p className="alert" role="alert">{error || failure}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!editions && !error && <p role="status">Loading…</p>}
    {editions?.length === 0 && <p>None yet. <Link href={`${base}?tab=edition`}>Collect stories</Link>.</p>}
    <ul className="edition-list">{editions?.map((edition) => <li key={edition.id}>
      <div>
        <strong>{edition.headline ?? "Untitled edition"}</strong>{" "}
        <span className={`status-badge tone-${edition.live ? "ok" : edition.status === "built" ? "warning" : ""}`}>{edition.live ? "Live" : edition.status === "built" ? "Ready to publish" : "Published earlier"}</span>
        <p className="chart-caption">{edition.window[0]} to {edition.window[1]} · {edition.items} stories{edition.held ? ` · ${edition.held} held` : ""} · built {when(edition.built_at)}{edition.published_at ? ` · published ${when(edition.published_at)}${edition.published_by ? ` by ${edition.published_by}` : ""}` : ""}</p>
      </div>
      <div className="card-actions">
        {!edition.live && <button type="button" disabled={busy !== null} onClick={() => void publish(edition)}>{busy === edition.id ? "Publishing…" : edition.status === "built" ? "Publish" : "Make live"}</button>}
        <Link href={`${base}?tab=edition&run=${encodeURIComponent(edition.run_id)}`}>Review stories</Link>
        <Link href={`/edition-map?location=${encodeURIComponent(locationId)}&run=${encodeURIComponent(edition.run_id)}`}>Funnel</Link>
        {edition.status === "published" && <a href={`/reader?location=${encodeURIComponent(locationId)}&edition=${encodeURIComponent(edition.id)}`}>Read</a>}
      </div>
    </li>)}</ul>
  </section>;
}
