"use client";

import { useEffect, useState } from "react";
import { adminApi as api } from "@/lib/admin-client";
import { ACCESS_RULES, FREE_SERVICES, GUARDRAIL_GROUPS, PAID_SERVICES, PRIORITY_TOPICS, type PaidService, type RunOptions } from "@/pipeline/core/run-values";

type Info = { defaults: RunOptions; deployed: boolean; configured: Record<PaidService, boolean>; local_model: boolean };

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string; disabled?: boolean }>; onChange: (value: T) => void }) {
  return <label className="field">{label}<select value={value} onChange={(event) => onChange(event.target.value as T)}>
    {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
  </select></label>;
}

const toggled = <T,>(list: T[], item: T, on: boolean) => on ? [...new Set([...list, item])] : list.filter((value) => value !== item);

/** The kick-off choices for a run. Config sets the defaults; these override them for one run. */
export default function RunOptionsPanel({ onChange }: { onChange: (options: RunOptions | null) => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [options, setOptions] = useState<RunOptions | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Info>("run-options").then((value) => { setInfo(value); setOptions(value.defaults); onChange(value.defaults); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (error) return <p className="alert" role="alert">{error}</p>;
  if (!options || !info) return <p role="status">Loading run options…</p>;
  const update = (values: Partial<RunOptions>) => {
    const next = { ...options, ...values };
    setOptions(next);
    onChange(next);
  };
  const loosened = options.guardrails === "exploration" || options.guardrails_off.length > 0 || options.access === "relaxed";
  const ticked = PAID_SERVICES.filter((service) => options.paid[service.id] !== undefined);
  return <section className="run-options" aria-label="Run options">
    <div className="filters">
      <Choice label="Run mode" value={options.mode} onChange={(mode) => update({ mode })} options={[{ value: "autopilot", label: "Autopilot: one click to edition" }, { value: "manual", label: "Manual: stop at each stage" }]} />
      <Choice label="Edition flow" value={options.flow} onChange={(flow) => update({ flow })} options={[{ value: "current", label: "Standard" }, { value: "agentic", label: "Agentic: adds topic sweeps" }]} />
      <Choice label="Source map method" value={options.map_flow ?? options.flow} onChange={(map_flow) => update({ map_flow })} options={[{ value: "current", label: "Standard" }, { value: "agentic", label: "Agentic: search and mapping agent" }]} />
      <Choice label="Guardrails" value={options.guardrails} onChange={(guardrails) => update({ guardrails })} options={[{ value: "strict", label: "Strict" }, { value: "exploration", label: "Exploration" }]} />
      <Choice label="Access" value={options.access} onChange={(access) => update({ access })} options={[{ value: "respect", label: "Respect site rules" }, { value: "relaxed", label: "Relaxed" }]} />
      <label className="field">Story limit (blank for none)<input type="number" min={1} value={options.story_limit ?? ""} onChange={(event) => update({ story_limit: event.target.value ? Number(event.target.value) : null })} /></label>
      <label className="field checkbox-field"><span>History</span><span><input type="checkbox" checked={options.count_history} onChange={(event) => update({ count_history: event.target.checked })} /> Count toward history</span></label>
    </div>
    {loosened && <p className="notice" role="status">This run publishes to {info.deployed ? "the live" : "the local"} reader site with these rules loosened, and each item records the rules it skipped. Untick history for a comparison run. Ignoring site preferences can breach a site&rsquo;s terms. Paywalls, logins and blocked social sites still apply.</p>}
    <details className="location-settings" open>
      <summary>Paid services: {ticked.length ? ticked.map((service) => service.label).join(", ") : "none ticked, so no paid calls"}</summary>
      <p className="chart-caption">A paid service runs only when ticked here and its key is set. Over budget or unticked, the step is skipped and logged, and the run continues.{info.local_model ? " With Gemini unticked, models fall back to local Ollama." : ""}</p>
      <div className="paid-grid">
        {PAID_SERVICES.map((service) => {
          const allowance = options.paid[service.id];
          return <div className="paid-row" key={service.id}>
            <label><input type="checkbox" checked={allowance !== undefined} onChange={(event) => { const paid = { ...options.paid }; if (event.target.checked) paid[service.id] = service.budget; else delete paid[service.id]; update({ paid }); }} /> <strong>{service.label}</strong> <small>{service.use}</small></label>
            <span className={`status-badge ${info.configured[service.id] ? "tone-ok" : "tone-warning"}`}>{info.configured[service.id] ? "key set" : "no key"}</span>
            <label className="budget">Max calls <input type="number" min={0} value={allowance ?? service.budget} disabled={allowance === undefined} onChange={(event) => update({ paid: { ...options.paid, [service.id]: Number(event.target.value) } })} /></label>
          </div>;
        })}
      </div>
    </details>
    {(options.flow === "agentic" || (options.map_flow ?? options.flow) === "agentic") && <div className="filters">
      <Choice label="Search provider" value={options.search_provider} onChange={(search_provider) => update({ search_provider })} options={[{ value: "serpapi", label: "SerpApi (paid)" }, { value: "searchapi", label: "SearchApi (paid)" }, { value: "brightdata", label: "Bright Data (paid)" }, { value: "exa", label: "Exa (paid)" }, { value: "tavily", label: "Tavily (paid, free tier)" }, { value: "fixture", label: "Fixture: known sites, free (local only)", disabled: info.deployed }]} />
      <Choice label="Classifier" value={options.classifier} onChange={(classifier) => update({ classifier })} options={[{ value: "off", label: "Rules only" }, { value: "shadow", label: "Jev in shadow: record scores only" }, { value: "jev", label: "Jev: scores set order and tier" }]} />
    </div>}
    <details className="location-settings">
      <summary>Advanced: topics, rule groups and free services</summary>
      <fieldset><legend>Priority topics</legend>{PRIORITY_TOPICS.map((topic) => <label key={topic.id} className="inline-check"><input type="checkbox" checked={options.topics.includes(topic.id)} onChange={(event) => update({ topics: toggled(options.topics, topic.id, event.target.checked) })} /> {topic.label}</label>)}</fieldset>
      <fieldset><legend>Rule groups off, without full exploration</legend>{GUARDRAIL_GROUPS.map((group) => <label key={group} className="inline-check"><input type="checkbox" checked={options.guardrails_off.includes(group)} onChange={(event) => update({ guardrails_off: toggled(options.guardrails_off, group, event.target.checked) })} /> {group.replace("_", " ")}</label>)}</fieldset>
      {options.access === "relaxed" && <fieldset><legend>Rules relaxed skips (none ticked means all)</legend>{ACCESS_RULES.map((rule) => <label key={rule} className="inline-check"><input type="checkbox" checked={options.access_ignore.includes(rule)} onChange={(event) => update({ access_ignore: toggled(options.access_ignore, rule, event.target.checked) })} /> {rule.replace("_", " ")}</label>)}</fieldset>}
      <fieldset><legend>Free external services switched off</legend>{FREE_SERVICES.map((service) => <label key={service.id} className="inline-check"><input type="checkbox" checked={options.external_off.includes(service.id)} onChange={(event) => update({ external_off: toggled(options.external_off, service.id, event.target.checked) })} /> {service.label}</label>)}</fieldset>
    </details>
  </section>;
}
