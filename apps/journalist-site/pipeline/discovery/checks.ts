/**
 * The page checks of Pipeline 1 discovery, in four groups:
 *
 *   Safety    Never open private addresses, and follow crawl delays. Always on, in code
 *             (connectors/public-http.ts, connectors/fetcher.ts).
 *   Quality   Reject known repost and aggregator sites, and pages clearly about another place.
 *             Always on in discovery: the run's guardrails don't switch it off.
 *   Access    Robots, AI opt-outs, `noai` and `nosnippet` tags, terms, and the never-read list
 *             (DO_NOT_SCRAPE). The Access setting: Respect follows them, Relaxed skips the ones
 *             ticked (none ticked means all), and Relaxed is local only. In code.
 *   Evidence  Locality and freshness facts. Not a pass-or-fail rule: code decides only the clear
 *             cases, marks the rest unclear, and keeps every fact for the model check.
 *
 * Quality and Evidence are named in the playbook (`general.reject.quality_checks`,
 * `general.evidence.evidence_facts`). Until the shared Model check decides unclear cases, they
 * keep today's outcome: a page with no evidence it is local is rejected, and a page with few or no
 * dates is kept as a link.
 */
import { mentions } from "../connectors/community";
import { censusGeocoder, extractAddresses, townName, type Geocoder } from "../connectors/locality";
import type { Fetcher } from "../connectors/fetcher";
import type { LocationProfile } from "../connectors/types";
import { ACCESS_RULES } from "../core/run-values";
import { limit, list } from "../playbook";
import type { SourceScope } from "../sourcemap/store";
import { withinArea } from "../../../../shared/geography";
import type { Db } from "mongodb";
import type { Endpoint, Inspection } from "./inspect";

export const CHECK_GROUPS = {
  safety: { label: "Safety", rules: ["private_addresses", "crawl_delay"], switchable: "never" },
  quality: { label: "Quality", rules: list("general.reject.quality_checks"), switchable: "never in Pipeline 1 discovery" },
  access: { label: "Access", rules: [...ACCESS_RULES], switchable: "the Access setting: Respect follows them, Relaxed skips them (local only)" },
  evidence: { label: "Evidence", rules: list("general.evidence.evidence_facts"), switchable: "not a pass-or-fail rule" },
} as const;
export type CheckGroup = keyof typeof CHECK_GROUPS;

const ADDRESSES_CHECKED = limit("general.evidence.addresses_checked");

/** A clear pass, a clear fail, or unclear: for the model check to decide. */
export type CheckOutcome = "pass" | "fail" | "unclear";
export type NameFact = { name: string; level: "place" | "city" | "county"; where: Array<"title" | "text" | "address"> };
export type AddressFact = { address: string; inside: boolean | null };
export type LocalityFacts = {
  outcome: CheckOutcome; reason: string; names: NameFact[]; official_site: boolean; found_by_location: boolean; scope: SourceScope | null;
  addresses: AddressFact[];
  /** Another nearby place the title names, when the page names none of ours. */
  other_place: string | null;
};
export type DateSource = "markup" | "text" | "feed" | "last_modified" | "sitemap";
export type DateFact = { source: DateSource; latest: string | null; count: number };
export type FreshnessFacts = { outcome: CheckOutcome; reason: string; latest: string | null; upcoming: string | null; dates: DateFact[] };
/** What the checks saw on one page, saved on the candidate and in the decision log. */
export type PageChecks = { locality: LocalityFacts; freshness: FreshnessFacts };

/** Where each of the place's names appears: the title, the text, or an address line. */
export function nameFacts(names: Array<{ name: string; level: NameFact["level"] }>, title: string, text: string): NameFact[] {
  const addressLines = extractAddresses(text, 10).map((address) => {
    const at = text.indexOf(address);
    return at < 0 ? address : text.slice(at, at + address.length + 80);
  });
  const seen = new Set<string>();
  return names.flatMap(({ name, level }) => {
    if (!name || seen.has(name.toLowerCase())) return [];
    seen.add(name.toLowerCase());
    const where: NameFact["where"] = [];
    if (mentions(title, name)) where.push("title");
    if (mentions(text, name)) where.push("text");
    if (addressLines.some((line) => mentions(line, name))) where.push("address");
    return where.length ? [{ name, level, where }] : [];
  });
}

/** A nearby place the title names instead of ours: the page is clearly about somewhere else. */
export function otherPlace(title: string, ours: string[], nearby: string[]) {
  const mine = ours.filter(Boolean).map((name) => name.toLowerCase());
  if (mine.some((name) => mentions(title, name))) return null;
  return nearby.find((name) => {
    const lower = name.toLowerCase();
    return lower.length >= 4 && !mine.some((own) => own.includes(lower) || lower.includes(own)) && mentions(title, name);
  }) ?? null;
}

