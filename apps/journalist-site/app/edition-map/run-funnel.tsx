"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { mapApi } from "@/lib/admin-client";
import EditionMapView, { type EditionMap } from "../components/edition-map-view";
import { PRIORITY_TOPICS, type RunOptions } from "@/pipeline/core/run-values";

type Stage = { id: string; phase: string; label: string; count: number | null; note: string | null; decided_by: string[]; left_out: Array<{ reason: string; count: number }>; recorded: boolean };
type Coverage = { topic: string; label: string; queries: number; sources: number; items: number; local: number; written: number; printed: number; status: string; note: string | null };
type Category = { category: string; label: string; found: number; readable: number; link_only: number; built_in: number; empty: boolean };
type FixedCategory = { category: string; label: string; found: number; readable: number; link_only: number; methods: Array<{ method: string; found: number }> };
type Service = { service: string; label: string; paid: boolean; calls: number; failed: number; skipped: number; cost_estimate: number | null; skip_reason: string | null };
type Funnel = {
  run: { id: string; location_id: string; location_name: string; status: string; created_at: number; completed_at: number | null; edition_id: string | null; error: string | null; window: [string, string]; recorded: boolean; transitions: Array<{ status: string; by: string; at: number }>; by: string };
  options: RunOptions; stages: Stage[]; coverage: Coverage[]; categories: Category[] | null; fixed_coverage: FixedCategory[] | null; costs: { services: Service[]; model_usage: Array<{ provider: string; role: string; calls: number; input_tokens: number; output_tokens: number }> };
  tiers: Record<string, number>; rules_tripped: Array<{ rule: string; count: number }>; access_overrides: Array<{ rule: string; count: number }>;
  agent_plans: Array<{ round: string; reason: string | null; queries: string[]; planned_by: string | null; model: string | null }>;
};
type Row = { id: string; title: string; url: string | null; status: string; reason: string | null; decided_by: string; topic: string | null; flags: string[]; detail: Record<string, unknown> | null };
type Trail = { id: string; title: string; url: string | null; status: string; section: string | null; topic: string | null; tier: string | null; source: string; flags: string[]; access_overrides: string[]; steps: Array<{ stage: string; decided_by: string; choice: string; evidence: string | null }>; printed: { headline: string; summary: string } | null; quotes: Array<{ field: string; value: string; quote: string }> };
type RunRow = { run_id: string; status: string; created_at: number; flow: string; guardrails: string; access: string; mode: string; printed: number | null; recorded: boolean };

const when = (seconds: number) => new Date(seconds * 1000).toLocaleString();
const ITEM_STAGES = new Set(["collected", "local", "merged", "new", "rated", "candidates_chosen", "written", "passed", "printed"]);
function runLabel(row: RunRow) { return `${when(row.created_at)} · ${row.flow} · ${row.guardrails} · ${row.status}${row.printed !== null ? ` · ${row.printed} printed` : ""}`; }

function ItemTrail({ locationId, runId, itemId, onClose }: { locationId: string; runId: string; itemId: string; onClose: () => void }) {
  const [trail, setTrail] = useState<Trail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    mapApi<Trail>(`locations/${encodeURIComponent(locationId)}/runs/${encodeURIComponent(runId)}/funnel?item=${encodeURIComponent(itemId)}`).then(setTrail).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [locationId, runId, itemId]);
  return <section className="panel item-trail" aria-label="Item trail">
    <div className="section-heading"><h3>{trail?.title ?? "Item trail"}</h3><button className="secondary" onClick={onClose}>Close trail</button></div>
    {error && <p className="alert" role="alert">{error}</p>}
    {trail && <>
      <p className="chart-caption">{trail.source}{trail.tier ? ` · ${trail.tier}` : ""}{trail.topic ? ` · ${trail.topic.replace("_", " ")}` : ""}{trail.url && <> · <a href={trail.url} target="_blank" rel="noopener noreferrer">Original</a></>}</p>
      {(trail.flags.length > 0 || trail.access_overrides.length > 0) && <p className="notice">{trail.flags.length > 0 && `Strict would have stopped this: ${trail.flags.join(", ")}. `}{trail.access_overrides.length > 0 && `Access rules skipped: ${trail.access_overrides.join(", ")}.`}</p>}
      <div className="table-wrap"><table><thead><tr><th>Stage</th><th>Decided by</th><th>Choice</th><th>Evidence</th></tr></thead><tbody>
        {trail.steps.map((step, index) => <tr key={index}><td>{step.stage}</td><td>{step.decided_by}</td><td>{step.choice}</td><td>{step.evidence}</td></tr>)}
      </tbody></table></div>
      {trail.quotes.length > 0 && <><h4>Supporting quotes</h4><ul>{trail.quotes.map((quote, index) => <li key={index}><strong>{quote.value}:</strong> &ldquo;{quote.quote}&rdquo;</li>)}</ul></>}
      {trail.printed && <><h4>Printed text</h4><p><strong>{trail.printed.headline}</strong></p><p>{trail.printed.summary}</p></>}
    </>}
  </section>;
}

