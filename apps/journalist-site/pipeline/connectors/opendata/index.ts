/**
 * The open-data reader: any Socrata dataset on the source map (police calls, fire and EMS
 * dispatch, permits, inspections, licence applications, 311 requests), found at discovery
 * on the city's, county's or state's portal. The dataset's columns are read from its own
 * metadata at collection time, so no column names are configured.
 *
 *   - Datasets with a location column are filtered on the server to a circle around the
 *     location, then each row is checked against the area (a point outside is decisive).
 *   - Statewide datasets without coordinates are filtered by city name; for a neighbourhood
 *     their addresses are geocoded (bounded) and kept only inside its area.
 *   - Police and fire calls become incidents with plain-word call types, block-level places,
 *     unit counts and outcomes; routine calls are counted in one weekly summary item.
 *   - 311 requests become one summary item; permits, licences and inspections become items.
 *
 * Only columns that are not personal (applicants, owners, phones, emails, mailing
 * addresses, names of individuals) are ever selected.
 */
import { fetchJson, runCollector, SourceUnavailable } from "../parents/shared";
import { addDays, plainText } from "../common";
import { sha256 } from "../wider/adapters";
import { newestFirst } from "../web";
import type { CollectedEvent, Connector, ConnectorContext, DroppedItem, SourceResult, SourceTask } from "../types";
import { rangesFor } from "../../core/time";
import { datasetWindow, effectiveWindow } from "../../sourcemap/windows";
import { censusGeocoder, locationCenter, townName, TOWN_RADIUS_KM } from "../locality";
import { distanceKm, withinArea, type Point } from "../../../../../shared/geography";
import type { Details } from "../../editions/details";
import { counts, groupIncidents, mapLink, notable, plainCall, tidyCode, toBlock, units, type Call } from "./safety";
import { itemCap } from "../../core/run-options";

export type Topic = "police" | "fire" | "permits" | "inspections" | "licences" | "311";
export type DatasetParams = { domain: string; dataset: string; topic: Topic; filter?: "radius" | "city"; agency?: string; license?: string | null };
export const TOPIC_KIND: Record<Topic, string> = { police: "safety_incident", fire: "safety_incident", permits: "development", inspections: "public_record", licences: "business_opening", "311": "public_record" };
export const TOPIC_SECTION: Record<Topic, string> = { police: "safety", fire: "safety", permits: "real_estate", inspections: "business", licences: "business", "311": "civic" };

const PERSONAL = /(applicant|owner|licensee_?name|contact|phone|email|mail|signee|officer|agent|principal|ssn|birth|ubi|person|first_?name|last_?name|victim|suspect|arrestee|subject|driver|dob|^name$|contractor_?name)/i;
const DATE_TYPES = new Set(["calendar_date", "floating_timestamp", "fixed_timestamp", "date"]);
const ROW_LIMIT = 1000;
const MAX_ITEMS = 25;
const GEOCODE_BUDGET = 15;

type Column = { field: string; type: string };
const pick = (columns: Column[], pattern: RegExp, unless?: RegExp) => columns.find((column) => pattern.test(column.field) && !(unless && unless.test(column.field)) && !PERSONAL.test(column.field))?.field ?? null;

/** The dataset's columns, from Socrata's own view metadata (a public JSON API). */
export async function datasetColumns(context: ConnectorContext, domain: string, dataset: string): Promise<Column[]> {
  const view = await fetchJson<{ columns?: Array<{ fieldName?: string; dataTypeName?: string }> }>(context, `https://${domain}/api/views/${dataset}.json`);
  return (view.columns ?? []).flatMap((column) => column.fieldName && !column.fieldName.startsWith(":") ? [{ field: column.fieldName, type: String(column.dataTypeName ?? "").toLowerCase().replace(/\s+/g, "_") }] : []);
}

