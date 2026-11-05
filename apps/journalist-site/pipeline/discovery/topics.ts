/**
 * Query generation for operator search. Priority topics are the main input: each enabled
 * topic has query families for Stage 1 (lasting sources) and Stage 2 (new pages in the
 * window), with a guaranteed share of the query budget. General families use what is left.
 *
 * The search kit is built from location data, and grows as discovery finds things: a school
 * on the map creates athletics queries, a funeral home creates obituary queries, a county
 * creates assessor and sheriff queries. A template whose placeholder has no value is skipped.
 *
 * A neighbourhood's best sources often never name it: the city's police, the county assessor.
 * So a topic can search by the city as well as the place, but every query stays tied to the
 * community: results about a whole county, state or region cost money and rarely concern it.
 * The state appears only to tell apart places with the same name.
 */
import type { Db } from "mongodb";
import type { ConnectorContext, LocationProfile } from "../connectors/types";
import type { HttpTransport } from "../core/http";
import type { PriorityTopic } from "../core/run-values";
import type { SectionId } from "../sourcemap/sections";
import { publicApiGet } from "../connectors/public-api";
import { townName } from "../connectors/locality";
import { mentions } from "../connectors/community";
import { DO_NOT_SCRAPE } from "../connectors/fetcher";
import { AGGREGATORS } from "../connectors/newssearch";
import { US_STATES } from "../../../../shared/geography";
import { hostOf, sourceMap } from "../sourcemap/store";
import { areaFacts } from "./area";
import { verifiedCitySite } from "./city-site";
import { localInstitutions, type Institution } from "./institutions";

export type SearchKit = {
  place: string; parent: string | null; state: string; stateCode: string; county: string | null; cityDomain: string | null; zips: string[];
  schools: Array<{ name: string; host: string | null }>; institutions: Institution[]; venues: string[]; agencyHosts: string[]; funeralHosts: string[]; schoolHosts: string[]; teamHosts: string[]; savedHosts: string[]; associationHost: string | null;
};

async function postcode(transport: HttpTransport, location: LocationProfile) {
  if (typeof location.latitude !== "number" || typeof location.longitude !== "number") return [];
  try {
    const params = new URLSearchParams({ lat: String(location.latitude), lon: String(location.longitude), format: "jsonv2", zoom: "14" });
    const body = await publicApiGet(transport, `https://nominatim.openstreetmap.org/reverse?${params}`, "application/json", 256 * 1024, 15_000);
    const code = (JSON.parse(new TextDecoder().decode(body)) as { address?: { postcode?: string } }).address?.postcode;
    return code ? [code.slice(0, 5)] : [];
  } catch { return []; }
}

const SCHOOL_NAME = /(?:high|middle|junior|prep\w*|academy|school)\b/i;

