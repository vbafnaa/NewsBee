/**
 * The portal dashboard and alerts. Alerts are computed from current state each time, so
 * they clear themselves when the condition passes:
 *
 *   - a source failing 3 runs in a row, or newly blocked (robots, AI opt-out, login wall);
 *   - a section with fewer than 3 local items, or local items down by more than half;
 *   - a run stuck in one stage for more than 15 minutes, or a job retried 3 times;
 *   - model calls above 80% of the daily cap;
 *   - a discovery method failing, or a location's source map older than 30 days.
 */
import type { Db } from "mongodb";
import type { Settings } from "../core/config";
import { listLocations } from "../communities/locations";
import { COLLECTIONS } from "../storage/mongo";
import { modelBudget } from "../model/budget";
import { runs, ACTIVE_RUN_STATUSES, PROCESSING_RUN_STATUSES, type PipelineRun } from "./runs";
import { sourceMap } from "../sourcemap/store";
import { discoveryState } from "../discovery/run";
import { editionMaps } from "../editions/edition-map";
import { SECTIONS } from "../sourcemap/sections";

export type Alert = { id: string; severity: "warning" | "failed"; location_id: string | null; location_name: string | null; kind: string; message: string; fix: string; at: number | null; link: string };

const STUCK_SECONDS = 15 * 60;
const MAP_MAX_AGE_DAYS = 30;

function funnelCount(map: { funnel: Array<{ step: string; count: number }> } | null, step: string) {
  return map?.funnel.find((item) => item.step === step)?.count ?? null;
}

export async function alerts(db: Db, settings: Settings, locationId?: string): Promise<Alert[]> {
  const out: Alert[] = [];
  const now = Date.now() / 1000;
  const locations = (await listLocations(db)).filter((location) => !locationId || location.id === locationId);
  const budget = await modelBudget(db, settings);
  if (!locationId && budget.near) out.push({ id: "model-cap", severity: budget.exhausted ? "failed" : "warning", location_id: null, location_name: null, kind: "model", message: `Model calls today: ${budget.used} of ${budget.cap}${budget.exhausted ? " (cap reached: detail extraction uses rules, discovery waits)" : ""}.`, fix: "Raise NEWSBEE_MODEL_DAILY_CALLS or wait until tomorrow (UTC).", at: now, link: "/model-usage" });
  for (const location of locations) {
    const name = location.name;
    const base = `/locations/${encodeURIComponent(location.id)}`;
    const failing = await sourceMap(db).find({ location_id: location.id, status: { $in: ["active", "pinned", "dormant"] }, $or: [{ "health.consecutive_failures": { $gte: 3 } }, { "health.last_status": "blocked" }] }).limit(20).toArray();
    for (const source of failing) {
      const blocked = source.health.last_status === "blocked";
      out.push({ id: `source:${source._id}`, severity: "warning", location_id: location.id, location_name: name, kind: blocked ? "source_blocked" : "source_failing", message: blocked ? `${source.name} is blocked: ${source.health.last_detail ?? "the site does not allow us"}.` : `${source.name} failed ${source.health.consecutive_failures} runs in a row: ${source.health.last_detail ?? "no detail"}.`, fix: blocked ? "Pause or reject it, or ask the site for a feed." : "Open the source, check the link, or pause it.", at: source.health.last_run_at, link: `${base}?tab=sources#${encodeURIComponent(source.source_id)}` });
    }
    const latest = await runs(db).findOne({ location_id: location.id }, { sort: { created_at: -1 } });
    if (latest && PROCESSING_RUN_STATUSES.includes(latest.status)) {
      const since = latest.stage_started_at ?? latest.updated_at;
      if (now - since > STUCK_SECONDS) out.push({ id: `stuck:${latest._id}`, severity: "failed", location_id: location.id, location_name: name, kind: "run_stuck", message: `Run has been ${latest.status} for ${Math.round((now - since) / 60)} minutes.`, fix: "Inspect the run; resume the stage or retry the failed job.", at: since, link: `${base}?tab=runs&run=${encodeURIComponent(latest._id)}` });
    }
    if (latest) {
      const retried = await db.collection(COLLECTIONS.jobs).find({ run_id: latest._id, attempts: { $gte: 3 }, status: { $in: ["pending", "running", "failed"] } }).limit(5).toArray();
      for (const job of retried) out.push({ id: `job:${job._id}`, severity: "warning", location_id: location.id, location_name: name, kind: "job_retried", message: `${String(job.kind).replace(/_/g, " ")} retried ${job.attempts} times: ${job.error ?? "no error recorded"}.`, fix: "Open the job log in the run inspector.", at: job.created_at, link: `${base}?tab=runs&run=${encodeURIComponent(latest._id)}` });
    }
    const maps = await editionMaps(db).find({ location_id: location.id, status: "published" }).sort({ published_at: -1 }).limit(2).toArray();
    if (maps[0]) {
      const thin = maps[0].sections.filter((section) => section.sources.reduce((sum, source) => sum + source.items.filter((item) => !["dropped"].includes(item.status)).length, 0) < 3).map((section) => section.label);
      const emptySections = SECTIONS.filter((section) => !maps[0].sections.some((item) => item.id === section.id)).map((section) => section.label);
      const weak = [...thin, ...emptySections].slice(0, 6);
      if (weak.length >= 4) out.push({ id: `sections:${location.id}`, severity: "warning", location_id: location.id, location_name: name, kind: "thin_sections", message: `Fewer than 3 local items in: ${weak.join(", ")}.`, fix: "Refresh the source map, or add source links for these sections.", at: maps[0].published_at, link: `${base}?tab=sources` });
      const now0 = funnelCount(maps[0], "local"), before = funnelCount(maps[1] ?? null, "local");
      if (now0 !== null && before && now0 < before / 2) out.push({ id: `drop:${location.id}`, severity: "warning", location_id: location.id, location_name: name, kind: "local_drop", message: `Local items fell from ${before} to ${now0} since the previous edition.`, fix: "Check failing or blocked sources in the edition map.", at: maps[0].published_at, link: `${base}?tab=map` });
    }
    const states = await discoveryState(db).find({ location_id: location.id }).toArray();
    for (const state of states.filter((item) => !item.ok)) out.push({ id: `discovery:${state._id}`, severity: "warning", location_id: location.id, location_name: name, kind: "discovery_failed", message: `Discovery "${state.label}" failed: ${state.detail}.`, fix: "Rerun the method on the Discovery page; it retries on the next run.", at: state.last_run_at, link: "/discovery" });
    const newest = states.reduce((max, state) => Math.max(max, state.ok ? state.last_run_at : 0), 0);
    if (!states.length || now - newest > MAP_MAX_AGE_DAYS * 86400) out.push({ id: `stale-map:${location.id}`, severity: "warning", location_id: location.id, location_name: name, kind: "stale_map", message: states.length ? `Source map last refreshed ${Math.round((now - newest) / 86400)} days ago.` : "Source map has not been built yet.", fix: "Start a run, or press Refresh sources.", at: newest || null, link: `${base}?tab=sources` });
  }
  return out.sort((a, b) => Number(b.severity === "failed") - Number(a.severity === "failed") || (b.at ?? 0) - (a.at ?? 0));
}

