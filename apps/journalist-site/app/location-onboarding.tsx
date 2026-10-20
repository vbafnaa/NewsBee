"use client";

import { useEffect, useId, useState } from "react";
import { adminApi } from "@/lib/admin-client";

type Place = { id: string; name: string; branch_count: number; system_count: number; kind?: "neighborhood"; provider?: string; area?: string };

export default function LocationOnboarding({ busy, enrolled, onAdd }: {
  busy: boolean; enrolled: string[]; onAdd: (place: Place) => Promise<void>;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [selected, setSelected] = useState<Place | null>(null);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [discovering, setDiscovering] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (searchQuery === query && query.trim().length >= 2) return;
    if (query.trim().length < 2 || selected) {
      setPlaces([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = window.setTimeout(async () => {
      try {
        const data = await adminApi<{ results: Place[] }>(`places?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPlaces(data.results);
        setActive(-1);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, selected, retry, searchQuery]);

  function choose(place: Place) {
    setSelected(place);
    setQuery(place.name);
    setLoading(false);
    setOpen(false);
  }
  async function discover() {
    if (query.trim().length < 2 || discovering) return;
    setDiscovering(true); setLoading(false); setSearchQuery(query); setError(""); setSelected(null); setPlaces([]); setActive(-1);
    try {
      const data = await adminApi<{ results: Place[] }>(`places?q=${encodeURIComponent(query)}&discover=1`);
      setPlaces(data.results); setActive(-1); setOpen(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setDiscovering(false); }
  }
  const added = selected ? enrolled.includes(selected.id) : false;
  return <section className="panel onboarding-panel" aria-labelledby="onboarding-title">
    <div className="section-heading"><div><p className="eyebrow">Add a community</p><h2 id="onboarding-title">Find your community</h2></div><span className="muted">Search &rarr; select &rarr; add</span></div>
    <p>Search any US neighborhood or community, then select and add it. A resolved location can be added even when some news sources are unavailable; source coverage is reported separately.</p>
    <form className="onboarding-form" onSubmit={(event) => { event.preventDefault(); if (selected && !added && !busy) void onAdd(selected); }}>
      <div className="town-combobox">
        <label className="field"><span>Neighborhood, town or city</span><input role="combobox" aria-autocomplete="list"
          aria-expanded={open && !selected && places.length > 0} aria-controls={listId} aria-describedby={`${listId}-help`}
          aria-activedescendant={active >= 0 && open && places[active] ? `${listId}-${active}` : undefined}
          value={query} placeholder="Try Wallingford, Seattle, WA" autoComplete="off" maxLength={80} disabled={discovering}
          onChange={(event) => { setQuery(event.target.value); setSearchQuery(""); setSelected(null); setPlaces([]); setActive(-1); setOpen(true); }}
          onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") { setOpen(false); setActive(-1); }
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && places.length) {
              event.preventDefault(); setOpen(true);
              setActive((value) => (value + (event.key === "ArrowDown" ? 1 : places.length - 1) + places.length) % places.length);
            }
            if (event.key === "Enter" && !selected) {
              event.preventDefault();
              if (open && active >= 0 && places[active]) choose(places[active]);
              else void discover();
            }
          }} /></label>
        <ul id={listId} role="listbox" aria-label="Matching communities" className="town-suggestions" hidden={!open || !!selected || !places.length}>
          {places.map((place, index) => <li role="option" id={`${listId}-${index}`} key={place.id} aria-selected={index === active}
            onMouseDown={(event) => event.preventDefault()} onClick={() => choose(place)}>
            <strong>{place.name}</strong><small>{enrolled.includes(place.id) ? "Already added" : place.provider ? `${place.provider} - ${place.area === "boundary" ? "boundary available" : "approximate area"}; sources checked when added` : `${place.kind === "neighborhood" ? "Community - " : ""}${place.system_count} library systems / ${place.branch_count} branches`}</small>
          </li>)}
        </ul>
      </div>
      <button type="button" className="secondary" disabled={busy || discovering || query.trim().length < 2} onClick={() => void discover()}>{discovering ? "Searching..." : "Search all communities"}</button>
      <button type="submit" disabled={busy || !selected || added}>{busy ? "Working..." : added ? "Location added" : "Add location"}</button>
    </form>
    <p id={`${listId}-help`} role="status" className="onboarding-help">
      {error ? `Location search unavailable: ${error}` : discovering ? "Searching OpenStreetMap communities..." : loading ? "Finding saved locations. On first use, reference directories are prepared automatically; this may take a minute." :
        selected ? `${selected.name} selected. ${added ? "This location is already in your workspace." : "Add it to set up its sources; start a run when you are ready."}` :
          query.trim().length < 2 ? "Type a community name and city/state, then press Search all communities or Enter." : places.length ? `${places.length} matches. Select a community or use arrow keys and Enter.` : searchQuery === query ? "No matching communities. Try including the city and state or a different spelling." : "No saved matches. Press Search all communities to query the geographic directory."}
    </p>
    <p className="chart-caption">Geographic search: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">&copy; OpenStreetMap contributors</a> via Photon. Only submitted searches are sent to the provider; boundaries and source availability vary.</p>
    {error && <button className="secondary" onClick={() => searchQuery === query ? void discover() : setRetry((value) => value + 1)}>Retry search</button>}
  </section>;
}
