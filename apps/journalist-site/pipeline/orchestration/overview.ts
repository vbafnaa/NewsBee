/**
 * The newsroom operations overview. Location state is loaded in bulk so the queue, alerts,
 * readiness and per-location rows reuse the same latest runs, edition maps and source counts.
 */
import type { Db } from "mongodb";
import type { Settings } from "../core/config";
import { listLocations } from "../communities/locations";
import { locationReadinessCatalog, type LocationReadinessRow } from "../communities/readiness";
import { COLLECTIONS } from "../storage/mongo";
import { modelBudget } from "../model/budget";
import { openRunIds, runs, ACTIVE_RUN_STATUSES, PROCESSING_RUN_STATUSES, type PipelineRun } from "./runs";
import { sourceMap, type SourceRecord } from "../sourcemap/store";
import { discoveryState } from "../discovery/run";
import { editionMaps, type EditionMap } from "../editions/edition-map";
import { SECTIONS } from "../sourcemap/sections";
import { inbox } from "./inbox";
import { coverageOperationsRequests } from "../communities/coverage-requests";
import { DISCOVERY_DISABLED_GUIDANCE, discoveryDisabledExplanation, discoveryOutcome } from "../discovery/status";

export type Alert = {
  id: string;
  severity: "warning" | "failed";
  location_id: string | null;
  location_name: string | null;
  kind: string;
  message: string;
  fix: string;
  at: number | null;
  link: string;
  host?: string;
  source_label?: string;
  diagnostics?: string;
};

export type OperationsQueueItem = {
  id: string;
  kind: "location_readiness" | "held_quality" | "alert";
  priority: number;
  location_id: string | null;
  location_name: string | null;
  title: string;
  detail: string;
  diagnostics?: string;
  href: string;
  updated_at: string | null;
  demand: number;
  state?: LocationReadinessRow["state"];
  can_mark_ready?: boolean;
  missing_prerequisites?: string[];
  coverage_requests?: Array<{ publication_name: string; href: string }>;
  affected_sources?: Array<{ label: string; href: string }>;
};
type RetriedJob = {
  _id: unknown;
  kind: unknown;
  attempts: number;
  error?: unknown;
  created_at: number;
};

const STUCK_SECONDS = 15 * 60;
const MAP_MAX_AGE_DAYS = 30;

function funnelCount(map: Pick<EditionMap, "funnel"> | null, step: string) {
  return map?.funnel.find((item) => item.step === step)?.count ?? null;
}

async function latestRuns(db: Db, locationIds: string[]) {
  if (!locationIds.length) return new Map<string, PipelineRun>();
  const rows = await runs(db).aggregate<{ _id: string; run: PipelineRun }>([
    { $match: { location_id: { $in: locationIds } } },
    { $sort: { location_id: 1, created_at: -1, _id: -1 } },
    { $group: { _id: "$location_id", run: { $first: "$$ROOT" } } },
  ]).toArray();
  return new Map(rows.map((row) => [row._id, row.run]));
}

async function recentMaps(db: Db, locationIds: string[]) {
  const groups = locationIds.length ? await editionMaps(db).aggregate<{ _id: string; rows: EditionMap[] }>([
    { $match: { location_id: { $in: locationIds }, status: { $in: ["built", "published"] } } },
    { $sort: { location_id: 1, published_at: -1, _id: -1 } },
    { $group: { _id: "$location_id", rows: { $push: "$$ROOT" } } },
    { $project: { rows: { $slice: ["$rows", 2] } } },
  ]).toArray() : [];
  const byLocation = new Map<string, EditionMap[]>();
  for (const group of groups) byLocation.set(group._id, group.rows);
  return byLocation;
}

async function sourceCounts(db: Db, locationIds: string[]) {
  if (!locationIds.length) return new Map<string, Record<string, number>>();
  const rows = await sourceMap(db).aggregate<{ _id: { location_id: string; status: string }; count: number }>([
    { $match: { location_id: { $in: locationIds } } },
    { $group: { _id: { location_id: "$location_id", status: "$status" }, count: { $sum: 1 } } },
  ]).toArray();
  const byLocation = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const counts = byLocation.get(row._id.location_id) ?? {};
    counts[row._id.status] = row.count;
    byLocation.set(row._id.location_id, counts);
  }
  return byLocation;
}

