/**
 * Wikidata Query Service lookups used to discover sources at run time: news outlets
 * published in or near a location, the state's school athletic association, and notable
 * nearby topics for trend watching. Only Wikidata's ontology classes appear here; no
 * place or outlet is named in code.
 */
import type { HttpTransport } from "../core/http";
import { publicApiGet } from "../connectors/public-api";

export const SPARQL = "https://query.wikidata.org/sparql";
type Binding = Record<string, { value: string } | undefined>;

export async function sparql(transport: HttpTransport, query: string): Promise<Binding[]> {
  const body = await publicApiGet(transport, `${SPARQL}?query=${encodeURIComponent(query)}`, "application/sparql-results+json", 4 * 1024 * 1024, 60_000);
  const data = JSON.parse(new TextDecoder().decode(body)) as { results?: { bindings?: Binding[] } };
  if (!Array.isArray(data.results?.bindings)) throw new Error("Wikidata returned no results table");
  return data.results.bindings;
}
const point = (latitude: number, longitude: number) => `"Point(${longitude.toFixed(4)} ${latitude.toFixed(4)})"^^geo:wktLiteral`;
const value = (binding: Binding, key: string) => binding[key]?.value ?? null;
function https(url: string | null) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    parsed.protocol = "https:";
    return parsed.toString();
  } catch { return null; }
}

export type Outlet = { name: string; website: string; place: string; wikidata: string };
/**
 * Newspapers, magazines and news sites whose place of publication lies within `radiusKm`,
 * nearest first. The radius search runs first (optimizer off): starting from all outlets,
 * or filtering places by class before the join, times out on the public endpoint.
 */
export function outletQuery(latitude: number, longitude: number, radiusKm: number) {
  return `SELECT ?outlet ?outletLabel ?website ?placeLabel (MIN(?dist) AS ?distance) WHERE {
  hint:Query hint:optimizer "None" .
  SERVICE wikibase:around { ?place wdt:P625 ?loc . bd:serviceParam wikibase:center ${point(latitude, longitude)} ; wikibase:radius "${radiusKm}" ; wikibase:distance ?dist . }
  ?outlet wdt:P291 ?place ; wdt:P856 ?website .
  FILTER NOT EXISTS { ?outlet wdt:P576 ?dissolved }
  FILTER EXISTS { ?outlet wdt:P31/wdt:P279* ?type . VALUES ?type { wd:Q11032 wd:Q1153191 wd:Q1193236 wd:Q41298 wd:Q2305295 } }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?outlet ?outletLabel ?website ?placeLabel ORDER BY ?distance LIMIT 60`;
}
export async function nearbyOutlets(transport: HttpTransport, latitude: number, longitude: number, radiusKm = 25): Promise<Outlet[]> {
  const seen = new Set<string>();
  return (await sparql(transport, outletQuery(latitude, longitude, radiusKm))).flatMap((row) => {
    const website = https(value(row, "website")), id = value(row, "outlet");
    if (!website || !id || seen.has(id)) return [];
    seen.add(id);
    return [{ name: value(row, "outletLabel") ?? website, website, place: value(row, "placeLabel") ?? "", wikidata: id }];
  });
}

export type Organisation = { name: string; website: string; wikidata: string };
const ATHLETICS = "(Interscholastic|School Activities Association|Activities Association|Athletic Association|High School [A-Za-z ]*Association|Scholastic [A-Za-z ]*Association)";
/** The state's school athletic association(s), by ISO 3166-2 code (e.g. US-OR). */
export function athleticsQuery(state: string) {
  return `SELECT DISTINCT ?org ?orgLabel ?website WHERE {
  ?state wdt:P300 "US-${state}" .
  { ?org wdt:P1001 ?state } UNION { ?org wdt:P131 ?state }
  ?org wdt:P856 ?website ; rdfs:label ?label .
  FILTER(LANG(?label) = "en" && REGEX(?label, "${ATHLETICS}", "i"))
  FILTER NOT EXISTS { ?org wdt:P576 ?dissolved }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 5`;
}
export async function athleticsAssociations(transport: HttpTransport, state: string): Promise<Organisation[]> {
  return (await sparql(transport, athleticsQuery(state))).flatMap((row) => {
    const website = https(value(row, "website")), id = value(row, "org");
    return website && id ? [{ name: value(row, "orgLabel") ?? website, website, wikidata: id }] : [];
  });
}

export type Topic = { article: string; about: string; place: string };
/** Notable places and institutions with an English Wikipedia article near the location. */
export function topicQuery(latitude: number, longitude: number, radiusKm: number) {
  return `SELECT ?item ?itemLabel ?description ?article ?links WHERE {
  SERVICE wikibase:around { ?item wdt:P625 ?loc . bd:serviceParam wikibase:center ${point(latitude, longitude)} ; wikibase:radius "${radiusKm}" . }
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  ?item wikibase:sitelinks ?links .
  FILTER NOT EXISTS { ?item wdt:P31 wd:Q5 }
  OPTIONAL { ?item schema:description ?description . FILTER(LANG(?description) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?links) LIMIT 15`;
}
export async function nearbyTopics(transport: HttpTransport, latitude: number, longitude: number, place: string, radiusKm = 15): Promise<Topic[]> {
  return (await sparql(transport, topicQuery(latitude, longitude, radiusKm))).flatMap((row) => {
    const url = value(row, "article");
    const article = url ? decodeURIComponent(url.replace(/^https:\/\/en\.wikipedia\.org\/wiki\//, "")) : null;
    if (!article || !/^[^\s#<>[\]{}|]{1,200}$/.test(article)) return [];
    return [{ article, about: value(row, "description") ?? value(row, "itemLabel") ?? article.replace(/_/g, " "), place }];
  });
}