export async function overview(db: Db, settings: Settings) {
  const locations = await listLocations(db);
  const [budget, queue, allAlerts] = await Promise.all([
    modelBudget(db, settings),
    db.collection(COLLECTIONS.jobs).aggregate<{ _id: string; count: number }>([{ $match: { status: { $in: ["pending", "running"] } } }, { $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
    alerts(db, settings),
  ]);
  const failingSources = await sourceMap(db).countDocuments({ status: { $in: ["active", "pinned"] }, "health.consecutive_failures": { $gte: 3 } });
  const dueDiscovery = await discoveryState(db).countDocuments({ next_due_at: { $lte: Date.now() / 1000 } });
  const rows = await Promise.all(locations.map(async (location) => {
    const latest = await runs(db).findOne({ location_id: location.id }, { sort: { created_at: -1 } }) as PipelineRun | null;
    const maps = await editionMaps(db).find({ location_id: location.id, status: "published" }).sort({ published_at: -1 }).limit(2).toArray();
    const current = latest ? await editionMaps(db).findOne({ _id: latest._id }) : null;
    const funnel = (current ?? maps[0])?.funnel ?? [];
    const previous = maps[current?.status === "published" ? 1 : 0]?.funnel ?? [];
    const sourceCounts = await sourceMap(db).aggregate<{ _id: string; count: number }>([{ $match: { location_id: location.id } }, { $group: { _id: "$status", count: { $sum: 1 } } }]).toArray();
    return {
      location_id: location.id, location_name: location.name,
      run: latest ? { id: latest._id, status: latest.status, created_at: latest.created_at, completed_at: latest.completed_at, stage_started_at: latest.stage_started_at ?? null, duration_seconds: (latest.completed_at ?? Date.now() / 1000) - latest.created_at, active: ACTIVE_RUN_STATUSES.includes(latest.status), sources: latest.sources.length, sources_done: latest.sources.filter((source) => source.status !== "pending").length, published: latest.published?.items ?? null, held: latest.published?.held ?? null, error: latest.error } : null,
      funnel: funnel.map((step) => ({ ...step, previous: previous.find((item) => item.step === step.step)?.count ?? null })),
      sources: Object.fromEntries(sourceCounts.map((row) => [row._id, row.count])),
      alerts: allAlerts.filter((alert) => alert.location_id === location.id).length,
    };
  }));
  return {
    strip: { model: budget, queue: Object.fromEntries(queue.map((row) => [row._id, row.count])), failing_sources: failingSources, discovery_due: dueDiscovery, alerts: allAlerts.length },
    locations: rows,
    alerts: allAlerts.slice(0, 10),
  };
}
