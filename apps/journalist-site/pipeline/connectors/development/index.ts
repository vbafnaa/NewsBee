/**
 * Development and construction permits from the city's Socrata open-data portal. Finds a
 * permits dataset through the Socrata catalog, then asks only for permits issued since the
 * edition's reporting period began (see reportingSince) within a radius of the location, and
 * drops permits an earlier published edition already ran. Only permit facts are read:
 * contractor, applicant and owner columns are never requested into facts, and single-family
 * addresses are withheld.
 */
import { httpsLink, plainText } from "../common";
import type { CollectedEvent, Connector, ConnectorContext, LocationProfile, SourceResult, SourceTask } from "../types";
import { publishedText } from "../wider/adapters";
import { fetchJson, hasPoint, label, isoDay, locationRegion, pointTier, publishedKeys, reportingSince, runCollector, skip, SourceUnavailable } from "../parents/shared";
import { websiteOrigin } from "../civiccalendar";

export const CATALOG = "https://api.us.socrata.com/api/catalog/v1";
export const CITY_RADIUS_M = 15000;
export const COMMUNITY_RADIUS_M = 3000;
export const MAX_ROWS = 400;
export const MAX_ITEMS = 8;
const KEEP = /\b(new|construct\w*|demoli\w*|demo|multi[- ]?family|apartments?|townhou\w*|mixed[- ]use|rezon\w*|subdivi\w*|plat|adu|accessory dwelling|school|park)\b/i;
const MINOR = /\b(alteration|alter|tenant improvement|repair|re-?roof|remodel|sign|mechanical|plumbing|electrical|side sewer|tree|fence|deck|solar|furnace|water heater|interior)\b/i;
const COMMERCIAL = /\b(commercial|industrial|institutional|mixed[- ]use|multi[- ]?family)\b/i;
const IDENT = /^[a-z][a-z0-9_]{0,63}$/;

export type Dataset = { id: string; name: string; permalink: string; columns: Array<{ field: string; type: string }> };
export type Columns = { point?: string; latitude?: string; longitude?: string; issued: string; description?: string; kind?: string[]; units?: string; cost?: string; address?: string; link?: string; id?: string };

/** data.{city}.gov, guessed from the city website host. */
export function portalDomain(location: LocationProfile): string | null {
  const origin = websiteOrigin(location);
  if (!origin) return null;
  const host = new URL(origin).hostname.replace(/^www\./, "");
  return /\.gov$/.test(host) ? `data.${host}` : null;
}
export function catalogUrl(domain: string) {
  return `${CATALOG}?q=permits&only=dataset&domains=${encodeURIComponent(domain)}&search_context=${encodeURIComponent(domain)}&limit=20`;
}

/** First column of `type` whose name matches the earliest pattern in `names`. */
const pick = (fields: Array<{ field: string; type: string }>, type: RegExp, ...names: RegExp[]) => {
  for (const name of names) { const found = fields.find((column) => type.test(column.type) && name.test(column.field) && IDENT.test(column.field)); if (found) return found.field; }
  return undefined;
};
const DATE = /calendar.?date|timestamp/i, NUMBER = /^number$/i, TEXT = /^text$/i;
export function mapColumns(dataset: Dataset): Columns | null {
  const fields = dataset.columns;
  const issued = pick(fields, DATE, /^issue(d)?_?date$/i, /issue/i);
  const point = pick(fields, /^(point|location)$/i, /^location1?$/i, /.*/);
  const latitude = pick(fields, NUMBER, /^lat(itude)?$/i);
  const longitude = pick(fields, NUMBER, /^(lon|lng|long|longitude)$/i);
  if (!issued || (!point && !(latitude && longitude))) return null;
  const kind = [/^permit_?type_?desc/i, /^permit_?class$/i, /^permit_?type$/i, /^work_?type$/i, /^permit_?type_?mapped$/i]
    .map((name) => pick(fields, TEXT, name)).filter((field): field is string => Boolean(field)).slice(0, 3);
  return {
    issued, point, latitude, longitude, kind,
    description: pick(fields, TEXT, /^description$/i, /desc/i),
    units: pick(fields, NUMBER, /^housing_?units_?added$/i, /units?_?(added|new|net)$/i, /^(added|new|net)_?units$/i),
    cost: pick(fields, NUMBER, /^est\w*cost$/i, /cost|valuation|value/i),
    address: pick(fields, TEXT, /^original_?address_?1$/i, /^address1?$/i),
    link: pick(fields, /^url$/i, /^link$/i, /url|link/i),
    id: pick(fields, TEXT, /^permit_?num(ber)?$/i, /^application_?number$/i),
  };
}
export function chooseDataset(results: Array<Record<string, any>>): { dataset: Dataset; columns: Columns } | null {
  const candidates = results.map((entry) => {
    const resource = entry.resource ?? {};
    const names: string[] = resource.columns_field_name ?? [], types: string[] = resource.columns_datatype ?? [];
    const dataset: Dataset = { id: String(resource.id ?? ""), name: String(resource.name ?? ""), permalink: String(entry.permalink ?? entry.link ?? ""), columns: names.map((field, index) => ({ field, type: String(types[index] ?? "") })) };
    return { dataset, columns: /^[a-z0-9]{4}-[a-z0-9]{4}$/.test(dataset.id) && /permit/i.test(dataset.name) ? mapColumns(dataset) : null };
  }).filter((candidate): candidate is { dataset: Dataset; columns: Columns } => Boolean(candidate.columns));
  candidates.sort((a, b) => Number(/building/i.test(b.dataset.name)) - Number(/building/i.test(a.dataset.name)));
  return candidates[0] ?? null;
}

