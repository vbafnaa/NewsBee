import { cancelledTitle, checkCount, FeedFormatError, plainText, scheduleText, type EventFacts, type LocalMoment } from "../common";

export const GATEWAY = "https://gateway.bibliocommons.com/v2/libraries/{slug}";
export const PAGE_LIMIT = 100;
export const MAX_PAGES = 5;
export const REQUEST_INTERVAL_SECONDS = 1;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG_PATTERNS = [
  /bibliocommons\.com(?:\\?\/)v2(?:\\?\/)libraries(?:\\?\/)([a-z0-9-]{1,40})/gi,
  /(?:\\?\/){2}([a-z0-9-]{1,40})\.bibliocommons\.com/gi,
];
const SHARED_HOSTS = /gateway|static|cdn|help|support|^www$|^api$/i;

type Json = Record<string, any>;
function readJson(content: Uint8Array): Json {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)); }
  catch (error) { throw new FeedFormatError("BiblioCommons response is not JSON", { cause: error }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FeedFormatError("BiblioCommons response is not a JSON object");
  return value as Json;
}
export function findSlug(html: string): string | null {
  const counts = new Map<string, number>();
  for (const pattern of SLUG_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of html.matchAll(pattern)) {
      const slug = match[1].toLowerCase();
      if (!SHARED_HOSTS.test(slug)) counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || (ranked.length > 1 && ranked[0][1] === ranked[1][1])) return null;
  return ranked[0][0];
}
export function eventCount(content: Uint8Array) { return Number(readJson(content).events?.pagination?.count ?? 0) || 0; }
export function locations(content: Uint8Array): Record<string, string> {
  const all = readJson(content).entities?.locations ?? {};
  const result: Record<string, string> = {};
  for (const [id, location] of Object.entries(all) as Array<[string, Json]>) {
    if (!SAFE_ID.test(id) || location.isHidden) continue;
    const address = location.address ?? {};
    const street = [address.number, address.street].filter(Boolean).join(" ");
    result[id] = [location.name, street, address.city].filter((part) => typeof part === "string" && part.trim()).map((part) => String(part).trim()).join(", ");
  }
  return result;
}
function moment(value: unknown): LocalMoment | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  return match ? { year: +match[1], month: +match[2], day: +match[3], hour: +match[4], minute: +match[5] } : null;
}
export function parse(content: Uint8Array, slug: string, venues: Record<string, string>): { events: EventFacts[]; skipped: Record<string, number> } {
  const data = readJson(content), listing = data.events ?? {}, order: unknown[] = listing.results ?? [];
  if (Number(listing.pagination?.count ?? 0) && !order.length) throw new FeedFormatError("BiblioCommons reported events but listed none (format change?)");
  const entities = data.entities?.events ?? {};
  checkCount(order.length);
  const events: EventFacts[] = [], skipped: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  for (const rawId of order) {
    const id = String(rawId), entry = entities[id] ?? {}, definition = entry.definition ?? {};
    if (!SAFE_ID.test(id) || !definition.title) throw new FeedFormatError("Event is missing an id or title");
    if (definition.isCancelled || cancelledTitle(definition.title)) { skip("cancelled"); continue; }
    const venue = venues[String(definition.branchLocationId)];
    if (venue === undefined) { skip("no_venue"); continue; }
    const start = moment(definition.start);
    if (!start) { skip("unsupported_time"); continue; }
    const end = moment(definition.end);
    const title = String(definition.title).split(/\s+/).filter(Boolean).join(" ");
    events.push({ source_event_id: id, title, event_date: `${String(start.year).padStart(4,"0")}-${String(start.month).padStart(2,"0")}-${String(start.day).padStart(2,"0")}`,
      schedule_text: scheduleText(start, end), venue, source_url: `https://${slug}.bibliocommons.com/events/${id}`, description: plainText(definition.description) });
  }
  return { events, skipped };
}

export async function fetchEvents(
  get: (url: string) => Promise<Uint8Array>, slug: string, window: [string, string], wanted: (venue: string) => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const base = GATEWAY.replace("{slug}", slug);
  const every = locations(await get(`${base}/locations?limit=${PAGE_LIMIT}`));
  const venues = Object.fromEntries(Object.entries(every).filter(([, venue]) => wanted(venue)));
  const detail = `bibliocommons feed (${Object.keys(venues).length} of ${Object.keys(every).length} locations in town)`;
  if (!Object.keys(venues).length) return { events: [] as EventFacts[], skipped: {} as Record<string, number>, response: new Uint8Array(), detail };
  const events: EventFacts[] = [], skipped: Record<string, number> = {}, raw: Uint8Array[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    await sleep(REQUEST_INTERVAL_SECONDS * 1000);
    const url = `${base}/events/search?startDate=${window[0]}&endDate=${window[1]}&locations=${Object.keys(venues).sort().join(",")}&limit=${PAGE_LIMIT}&page=${page}`;
    const content = await get(url); raw.push(content);
    const pagination = readJson(content).events?.pagination ?? {};
    checkCount(Number(pagination.count ?? 0));
    const parsed = parse(content, slug, venues);
    events.push(...parsed.events);
    for (const [reason, amount] of Object.entries(parsed.skipped)) skipped[reason] = (skipped[reason] ?? 0) + amount;
    if (page >= Number(pagination.pages ?? 1)) break;
  }
  const size = raw.reduce((sum, item) => sum + item.length, 0) + Math.max(0, raw.length - 1);
  const response = new Uint8Array(size);
  let offset = 0;
  raw.forEach((item, index) => { if (index) response[offset++] = 10; response.set(item, offset); offset += item.length; });
  return { events, skipped, response, detail };
}
