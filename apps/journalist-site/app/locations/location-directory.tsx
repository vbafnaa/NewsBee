"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import LocationOnboarding from "../location-onboarding";

type Location = { id: string; name: string; state: string; removal_pending?: boolean; source_coverage?: { status: string } };
export default function LocationDirectory({ owner = false }: { owner?: boolean }) {
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setLocations((await adminApi<{ locations: Location[] }>("locations")).locations); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => {
    const removed = new URLSearchParams(window.location.search).get("removed");
    if (removed) setNotice(`Removed ${removed} and its tracked generated files. Shared and retained reader data were not deleted.`);
    void load();
  }, [load]);
  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="panel">
      <div className="section-heading"><h2>Locations</h2></div>
      <label className="field">Find a workspace<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by location" /></label>
      {!locations && !error && <p role="status">Loading locations…</p>}
      <ul className="location-directory-list">{locations?.filter((location) => location.name.toLowerCase().includes(query.toLowerCase())).map((location) => <li className="location-directory-row" key={location.id}>
        <div className="location-directory-copy">
          <p className="eyebrow">{location.state} · {location.source_coverage?.status?.replaceAll("_", " ") ?? "Coverage not assessed"}</p>
          <h3><Link href={`/locations/${encodeURIComponent(location.id)}`}>{location.name}</Link></h3>
          {location.removal_pending && <p className="alert">Removal incomplete{owner ? <> — <Link href={`/locations/${encodeURIComponent(location.id)}?tab=settings#remove-location`}>retry cleanup</Link></> : " — contact the owner"}</p>}
        </div>
        <div className="location-directory-actions"><Link className="button secondary" href={`/locations/${encodeURIComponent(location.id)}`}>Open workspace</Link></div>
      </li>)}</ul>
      {locations?.length === 0 && <p>No locations onboarded. Add your first community below.</p>}
      {locations?.length !== 0 && locations && !locations.some((location) => location.name.toLowerCase().includes(query.toLowerCase())) && <p>No locations match this search.</p>}
    </section>
    <div id="onboarding"><LocationOnboarding busy={busy} enrolled={locations?.map((location) => location.id) ?? []} onAdd={async (place) => {
      setBusy(true); setError(""); setNotice("");
      try {
        await adminApi("locations", { method: "POST", body: JSON.stringify({ place_id: place.id }) });
        setNotice(`Added ${place.name}. Open its workspace to manage sources, collect stories, publish editions, and make videos.`);
        await load();
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setBusy(false); }
    }} /></div>
  </>;
}
