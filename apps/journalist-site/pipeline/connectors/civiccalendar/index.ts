/**
 * City and parks calendars (CivicPlus). Reads the category list on the city's /Calendar.aspx,
 * then each community or parks category's iCalendar feed. Meeting categories are skipped
 * because the meetings connector already covers them.
 */
import { cancelledTitle, httpsLink, isoDate, plainText, scheduleText } from "../common";
import { icalMoment, unescapeIcs, unfold } from "../library/parsers";
import type { Connector, ConnectorContext, LocationProfile, SourceResult, SourceTask } from "../types";
import type { Region } from "../wider/regions";
import { decode, fetchBytes, label, locationRegion, placeTier, runCollector, skip, SourceUnavailable, type Tier } from "../parents/shared";
import { FAMILY } from "../../ranking/parents";

export const MAX_CATEGORIES = 6;
const ACCEPT_HTML = "text/html, application/xhtml+xml";
const ACCEPT_ICS = "text/calendar, text/plain";
export const MEETING_CATEGORY = /\b(councils?|boards?|commissions?|committees?|hearings?|meetings?|agendas?|planning|courts?|budget|advisory|task force|staff)\b/i;
const CATEGORY = /<label[^>]*for="chkCalendarID_(\d+)"[^>]*>[\s\S]*?<input[^>]*>\s*([^<]+?)\s*<\/label>/gi;
const VIRTUAL = /\b(virtual|online only|zoom|webinar|teams meeting)\b/i;
const CITY_STATE_ZIP = /([A-Za-z][A-Za-z .'-]*?)\s*,?\s+([A-Z]{2})\s+\d{5}(?:-\d{4})?\s*$/;

export function websiteOrigin(location: LocationProfile): string | null {
  const site = httpsLink(location.government?.website ?? null);
  return site ? new URL(site).origin : null;
}

export const civicCalendarConnector: Connector = {
  type: "civiccalendar",
  sources(location) {
    const origin = websiteOrigin(location);
    return origin ? [{ source_id: `civiccalendar:${new URL(origin).host}`, name: `${location.name.split(",")[0]} city calendar`, type: "civiccalendar" }] : [];
  },
  collect(task, context) { return runCollector(task, context, (record) => collectCalendar(task, context, record)); },
};

export type Category = { id: string; name: string };
export function parseCategories(html: string): Category[] {
  const seen = new Set<string>();
  return [...html.matchAll(CATEGORY)].map((match) => ({ id: match[1], name: label(match[2], 80) ?? "" }))
    .filter((category) => category.name && !seen.has(category.id) && seen.add(category.id));
}
export function icsUrl(origin: string, id: string) { return `${origin}/common/modules/iCalendar/iCalendar.aspx?catID=${id}&feed=calendar`; }

async function collectCalendar(task: SourceTask, context: ConnectorContext, record: SourceResult) {
  const origin = websiteOrigin(context.location);
  if (!origin) throw new SourceUnavailable("no_feed", "Location has no city website");
  const page = `${origin}/Calendar.aspx`;
  record.website = origin; record.pages_checked = [page]; record.feed_kind = "civicplus_ical";
  let html: string;
  try { html = decode(await fetchBytes(context, page, ACCEPT_HTML)); }
  catch (error) {
    if (error instanceof SourceUnavailable && error.status === "failed") throw new SourceUnavailable("no_feed", `No CivicPlus calendar at ${page} (${error.message})`);
    throw error;
  }
  const categories = parseCategories(html);
  if (!categories.length) throw new SourceUnavailable("no_feed", `${page} has no CivicPlus calendar categories`);
  const wanted = categories.filter((category) => !MEETING_CATEGORY.test(category.name));
  skip(record, "meeting_category", categories.length - wanted.length);
  if (!wanted.length) throw new SourceUnavailable("no_feed", "Every calendar category is a public meeting calendar, which the meetings connector covers");
  const chosen = wanted.slice(0, MAX_CATEGORIES);
  skip(record, "category_limit", wanted.length - chosen.length);
  record.feed_url = icsUrl(origin, chosen[0].id);
  const region = await locationRegion(context);
  const events = new Map<string, ReturnType<typeof eventFacts>>();
  let failures = 0;
  for (const category of chosen) {
    let body: Uint8Array;
    try { body = await fetchBytes(context, icsUrl(origin, category.id), ACCEPT_ICS); }
    catch (error) { if (error instanceof SourceUnavailable) { failures += 1; skip(record, "category_failed"); continue; } throw error; }
    for (const item of parseCalendar(decode(body), record)) {
      const facts = eventFacts(item, category, origin, region, context, record);
      if (facts && !events.has(facts.source_event_id)) events.set(facts.source_event_id, facts);
      else if (facts) skip(record, "duplicate_category");
    }
  }
  if (failures === chosen.length) throw new SourceUnavailable("failed", `All ${failures} calendar feeds failed`);
  const kept = [...events.values()].filter((facts): facts is NonNullable<typeof facts> => facts !== null);
  record.detail = `${chosen.length} calendar categories (${chosen.map((category) => category.name).join(", ")}); ${kept.length} events in the window`;
  return kept;
}

type Fields = Record<string, [string, string]>;
function parseCalendar(source: string, record: SourceResult): Fields[] {
  const text = source.replace(/^\uFEFF/, "");
  if (!text.startsWith("BEGIN:VCALENDAR")) { skip(record, "not_icalendar"); return []; }
  return unfold(text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/));
}

function eventFacts(item: Fields, category: Category, origin: string, region: Region, context: ConnectorContext, record: SourceResult) {
  const field = (name: string) => unescapeIcs(item[name]?.[1] ?? "").trim();
  const title = field("SUMMARY").split(/\s+/).join(" "), uid = field("UID");
  if (!title || !uid) { skip(record, "missing_title"); return null; }
  if ("RRULE" in item || "RECURRENCE-ID" in item) { skip(record, "recurring"); return null; }
  if (field("STATUS").toUpperCase() === "CANCELLED" || cancelledTitle(title)) { skip(record, "cancelled"); return null; }
  const startPair = item.DTSTART ?? ["", ""];
  const start = icalMoment(startPair[1], startPair[0]);
  if (!start) { skip(record, "unsupported_time"); return null; }
  const day = isoDate(start);
  if (day < context.window[0] || day > context.window[1]) { record.skipped_outside_window += 1; return null; }
  const location = field("LOCATION").split(/\s+/).join(" ");
  if (!location) { skip(record, "no_venue"); return null; }
  if (VIRTUAL.test(location)) { skip(record, "virtual_only"); return null; }
  const tier = locationTier(region, location);
  if (!tier) { skip(record, "outside_area"); return null; }
  const endPair = item.DTEND;
  const end = endPair ? icalMoment(endPair[1], endPair[0]) : null;
  const rawDescription = field("DESCRIPTION");
  const link = eventLink(rawDescription, field("URL"), origin, uid);
  if (!link) { skip(record, "no_link"); return null; }
  const description = plainText(rawDescription.replace(/https?:\/\/\S+/g, " ")) ?? `Listed on the ${region.town} city calendar under ${category.name}.`;
  const [venue, ...address] = location.split(/\s+-\s+/);
  return {
    source_event_id: uid, title, event_date: day, schedule_text: scheduleText(start, end), venue: venue.trim(), room: address.join(" - ").trim() || null,
    source_url: link, description, kind: "event", tier, category: category.name,
    signals: { family: FAMILY.test(`${title} ${category.name} ${description}`) ? 1 : 0 },
  };
}

/** City calendars list the city's own venues; an address naming another city must be within 50 km. */
export function locationTier(region: Region, location: string): Tier | null {
  const match = CITY_STATE_ZIP.exec(location);
  if (!match) return "local";
  if (region.state_code && match[2] !== region.state_code) return null;
  const city = match[1].split(/\s{2,}|,/).at(-1)?.trim() ?? "";
  const words = city.split(/\s+/);
  for (let size = Math.min(3, words.length); size >= 1; size -= 1) {
    const tier = placeTier(region, words.slice(-size).join(" "));
    if (tier) return tier;
  }
  return null;
}

/** CivicPlus puts the event page in DESCRIPTION (`/calendar.aspx?EID=…`); the URL field points at the feed. */
function eventLink(description: string, url: string, origin: string, uid: string): string | null {
  const host = new URL(origin).host;
  const candidates = [...description.matchAll(/https:\/\/\S+/g)].map((match) => match[0].replace(/[).,;]+$/, ""));
  candidates.push(url.startsWith("/") ? `${origin}${url}` : url);
  for (const candidate of candidates) {
    const link = httpsLink(candidate);
    if (link && new URL(link).host === host && /EID=\d+/i.test(link)) return link;
  }
  return /^\d+$/.test(uid) ? `${origin}/Calendar.aspx?EID=${uid}` : null;
}