export async function buildSearchKit(context: { db: Db; transport: HttpTransport; location: LocationProfile; today: string; settings: unknown; log: unknown; fetcher: unknown }): Promise<SearchKit> {
  const { location, db } = context;
  const facts = await areaFacts(context as unknown as ConnectorContext).catch(() => null);
  const records = await sourceMap(db).find({ location_id: location.id, status: { $ne: "rejected" } }, { projection: { name: 1, url: 1, section: 1, found_by: 1, topics: 1, source_tier: 1 } }).toArray();
  const hostsIn = (test: (record: typeof records[number]) => boolean) => [...new Set(records.filter(test).map((record) => hostOf(record.url)).filter(Boolean))];
  const institutions = await localInstitutions({ db, transport: context.transport, location }).catch(() => [] as Institution[]);
  const onMapSchools = records.filter((record) => record.section === "schools" && SCHOOL_NAME.test(record.name)).map((record) => ({ name: record.name.split(/[:(]/)[0].trim(), host: hostOf(record.url) || null }));
  const nearbySchools = institutions.filter((item) => item.kind === "school").map((item) => ({ name: item.name, host: hostOf(item.website) || null }));
  const schools = [...nearbySchools, ...onMapSchools].filter((school, index, all) => all.findIndex((other) => other.name === school.name) === index).slice(0, 8);
  // Search only inside a site that has been checked as the city's own.
  const citySite = await verifiedCitySite(context as unknown as Parameters<typeof verifiedCitySite>[0]).catch(() => null);
  const names = location.community ? { place: location.community.name, parent: location.community.parent_name } : { place: townName(location), parent: null };
  return {
    ...names, state: US_STATES[location.state] ?? location.state, stateCode: location.state, county: facts?.county?.replace(/\s+County$/i, "") ?? null,
    cityDomain: citySite?.host ?? null, zips: await postcode(context.transport, location), schools, institutions,
    venues: records.filter((record) => record.section === "events").slice(0, 5).map((record) => record.name.split(/[:(]/)[0].trim()),
    agencyHosts: hostsIn((record) => record.section === "safety" || record.topics?.includes("crime") === true),
    funeralHosts: hostsIn((record) => record.section === "obituaries" || record.topics?.includes("deaths") === true),
    schoolHosts: hostsIn((record) => record.section === "schools"),
    teamHosts: hostsIn((record) => record.topics?.includes("sports") === true && record.section === "sports"),
    savedHosts: hostsIn((record) => record.source_tier === "official" || record.source_tier === "organisation"),
    associationHost: hostsIn((record) => record.found_by.method === "athletics")[0] ?? null,
  };
}

export type PlannedQuery = { topic: PriorityTopic | null; family: string; query: string; stage: "stage1" | "stage2"; section?: SectionId };

/** Sites to leave out: aggregators and platforms we never read. */
function exclusions(topic: PriorityTopic | null) {
  const list = topic === "home_sales" ? ["yelp.com", "zillow.com"] : topic === "events" ? ["facebook.com", "eventbrite.com"] : topic === "deaths" ? ["legacy.com"] : ["facebook.com"];
  return list.map((site) => `-site:${site}`).join(" ");
}
export const NEVER_READ = [...DO_NOT_SCRAPE, ...AGGREGATORS];

function fill(kit: SearchKit, template: string, topic: PriorityTopic | null, values: Record<string, string> = {}) {
  const lookup: Record<string, string | null> = { place: kit.place, parent: kit.parent, city: kit.parent ?? kit.place, state: kit.state, county: kit.county, city_domain: kit.cityDomain, zip: kit.zips[0] ?? null, ...values };
  let missing = false;
  const query = template.replace(/\{(\w+)\}/g, (_, name: string) => { const value = lookup[name]; if (!value) missing = true; return value ?? ""; });
  return missing ? null : `${query} ${exclusions(topic)}`.trim();
}

function stage1(kit: SearchKit, topic: PriorityTopic): Array<[string, string, Record<string, string>?]> {
  switch (topic) {
    case "crime": return [
      ["city_police", 'site:{city_domain} police (blotter OR "incident reports" OR "crime data")'],
      ["city_police_news", '"{parent}" police (blotter OR "significant incident" OR "press releases")'],
      ["police_blotter", '"{place}" ("police blotter" OR "incident report" OR "press release") site:.gov'],
      ["open_data", '"{parent}" (police OR crime OR fire OR 911) dataset "open data"'],
      ["sheriff", '"{county} County" "{city}" sheriff (blotter OR "press release" OR arrests)'],
      ["prosecutor", '"{county} County" "{city}" prosecutor ("press release" OR news OR charges)'],
    ];
    case "deaths": return [
      ["funeral_homes", '"{place}" "{state}" ("funeral home" OR mortuary OR cremation) (obituaries OR "recent services")'],
      ["city_funeral_homes", '"{parent}" "{state}" ("funeral home" OR mortuary OR cremation) obituaries'],
      ["obituaries", 'inurl:obituaries "{place}" "{state}"'],
      ...kit.institutions.filter((item) => item.kind === "funeral_directors" && !item.website).slice(0, 2).map((item): [string, string, Record<string, string>] => ["institution", '"{name}" "{state}" obituaries', { name: item.name }]),
    ];
    case "events": return [
      ["calendars", '"{place}" inurl:calendar (parks OR library OR community)'],
      ["branch_library", '"{place}" (branch OR library) events'],
      ["community_center", '"{place}" "community center" programs'],
      ...kit.institutions.filter((item) => ["library", "community_centre", "arts_centre", "theatre"].includes(item.kind) && !item.website).slice(0, 2).map((item): [string, string, Record<string, string>] => ["institution", '"{name}" "{state}" events', { name: item.name }]),
      ["city_events", 'site:{city_domain} "{place}" ("upcoming events" OR calendar)'],
      ...kit.venues.slice(0, 2).map((venue): [string, string, Record<string, string>] => ["venue", '"{venue}" ("upcoming events" OR tickets OR schedule)', { venue }]),
    ];
    case "home_sales": return [
      ["assessor", '"{county} County" "{city}" (assessor OR recorder) ("sales data" OR "parcel search" OR "recorded documents")'],
      ["sales_files", '"{county} County" "{city}" "real property" sales filetype:csv'],
      ["permits", 'site:{city_domain} ("building permit" OR "land use") (notices OR issued OR applications)'],
    ];
    // Each level of sport comes first, so the budget can't cut one out; specific schools follow.
    case "sports": return [
      ["high_school_sports", '"{place}" "high school" (athletics OR "varsity") (schedule OR scores)'],
      ["middle_school_sports", '"{place}" "middle school" (athletics OR sports) schedule'],
      ...kit.schools.slice(0, 3).map((school): [string, string, Record<string, string>] => ["school_athletics", '"{school}" athletics (schedule OR scores OR roster)', { school: school.name }]),
      ["youth_leagues", '"{place}" youth (soccer OR baseball OR basketball OR hockey OR "little league") (schedule OR standings)'],
      ["league", '"{parent}" high school league (schedule OR standings OR results)'],
      ...kit.institutions.filter((item) => item.kind === "club" && !item.website).slice(0, 2).map((item): [string, string, Record<string, string>] => ["institution", '"{name}" "{state}" (schedule OR results OR calendar)', { name: item.name }]),
      ...kit.schoolHosts.slice(0, 2).map((host): [string, string, Record<string, string>] => ["district_athletics", "site:{host} inurl:athletics", { host }]),
      ...(kit.associationHost && kit.schools[0] ? [["association", 'site:{association} "{school}" (schedule OR results)', { association: kit.associationHost, school: kit.schools[0].name }] as [string, string, Record<string, string>]] : []),
    ];
  }
}

function stage2(kit: SearchKit, topic: PriorityTopic, after: string): Array<[string, string, Record<string, string>?]> {
  const since = { after };
  const each = (family: string, hosts: string[], template: string, count = 2) => hosts.slice(0, count).map((host): [string, string, Record<string, string>] => [family, template, { host, ...since }]);
  switch (topic) {
    case "crime": return [...each("agency_sweep", kit.agencyHosts, 'site:{host} "{place}" (arrest OR incident OR investigation) after:{after}'), ["place_sweep", '"{place}" (police OR sheriff) (arrested OR incident OR investigation) after:{after}', since]];
    case "deaths": return [...each("funeral_sweep", kit.funeralHosts, 'site:{host} (obituary OR "in loving memory") after:{after}'), ["place_sweep", '"{place}" "{state}" obituary after:{after}', since]];
    case "events": return [["place_sweep", '"{place}" ("this weekend" OR "upcoming") (event OR festival OR concert) after:{after}', since]];
    case "home_sales": return [["sales_sweep", '"{place}" ("sold for" OR "sale price" OR "recently sold") after:{after}', since], ["permit_sweep", 'site:{city_domain} "{place}" ("permit issued" OR "land use notice") after:{after}', since]];
    case "sports": return [
      ...each("school_sweep", kit.schoolHosts, "site:{host} (score OR recap OR results) after:{after}"),
      ...kit.schools.slice(0, 2).map((school): [string, string, Record<string, string>] => ["school_results", '"{school}" (defeated OR playoff OR "final score") after:{after}', { school: school.name, ...since }]),
      ...each("team_sweep", kit.teamHosts, "site:{host} (recap OR result OR schedule) after:{after}"),
    ];
  }
}

const GENERAL: Array<[string, string, SectionId]> = [
  ["city_records", 'site:{city_domain} (agenda OR minutes OR "public hearing" OR "city council")', "civic"],
  ["representative", 'site:{city_domain} (councilmember OR "town hall") "{place}"', "civic"],
  ["community_groups", 'site:.org "{place}" ("community council" OR "neighborhood association") meeting', "community"],
  ["school_groups", '"{place}" (PTA OR PTSA) newsletter', "schools"],
  ["street_projects", 'site:{city_domain} (transportation OR "capital projects" OR "current projects") "{place}"', "community"],
  ["transit_alerts", '"{city}" (transit OR metro) "service advisories"', "community"],
  ["parks", 'site:{city_domain} parks "{place}"', "community"],
  ["licences", '"{city}" (liquor OR cannabis) "license" ("new applications" OR "license actions")', "business"],
  ["inspections", '"{county} County" "{city}" "food establishment" inspection data', "business"],
  ["other_agencies", 'site:.gov "{place}" "{state}" (permit OR notice)', "civic"],
  ["hidden_documents", 'site:{city_domain} filetype:pdf "{place}" "land use"', "real_estate"],
  ["businesses", '"{place}" ("now open" OR "grand opening")', "business"],
];

/** A query must name the place, its city, a ZIP or a local institution, or stay inside a confirmed site. */
export function isLocalQuery(kit: SearchKit, query: string, sites: Set<string>) {
  const names = [kit.place, kit.parent, ...kit.zips, ...kit.schools.map((school) => school.name), ...kit.institutions.map((item) => item.name), ...kit.venues];
  if (names.some((name) => mentions(query, name))) return true;
  return [...query.matchAll(/(?:^|\s)site:(\S+)/gi)].some(([, target]) => {
    const host = target.toLowerCase().replace(/^www\./, "").split("/")[0];
    return [...sites].some((site) => host === site || host.endsWith(`.${site}`));
  });
}

/** Stage 1 queries: every topic gets a guaranteed share of the budget, and general families use the rest. */
export function stage1Queries(kit: SearchKit, topics: PriorityTopic[], budget: number): PlannedQuery[] {
  const share = Math.max(2, Math.floor(budget / Math.max(1, topics.length + 1)));
  const planned: PlannedQuery[] = [];
  for (const topic of topics) {
    const filled = stage1(kit, topic).flatMap(([family, template, values]) => { const query = fill(kit, template, topic, values); return query ? [{ topic, family, query, stage: "stage1" as const }] : []; });
    planned.push(...filled.slice(0, share));
  }
  for (const [family, template, section] of GENERAL) {
    if (planned.length >= budget) break;
    const query = fill(kit, template, null);
    if (query) planned.push({ topic: null, family, query, stage: "stage1", section });
  }
  return planned;
}

/** Stage 2 queries for one topic, looking for new pages in the window. */
export function stage2Queries(kit: SearchKit, topic: PriorityTopic, after: string, budget = 4): PlannedQuery[] {
  return stage2(kit, topic, after).flatMap(([family, template, values]) => { const query = fill(kit, template, topic, values); return query ? [{ topic, family, query, stage: "stage2" as const }] : []; }).slice(0, budget);
}

export const TOPIC_SECTIONS: Record<PriorityTopic, "safety" | "obituaries" | "events" | "real_estate" | "sports"> = { crime: "safety", deaths: "obituaries", events: "events", home_sales: "real_estate", sports: "sports" };
export const TOPIC_KINDS: Record<PriorityTopic, string> = { crime: "news_report", deaths: "obituary", events: "event", home_sales: "home_sale", sports: "game_result" };

/** The priority topic an item or section belongs to, for coverage counts. */
export function topicOfItem(item: { kind?: unknown; section?: unknown }): PriorityTopic | null {
  const kind = String(item.kind ?? ""), section = String(item.section ?? "");
  if (["safety_incident", "court_case"].includes(kind) || section === "safety") return "crime";
  if (kind === "obituary" || section === "obituaries") return "deaths";
  if (kind === "event" || section === "events") return "events";
  if (["home_sale", "building_permit", "development", "housing_market"].includes(kind) || section === "real_estate") return "home_sales";
  if (["school_sports", "game_result"].includes(kind) || section === "sports") return "sports";
  return null;
}