export function permitsUrl(domain: string, dataset: Dataset, columns: Columns, latitude: number, longitude: number, meters: number, since: string) {
  const fields = [columns.issued, columns.point, columns.latitude, columns.longitude, columns.description, ...(columns.kind ?? []), columns.units, columns.cost, columns.address, columns.link, columns.id].filter((field): field is string => Boolean(field));
  const near = columns.point
    ? `within_circle(${columns.point}, ${latitude}, ${longitude}, ${meters})`
    : (() => { const dLat = meters / 111320, dLon = meters / (111320 * Math.cos(latitude * Math.PI / 180)); return `${columns.latitude} between ${(latitude - dLat).toFixed(5)} and ${(latitude + dLat).toFixed(5)} AND ${columns.longitude} between ${(longitude - dLon).toFixed(5)} and ${(longitude + dLon).toFixed(5)}`; })();
  const query = new URLSearchParams({ $select: [...new Set(fields)].join(","), $where: `${near} AND ${columns.issued} >= '${since}'`, $order: `${columns.issued} DESC`, $limit: String(MAX_ROWS) });
  return `https://${domain}/resource/${dataset.id}.json?${query.toString()}`;
}

export const developmentConnector: Connector = {
  type: "development",
  sources(location) {
    const domain = portalDomain(location);
    return domain && typeof location.latitude === "number" && typeof location.longitude === "number" ? [{ source_id: `development:${domain}`, name: `Building permits (${domain})`, type: "development" }] : [];
  },
  collect(task, context) { return runCollector(task, context, (record) => collectPermits(task, context, record)); },
};

const text = (row: Record<string, unknown>, field?: string) => field && typeof row[field] === "string" ? (row[field] as string).trim() : "";
const number = (row: Record<string, unknown>, field?: string) => { const value = field ? Number(row[field]) : NaN; return Number.isFinite(value) ? value : 0; };
function coordinates(row: Record<string, any>, columns: Columns): [number, number] | null {
  const point = columns.point ? row[columns.point] : null;
  if (point?.coordinates?.length === 2) return [Number(point.coordinates[1]), Number(point.coordinates[0])];
  if (point && point.latitude !== undefined) return [Number(point.latitude), Number(point.longitude)];
  const latitude = number(row, columns.latitude), longitude = number(row, columns.longitude);
  return latitude && longitude ? [latitude, longitude] : null;
}