async function alertRows(
  db: Db,
  settings: Settings,
  locations: Awaited<ReturnType<typeof listLocations>>,
  latestByLocation: Map<string, PipelineRun>,
  mapsByLocation: Map<string, EditionMap[]>,
  suppliedBudget?: Awaited<ReturnType<typeof modelBudget>>,
  includeGlobalAlerts = true,
): Promise<Alert[]> {
  const budget = suppliedBudget ?? await modelBudget(db, settings);
  const out: Alert[] = [];
  const now = Date.now() / 1000;
  const locationIds = locations.map((location) => location.id);
  if (!locations.length) {
    if (includeGlobalAlerts && budget.near) out.push({
      id: "model-cap",
      severity: budget.exhausted ? "failed" : "warning",
      location_id: null,
      location_name: null,
      kind: "model",
      message: `Shared managed model attempts today: ${budget.used} of ${budget.cap}${budget.exhausted ? " (allowance reached: managed model work waits)" : ""}.`,
      fix: "Raise NEWSBEE_MODEL_DAILY_CALLS or wait until tomorrow (UTC).",
      at: now,
      link: "/health?view=usage",
    });
    return out;
  }
  const latestRunIds = [...latestByLocation.values()].map((run) => run._id);
  const [failingGroups, retriedGroups, states] = await Promise.all([
    sourceMap(db).aggregate<{ _id: string; rows: SourceRecord[] }>([
      { $match: {
        location_id: { $in: locationIds },
        status: { $in: ["active", "pinned", "dormant"] },
        $or: [{ "health.consecutive_failures": { $gte: 3 } }, { "health.last_status": "blocked" }],
      } },
      { $sort: { location_id: 1, "health.last_run_at": -1, _id: 1 } },
      { $group: { _id: "$location_id", rows: { $push: "$$ROOT" } } },
      { $project: { rows: { $slice: ["$rows", 20] } } },
    ]).toArray(),
    latestRunIds.length ? db.collection(COLLECTIONS.jobs).aggregate<{ _id: string; rows: RetriedJob[] }>([
      { $match: { run_id: { $in: latestRunIds }, attempts: { $gte: 3 }, status: { $in: ["pending", "running", "failed"] } } },
      { $sort: { run_id: 1, created_at: -1, _id: 1 } },
      { $group: { _id: "$run_id", rows: { $push: "$$ROOT" } } },
      { $project: { rows: { $slice: ["$rows", 5] } } },
    ]).toArray() : [],
    discoveryState(db).find({ location_id: { $in: locationIds } }).toArray(),
  ]);
  if (includeGlobalAlerts && budget.near) out.push({
    id: "model-cap",
    severity: budget.exhausted ? "failed" : "warning",
    location_id: null,
    location_name: null,
    kind: "model",
    message: `Shared managed model attempts today: ${budget.used} of ${budget.cap}${budget.exhausted ? " (allowance reached: managed model work waits)" : ""}.`,
    fix: "Raise NEWSBEE_MODEL_DAILY_CALLS or wait until tomorrow (UTC).",
    at: now,
    link: "/health?view=usage",
  });
  const failingByLocation = new Map(failingGroups.map((group) => [group._id, group.rows]));
  const retriedByRun = new Map(retriedGroups.map((group) => [group._id, group.rows]));
  const statesByLocation = new Map<string, typeof states>();
  for (const state of states) statesByLocation.set(state.location_id, [...(statesByLocation.get(state.location_id) ?? []), state]);

  for (const location of locations) {
    const name = location.name;
    const base = `/locations/${encodeURIComponent(location.id)}`;
    for (const source of failingByLocation.get(location.id) ?? []) {
      const blocked = source.health.last_status === "blocked";
      out.push({
        id: `source:${source._id}`,
        severity: "warning",
        location_id: location.id,
        location_name: name,
        kind: blocked ? "source_blocked" : "source_failing",
        message: blocked
          ? `${source.name} is blocked: ${source.health.last_detail ?? "the site does not allow us"}.`
          : `${source.name} failed ${source.health.consecutive_failures} runs in a row: ${source.health.last_detail ?? "no detail"}.`,
        fix: blocked ? "Pause or reject it, or ask the site for a feed." : "Open the source, check the link, or pause it.",
        at: source.health.last_run_at,
        link: `${base}?tab=sources#${encodeURIComponent(source.source_id)}`,
        host: source.url && URL.canParse(source.url) ? new URL(source.url).hostname : undefined,
        source_label: source.name,
      });
    }
    const latest = latestByLocation.get(location.id) ?? null;
    if (latest && PROCESSING_RUN_STATUSES.includes(latest.status)) {
      const since = latest.stage_started_at ?? latest.updated_at;
      if (now - since > STUCK_SECONDS) out.push({
        id: `stuck:${latest._id}`,
        severity: "failed",
        location_id: location.id,
        location_name: name,
        kind: "run_stuck",
        message: `Run has been ${latest.status} for ${Math.round((now - since) / 60)} minutes.`,
        fix: "Inspect the run; resume the stage or retry the failed job.",
        at: since,
        link: `${base}?tab=edition&run=${encodeURIComponent(latest._id)}`,
      });
    }
    if (latest) {
      for (const job of retriedByRun.get(latest._id) ?? []) out.push({
        id: `job:${String(job._id)}`,
        severity: "warning",
        location_id: location.id,
        location_name: name,
        kind: "job_retried",
        message: `${String(job.kind).replace(/_/g, " ")} retried ${job.attempts} times: ${job.error ?? "no error recorded"}.`,
        fix: "Open the job log in the run inspector.",
        at: job.created_at,
        link: `${base}?tab=edition&run=${encodeURIComponent(latest._id)}`,
      });
    }
    const maps = mapsByLocation.get(location.id) ?? [];
    if (maps[0]) {
      const thin = maps[0].sections.filter((section) =>
        section.sources.reduce((sum, source) => sum + source.items.filter((item) => item.status !== "dropped").length, 0) < 3)
        .map((section) => section.label);
      const emptySections = SECTIONS.filter((section) => !maps[0].sections.some((item) => item.id === section.id)).map((section) => section.label);
      const weak = [...thin, ...emptySections].slice(0, 6);
      if (weak.length >= 4) out.push({
        id: `sections:${location.id}`,
        severity: "warning",
        location_id: location.id,
        location_name: name,
        kind: "thin_sections",
        message: `Fewer than 3 local items in: ${weak.join(", ")}.`,
        fix: "Refresh the source map, or add source links for these sections.",
        at: maps[0].published_at,
        link: `${base}?tab=sources`,
      });
      const currentLocal = funnelCount(maps[0], "local");
      const previousLocal = funnelCount(maps[1] ?? null, "local");
      if (currentLocal !== null && previousLocal && currentLocal < previousLocal / 2) out.push({
        id: `drop:${location.id}`,
        severity: "warning",
        location_id: location.id,
        location_name: name,
        kind: "local_drop",
        message: `Local items fell from ${previousLocal} to ${currentLocal} since the previous edition.`,
        fix: "Check failing or blocked sources in the edition map.",
        at: maps[0].published_at,
        link: `${base}?tab=published`,
      });
    }
    const locationStates = statesByLocation.get(location.id) ?? [];
    for (const state of locationStates) {
      const outcome = discoveryOutcome(state);
      if (outcome !== "failed" && outcome !== "disabled") continue;
      const disabled = outcome === "disabled";
      out.push({
        id: `discovery:${state._id}`,
        severity: "warning",
        location_id: location.id,
        location_name: name,
        kind: disabled ? "discovery_disabled" : "discovery_failed",
        message: disabled ? `Discovery "${state.label}" disabled / unavailable. ${discoveryDisabledExplanation(state)}` : `Discovery "${state.label}" failed.`,
        fix: disabled ? DISCOVERY_DISABLED_GUIDANCE : "Review the diagnostics, then refresh the source map to run it again.",
        diagnostics: state.detail,
        at: state.last_run_at,
        link: `${base}?tab=sources#discovery`,
      });
    }
    const newest = locationStates.reduce((max, state) => Math.max(max, discoveryOutcome(state) === "succeeded" ? state.last_run_at : 0), 0);
    if (!locationStates.length || now - newest > MAP_MAX_AGE_DAYS * 86400) out.push({
      id: `stale-map:${location.id}`,
      severity: "warning",
      location_id: location.id,
      location_name: name,
      kind: "stale_map",
      message: locationStates.length ? `Source map last refreshed ${Math.round((now - newest) / 86400)} days ago.` : "Source map has not been built yet.",
      fix: "Start a run, or press Refresh sources.",
      at: newest || null,
      link: `${base}?tab=sources`,
    });
  }
  return out.sort((a, b) =>
    Number(b.severity === "failed") - Number(a.severity === "failed")
    || (b.at ?? 0) - (a.at ?? 0)
    || a.id.localeCompare(b.id));
}

