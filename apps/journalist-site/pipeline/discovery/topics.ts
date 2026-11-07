/**
 * Query generation for operator search. Priority topics are the main input: each enabled
 * topic has query families for Stage 1 (lasting sources) and Stage 2 (new pages in the
 * window), with a guaranteed share of the query budget. General families use what is left.
 *
 * The search kit is built from location data, and grows as discovery finds things: a school
 * on the map creates athletics and PTA queries, a funeral home creates obituary queries, a county
 * creates assessor and sheriff queries. A template whose placeholder has no value is skipped.
 *
 * A neighbourhood's best sources often never name it: the city's police, the county assessor.
 * So a topic can search by the city as well as the place, but every query stays tied to the
 * community: results about a whole county, state or region cost money and rarely concern it.
 * The state appears only to tell apart places with the same name. The query patterns are in the
 * playbook, under each category's search playbook, in the order they run.
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
import { CATEGORIES_IN_PLAYBOOK, limit, queriesFor, regex, ruleSet, type Rule } from "../playbook";
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

const SCHOOL_NAME = regex("schools.page.kit_school_name");

export async function buildSearchKit(context: { db: Db; transport: HttpTransport; location: LocationProfile; today: string; settings: unknown; log: unknown; fetcher: unknown }): Promise<SearchKit> {
  const { location, db } = context;
  const facts = await areaFacts(context as unknown as ConnectorContext).catch(() => null);
  const records = await sourceMap(db).find({ location_id: location.id, status: { $ne: "rejected" } }, { projection: { name: 1, url: 1, section: 1, found_by: 1, topics: 1, source_tier: 1 } }).toArray();
  const hostsIn = (test: (record: typeof records[number]) => boolean) => [...new Set(records.filter(test).map((record) => hostOf(record.url)).filter(Boolean))];
  const institutions = await localInstitutions({ db, transport: context.transport, location }).catch(() => [] as Institution[]);
  const onMapSchools = records.filter((record) => record.section === "schools" && SCHOOL_NAME.test(record.name)).map((record) => ({ name: record.name.split(/[:(]/)[0].trim(), host: hostOf(record.url) || null }));
  const nearbySchools = institutions.filter((item) => item.kind === "school").map((item) => ({ name: item.name, host: hostOf(item.website) || null }));
  const schools = [...nearbySchools, ...onMapSchools].filter((school, index, all) => all.findIndex((other) => other.name === school.name) === index).slice(0, limit("general.stop.kit_schools"));
  // Search only inside a site that has been checked as the city's own.
  const citySite = await verifiedCitySite(context as unknown as Parameters<typeof verifiedCitySite>[0]).catch(() => null);
  const names = location.community ? { place: location.community.name, parent: location.community.parent_name } : { place: townName(location), parent: null };
  return {
    ...names, state: US_STATES[location.state] ?? location.state, stateCode: location.state, county: facts?.county?.replace(/\s+County$/i, "") ?? null,
    cityDomain: citySite?.host ?? null, zips: await postcode(context.transport, location), schools, institutions,
    venues: records.filter((record) => record.section === "events").slice(0, limit("general.stop.kit_venues")).map((record) => record.name.split(/[:(]/)[0].trim()),
    agencyHosts: hostsIn((record) => record.section === "safety" || record.topics?.includes("crime") === true),
    funeralHosts: hostsIn((record) => record.section === "obituaries" || record.topics?.includes("deaths") === true),
    schoolHosts: hostsIn((record) => record.section === "schools"),
    teamHosts: hostsIn((record) => record.topics?.includes("sports") === true && record.section === "sports"),
    savedHosts: hostsIn((record) => record.source_tier === "official" || record.source_tier === "organisation"),
    associationHost: hostsIn((record) => record.found_by.method === "athletics")[0] ?? null,
  };
}

export type PlannedQuery = { topic: PriorityTopic | null; family: string; query: string; stage: "stage1" | "stage2"; section?: SectionId };

const EXCLUSIONS = ruleSet("search_exclusions");
/** Sites to leave out: aggregators and platforms we never read. */
function exclusions(topic: PriorityTopic | null) {
  const list = EXCLUSIONS.find((rule) => rule.topic === topic && topic !== null) ?? EXCLUSIONS.find((rule) => rule.category === "general")!;
  return list.values!.map((site) => `-site:${site}`).join(" ");
}
export const NEVER_READ = [...DO_NOT_SCRAPE, ...AGGREGATORS];

function fill(kit: SearchKit, template: string, topic: PriorityTopic | null, values: Record<string, string> = {}) {
  const lookup: Record<string, string | null> = { place: kit.place, parent: kit.parent, city: kit.parent ?? kit.place, state: kit.state, county: kit.county, city_domain: kit.cityDomain, zip: kit.zips[0] ?? null, ...values };
  let missing = false;
  const query = template.replace(/\{(\w+)\}/g, (_, name: string) => { const value = lookup[name]; if (!value) missing = true; return value ?? ""; });
  return missing ? null : `${query} ${exclusions(topic)}`.trim();
}