async function collectPermits(task: SourceTask, context: ConnectorContext, record: SourceResult): Promise<CollectedEvent[]> {
  const domain = portalDomain(context.location);
  const region = await locationRegion(context);
  if (!domain || !hasPoint(region)) throw new SourceUnavailable("no_feed", "Location has no open-data portal or coordinates");
  record.website = `https://${domain}`;
  const catalog = await fetchJson<{ results?: Array<Record<string, any>> }>(context, catalogUrl(domain));
  const found = chooseDataset(catalog.results ?? []);
  if (!found) throw new SourceUnavailable("no_feed", `No mappable permits dataset on ${domain}`);
  const { dataset, columns } = found;
  const since = await reportingSince(context);
  const published = await publishedKeys(context, task.source_id);
  const meters = context.location.community ? COMMUNITY_RADIUS_M : CITY_RADIUS_M;
  const url = permitsUrl(domain, dataset, columns, region.latitude, region.longitude, meters, since);
  record.feed_kind = "socrata_permits"; record.feed_url = url;
  const rows = await fetchJson<Array<Record<string, any>>>(context, url);
  if (!Array.isArray(rows)) throw new SourceUnavailable("failed", "Socrata did not return a list of permits");
  const events: CollectedEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const issued = isoDay(row[columns.issued]);
    if (!issued || issued < since || issued > context.today) { record.skipped_outside_window += 1; continue; }
    const point = coordinates(row, columns);
    const place = point ? pointTier(region, point[0], point[1], meters / 1000, meters / 1000) : null;
    if (!place) { skip(record, "outside_area"); continue; }
    const description = plainText(text(row, columns.description), 400) ?? "";
    const kinds = (columns.kind ?? []).map((field) => text(row, field)).filter(Boolean);
    const units = number(row, columns.units);
    const all = [description, ...kinds].join(" ");
    if (units < 2 && (!KEEP.test(all) || MINOR.test(kinds.join(" ")))) { skip(record, "minor_permit"); continue; }
    const key = text(row, columns.id) || `${issued}:${point?.join(",")}:${description.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (published.has(`${dataset.id}:${key}`)) { skip(record, "already_published"); continue; }
    events.push(permitFacts(row, columns, dataset, { issued, units, description, kinds, distance_km: place.distance_km, key }, region.town, domain));
  }
  events.sort((a, b) => Number((b.signals as any).units) - Number((a.signals as any).units) || Number((b.signals as any).cost) - Number((a.signals as any).cost) || String(b.event_date).localeCompare(String(a.event_date)));
  const kept = events.slice(0, MAX_ITEMS);
  skip(record, "item_limit", events.length - kept.length);
  record.detail = `${dataset.name} (${dataset.id}): ${rows.length} permits issued within ${meters / 1000} km since ${since}, ${events.length} new construction or multi-unit, ${kept.length} kept`;
  return kept;
}

export function permitFacts(row: Record<string, any>, columns: Columns, dataset: Dataset, facts: { issued: string; units: number; description: string; kinds: string[]; distance_km: number; key: string }, town: string, domain: string): CollectedEvent {
  const cost = number(row, columns.cost);
  const kindText = facts.kinds.join(" ");
  const showAddress = facts.units >= 2 || COMMERCIAL.test(kindText);
  const address = showAddress ? label(text(row, columns.address)) : null;
  const demolition = /demoli/i.test(`${kindText} ${facts.description}`) && !/\bnew\b/i.test(kindText);
  const what = demolition ? "a demolition" : facts.units >= 2 ? `${facts.units} new homes` : "new construction";
  const where = address ? ` at ${address}` : "";
  const title = `Permit issued for ${what}${where}`;
  let description = `${town}'s permit records show a ${facts.kinds[0]?.toLowerCase() || "building"} permit issued on ${publishedText(facts.issued)}`;
  description += facts.description ? `: ${facts.description.replace(/\.?$/, ".")}` : ".";
  if (cost >= 1000) description += ` The estimated project cost is $${Math.round(cost).toLocaleString("en-US")}.`;
  if (!address) description += " The exact address is withheld for single-family projects.";
  const link = httpsLink(typeof row[columns.link ?? ""] === "object" ? row[columns.link ?? ""]?.url : text(row, columns.link)) ?? httpsLink(dataset.permalink) ?? `https://${domain}/d/${dataset.id}`;
  return {
    source_event_id: `${dataset.id}:${facts.key}`, title, event_date: facts.issued, schedule_text: publishedText(facts.issued),
    venue: `${town} permit records`, room: null, source_url: link, description, kind: "development", tier: "local", section: `Building in ${town}`,
    signals: { units: demolition ? 0 : facts.units, distance_km: facts.distance_km, cost },
  };
}
