"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ConnectorInventory } from "@/pipeline/connectors/inventory";
import { adminApi } from "@/lib/admin-client";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function SourceManagement() {
  const [data, setData] = useState<ConnectorInventory | null>(null);
  const [locationId, setLocationId] = useState("");
  const [connector, setConnector] = useState("library");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setData(await adminApi<ConnectorInventory>("connectors")), []);
  useEffect(() => { void load().catch((caught) => setError(message(caught))); }, [load]);
  const location = data?.locations.find(({ id }) => id === locationId);
  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await load(); setNotice(success); }
    catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    await act(async () => {
      await adminApi(`locations/${encodeURIComponent(locationId)}/links`, {
        method: "POST", body: JSON.stringify({ connector, name: values.get("name"), url: values.get("url"), system_id: values.get("system_id") }),
      });
      form.reset();
    }, "Link validated and saved. It will supplement discovered sources on subsequent runs, even when it has no current items.");
  }
  return <>
    {error && <p role="alert" className="alert">{error}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    <section className="panel">
      <div className="section-heading"><div><h2>Pipeline connectors</h2><p>Connectors are implemented in pipeline code, not added or edited here. Each connector finds and queries supported links.</p></div>
        <button className="secondary" disabled={busy} onClick={() => void act(load, "Connector inventory refreshed.")}>Refresh inventory</button></div>
      <label className="field"><span>Location filter</span><select value={locationId} disabled={busy} onChange={(event) => { setLocationId(event.target.value); setNotice(""); }}>
        <option value="">All onboarded locations</option>
        {data?.locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {location?.source_coverage && <div className="notice" role="status">
        <p><strong>Location resolved / sources {location.source_coverage.status.replaceAll("_", " ")}.</strong> {location.source_coverage.area}.</p>
        {location.source_coverage.gaps.length > 0 && <ul>{location.source_coverage.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>}
      </div>}
      {location?.community && <div className="notice">
        <p><strong>Community coverage:</strong> {location.community.jurisdiction_resolved ? `Government discovery uses ${location.community.parent_name}` : "Governing jurisdiction is unresolved"}; agenda items and news require a community/coverage-term mention, selected-venue reference or available geographic evidence. Nearby city news is not included automatically.</p>
        <p>Coverage terms: {location.community.coverage_terms.join(", ")}. Library branches: {location.systems.flatMap((system) => system.branches.map((branch) => branch.name)).join(", ") || "None configured"}.</p>
        {location.community.newsrooms.length ? <p>Configured local feeds: {location.community.newsrooms.map((room, index) => <span key={room.feed}>{index ? ", " : ""}<a href={room.feed} target="_blank" rel="noreferrer">{room.name}</a></span>)}.</p>
          : <p>No automatic community news feed is configured. Add a validated local publisher RSS/Atom link below; retained manual links are listed separately and require the same community evidence.</p>}
      </div>}
      {!data && !error && <p role="status">Loading connectors and links...</p>}
      <div className="connector-grid">{data?.connectors.map((item) => {
        const tasks = data.sources.filter((source) => source.type === item.id && (!locationId || source.location_id === locationId));
        const caches = data.cached_links.filter((link) => link.source_id.split(":")[0] === item.id && (!locationId || link.location_id === locationId));
        const manual = data.manual_links.filter((link) => link.connector === item.id && (!locationId || link.location_id === locationId));
        return <article key={item.id} className="connector-card">
          <div className="section-heading"><h3>{item.name}</h3><span className="status-badge">{tasks.filter((task) => task.enabled).length} active sources</span></div>
          <p>{item.formats}</p><p className="chart-caption">Code-defined &middot; {item.manual ? "Supports validated manual links" : "Links are managed by the pipeline"}</p>
          <details><summary>Source queries and latest outcomes ({tasks.length})</summary>
            {tasks.length ? tasks.map((task) => <div className="connector-source" key={`${task.location_id}:${task.source_id}`}>
              <strong>{task.location_name} / {task.name}</strong>
              <p>{!task.enabled ? "Disabled in pipeline settings" : task.latest ? `${task.latest.result_status ?? task.latest.status}: ${task.latest.detail ?? "No detail recorded"}` : "Not queried in the latest run"}
                {task.latest && ` (${task.latest.event_count} items)`}</p><code>{task.source_id}</code>
            </div>) : <p>No sources selected for these locations.</p>}
          </details>
          <details open={caches.length > 0}><summary>Discovered link cache ({caches.length})</summary>
            {caches.length ? caches.map((link) => <div key={`${link.location_id}:${link.source_id}`} className="connector-source">
              <strong>{data.locations.find((place) => place.id === link.location_id)?.name} / {link.kind}</strong>
              <a className="source-url" href={link.url} target="_blank" rel="noreferrer">{link.url}</a>
              <p className="chart-caption">{link.source_id} &middot; Found by {link.method} &middot; {new Date(link.discovered_at).toLocaleString()}</p>
              {link.page && link.page !== link.url && <a className="source-url" href={link.page} target="_blank" rel="noreferrer">Discovery page: {link.page}</a>}
            </div>) : <p>No cached links. A connector may use fixed feeds or discover links on its next run.</p>}
          </details>
          <details open={manual.length > 0}><summary>Retained manual links ({manual.length})</summary>
            {manual.length ? manual.map((link) => <div key={link._id} className="connector-source">
              <strong>{data.locations.find((place) => place.id === link.location_id)?.name} / {link.name}</strong>
              <a className="source-url" href={link.url} target="_blank" rel="noreferrer">{link.url}</a>
              {link.feed_url && link.feed_url !== link.url && <a className="source-url" href={link.feed_url} target="_blank" rel="noreferrer">Validated feed: {link.feed_url}</a>}
              <p className="chart-caption">Validated {new Date(link.validated_at).toLocaleString()} &middot; {link.validated_events} usable items at validation &middot; Retained until removed</p>
              <button className="secondary" disabled={busy} onClick={() => {
                if (window.confirm(`Remove ${link.name} from future runs?`)) void act(() => adminApi(`locations/${encodeURIComponent(link.location_id)}/links?manual=${encodeURIComponent(link._id)}`, { method: "DELETE" }), "Manual link removed from future collection.");
              }}>Remove manual link</button>
            </div>) : <p>No manual links.</p>}
          </details>
        </article>;
      })}</div>
    </section>
    <section className="panel">
      <h2>Add a link for a location</h2>
      <p>Choose a location above, then an existing connector. The connector must successfully query the link before it is saved. New connector formats require a pipeline code change.</p>
      {location ? <form className="manual-link-form" onSubmit={(event) => void save(event)}>
        <label className="field"><span>Existing connector</span><select value={connector} disabled={busy} onChange={(event) => setConnector(event.target.value)}>
          {data?.connectors.filter((item) => item.manual).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        {connector === "library" && <label className="field"><span>Onboarded library system</span><select name="system_id" required disabled={busy || !location.systems.length} key={locationId}>
          {location.systems.map((system) => <option key={system.fscskey} value={system.fscskey}>{system.name}</option>)}
        </select></label>}
        {connector === "library" && !location.systems.length && <p className="alert">This location has no onboarded library system. Library links must match its onboarded branches.</p>}
        <label className="field"><span>Source name</span><input name="name" required maxLength={120} disabled={busy} /></label>
        <label className="field"><span>{connector === "meetings" ? "Legistar or CivicClerk tenant URL" : connector === "statenews" ? "Local publisher or agency RSS/Atom feed URL" : "Library event page or supported feed URL"}</span>
          <input name="url" type="url" required pattern="https://.*" maxLength={2000} placeholder="https://..." disabled={busy} /></label>
        <p className="chart-caption">Manual links supplement automatic discovery, apply only to {location.name}, and remain until removed. Normal date, venue, geographic and editorial checks still apply.</p>
        <button disabled={busy || (connector === "library" && !location.systems.length)}>{busy ? "Validating link..." : "Validate & save link"}</button>
      </form> : <p>Select one location to add a link.</p>}
      {location && <div className="cache-actions"><h3>Rediscover automatic links</h3><p>Forget {location.name}&apos;s discovered cache so the next run finds links again. Retained manual links are not removed.</p>
        <button className="secondary" disabled={busy} onClick={() => void act(() => adminApi(`locations/${encodeURIComponent(location.id)}/links`, { method: "DELETE" }), "Discovered cache cleared. Manual links retained; automatic links will be rediscovered on the next run.")}>Forget discovered links</button></div>}
    </section>
  </>;
}
