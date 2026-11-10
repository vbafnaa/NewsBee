"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { mapApi } from "@/lib/admin-client";
import RunFunnel from "./run-funnel";

/** The edition tabs that used to sit under Source map: the Edition funnel and Compare editions. */
export default function EditionReview({ locationId, runId, view }: { locationId: string; runId: string | null; view: "funnel" | "compare" }) {
  const router = useRouter();
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState("");
  const path = (location: string, nextView = view) => `/edition-map?${new URLSearchParams({ ...(location ? { location } : {}), ...(nextView === "compare" ? { view: "compare" } : {}) })}`;
  useEffect(() => {
    mapApi<{ locations: Array<{ id: string; name: string }> }>("locations").then((value) => setLocations(value.locations))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  return <>
    <nav className="tabs" aria-label="Edition map views">
      <Link aria-current={view !== "compare" ? "page" : undefined} href={path(locationId, "funnel")}>Edition funnel</Link>
      <Link aria-current={view === "compare" ? "page" : undefined} href={path(locationId, "compare")}>Compare editions</Link>
    </nav>
    <section className="workspace-toolbar panel">
      <label className="field">Location<select value={locationId} onChange={(event) => router.push(path(event.target.value))}>
        <option value="">Choose a location</option>{locations.map((location) => <option value={location.id} key={location.id}>{location.name}</option>)}
      </select></label>
      {locationId && <Link className="button secondary" href={`/source-map?location=${encodeURIComponent(locationId)}`}>Its sources</Link>}
    </section>
    {error && <p className="alert" role="alert">{error}</p>}
    {!locationId ? <section className="panel"><h2>Choose a location above to review its editions</h2></section> :
      <RunFunnel key={`${locationId}:${view}`} locationId={locationId} runId={runId} view={view} />}
  </>;
}