type Planned = [string, string, Record<string, string>?];
const family = (rule: Rule) => rule.id.split(".").pop()!;
const categoryOf = (topic: PriorityTopic) => CATEGORIES_IN_PLAYBOOK.find((category) => category.topic === topic)!.id;

/** One value set per row a `for_each` query makes. */
function rows(kit: SearchKit, each: NonNullable<Rule["for_each"]>): Array<Record<string, string>> {
  const hosts = (list: string[]) => list.slice(0, each.limit).map((host) => ({ host }));
  switch (each.list) {
    case "institutions": return kit.institutions.filter((item) => each.kinds!.includes(item.kind) && !item.website).slice(0, each.limit).map((item) => ({ name: item.name }));
    case "venues": return kit.venues.slice(0, each.limit).map((venue) => ({ venue }));
    case "schools": return kit.schools.slice(0, each.limit).map((school) => ({ school: school.name }));
    case "school_hosts": return hosts(kit.schoolHosts);
    case "agency_hosts": return hosts(kit.agencyHosts);
    case "funeral_hosts": return hosts(kit.funeralHosts);
    case "team_hosts": return hosts(kit.teamHosts);
    case "association_school": return kit.associationHost && kit.schools[0] ? [{ association: kit.associationHost, school: kit.schools[0].name }] : [];
    default: throw new Error(`Unknown query list: ${each.list}`);
  }
}

function queryRows(kit: SearchKit, topic: PriorityTopic, stage: "stage1" | "stage2", extra: Record<string, string> = {}): Planned[] {
  return queriesFor(stage, categoryOf(topic)).flatMap((rule): Planned[] => rule.for_each ? rows(kit, rule.for_each).map((values) => [family(rule), rule.pattern!, { ...values, ...extra }]) : [[family(rule), rule.pattern!, extra]]);
}

const GENERAL = queriesFor("general").sort((a, b) => a.order! - b.order!).map((rule): [string, string, SectionId] => [family(rule), rule.pattern!, rule.category as SectionId]);

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
  const share = Math.max(limit("general.stop.min_topic_share"), Math.floor(budget / Math.max(1, topics.length + 1)));
  const shares = topics.map((topic) => queryRows(kit, topic, "stage1").flatMap(([family, template, values]) => { const query = fill(kit, template, topic, values); return query ? [{ topic, family, query, stage: "stage1" as const }] : []; }).slice(0, share));
  // Taken in turn, so running out of time costs every topic a query, not the last topics all of theirs.
  const planned: PlannedQuery[] = [];
  for (let turn = 0; turn < share; turn += 1) for (const filled of shares) if (filled[turn]) planned.push(filled[turn]);
  for (const [family, template, section] of GENERAL) {
    if (planned.length >= budget) break;
    const query = fill(kit, template, null);
    if (query) planned.push({ topic: null, family, query, stage: "stage1", section });
  }
  return planned;
}

/** Stage 2 queries for one topic, looking for new pages in the window. */
export function stage2Queries(kit: SearchKit, topic: PriorityTopic, after: string, budget = limit("general.stop.stage2_queries")): PlannedQuery[] {
  return queryRows(kit, topic, "stage2", { after }).flatMap(([family, template, values]) => { const query = fill(kit, template, topic, values); return query ? [{ topic, family, query, stage: "stage2" as const }] : []; }).slice(0, budget);
}

export const TOPIC_SECTIONS = Object.fromEntries(CATEGORIES_IN_PLAYBOOK.filter((category) => category.topic).map((category) => [category.topic, category.id])) as Record<PriorityTopic, SectionId>;
export const TOPIC_KINDS = Object.fromEntries(ruleSet("item_kinds").map((rule) => [rule.topic, rule.value])) as Record<PriorityTopic, string>;

/** The priority topic an item or section belongs to, for coverage counts. */
export function topicOfItem(item: { kind?: unknown; section?: unknown }): PriorityTopic | null {
  const kind = String(item.kind ?? ""), section = String(item.section ?? "");
  if (["safety_incident", "court_case"].includes(kind) || section === "safety") return "crime";
  if (kind === "obituary" || section === "obituaries") return "deaths";
  if (kind === "event" || section === "events") return "events";
  if (["home_sale", "building_permit", "development", "housing_market"].includes(kind) || section === "real_estate") return "home_sales";
  if (["school_sports", "game_result"].includes(kind) || section === "sports") return "sports";
  if (["meeting_preview", "meeting_outcome", "public_record"].includes(kind) || section === "civic") return "government";
  if (section === "schools") return "schools";
  if (section === "business") return "business";
  if (section === "community") return "community";
  if (section === "news") return "news";
  return null;
}
