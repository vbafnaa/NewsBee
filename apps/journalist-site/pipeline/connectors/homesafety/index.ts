/**
 * Drinking-water safety from EPA Envirofacts (SDWIS). Health-based violations for community
 * water systems in the state, kept only when the system's registered city is the location
 * (local) or a configured place within 50 km (nearby). Contact names, emails, phones and
 * addresses in the EPA records are never read into facts.
 *
 * FEMA disaster declarations were planned here, but fema.gov answers robots.txt with 403,
 * which the Fetcher treats as "disallow all", so they're not collected.
 */
import { addDays, plainText } from "../common";
import type { CollectedEvent, Connector, ConnectorContext, SourceResult, SourceTask } from "../types";
import { publishedText } from "../wider/adapters";
import { fetchJson, isoDay, label, locationRegion, placeTier, runCollector, sectionFor, skip, SourceUnavailable } from "../parents/shared";

export const EPA_BASE = "https://data.epa.gov/efservice";
export const LOOKBACK_DAYS = 180;
export const MAX_SYSTEMS = 25;
export const MAX_ITEMS = 5;
const STATE = /^[A-Z]{2}$/;
const CATEGORY: Record<string, string> = {
  MCL: "a contaminant above the federal maximum level",
  MRDL: "a disinfectant above the federal maximum level",
  TT: "a required water treatment step that was not met",
};

export type Violation = { pwsid: string; violation_id: string; pws_type_code?: string; is_health_based_ind?: string; violation_category_code?: string; compl_per_begin_date?: string | null; rtc_date?: string | null; population_served_count?: number | null; public_notification_tier?: number | null };
export type WaterSystem = { pwsid: string; pws_name?: string | null; city_name?: string | null; state_code?: string | null; pws_activity_code?: string | null; pws_type_code?: string | null; population_served_count?: number | null };

export function violationsUrl(state: string, since: string) { return `${EPA_BASE}/VIOLATION/PRIMACY_AGENCY_CODE/${state}/IS_HEALTH_BASED_IND/Y/COMPL_PER_BEGIN_DATE/%3E/${since}/JSON`; }
export function systemUrl(pwsid: string) { return `${EPA_BASE}/WATER_SYSTEM/PWSID/${encodeURIComponent(pwsid)}/JSON`; }
export function reportUrl(pwsid: string) { return `${EPA_BASE}/VIOLATION/PWSID/${encodeURIComponent(pwsid)}/HTML`; }

export const homeSafetyConnector: Connector = {
  type: "homesafety",
  sources(location) {
    return location.state ? [{ source_id: "homesafety:sdwis", name: "Drinking water safety (EPA)", type: "homesafety" }] : [];
  },
  collect(task, context) { return runCollector(task, context, (record) => collectWater(task, context, record)); },
};

const titleCase = (value: string) => value.toLowerCase().replace(/\b([a-z])/g, (letter) => letter.toUpperCase()).replace(/\b(Of|And|The|For)\b/g, (word) => word.toLowerCase());

