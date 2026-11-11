"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiJson, mapApi } from "@/lib/admin-client";
import SourceMapManager from "../locations/[locationId]/source-map-manager";
import SourceRuns from "./source-runs";

/**
 * Source map: All sources (the source network) and Collect sources (what each run did), read-only for
 * everyone. Sources are edited, and runs started, only in a location's workspace, under Sources.
 */
export default function SourceReview({ locationId, tab, runId, signedIn, showLocationPicker = true, locationName, basePath }: { locationId: string; tab: "sources" | "runs"; runId: string | null; signedIn: boolean; showLocationPicker?: boolean; locationName?: string; basePath?: string }) {
  const router = useRouter();
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>(() =>
    !showLocationPicker && locationId ? [{ id: locationId, name: locationName ?? locationId }] : []);
  const [error, setError] = useState("");
  const path = (location: string, nextTab = tab, run?: string | null) => {
    const params = new URLSearchParams({
      ...(!basePath && location ? { location } : {}),
      ...(nextTab === "runs" ? { tab: "runs" } : {}),
      ...(run ? { run } : {}),
    });
    return `${basePath ?? "/source-map"}?${params}`;
  };
  useEffect(() => {
    if (!showLocationPicker) return;
    mapApi<{ locations: Array<{ id: string; name: string }> }>("locations").then((value) => setLocations(value.locations))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [showLocationPicker]);
  return <>
    <nav className="tabs" aria-label="Source map views">
      <Link aria-current={tab === "sources" ? "page" : undefined} href={path(locationId, "sources")}>All sources</Link>
      <Link aria-current={tab === "runs" ? "page" : undefined} href={path(locationId, "runs")}>Collect sources</Link>
    </nav>
    {error && <p className="alert" role="alert">{error}</p>}
    {tab === "runs" ? <SourceRuns key={locationId} locationId={locationId} runId={runId} canEdit={false} locations={locations}
      routeFor={basePath ? (location, run) => path(location, "runs", run) : undefined}
      editHref={signedIn && locationId ? `/locations/${encodeURIComponent(locationId)}?${new URLSearchParams({ tab: "collect-sources", ...(runId ? { run: runId } : {}) })}` : null} /> : <>
      <section className="workspace-toolbar panel">
        {showLocationPicker && <label className="field">Coverage area<select value={locationId} onChange={(event) => router.push(path(event.target.value))}>
          <option value="">All locations · source network</option>{locations.map((location) => <option value={location.id} key={location.id}>{location.name}</option>)}
        </select></label>}
        {locationId && signedIn && <Link className="button secondary" href={`/locations/${encodeURIComponent(locationId)}?tab=sources`}>Edit in workspace</Link>}
        {!signedIn && <button className="secondary" onClick={async () => {
          try { await apiJson("/api/internal-access", { method: "DELETE" }); router.refresh(); }
          catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        }}>Lock maps</button>}
      </section>
      <SourceMapManager key={locationId} locationId={locationId || undefined} />
    </>}
  </>;
}