/** Up to the playbook's number of the page's addresses, checked against the area (or the town, with no boundary). */
export async function addressFacts(location: LocationProfile, fetcher: Fetcher, db: Db, text: string, geocoder: Geocoder = censusGeocoder(fetcher, db)): Promise<AddressFact[]> {
  const town = townName(location);
  const lat = location.community?.latitude ?? location.latitude, lon = location.community?.longitude ?? location.longitude;
  const center = typeof lat === "number" && typeof lon === "number" ? [lon, lat] as [number, number] : null;
  const area = location.community?.geography?.area ?? null;
  const out: AddressFact[] = [];
  for (const address of extractAddresses(text, ADDRESSES_CHECKED)) {
    const query = /,\s*[A-Z]{2}\b/.test(address) ? address : `${address}, ${town}, ${location.state}`;
    const match = await geocoder.geocode(query).catch(() => null);
    const inside = !match ? null : area && center ? withinArea(area, center, match.point) : match.city ? match.city.toLowerCase() === town.toLowerCase() && (!match.state || match.state === location.state) : null;
    out.push({ address: match?.matched || address, inside });
  }
  return out;
}

/**
 * Locality: a clear pass when the page names the place, its city or (first-party) its county, sits
 * on the city's confirmed site, is an institution found by location, or lists an address inside the
 * area. A clear fail when it is clearly about another place: its title names a nearby place instead
 * of ours, or every address it lists is outside the area. Anything else is unclear.
 */
export function localityFacts(input: { scope: SourceScope | null; names: NameFact[]; officialSite: boolean; foundByLocation: boolean; addresses: AddressFact[]; otherPlace: string | null; place: string }): LocalityFacts {
  const { scope, names, addresses } = input;
  const base = { names, official_site: input.officialSite, found_by_location: input.foundByLocation, scope, addresses, other_place: input.otherPlace };
  const inside = addresses.find((item) => item.inside);
  if (scope) {
    const reason = names.length ? `names ${names[0].name}` : input.officialSite ? "on the city's confirmed site" : inside ? `lists an address inside the area (${inside.address})` : input.foundByLocation ? "an institution found by location" : `serves this place (${scope})`;
    return { outcome: "pass", reason, ...base };
  }
  if (input.otherPlace) return { outcome: "fail", reason: `clearly about ${input.otherPlace}, not ${input.place}`, ...base };
  const checked = addresses.filter((item) => item.inside !== null);
  if (checked.length && checked.every((item) => item.inside === false)) return { outcome: "fail", reason: `every address it lists is outside ${input.place}`, ...base };
  return { outcome: "unclear", reason: `no evidence it concerns ${input.place}`, ...base };
}

/** A server date header as a day, when it is one. */
export function headerDay(value: string | undefined) {
  const stamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : null;
}

/**
 * Freshness: a clear pass when the page has something current or upcoming, and a clear fail when it
 * has plenty of dates and all are old. A page with few or no dates, or a lookup, is unclear. Only
 * the page's own dates and a working feed decide; the server's Last-Modified and the sitemap's
 * lastmod are kept as facts, because many servers stamp every page with today.
 */
export function freshnessFacts(inspection: Inspection, endpoint: Endpoint | null, headers: Record<string, string>, sitemapDay: string | null | undefined, staleMinDates: number): FreshnessFacts {
  const latestOf = (days: string[]) => [...days].sort().at(-1) ?? null;
  const modified = headerDay(headers["last-modified"]);
  const dates = ([
    { source: "markup", latest: latestOf(inspection.dates.markup), count: inspection.dates.markup.length },
    { source: "text", latest: latestOf(inspection.dates.text), count: inspection.dates.text.length },
    ...(endpoint ? [{ source: "feed" as const, latest: endpoint.latest, count: endpoint.items }] : []),
    ...(modified ? [{ source: "last_modified" as const, latest: modified, count: 1 }] : []),
    ...(sitemapDay ? [{ source: "sitemap" as const, latest: sitemapDay, count: 1 }] : []),
  ] satisfies DateFact[]).filter((item) => item.count > 0);
  const base = { latest: inspection.latest, upcoming: inspection.upcoming, dates };
  if (inspection.fresh) return { outcome: "pass", reason: inspection.upcoming ? `something upcoming on ${inspection.upcoming}` : `latest dated item ${inspection.latest}`, ...base };
  if (inspection.kind !== "lookup" && inspection.dated >= staleMinDates) return { outcome: "fail", reason: inspection.latest ? `nothing newer than ${inspection.latest}` : "no dated items", ...base };
  return { outcome: "unclear", reason: inspection.kind === "lookup" ? "a lookup or dashboard" : inspection.dated ? `only ${inspection.dated} dates, all old` : "no dates found", ...base };
}