export type ColumnMap = { date: string | null; point: string | null; lat: string | null; lon: string | null; what: string | null; outcome: string | null; priority: string | null; area: string | null; address: string | null; city: string | null; name: string | null; type: string | null; category: string | null; units: string | null; value: string | null; result: string | null; description: string | null };

export function mapColumns(columns: Column[], topic: Topic): ColumnMap {
  const date = columns.find((column) => DATE_TYPES.has(column.type) && /date|time|issued|applied|filed|received|opened|reported|inspection/i.test(column.field))?.field
    ?? columns.find((column) => DATE_TYPES.has(column.type))?.field ?? null;
  return {
    date,
    point: columns.find((column) => ["point", "location"].includes(column.type))?.field ?? null,
    lat: pick(columns, /(^|_)lat(itude)?$/i),
    lon: pick(columns, /(^|_)(lon|lng|long|longitude)$/i),
    what: topic === "police" || topic === "fire"
      ? pick(columns, /final_call_type|initial_call_type|call_?type|^type$|incident_?type|event_?type|offen[cs]e(_?(type|description|category))?$|crime_?type|nature|^category$|description$/i, /disposition|clearance|outcome|status/i)
      : pick(columns, /description|work_?type|permit_?type|permittypedesc|request_?type|service_?request_?type|^type$|program_?identifier|violation_?description|category|privdesc0?1/i),
    outcome: pick(columns, /disposition|clearance|outcome|resolution|^status$|result|current_?status/i),
    priority: pick(columns, /priority/i),
    area: pick(columns, /beat|sector|precinct|neighbou?rhood|mcpp|^district$|council_?district/i),
    address: pick(columns, /^(original_?)?address(1|_?line_?1)?$|street_?address|streetaddress|location_?(text|desc|address)|block_?address|hundred_?block|incident_?address|address/i, /mail|city|state|zip/i),
    city: pick(columns, /^(cityname|city_?name|city|premises?_?city|business_?city|location_?city)$/i),
    name: topic === "licences" || topic === "inspections" ? pick(columns, /trade_?name|tradename|dba|doing_?business_?as|business_?name|establishment_?name|facility_?name|^name$|program_?name/i, /owner|applicant/i) ?? columns.find((column) => /^name$|business_?name|program_?name/i.test(column.field))?.field ?? null : null,
    type: pick(columns, /l_a_type|application_?type|app_?type|^action$|request_?type|permit_?class|permitclass/i),
    category: pick(columns, /privdesc0?1|license_?description|license_?type|privilege|business_?type|category/i),
    units: pick(columns, /units?(_?count)?$|number_?of_?units|apparatus|housingunits|dwelling_?units/i),
    value: pick(columns, /value|valuation|estimated_?cost|project_?cost/i),
    result: pick(columns, /inspection_?result|result|grade|violation_?type/i),
    description: pick(columns, /^description$|project_?description|work_?description/i),
  };
}