function StageDetail({ locationId, runId, stage, topic }: { locationId: string; runId: string; stage: Stage; topic: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [page, setPage] = useState(0);
  const [trailId, setTrailId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [decider, setDecider] = useState("");
  const [flagged, setFlagged] = useState(false);
  useEffect(() => { setPage(0); setTrailId(null); }, [stage.id, topic]);
  useEffect(() => {
    let active = true;
    setRows(null);
    mapApi<{ rows: Row[] }>(`locations/${encodeURIComponent(locationId)}/runs/${encodeURIComponent(runId)}/funnel?stage=${stage.id}&page=${page}${topic ? `&topic=${topic}` : ""}`)
      .then((value) => { if (active) setRows(value.rows); }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [locationId, runId, stage.id, topic, page]);
  const deciders = useMemo(() => [...new Set((rows ?? []).map((row) => row.decided_by))].sort(), [rows]);
  const shown = (rows ?? []).filter((row) => (!decider || row.decided_by === decider) && (!flagged || row.flags.length > 0));
  return <section className="stage-detail" aria-label={`${stage.label} detail`}>
    <h3>{stage.label}</h3>
    {stage.left_out.length > 0 && <div><h4>Left out here, by reason</h4><ul className="reason-list">{stage.left_out.map((row) => <li key={row.reason}><strong>{row.count}</strong> {row.reason}</li>)}</ul></div>}
    {error && <p className="alert" role="alert">{error}</p>}
    <div className="filters">
      <label>Decided by<select value={decider} onChange={(event) => setDecider(event.target.value)}><option value="">All</option>{deciders.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label className="inline-check"><input type="checkbox" checked={flagged} onChange={(event) => setFlagged(event.target.checked)} /> Only flagged</label>
    </div>
    {!rows && !error && <p role="status">Loading…</p>}
    {rows && !shown.length && <p>Nothing recorded here{topic ? " for this topic" : ""}.</p>}
    {shown.length > 0 && <div className="table-wrap"><table><thead><tr><th>Item</th><th>Outcome</th><th>Why</th><th>Decided by</th><th>Topic</th></tr></thead><tbody>
      {shown.map((row) => <tr key={row.id}>
        <td>{row.url ? <a href={row.url} target="_blank" rel="noopener noreferrer">{row.title}</a> : row.title}{row.flags.length > 0 && <small className="flag"> Flagged: {row.flags.join(", ")}</small>}{ITEM_STAGES.has(stage.id) && <> <button type="button" className="run-inspect-link" onClick={() => setTrailId(row.id)}>Trail</button></>}</td>
        <td><span className={`item-status ${row.status}`}>{row.status.replaceAll("_", " ")}</span></td><td>{row.reason}</td><td>{row.decided_by}</td><td>{row.topic?.replace("_", " ")}</td>
      </tr>)}
    </tbody></table></div>}
    <div className="card-actions">
      {page > 0 && <button className="secondary" onClick={() => setPage(page - 1)}>Previous</button>}
      {(rows?.length ?? 0) >= 50 && <button className="secondary" onClick={() => setPage(page + 1)}>Next</button>}
    </div>
    {trailId && <ItemTrail locationId={locationId} runId={runId} itemId={trailId} onClose={() => setTrailId(null)} />}
  </section>;
}

function FunnelTable({ funnel, selected, onSelect }: { funnel: Funnel; selected: string | null; onSelect: (id: string | null) => void }) {
  const top = Math.max(1, ...funnel.stages.map((stage) => stage.count ?? 0));
  const phases = [...new Set(funnel.stages.map((stage) => stage.phase))];
  return <div className="run-funnel">
    {phases.map((phase) => <div className="funnel-phase" key={phase}>
      <h3>{phase}</h3>
      <ol className="funnel" aria-label={`${phase} stages`}>
        {funnel.stages.filter((stage) => stage.phase === phase).map((stage) => <li key={stage.id}>
          <button type="button" aria-pressed={selected === stage.id} onClick={() => onSelect(selected === stage.id ? null : stage.id)}>{stage.label}</button>
          {stage.count === null ? <span className="chart-caption">{stage.note ?? "Not recorded for this run"}</span> : <span className="bar" style={{ width: `${Math.max(2, Math.round(stage.count / top * 100))}%` }} aria-hidden="true" />}
          <span>{stage.count !== null && <strong>{stage.count}</strong>}{stage.count !== null && stage.note && <small className="delta"> {stage.note}</small>}{stage.decided_by.length > 0 && <small className="delta"> by {stage.decided_by.join(", ")}</small>}</span>
        </li>)}
      </ol>
    </div>)}
  </div>;
}

function RunHeader({ funnel, locationId }: { funnel: Funnel; locationId: string }) {
  const { run, options, costs } = funnel;
  const paid = costs.services.filter((service) => service.paid);
  const free = costs.services.filter((service) => !service.paid);
  const total = paid.reduce((sum, service) => sum + (service.cost_estimate ?? 0), 0);
  const loosened = options.guardrails === "exploration" || options.guardrails_off.length > 0 || options.access === "relaxed";
  return <div className="run-header">
    <div className="run-chips">
      <span className="status-badge">{run.status.replaceAll("_", " ")}</span>
      <span className="status-badge">{options.flow} flow</span><span className="status-badge">{options.mode}</span>
      <span className={`status-badge ${options.guardrails === "exploration" ? "tone-warning" : ""}`}>{options.guardrails}</span>
      <span className={`status-badge ${options.access === "relaxed" ? "tone-warning" : ""}`}>{options.access}</span>
      {!options.count_history && <span className="status-badge">not counted in history</span>}
      {!run.recorded && <span className="status-badge tone-warning">older run: partial record</span>}
    </div>
    <p className="chart-caption">Started {when(run.created_at)} by {run.by}{run.completed_at ? `, finished ${when(run.completed_at)} (${Math.max(1, Math.round((run.completed_at - run.created_at) / 60))} min)` : ""}. Window {run.window.join(" to ")}.</p>
    {run.error && <p className="alert" role="alert">{run.error}</p>}
    {loosened && <p className="notice">Run with loosened rules.</p>}
    <div className="card-actions">
      <Link href={`/locations/${encodeURIComponent(locationId)}?tab=edition&run=${encodeURIComponent(run.id)}`}>Run controls</Link>
      {run.status === "published" && <a href={`/reader?location=${encodeURIComponent(locationId)}`}>Latest newsletter</a>}
    </div>
    <details className="location-settings">
      <summary>Cost and API calls: {paid.reduce((sum, service) => sum + service.calls, 0)} paid calls{total ? `, about $${total.toFixed(4)} estimated` : ""}, {free.reduce((sum, service) => sum + service.calls, 0)} free API calls</summary>
      <div className="table-wrap"><table><thead><tr><th>Service</th><th>Type</th><th>Calls</th><th>Failed</th><th>Skipped</th><th>Estimated cost</th><th>Why skipped</th></tr></thead><tbody>
        {costs.services.map((service) => <tr key={service.service}><td>{service.label}</td><td>{service.paid ? "Paid" : "Free"}</td><td>{service.calls}</td><td>{service.failed}</td><td>{service.skipped}</td><td>{service.cost_estimate ? `$${service.cost_estimate.toFixed(4)}` : "-"}</td><td>{service.skip_reason}</td></tr>)}
        {!costs.services.length && <tr><td colSpan={7}>No external calls recorded.</td></tr>}
      </tbody></table></div>
      {costs.model_usage.length > 0 && <div className="table-wrap"><table><thead><tr><th>Model provider</th><th>Role</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th></tr></thead><tbody>{costs.model_usage.map((row) => <tr key={`${row.provider}:${row.role}`}><td>{row.provider}</td><td>{row.role}</td><td>{row.calls}</td><td>{row.input_tokens}</td><td>{row.output_tokens}</td></tr>)}</tbody></table></div>}
      <p className="chart-caption">Costs are estimates until checked against real bills.</p>
    </details>
  </div>;
}

function TopicCoverage({ coverage, topic, onTopic }: { coverage: Coverage[]; topic: string; onTopic: (topic: string) => void }) {
  return <section aria-label="Topic coverage"><h3>Topic coverage</h3>
    <div className="table-wrap"><table><thead><tr><th>Topic</th><th>Queries</th><th>Sources</th><th>Items</th><th>Kept</th><th>Written</th><th>Printed</th><th>Status</th></tr></thead><tbody>
      {coverage.map((row) => <tr key={row.topic} className={topic === row.topic ? "selected-row" : ""}>
        <td><button type="button" className="run-inspect-link" aria-pressed={topic === row.topic} onClick={() => onTopic(topic === row.topic ? "" : row.topic)}>{row.label}</button></td>
        <td>{row.queries}</td><td>{row.sources}</td><td>{row.items}</td><td>{row.local}</td><td>{row.written}</td><td><strong>{row.printed}</strong></td><td>{row.status}{row.note && <small className="delta"> {row.note}</small>}</td>
      </tr>)}
    </tbody></table></div></section>;
}

function CategoryCoverage({ categories }: { categories: Category[] }) {
  const empty = categories.filter((row) => row.empty);
  return <section aria-label="Sources by category"><h3>Sources by category</h3>
    <p>{empty.length ? `Nothing found for: ${empty.map((row) => row.label).join(", ")}.` : "Every category has a source."}</p>
    <div className="table-wrap"><table><thead><tr><th>Category</th><th>Found</th><th>Read each run</th><th>Links only</th><th>National readers</th></tr></thead><tbody>
      {categories.map((row) => <tr key={row.category}><td>{row.label}</td><td><strong>{row.found}</strong></td><td>{row.readable}</td><td>{row.link_only}</td><td>{row.built_in}</td></tr>)}
    </tbody></table></div></section>;
}

function FixedCoverage({ categories }: { categories: FixedCategory[] }) {
  const empty = categories.filter((row) => !row.found);
  return <section aria-label="Found by the fixed pipeline"><h3>Found by the fixed pipeline</h3>
    <p>{empty.length ? `The fixed pipeline found nothing for: ${empty.map((row) => row.label).join(", ")}.` : "The fixed pipeline found something in every category."} A source two methods found counts twice.</p>
    <div className="table-wrap"><table><thead><tr><th>Category</th><th>Found</th><th>Read each run</th><th>Links only</th><th>By method</th></tr></thead><tbody>
      {categories.map((row) => <tr key={row.category}><td>{row.label}</td><td><strong>{row.found}</strong></td><td>{row.readable}</td><td>{row.link_only}</td><td>{row.methods.map((item) => `${item.method} ${item.found}`).join(", ") || "none"}</td></tr>)}
    </tbody></table></div></section>;
}

function Compare({ locationId, runs }: { locationId: string; runs: RunRow[] }) {
  const [left, setLeft] = useState(runs[1]?.run_id ?? "");
  const [right, setRight] = useState(runs[0]?.run_id ?? "");
  const [data, setData] = useState<[Funnel, Funnel] | null>(null);
  useEffect(() => {
    if (!left || !right) return;
    setData(null);
    Promise.all([left, right].map((id) => mapApi<Funnel>(`locations/${encodeURIComponent(locationId)}/runs/${encodeURIComponent(id)}/funnel`))).then(([a, b]) => setData([a, b])).catch(() => setData(null));
  }, [locationId, left, right]);
  if (runs.length < 2) return <p>Compare needs two runs for this location.</p>;
  const pick = (value: string, set: (value: string) => void, label: string) => <label className="field">{label}<select value={value} onChange={(event) => set(event.target.value)}>{runs.map((row) => <option key={row.run_id} value={row.run_id}>{runLabel(row)}</option>)}</select></label>;
  const cost = (funnel: Funnel) => funnel.costs.services.filter((service) => service.paid).reduce((sum, service) => sum + service.calls, 0);
  return <section aria-label="Compare editions">
    <div className="filters">{pick(left, setLeft, "Run A")}{pick(right, setRight, "Run B")}</div>
    {!data && <p role="status">Loading…</p>}
    {data && <div className="table-wrap"><table>
      <thead><tr><th>Stage</th><th>A: {data[0].options.flow}, {data[0].options.guardrails}</th><th>B: {data[1].options.flow}, {data[1].options.guardrails}</th></tr></thead>
      <tbody>
        {data[0].stages.map((stage, index) => <tr key={stage.id}><td>{stage.label}</td><td>{stage.count ?? "-"}</td><td>{data[1].stages[index]?.count ?? "-"}</td></tr>)}
        {PRIORITY_TOPICS.map((topic) => <tr key={topic.id}><td>Printed: {topic.label}</td><td>{data[0].coverage.find((row) => row.topic === topic.id)?.printed ?? 0}</td><td>{data[1].coverage.find((row) => row.topic === topic.id)?.printed ?? 0}</td></tr>)}
        <tr><td>Primary sources read</td><td>{(data[0].tiers.official ?? 0) + (data[0].tiers.organisation ?? 0) + (data[0].tiers.business ?? 0)}</td><td>{(data[1].tiers.official ?? 0) + (data[1].tiers.organisation ?? 0) + (data[1].tiers.business ?? 0)}</td></tr>
        <tr><td>Paid calls</td><td>{cost(data[0])}</td><td>{cost(data[1])}</td></tr>
      </tbody></table></div>}
  </section>;
}

/** One funnel per run, from the first search to the final edition, for either flow. */
export default function RunFunnel({ locationId, runId, view }: { locationId: string; runId: string | null; view: string }) {
  const router = useRouter();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  const [legacy, setLegacy] = useState<EditionMap | null>(null);
  const [error, setError] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const params = (run?: string, nextView = view) => `/edition-map?${new URLSearchParams({ location: locationId, ...(run ? { run } : {}), ...(nextView !== "funnel" ? { view: nextView } : {}) })}`;
  useEffect(() => {
    mapApi<{ runs: RunRow[] }>(`locations/${encodeURIComponent(locationId)}/runs`).then((value) => setRuns(value.runs)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [locationId]);
  useEffect(() => {
    let active = true;
    const load = () => mapApi<Funnel>(`locations/${encodeURIComponent(locationId)}/runs/${encodeURIComponent(runId ?? "latest")}/funnel`)
      .then((value) => { if (active) { setFunnel(value); setError(""); } })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    setFunnel(null); setStage(null); setLegacy(null);
    void load();
    // A live run updates as it goes.
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [locationId, runId]);
  useEffect(() => {
    if (!funnel || funnel.run.recorded) return;
    mapApi<{ map: EditionMap | null }>(`locations/${encodeURIComponent(locationId)}/edition-map?run=${encodeURIComponent(funnel.run.id)}`).then((value) => setLegacy(value.map)).catch(() => setLegacy(null));
  }, [funnel?.run.id, funnel?.run.recorded, locationId]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = funnel?.stages.find((item) => item.id === stage) ?? null;
  return <section className="panel">
    <div className="section-heading">
      <div><h2>{view === "compare" ? "Compare two editions" : "From first search to final edition"}</h2><p>Select a stage or topic for details.</p></div>
      {view !== "compare" && <label className="field">Run<select value={runId ?? ""} onChange={(event) => router.push(params(event.target.value))}>
        <option value="">Latest run</option>
        {runs.map((row) => <option key={row.run_id} value={row.run_id}>{runLabel(row)}</option>)}
      </select></label>}
    </div>
    {error && <p className="alert" role="alert">{error}</p>}
    {view === "compare" ? <Compare key={runs.length} locationId={locationId} runs={runs} /> : <>
      {!funnel && !error && <p role="status">Loading the run…</p>}
      {!funnel && error && <p><Link href={`/locations/${encodeURIComponent(locationId)}?tab=edition`}>Start or inspect a pipeline run</Link>.</p>}
      {funnel && <>
        <RunHeader funnel={funnel} locationId={locationId} />
        <FunnelTable funnel={funnel} selected={stage} onSelect={setStage} />
        {selected && <StageDetail locationId={locationId} runId={funnel.run.id} stage={selected} topic={topic} />}
        {funnel.fixed_coverage && <FixedCoverage categories={funnel.fixed_coverage} />}
        {funnel.categories && <CategoryCoverage categories={funnel.categories} />}
        <TopicCoverage coverage={funnel.coverage} topic={topic} onTopic={setTopic} />
        {funnel.agent_plans.length > 0 && <details className="location-settings"><summary>Agent plans: {funnel.agent_plans.length} rounds</summary>
          {funnel.agent_plans.map((plan) => <div key={plan.round}><h4>{plan.round} ({plan.planned_by === "model" ? `planned by ${plan.model ?? "the model"}` : "planned by rules"})</h4><p>{plan.reason}</p><ul>{plan.queries.map((query) => <li key={query}><code>{query}</code></li>)}</ul></div>)}
        </details>}
        {(funnel.rules_tripped.length > 0 || funnel.access_overrides.length > 0) && <section aria-label="Rules skipped"><h3>What strict rules would have stopped</h3>
          <ul className="reason-list">{funnel.rules_tripped.map((row) => <li key={row.rule}><strong>{row.count}</strong> {row.rule.replaceAll("_", " ")}</li>)}{funnel.access_overrides.map((row) => <li key={row.rule}><strong>{row.count}</strong> items read by skipping {row.rule.replaceAll("_", " ")}</li>)}</ul></section>}
        {!funnel.run.recorded && legacy && <details className="location-settings"><summary>Saved edition map for this older run</summary><EditionMapView key={legacy.run_id} map={legacy} internal /></details>}
      </>}
    </>}
  </section>;
}
