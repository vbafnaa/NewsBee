"use client";

import { useEffect, useId, useState } from "react";
import { adminApi } from "@/lib/admin-client";

type Place = { id: string; name: string; branch_count: number; system_count: number };

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

  useEffect(() => {
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
  }, [query, selected, retry]);

  function choose(place: Place) {
    setSelected(place);
    setQuery(place.name);
    setOpen(false);
  }
  const added = selected ? enrolled.includes(selected.id) : false;
  return <section className="panel onboarding-panel" aria-labelledby="onboarding-title">
    <div className="section-heading"><div><p className="eyebrow">Add a community</p><h2 id="onboarding-title">Find your town</h2></div><span className="muted">Search &rarr; select &rarr; add</span></div>
    <p>Choose a town or city. We&apos;ll find the correct sources for news automatically.</p>
    <form className="onboarding-form" onSubmit={(event) => { event.preventDefault(); if (selected && !added) void onAdd(selected); }}>
      <div className="town-combobox">
        <label className="field"><span>Town or city</span><input role="combobox" aria-autocomplete="list"
          aria-expanded={open && !selected && places.length > 0} aria-controls={listId} aria-describedby={`${listId}-help`}
          aria-activedescendant={active >= 0 && open && places[active] ? `${listId}-${active}` : undefined}
          value={query} placeholder="Start typing, e.g. Vancouver, WA" autoComplete="off" maxLength={80}
          onChange={(event) => { setQuery(event.target.value); setSelected(null); setPlaces([]); setActive(-1); setOpen(true); }}
          onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") { setOpen(false); setActive(-1); }
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && places.length) {
              event.preventDefault(); setOpen(true);
              setActive((value) => (value + (event.key === "ArrowDown" ? 1 : places.length - 1) + places.length) % places.length);
            }
            if (event.key === "Enter" && open && active >= 0 && places[active]) { event.preventDefault(); choose(places[active]); }
          }} /></label>
        <ul id={listId} role="listbox" aria-label="Matching towns" className="town-suggestions" hidden={!open || !!selected || !places.length}>
          {places.map((place, index) => <li role="option" id={`${listId}-${index}`} key={place.id} aria-selected={index === active}
            onMouseDown={(event) => event.preventDefault()} onClick={() => choose(place)}>
            <strong>{place.name}</strong><small>{enrolled.includes(place.id) ? "Already added" : `${place.system_count} library systems / ${place.branch_count} branches`}</small>
          </li>)}
        </ul>
      </div>
      <button type="submit" disabled={busy || !selected || added}>{busy ? "Working..." : added ? "Location added" : "Add location"}</button>
    </form>
    <p id={`${listId}-help`} role="status" className="onboarding-help">
      {error ? `Location search unavailable: ${error}` : loading ? "Finding towns. On first use, reference directories are prepared automatically; this may take a minute." :
        selected ? `${selected.name} selected. ${added ? "This location is already in your workspace." : "Add it to set up its sources; start a run when you are ready."}` :
          query.trim().length < 2 ? "Type at least two letters; add a state to narrow the results." : places.length ? `${places.length} matches. Select a town or use arrow keys and Enter.` : "No matching towns. Try a different spelling or state."}
    </p>
    {error && <button className="secondary" onClick={() => setRetry((value) => value + 1)}>Retry search</button>}
  </section>;
}