export async function alerts(db: Db, settings: Settings, locationId?: string): Promise<Alert[]> {
  const locations = (await listLocations(db)).filter((location) => !locationId || location.id === locationId);
  const ids = locations.map((location) => location.id);
  const [latestByLocation, mapsByLocation] = await Promise.all([latestRuns(db, ids), recentMaps(db, ids)]);
  return alertRows(db, settings, locations, latestByLocation, mapsByLocation, undefined, !locationId);
}

function workQueue(
  readiness: LocationReadinessRow[],
  allAlerts: Alert[],
  held: Array<{ location_id: string; location_name: string }>,
  requests: Awaited<ReturnType<typeof coverageOperationsRequests>>,
): OperationsQueueItem[] {
  const rows: OperationsQueueItem[] = [];
  const readinessById = new Map(readiness.map((row) => [row.location_id, row]));
  for (const row of readiness) {
    if (row.state === "ready" || (!row.onboarded && row.demand === 0 && !row.newsroom_request_count)) continue;
    const requested = !row.onboarded;
    const detail = requested
      ? `${row.demand} reader requests; ${row.newsroom_request_count ?? 0} newsroom requests. Requester identities stay private.`
      : row.state === "blocked"
        ? row.preparation?.reason ?? "Preparation is blocked."
        : "Preparation is in progress.";
    rows.push({
      id: `readiness:${row.location_id}`,
      kind: "location_readiness",
      priority: row.state === "blocked" ? 95 : requested ? 70 + Math.min(row.demand, 20) : 65 + Math.min(row.demand, 10),
      location_id: row.location_id,
      location_name: row.location_name,
      title: requested ? `Prepare ${row.location_name}` : `${row.location_name}: ${row.state}`,
      detail,
      href: requested ? `/admin?requested_location=${encodeURIComponent(row.location_id)}&requested_name=${encodeURIComponent(row.location_name)}#onboarding` : row.remedy?.href ?? `/locations/${encodeURIComponent(row.location_id)}?tab=sources`,
      updated_at: row.preparation?.updated_at ?? row.last_requested_at,
      demand: row.demand,
      state: row.state,
      can_mark_ready: row.can_mark_ready,
      missing_prerequisites: row.missing_prerequisites,
      coverage_requests: requests.filter((request) => request.location_id === row.location_id).map((request) => ({
        publication_name: request.publication_name, href: `/admin/publications/${encodeURIComponent(request.publication_id)}`,
      })),
    });
  }
  for (const request of requests.filter((request) => request.location_id === null)) rows.push({
    id: `coverage:${request._id}`, kind: "location_readiness", priority: 75, location_id: null, location_name: null,
    title: `${request.publication_name}: coverage requested`, detail: "No locations are allowed yet. Review the newsroom coverage boundary; this request grants no access.",
    href: `/admin/publications/${encodeURIComponent(request.publication_id)}`, updated_at: request.requested_at,
    demand: 0, state: "requested",
  });
  const heldByLocation = new Map<string, { name: string; count: number }>();
  for (const item of held) {
    const group = heldByLocation.get(item.location_id) ?? { name: item.location_name, count: 0 };
    group.count += 1;
    heldByLocation.set(item.location_id, group);
  }
  for (const [locationId, group] of heldByLocation) rows.push({
    id: `held:${locationId}`,
    kind: "held_quality",
    priority: 60 + Math.min(group.count, 10),
    location_id: locationId,
    location_name: group.name,
    title: `${group.name}: review held quality items`,
    detail: `${group.count} held ${group.count === 1 ? "story needs" : "stories need"} an editor decision.`,
    href: `/locations/${encodeURIComponent(locationId)}?tab=edition`,
    updated_at: null,
    demand: readinessById.get(locationId)?.demand ?? 0,
  });
  for (const alert of allAlerts) {
    if (alert.kind === "stale_map" && alert.location_id && readinessById.get(alert.location_id)?.state !== "ready") continue;
    const hostGroup = alert.host ? rows.find((row) => row.id === `host:${alert.location_id}:${alert.kind}:${alert.host}`) : undefined;
    if (hostGroup) {
      hostGroup.affected_sources!.push({ label: `${alert.source_label}: ${alert.message}`, href: alert.link });
      continue;
    }
    rows.push({
      id: alert.host ? `host:${alert.location_id}:${alert.kind}:${alert.host}` : `alert:${alert.id}`,
      kind: "alert",
      priority: alert.severity === "failed" ? 90 : alert.kind === "model" ? 80 : 55,
      location_id: alert.location_id,
      location_name: alert.location_name,
      title: alert.host ? `${alert.location_name}: ${alert.host} ${alert.kind === "source_blocked" ? "access blocked" : "source failures"}` : alert.location_name ? `${alert.location_name}: ${alert.message}` : alert.message,
      detail: alert.fix,
      ...(alert.diagnostics ? { diagnostics: alert.diagnostics } : {}),
      href: alert.link,
      updated_at: alert.at ? new Date(alert.at * 1000).toISOString() : null,
      demand: alert.location_id ? readinessById.get(alert.location_id)?.demand ?? 0 : 0,
      ...(alert.host ? { affected_sources: [{ label: `${alert.source_label}: ${alert.message}`, href: alert.link }] } : {}),
    });
  }
  return rows.sort((a, b) =>
    b.priority - a.priority
    || b.demand - a.demand
    || String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""))
    || a.id.localeCompare(b.id));
}