async function collectWater(task: SourceTask, context: ConnectorContext, record: SourceResult): Promise<CollectedEvent[]> {
  const region = await locationRegion(context);
  const state = region.state_code;
  if (!STATE.test(state)) throw new SourceUnavailable("no_feed", "Location has no state code");
  const since = addDays(context.today, -LOOKBACK_DAYS);
  const url = violationsUrl(state, since);
  record.feed_kind = "epa_sdwis"; record.feed_url = url; record.website = "https://www.epa.gov/ground-water-and-drinking-water";
  const rows = await fetchJson<Violation[]>(context, url);
  if (!Array.isArray(rows)) throw new SourceUnavailable("failed", "Envirofacts did not return a list of violations");
  const community = rows.filter((row) => row.pws_type_code === "CWS" && row.is_health_based_ind === "Y" && typeof row.pwsid === "string");
  skip(record, "not_community_water_system", rows.length - community.length);
  const bySystem = new Map<string, Violation[]>();
  for (const row of community) bySystem.set(row.pwsid, [...(bySystem.get(row.pwsid) ?? []), row]);
  const systems = [...bySystem.entries()].sort((a, b) => Number(b[1][0].population_served_count ?? 0) - Number(a[1][0].population_served_count ?? 0));
  const checked = systems.slice(0, MAX_SYSTEMS);
  skip(record, "system_limit", systems.length - checked.length);
  const events: CollectedEvent[] = [];
  for (const [pwsid, violations] of checked) {
    if (!violations.some((row) => isoDay(row.compl_per_begin_date))) { skip(record, "no_date"); continue; }
    let found: WaterSystem[];
    try { found = await fetchJson<WaterSystem[]>(context, systemUrl(pwsid)); }
    catch (error) { if (error instanceof SourceUnavailable) { skip(record, "system_lookup_failed"); continue; } throw error; }
    const system = Array.isArray(found) ? found[0] : undefined;
    if (!system || system.pws_activity_code !== "A") { skip(record, "inactive_system"); continue; }
    if (system.state_code && system.state_code !== state) { skip(record, "outside_area"); continue; }
    const tier = placeTier(region, system.city_name);
    if (!tier) { skip(record, "outside_area"); continue; }
    events.push(systemFacts(system, violations, tier, region.town, sectionFor(region, tier, "Water safety")));
  }
  events.sort((a, b) => Number(a.tier !== "local") - Number(b.tier !== "local") || Number((b.signals as Record<string, number>).population_served) - Number((a.signals as Record<string, number>).population_served));
  const kept = events.slice(0, MAX_ITEMS);
  skip(record, "item_limit", events.length - kept.length);
  record.detail = `${rows.length} health-based violations in ${state} since ${since}; ${bySystem.size} community water systems, ${checked.length} checked, ${kept.length} serving ${region.town} or within 50 km`;
  return kept;
}

export function systemFacts(system: WaterSystem, violations: Violation[], tier: "local" | "region" | "nearby", town: string, section: string): CollectedEvent {
  const name = titleCase(label(system.pws_name ?? system.pwsid) ?? system.pwsid);
  const begins = violations.map((row) => isoDay(row.compl_per_begin_date)).filter((day): day is string => Boolean(day)).sort();
  const newest = begins.at(-1) ?? "";
  const open = violations.filter((row) => !isoDay(row.rtc_date));
  const returned = violations.map((row) => isoDay(row.rtc_date)).filter((day): day is string => Boolean(day)).sort().at(-1);
  const categories = [...new Set(violations.map((row) => CATEGORY[row.violation_category_code ?? ""]).filter(Boolean))];
  const population = Number(system.population_served_count ?? violations[0].population_served_count ?? 0);
  const count = violations.length;
  let description = `The U.S. Environmental Protection Agency's Safe Drinking Water records list ${count} health-based violation${count === 1 ? "" : "s"} for ${name}, a community water system${population ? ` serving about ${population.toLocaleString("en-US")} people` : ""} registered in ${titleCase(system.city_name ?? town)}`;
  description += newest ? `, for a compliance period beginning ${publishedText(newest)}.` : ".";
  if (categories.length) description += ` The record type is ${categories.join(" and ")}.`;
  description += open.length ? ` The EPA record does not yet show a return to compliance for ${open.length === count ? (count === 1 ? "it" : "them") : `${open.length} of them`}.` : returned ? ` The EPA record shows the system returned to compliance on ${publishedText(returned)}.` : "";
  return {
    source_event_id: `${system.pwsid}:${violations.map((row) => row.violation_id).sort().join("+")}`,
    title: `Drinking water: health-based violation${count === 1 ? "" : "s"} recorded for ${name}`,
    event_date: newest, schedule_text: publishedText(newest), venue: "U.S. EPA Safe Drinking Water records", room: null,
    source_url: reportUrl(system.pwsid), description, kind: "safety_notice", tier, section,
    signals: { health_based: 1, open: open.length ? 1 : 0, population_served: population, violations: count },
  };
}
