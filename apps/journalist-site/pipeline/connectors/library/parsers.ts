import { XMLParser, XMLValidator } from "fast-xml-parser";
import { Parser } from "htmlparser2";
import { cancelledTitle, checkCount, checkSize, FeedFormatError, httpsLink, plainText, rejectUnsafeXml, scheduleText, type EventFacts, type LocalMoment } from "../common";

export type Skipped = Record<string, number>;
export type ParsedEvents = { events: EventFacts[]; skipped: Skipped };
const count = (items: number) => checkCount(items);

function unescapeIcs(value: string) { return value.replace(/\\([\\;,nN])/g, (_whole, escaped: string) => /n/i.test(escaped) ? "\n" : escaped); }
function icalMoment(value: string, params: string): LocalMoment | null {
  if (value.length === 8 || (/VALUE=DATE/i.test(params) && !/DATE-TIME/i.test(params))) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    return m ? { year: +m[1], month: +m[2], day: +m[3] } : null;
  }
  if (value.endsWith("Z")) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  return m ? { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] } : null;
}
function unfold(lines: string[]) {
  const events: Array<Record<string, [string, string]>> = [];
  let current: Record<string, [string, string]> | null = null;
  for (const line of lines) {
    const colon = line.indexOf(":");
    const left = colon < 0 ? line : line.slice(0, colon), value = colon < 0 ? "" : line.slice(colon + 1);
    const semicolon = left.indexOf(";");
    const name = (semicolon < 0 ? left : left.slice(0, semicolon)).toUpperCase();
    const params = semicolon < 0 ? "" : left.slice(semicolon + 1);
    if (name === "BEGIN" && value.toUpperCase() === "VEVENT") current = {};
    else if (name === "END" && value.toUpperCase() === "VEVENT" && current) { events.push(current); current = null; }
    else if (current && !(name in current)) current[name] = [params, value];
  }
  return events;
}
export function parseIcal(content: Uint8Array): ParsedEvents {
  checkSize(content);
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch (error) { throw new FeedFormatError("iCalendar must be UTF-8", { cause: error }); }
  if (!source.replace(/^\uFEFF/, "").startsWith("BEGIN:VCALENDAR")) throw new FeedFormatError("Expected an iCalendar, not an HTML or error response");
  const lines = source.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const vevents = unfold(lines);
  count(vevents.length);
  const events: EventFacts[] = [], skipped: Skipped = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  for (const item of vevents) {
    const field = (name: string) => unescapeIcs(item[name]?.[1] ?? "").trim();
    if ("RRULE" in item || "RECURRENCE-ID" in item) { skip("recurring"); continue; }
    if (field("STATUS").toUpperCase() === "CANCELLED" || cancelledTitle(field("SUMMARY"))) { skip("cancelled"); continue; }
    if (!field("LOCATION")) { skip("no_venue"); continue; }
    const link = httpsLink(field("URL"));
    if (!link) { skip("no_link"); continue; }
    const startPair = item.DTSTART ?? ["", ""];
    const start = icalMoment(startPair[1], startPair[0]);
    if (!start) { skip("unsupported_time"); continue; }
    const endPair = item.DTEND;
    const end = endPair ? icalMoment(endPair[1], endPair[0]) : null;
    if (!field("SUMMARY") || !field("UID")) throw new FeedFormatError("Event is missing title or UID");
    const [venue, room] = field("LOCATION").split("\n", 2);
    events.push({ source_event_id: field("UID"), title: field("SUMMARY").split(/\s+/).join(" "), event_date: `${String(start.year).padStart(4,"0")}-${String(start.month).padStart(2,"0")}-${String(start.day).padStart(2,"0")}`,
      schedule_text: scheduleText(start, end), venue: venue.split(/\s+/).join(" "), room: room?.split(/\s+/).join(" ") || null, source_url: link, description: plainText(field("DESCRIPTION")) });
  }
  return { events, skipped };
}