export async function overview(db: Db, settings: Settings) {
  const locations = await listLocations(db);
  const locationIds = locations.map((location) => location.id);
  const open = await openRunIds(db);
  const [budget, queue, latestByLocation, mapsByLocation, countsByLocation, readiness, editorialInbox, coverageRequests] = await Promise.all([
    modelBudget(db, settings),
    db.collection(COLLECTIONS.jobs).aggregate<{ _id: string; count: number }>([
      { $match: { status: { $in: ["pending", "running"] }, run_id: { $in: open } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).toArray(),
    latestRuns(db, locationIds),
    recentMaps(db, locationIds),
    sourceCounts(db, locationIds),
    locationReadinessCatalog(db, locations),
    inbox(db),
    coverageOperationsRequests(db),
  ]);
  const latestRunIds = [...latestByLocation.values()].map((run) => run._id);
  const currentMapById = new Map<string, EditionMap>();
  for (const maps of mapsByLocation.values()) for (const map of maps) currentMapById.set(map._id, map);
  const missingCurrentMapIds = latestRunIds.filter((runId) => !currentMapById.has(runId));
  if (missingCurrentMapIds.length) {
    for (const map of await editionMaps(db).find({ _id: { $in: missingCurrentMapIds } }).toArray()) currentMapById.set(map._id, map);
  }
  const allAlerts = await alertRows(db, settings, locations, latestByLocation, mapsByLocation, budget);
  const readinessById = new Map(readiness.map((row) => [row.location_id, row]));
  const alertCountByLocation = new Map<string, number>();
  for (const alert of allAlerts) if (alert.location_id) alertCountByLocation.set(alert.location_id, (alertCountByLocation.get(alert.location_id) ?? 0) + 1);
  const rows = locations.map((location) => {
    const latest = latestByLocation.get(location.id) ?? null;
    const maps = mapsByLocation.get(location.id) ?? [];
    const current = latest ? currentMapById.get(latest._id) ?? null : null;
    const funnel = (current ?? maps[0])?.funnel ?? [];
    const previous = maps[current?.status === "published" || current?.status === "built" ? 1 : 0]?.funnel ?? [];
    return {
      location_id: location.id,
      location_name: location.name,
      state: location.state,
      removal_pending: location.removal_pending,
      source_coverage: readinessById.get(location.id)?.source_coverage ?? null,
      readiness: readinessById.get(location.id) ?? null,
      run: latest ? {
        id: latest._id,
        status: latest.status,
        created_at: latest.created_at,
        completed_at: latest.completed_at,
        stage_started_at: latest.stage_started_at ?? null,
        duration_seconds: (latest.completed_at ?? Date.now() / 1000) - latest.created_at,
        active: ACTIVE_RUN_STATUSES.includes(latest.status),
        sources: latest.sources.length,
        sources_done: latest.sources.filter((source) => source.status !== "pending").length,
        published: latest.published?.items ?? null,
        held: latest.published?.held ?? null,
        error: latest.error,
      } : null,
      funnel: funnel.map((step) => ({ ...step, previous: previous.find((item) => item.step === step.step)?.count ?? null })),
      sources: countsByLocation.get(location.id) ?? {},
      alerts: alertCountByLocation.get(location.id) ?? 0,
    };
  });
  const failingSources = await sourceMap(db).countDocuments({ status: { $in: ["active", "pinned"] }, "health.consecutive_failures": { $gte: 3 } });
  const dueDiscovery = await discoveryState(db).countDocuments({ next_due_at: { $lte: Date.now() / 1000 } });
  return {
    strip: {
      model: budget,
      queue: Object.fromEntries(queue.map((row) => [row._id, row.count])),
      failing_sources: failingSources,
      discovery_due: dueDiscovery,
      alerts: allAlerts.length,
    },
    work_queue: workQueue(readiness, allAlerts, editorialInbox.held, coverageRequests),
    locations: rows,
    alerts: allAlerts.slice(0, 10),
  };
}