function str(value: unknown) { return value === null || value === undefined ? "" : typeof value === "object" ? "" : String(value).trim(); }
function rowPoint(row: Record<string, unknown>, map: ColumnMap): Point | null {
  const lat = Number(map.lat ? row[map.lat] : NaN), lon = Number(map.lon ? row[map.lon] : NaN);
  if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0) return [lon, lat];
  const value = map.point ? row[map.point] as Record<string, unknown> | undefined : undefined;
  if (value && typeof value === "object") {
    const coordinates = (value as { coordinates?: number[] }).coordinates;
    if (Array.isArray(coordinates) && coordinates.length >= 2) return [Number(coordinates[0]), Number(coordinates[1])];
    const latitude = Number((value as { latitude?: unknown }).latitude), longitude = Number((value as { longitude?: unknown }).longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) return [longitude, latitude];
  }
  return null;
}
function dayOf(value: string) { return /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1] ?? (/^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : null); }
function timeOf(value: string) {
  const match = /T(\d{2}):(\d{2})/.exec(value);
  if (!match || (match[1] === "00" && match[2] === "00")) return null;
  const hour = Number(match[1]), minute = match[2];
  return `${hour % 12 || 12}:${minute} ${hour < 12 ? "am" : "pm"}`;
}
function dayText(day: string) {
  const date = new Date(`${day}T12:00:00Z`);
  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

export const openDataConnector: Connector = {
  type: "opendata",
  meta: {
    name: "Open-data portals",
    formats: "Socrata datasets on the city's, county's or state's open-data portal: police and fire calls, permits, inspections, licence applications and 311 requests",
    manual: true,
    coverage: { group: "local", label: "public records" },
    storyKinds: ["safety_incident", "development", "business_opening", "public_record"],
  },
  window: datasetWindow("permits"),
  windowFor(task) { return datasetWindow(String(task.params?.topic ?? "permits")); },
  rank: newestFirst,
  sources() { return []; },
  async collect(task, context) {
    const dropped: DroppedItem[] = [];
    const collected = await runCollector(task, context, (record) => readDataset(task, context, record, dropped));
    return { ...collected, dropped };
  },
};

export async function readDataset(task: SourceTask, context: ConnectorContext, record: SourceResult, dropped: DroppedItem[]): Promise<CollectedEvent[]> {
  const params = task.params as unknown as DatasetParams;
  if (!params?.domain || !/^[a-z0-9]{4}-[a-z0-9]{4}$/.test(params.dataset ?? "")) throw new SourceUnavailable("failed", "Source has no Socrata dataset");
  const topic = params.topic;
  const columns = await datasetColumns(context, params.domain, params.dataset);
  const map = mapColumns(columns, topic);
  if (!map.date) throw new SourceUnavailable("failed", "Dataset has no date column");
  const window = effectiveWindow(datasetWindow(topic), (task.params?.window as never) ?? null);
  const since = rangesFor(context, window).back?.[0] ?? addDays(context.today, -7);
  const { center, area } = locationCenter(context.location);
  const town = townName(context.location);
  const place = context.location.community?.name ?? town;
  const where = [`${map.date} >= '${since}T00:00:00'`];
  const radiusKm = area?.radius_km ?? (area ? 4 : TOWN_RADIUS_KM);
  const geoColumn = map.point;
  if (params.filter !== "city" && geoColumn && center) where.push(`within_circle(${geoColumn}, ${center[1]}, ${center[0]}, ${Math.round(radiusKm * 1000)})`);
  else if (map.city) where.push(`upper(${map.city}) = '${town.toUpperCase().replace(/'/g, "''")}'`);
  else if (!center) throw new SourceUnavailable("failed", "Location has no coordinates and the dataset has no city column");
  const selected = [...new Set(Object.values(map).filter((value): value is string => Boolean(value)))];
  const query = new URLSearchParams({ $select: selected.join(","), $where: where.join(" AND "), $order: `${map.date} DESC`, $limit: String(ROW_LIMIT) });
  const url = `https://${params.domain}/resource/${params.dataset}.json?${query.toString()}`;
  record.feed_kind = "socrata";
  record.feed_url = url;
  record.website = `https://${params.domain}/d/${params.dataset}`;
  let rows: Array<Record<string, unknown>>;
  try { rows = await fetchJson<Array<Record<string, unknown>>>(context, url); }
  catch (error) {
    // Some location columns don't support within_circle; fall back to filtering locally.
    if (!(error instanceof SourceUnavailable) || params.filter === "city") throw error;
    const fallback = new URLSearchParams({ $select: selected.join(","), $where: where[0], $order: `${map.date} DESC`, $limit: String(ROW_LIMIT) });
    rows = await fetchJson<Array<Record<string, unknown>>>(context, `https://${params.domain}/resource/${params.dataset}.json?${fallback.toString()}`);
  }
  if (!Array.isArray(rows)) throw new SourceUnavailable("failed", "Dataset did not return rows");

  // Locality for every row: a point inside is local, a point outside is dropped.
  const geocoder = censusGeocoder(context.fetcher, context.db);
  let geocodes = GEOCODE_BUDGET;
  const inside = async (row: Record<string, unknown>): Promise<{ ok: boolean | null; point: Point | null; how: string }> => {
    const point = rowPoint(row, map);
    if (point && center) {
      const ok = area ? withinArea(area, center, point) : distanceKm(center, point) <= TOWN_RADIUS_KM;
      return { ok, point, how: ok ? (area?.method === "boundary" ? "boundary" : "approximate_area") : "outside" };
    }
    if (!context.location.community && map.city) return { ok: true, point: null, how: "town_record" };
    const address = map.address ? str(row[map.address]) : "";
    if (address && geocodes > 0 && center) {
      geocodes -= 1;
      const match = await geocoder.geocode(`${address}, ${town}, ${context.location.state}`).catch(() => null);
      if (match) {
        const ok = area ? withinArea(area, center, match.point) : distanceKm(center, match.point) <= TOWN_RADIUS_KM;
        return { ok, point: match.point, how: ok ? "address_boundary" : "outside" };
      }
    }
    return { ok: null, point: null, how: "unknown" };
  };

  const agency = params.agency ?? params.domain;
  const events: CollectedEvent[] = [];
  const drop = (row: Record<string, unknown>, title: string, reason: string) => {
    const day = dayOf(str(row[map.date!]));
    dropped.push({ source_event_id: sha256(JSON.stringify(row)).slice(0, 16), title, url: record.website, reason, event_date: day });
  };

  if (topic === "police" || topic === "fire") {
    const calls: Call[] = [];
    for (const row of rows) {
      const located = await inside(row);
      const raw = map.what ? str(row[map.what]) : "";
      if (located.ok === false) { drop(row, plainCall(raw), "not_local"); continue; }
      if (located.ok === null) { drop(row, plainCall(raw), "no_location"); continue; }
      const value = str(row[map.date!]);
      calls.push({
        id: sha256(JSON.stringify(row)).slice(0, 16), at: new Date(`${value.slice(0, 19)}Z`), raw: tidyCode(raw), what: plainCall(raw),
        block: map.address ? toBlock(str(row[map.address])) : "", outcome: map.outcome ? tidyCode(str(row[map.outcome])) : "",
        priority: map.priority ? str(row[map.priority]) : "", area: map.area ? `${map.area.replace(/_/g, " ")} ${str(row[map.area])}`.trim() : "",
        lat: located.point ? located.point[1] : null, lon: located.point ? located.point[0] : null, units: map.units ? Number(row[map.units]) || 1 : 1,
      });
    }
    const incidents = groupIncidents(calls).sort((a, b) => b.last.getTime() - a.last.getTime());
    const routine: Call[] = [];
    for (const incident of incidents) {
      if (!notable(incident) || events.length >= itemCap(MAX_ITEMS)) {
        routine.push(...incident.calls);
        dropped.push({ source_event_id: incident.key, title: `${incident.what}${incident.block ? ` on the ${incident.block}` : ""}`, url: record.website, reason: "routine_call (counted in the weekly summary)", event_date: incident.first.toISOString().slice(0, 10) });
        continue;
      }
      const day = incident.first.toISOString().slice(0, 10);
      const time = timeOf(incident.first.toISOString());
      const count = units(incident);
      const types = counts(incident.calls).map(([what, n]) => n > 1 ? `${what} (${n})` : what).join(", ");
      const responders = topic === "fire" ? "Fire and medic units" : "Police";
      const placeText = incident.block ? `the ${incident.block}` : place;
      const description = [
        `${responders} responded to a ${incident.what.toLowerCase()} at ${placeText} on ${dayText(day)}${time ? ` at ${time}` : ""}.`,
        count > 1 ? `${count} ${topic === "fire" ? "units were dispatched" : "calls were logged"}: ${types}.` : `The call was logged as ${incident.calls[0].raw || incident.what}.`,
        incident.outcome ? `Recorded outcome: ${incident.outcome}.` : "",
        incident.area ? `Area: ${incident.area}.` : "",
        `Source: ${agency} public call data. A call is not a confirmed crime.`,
      ].filter(Boolean).join(" ");
      events.push({
        source_event_id: incident.key, title: `${incident.what}${incident.block ? ` on the ${incident.block}` : ` in ${place}`}`, event_date: day,
        schedule_text: `${dayText(day)}${time ? `, ${time}` : ""}`, venue: incident.block || place, room: null, source_url: record.website!, description,
        kind: "safety_incident", tier: "local", section_id: "safety", source_name: agency,
        locality: { method: incident.lat !== null ? "boundary" : "town_record", matches: [incident.block || place] },
        ...(incident.lat !== null ? { coordinates: [incident.lon, incident.lat] } : {}),
        incident: { units: count, calls: incident.calls.length, what: incident.what, block: incident.block, map_url: mapLink(incident.lat, incident.lon) },
        details: { places: [incident.block, incident.area].filter(Boolean), when: `${dayText(day)}${time ? ` at ${time}` : ""}`, numbers: count > 1 ? [`${count} ${topic === "fire" ? "units dispatched" : "calls"}`] : [], what: [description.split(". ")[0] + "."], organisations: [agency], links: [record.website!] } as Partial<Details>,
      } as CollectedEvent);
    }
    if (routine.length) {
      const list = counts(routine).slice(0, 8).map(([what, n]) => `${n} ${what.toLowerCase()}${n > 1 ? " calls" : " call"}`).join(", ");
      events.push({
        source_event_id: sha256(`${task.source_id}:${since}:summary`).slice(0, 16), title: `${topic === "fire" ? "Fire and medic" : "Police"} calls in ${place} since ${dayText(since)}`,
        event_date: context.today, schedule_text: `Since ${dayText(since)}`, venue: place, room: null, source_url: record.website!,
        description: `${agency} public call data shows ${routine.length} more ${topic === "fire" ? "fire and medic" : "police"} calls in ${place} since ${dayText(since)}: ${list}. A call is not a confirmed crime.`,
        kind: "safety_incident", tier: "local", section_id: "safety", source_name: agency, summary: true, locality: { method: "boundary", matches: [place] },
        details: { numbers: [`${routine.length} calls`], places: [place], organisations: [agency], links: [record.website!] } as Partial<Details>,
      } as CollectedEvent);
    }
  } else if (topic === "311") {
    const kept: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const located = await inside(row);
      if (located.ok) kept.push(row); else drop(row, map.what ? tidyCode(str(row[map.what])) : "311 request", located.ok === false ? "not_local" : "no_location");
    }
    if (kept.length) {
      const by = new Map<string, number>();
      for (const row of kept) { const what = map.what ? tidyCode(str(row[map.what])) || "Other" : "Request"; by.set(what, (by.get(what) ?? 0) + 1); }
      const list = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([what, n]) => `${n} ${what.toLowerCase()}`).join(", ");
      events.push({
        source_event_id: sha256(`${task.source_id}:${since}`).slice(0, 16), title: `${kept.length} service requests from ${place} since ${dayText(since)}`,
        event_date: context.today, schedule_text: `Since ${dayText(since)}`, venue: place, room: null, source_url: record.website!,
        description: `${agency} records ${kept.length} service requests from ${place} since ${dayText(since)}: ${list}.`, kind: "public_record", tier: "local", section_id: "civic",
        source_name: agency, summary: true, locality: { method: "boundary", matches: [place] },
        details: { numbers: [`${kept.length} requests`, ...[...by.entries()].slice(0, 3).map(([what, n]) => `${n} ${what.toLowerCase()}`)], places: [place], organisations: [agency], links: [record.website!] } as Partial<Details>,
      } as CollectedEvent);
    }
  } else {
    for (const row of rows) {
      if (events.length >= itemCap(MAX_ITEMS)) break;
      const day = dayOf(str(row[map.date]));
      const what = map.what ? tidyCode(str(row[map.what])) : "";
      const name = map.name ? tidyCode(str(row[map.name])) : "";
      const address = map.address ? str(row[map.address]) : "";
      const type = map.type ? tidyCode(str(row[map.type])) : "";
      const titleBase = topic === "licences" ? name || what : topic === "inspections" ? name : what || type;
      if (!day || !titleBase) { drop(row, titleBase || "Record", "incomplete"); continue; }
      if (topic === "licences" && type && /renewal|discontinu|withdrawn|cancel/i.test(type)) { drop(row, titleBase, "not_new"); continue; }
      const located = await inside(row);
      if (located.ok === false) { drop(row, titleBase, "not_local"); continue; }
      if (located.ok === null) { drop(row, titleBase, "no_location"); continue; }
      // Permits can be private homes: place them at the block. Licences and inspections are business premises.
      const where = topic === "permits" ? toBlock(address) : address;
      const category = map.category ? tidyCode(str(row[map.category])) : "";
      const value = map.value ? Number(row[map.value]) : NaN;
      const unitCount = map.units ? Number(row[map.units]) : NaN;
      const result = map.result && topic === "inspections" ? tidyCode(str(row[map.result])) : "";
      const description = map.description ? plainText(str(row[map.description]), 400) : null;
      const title = topic === "licences" ? `${titleBase} applies for a licence${where ? ` at ${where}` : ""}`
        : topic === "inspections" ? `${titleBase} inspected${result ? `: ${result.toLowerCase()}` : ""}`
          : `${titleBase}${where ? ` at the ${where}` : ""}`;
      const sentences = [
        topic === "licences" ? `${agency} records show ${type ? `a ${type.toLowerCase()}` : "an application"}${category ? ` for a ${category.toLowerCase()} licence` : ""}, filed ${dayText(day)}, for ${titleBase}${where ? ` at ${where}` : ""}. An application is not an approval.` : "",
        topic === "permits" ? `${agency} recorded a ${type ? type.toLowerCase() : "permit"} on ${dayText(day)}${where ? ` for the ${where}` : ""}: ${what || type}.${Number.isFinite(unitCount) && unitCount > 0 ? ` ${unitCount} housing units.` : ""}${Number.isFinite(value) && value > 0 ? ` Estimated value $${Math.round(value).toLocaleString("en-US")}.` : ""}` : "",
        topic === "inspections" ? `${agency} inspected ${titleBase}${where ? ` at ${where}` : ""} on ${dayText(day)}${result ? `; result: ${result}` : ""}.` : "",
        description && topic === "permits" ? `Project: ${description}` : "",
      ].filter(Boolean).join(" ");
      const point = located.point;
      events.push({
        source_event_id: sha256(JSON.stringify(row)).slice(0, 16), title: title.slice(0, 200), event_date: day, schedule_text: dayText(day), venue: where || place, room: null,
        source_url: record.website!, description: sentences, kind: TOPIC_KIND[topic], tier: "local", section_id: TOPIC_SECTION[topic], source_name: agency,
        locality: { method: located.how, matches: [where || place] }, ...(point ? { coordinates: point } : {}),
        details: {
          places: [where].filter(Boolean), organisations: [topic === "permits" ? "" : titleBase, agency].filter(Boolean), when: dayText(day),
          numbers: [Number.isFinite(unitCount) && unitCount > 0 ? `${unitCount} housing units` : "", Number.isFinite(value) && value > 0 ? `$${Math.round(value).toLocaleString("en-US")} estimated value` : ""].filter(Boolean),
          what: [sentences.split(". ")[0] + "."], links: [record.website!],
        } as Partial<Details>,
      } as CollectedEvent);
    }
  }
  record.detail = `${rows.length} rows since ${since}; ${events.length} items kept, ${dropped.length} left out`;
  return events;
}