type JsonObject = Record<string, unknown>;
class JsonLdParser {
  blocks: string[] = [];
  private capturing = false;
  private index = -1;
  parser = new Parser({
    onopentag: (name, attrs) => { if (name === "script" && (attrs.type ?? "").toLowerCase() === "application/ld+json") { this.capturing = true; this.blocks.push(""); this.index = this.blocks.length - 1; } },
    onclosetag: (name) => { if (name === "script") this.capturing = false; },
    ontext: (data) => { if (this.capturing) this.blocks[this.index] += data; },
  }, { decodeEntities: false });
}
export function jsonLdBlocks(html: string): unknown[] {
  const parser = new JsonLdParser(); parser.parser.write(html); parser.parser.end();
  const values: unknown[] = [];
  for (const block of parser.blocks) { try { values.push(JSON.parse(block)); } catch { /* malformed JSON-LD blocks are ignored */ } }
  return values;
}
export function findEvents(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(findEvents);
  if (!value || typeof value !== "object") return [];
  const node = value as JsonObject;
  const kinds = Array.isArray(node["@type"]) ? node["@type"] as unknown[] : [node["@type"]];
  if (kinds.some((kind) => typeof kind === "string" && kind.endsWith("Event"))) return [node];
  return findEvents(node["@graph"] ?? []);
}
function jsonLdMoment(value: unknown): LocalMoment | null {
  if (typeof value !== "string" || value.endsWith("Z")) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:[+-]\d{2}:?\d{2})?)?$/.exec(value);
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3], ...(m[4] ? { hour: +m[4], minute: +m[5] } : {}) };
}
function jsonLdVenue(value: unknown): string | null {
  if (Array.isArray(value)) value = value[0];
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || (value as JsonObject)["@type"] === "VirtualLocation") return null;
  const node = value as JsonObject, address = node.address;
  const street = address && typeof address === "object" ? (address as JsonObject).streetAddress : address;
  const parts = [node.name, street].filter((part): part is string => typeof part === "string").map((part) => part.trim());
  return [...new Set(parts.filter(Boolean))].join(", ") || null;
}
export function parseJsonLd(content: Uint8Array): ParsedEvents {
  checkSize(content);
  const nodes = jsonLdBlocks(new TextDecoder().decode(content)).flatMap(findEvents);
  count(nodes.length);
  if (!nodes.length) throw new FeedFormatError("Page has no schema.org Event JSON-LD");
  const events: EventFacts[] = [], skipped: Skipped = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  for (const node of nodes) {
    const title = node.name;
    const venue = jsonLdVenue(node.location);
    const link = httpsLink(typeof node.url === "string" ? node.url : null);
    const start = jsonLdMoment(node.startDate);
    if (/EventCancelled$/i.test(String(node.eventStatus ?? "")) || cancelledTitle(title)) { skip("cancelled"); continue; }
    if (!venue) { skip("no_venue"); continue; }
    if (!link) { skip("no_link"); continue; }
    if (!start) { skip("unsupported_time"); continue; }
    if (typeof title !== "string" || !title.trim()) throw new FeedFormatError("Event is missing a title");
    const end = jsonLdMoment(node.endDate);
    events.push({ source_event_id: String(node["@id"] ?? link), title: title.split(/\s+/).join(" "), event_date: `${String(start.year).padStart(4,"0")}-${String(start.month).padStart(2,"0")}-${String(start.day).padStart(2,"0")}`,
      schedule_text: scheduleText(start, end), venue: venue.split(/\s+/).join(" "), source_url: link, description: plainText(node.description) });
  }
  return { events, skipped };
}

class DescriptionParser {
  private line = "";
  schedule: string | null = null;
  venue: string | null = null;
  venueUrl: string | undefined;
  room: string | null = null;
  details: string[] = [];
  parser: Parser;
  constructor(html: string) {
    this.parser = new Parser({
      onopentag: (tag, attrs) => { if (tag === "br") this.finish(); else if (tag === "a" && this.line.trim().startsWith("Location Link:")) this.venueUrl = attrs.href; },
      ontext: (data) => { this.line += data; },
    }, { decodeEntities: true });
    this.parser.write(html); this.parser.end();
  }
  finish() {
    const line = this.line.split(/\s+/).filter(Boolean).join(" ");
    if (this.schedule === null) this.schedule = line;
    else if (line.startsWith("Location Link:")) this.venue = line.slice("Location Link:".length).trim() || null;
    else if (line.startsWith("Room Location:")) this.room = line.slice("Room Location:".length).trim() || null;
    else if (line) this.details.push(line);
    this.line = "";
  }
}
function textValue(value: unknown) { return typeof value === "string" ? value : value == null ? "" : String(value); }
function xmlItems(content: Uint8Array): JsonObject[] {
  rejectUnsafeXml(content);
  const source = new TextDecoder().decode(content);
  const validation = XMLValidator.validate(source);
  if (validation !== true) throw new FeedFormatError(`Invalid RSS XML: ${validation.err.msg}`);
  let root: JsonObject;
  try { root = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: false, processEntities: true }).parse(source) as JsonObject; }
  catch (error) { throw new FeedFormatError(`Invalid RSS XML: ${error instanceof Error ? error.message : String(error)}`); }
  const rss = root.rss as JsonObject | undefined;
  const channel = rss?.channel as JsonObject | undefined;
  if (!rss || !channel) throw new FeedFormatError("Expected an RSS channel, not an HTML or error response");
  const value = channel.item;
  return value == null ? [] : (Array.isArray(value) ? value : [value]).map((item) => item as JsonObject);
}
export function parseTrumba(content: Uint8Array): ParsedEvents {
  checkSize(content); rejectUnsafeXml(content);
  const items = xmlItems(content);
  count(items.length);
  const events: EventFacts[] = [], skipped: Skipped = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  for (const item of items) {
    const details = new DescriptionParser(textValue(item.description)); details.finish();
    if (cancelledTitle(textValue(item.title))) { skip("cancelled"); continue; }
    if (!details.venue) { skip("no_venue"); continue; }
    const title = textValue(item.title).trim(), id = textValue(item.guid).trim(), link = httpsLink(textValue(item.link));
    const dateString = textValue(item.category).split(" ")[0];
    const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(dateString);
    if (!match) throw new FeedFormatError("Event is missing a supported calendar date");
    if (!title || !id || !details.schedule) throw new FeedFormatError("Event is missing title, ID, or schedule");
    if (!link) throw new FeedFormatError("Event link must be an HTTPS URL");
    const year = +match[1], month = +match[2], day = +match[3];
    if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0,10) !== `${match[1]}-${match[2]}-${match[3]}`) throw new FeedFormatError("Event is missing a supported calendar date");
    events.push({ source_event_id: id, title, event_date: `${match[1]}-${match[2]}-${match[3]}`, schedule_text: details.schedule,
      venue: details.venue, venue_url: httpsLink(details.venueUrl), room: details.room, source_url: link, description: plainText(details.details.join("\n")) });
  }
  if (items.length > (skipped.cancelled ?? 0) && !events.length) throw new FeedFormatError("No event has explicit venue attribution; feed format changed?");
  return { events, skipped };
}
