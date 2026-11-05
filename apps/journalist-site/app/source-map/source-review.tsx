"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiJson, mapApi } from "@/lib/admin-client";
import SourceMapManager from "../locations/[locationId]/source-map-manager";
import RunFunnel from "./run-funnel";

export default function SourceReview({ locationId, mode, runId, view }: { locationId: string; mode: string; runId: string | null; view: string }) {
  const router = useRouter();
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState("");
  const path = (location: string, nextMode = mode, run?: string | null, nextView?: string) => `/source-map?${new URLSearchParams({ ...(location ? { location } : {}), mode: nextMode, ...(run ? { run } : {}), ...(nextView ? { view: nextView } : {}) })}`;
  useEffect(() => {
    mapApi<{ locations: Array<{ id: string; name: string }> }>("locations").then((value) => setLocations(value.locations))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  return <>
    <section className="workspace-toolbar panel">
      <label className="field">Coverage area<select value={locationId} onChange={(event) => router.push(path(event.target.value))}>
        <option value="">All locations · source network</option>{locations.map((location) => <option value={location.id} key={location.id}>{location.name}</option>)}
      </select></label>
      {locationId && <Link className="button secondary" href={`/locations/${encodeURIComponent(locationId)}?tab=settings#source-settings`}>Manage sources · journalist sign-in</Link>}
      <button className="secondary" onClick={async () => {
        try { await apiJson("/api/internal-access", { method: "DELETE" }); router.refresh(); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>Lock maps</button>
    </section>
    <nav className="tabs" aria-label="Source review views">
      <Link aria-current={mode === "edition" && view !== "compare" ? "page" : undefined} href={path(locationId, "edition")}>Run funnel</Link>
      <Link aria-current={mode === "edition" && view === "compare" ? "page" : undefined} href={path(locationId, "edition", null, "compare")}>Compare runs</Link>
      <Link aria-current={mode !== "edition" ? "page" : undefined} href={path(locationId, "inventory")}>Source network</Link>
    </nav>
    {error && <p className="alert" role="alert">{error}</p>}
    {mode !== "edition" ? <SourceMapManager key={locationId} locationId={locationId || undefined} /> :
      !locationId ? <section className="panel"><h2>Choose a location to review a run</h2><p>Each run is specific to one location. Choose a coverage area above to see its funnel, from the first search to the final edition.</p></section> :
      <RunFunnel key={`${locationId}:${view}`} locationId={locationId} runId={runId} view={view} />}
  </>;
}
