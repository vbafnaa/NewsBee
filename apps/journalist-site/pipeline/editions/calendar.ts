/**
 * The edition's full calendar: every upcoming event and public meeting the sources returned
 * in the window, published as source facts with no model writing. Stories stay capped at
 * MAX_ENTRIES; listings are not, so readers can see everything happening. Listings pass the
 * same deterministic checks as stories: HTTPS source link, no sensitive or private matters,
 * not cancelled, and not withdrawn by an editor.
 */
import { createHash } from "node:crypto";
import { cancelledTitle, httpsLink } from "../connectors/common";
import * as policy from "../editorial/policy";
import type { Withdrawal } from "../editorial/withdrawals";
import { isUpcoming, type CalendarEntry } from "../../../../shared/newsletter-layout";
import { storyKey, type SourceEvent } from "./stories";

export const MAX_LISTINGS_PER_SOURCE = 100;
export const MAX_LISTINGS = 300;

/** A listing as stored on the draft; the source reference lets editor withdrawals remove it. */
export type DraftListing = CalendarEntry & { source_id: string; source_event_id: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i;

/** Minutes after midnight from text like "Tue, Oct 27, 10:30 AM"; untimed listings sort first. */
export function minutesOf(scheduleText: string) {
  const match = TIME.exec(scheduleText);
  if (!match) return -1;
  const hour = Number(match[1]) % 12 + (match[3].toLowerCase() === "p" ? 12 : 0);
  return hour * 60 + Number(match[2] ?? 0);
}

function byTime(a: CalendarEntry, b: CalendarEntry) {
  return a.event_date.localeCompare(b.event_date) || minutesOf(a.schedule_text) - minutesOf(b.schedule_text) || a.title.localeCompare(b.title);
}

/** Every eligible upcoming listing one source returned, capped per source. */
export function sourceListings(events: SourceEvent[], sourceName: string, window: [string, string], limit = MAX_LISTINGS_PER_SOURCE): DraftListing[] {
  const listings: DraftListing[] = [];
  for (const { source_id, facts } of events) {
    const kind = (facts.kind ?? "event") as string;
    const title = String(facts.title ?? "").trim();
    const content = `${title} ${facts.description ?? ""}`;
    const sourceUrl = httpsLink(String(facts.source_url ?? ""));
    if (!isUpcoming(kind) || !title || cancelledTitle(title) || !sourceUrl) continue;
    if (facts.tier === "region" || facts.tier === "nearby") continue;
    if (!DATE.test(facts.event_date) || facts.event_date < window[0] || facts.event_date > window[1]) continue;
    if (policy.SENSITIVE.test(content) || policy.PRIVATE.test(content)) continue;
    const key = `${storyKey(title)}|${facts.event_date}|${String(facts.venue ?? "").toLowerCase()}`;
    listings.push({
      id: createHash("sha256").update(key).digest("hex").slice(0, 16),
      title,
      event_date: facts.event_date,
      schedule_text: String(facts.schedule_text ?? ""),
      venue: String(facts.venue ?? ""),
      source_url: sourceUrl,
      source_name: sourceName,
      kind: kind as CalendarEntry["kind"],
      source_id,
      source_event_id: facts.source_event_id,
    });
  }
  return listings.sort(byTime).slice(0, limit);
}

/** One calendar for the draft: duplicates across sources collapse to the first listing. */
export function mergeListings(listings: DraftListing[], limit = MAX_LISTINGS): DraftListing[] {
  const seen = new Set<string>();
  return [...listings].sort(byTime).filter((listing) => !seen.has(listing.id) && seen.add(listing.id)).slice(0, limit);
}

/** The public calendar at publish time: drops past and withdrawn listings and source references. */
export function publishedCalendar(listings: DraftListing[], publishToday: string | undefined, decisions: Record<string, Withdrawal>): CalendarEntry[] {
  const withdrawn = new Set(Object.values(decisions).flatMap((decision) => decision.source_refs.map(([source, event]) => `${source}\0${event}`)));
  return listings
    .filter((listing) => !(publishToday && listing.event_date < publishToday))
    .filter((listing) => !withdrawn.has(`${listing.source_id}\0${listing.source_event_id}`))
    .map(({ source_id: _source, source_event_id: _event, ...entry }) => entry);
}
