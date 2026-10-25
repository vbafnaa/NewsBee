/**
 * The edition's listings: every eligible item each source returned, published as source facts
 * with no model writing. Only the front-page stories are model-written and capped at
 * NEWSBEE_MAX_STORIES when it is set; listings are never capped, so readers see everything collected.
 * Listings pass the same deterministic checks as stories: a supported kind, an HTTPS source
 * link, no sensitive or private matters, not cancelled, and not withdrawn by an editor.
 * Upcoming events and meetings must fall in the run window and be local; news-like items
 * keep the lookback window each connector already applied.
 */
import { createHash } from "node:crypto";
import { cancelledTitle, httpsLink, plainText } from "../connectors/common";
import * as policy from "../editorial/policy";
import type { Withdrawal } from "../editorial/withdrawals";
import { isUpcoming, type SourceListing } from "../../../../shared/newsletter-layout";
import { storyKey, type SourceEvent } from "./stories";

export const SUMMARY_MAX = 300;

/** A listing as stored on the draft; the source reference lets editor withdrawals remove it. */
export type DraftListing = SourceListing & { source_id: string; source_event_id: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i;

/** Minutes after midnight from text like "Tue, Oct 27, 10:30 AM"; untimed listings sort first. */
export function minutesOf(scheduleText: string) {
  const match = TIME.exec(scheduleText);
  if (!match) return -1;
  const hour = Number(match[1]) % 12 + (match[3].toLowerCase() === "p" ? 12 : 0);
  return hour * 60 + Number(match[2] ?? 0);
}

/** Upcoming items soonest first; everything else newest first. */
export function listingOrder(a: SourceListing, b: SourceListing) {
  const upcoming = Number(isUpcoming(b.kind)) - Number(isUpcoming(a.kind));
  if (upcoming) return upcoming;
  if (isUpcoming(a.kind)) return a.event_date.localeCompare(b.event_date) || minutesOf(a.schedule_text) - minutesOf(b.schedule_text) || a.title.localeCompare(b.title);
  return b.event_date.localeCompare(a.event_date) || a.title.localeCompare(b.title);
}

/** Every eligible item one source returned. */
export function sourceListings(events: SourceEvent[], sourceName: string, window: [string, string]): DraftListing[] {
  const listings: DraftListing[] = [];
  for (const { source_id, facts } of events) {
    const kind = String(facts.kind ?? "event");
    const title = String(facts.title ?? "").trim();
    const content = `${title} ${facts.description ?? ""}`;
    const sourceUrl = httpsLink(String(facts.source_url ?? ""));
    const local = facts.tier !== "region" && facts.tier !== "nearby";
    if (!policy.KINDS.has(kind) || !title || cancelledTitle(title) || !sourceUrl || !DATE.test(facts.event_date)) continue;
    if (isUpcoming(kind) && (!local || facts.event_date < window[0] || facts.event_date > window[1])) continue;
    if (policy.SENSITIVE.test(content) || policy.PRIVATE.test(content)) continue;
    const key = `${kind}|${storyKey(title)}|${facts.event_date}|${String(facts.venue ?? "").toLowerCase()}`;
    listings.push({
      id: createHash("sha256").update(key).digest("hex").slice(0, 16),
      title,
      event_date: facts.event_date,
      schedule_text: String(facts.schedule_text ?? ""),
      venue: String(facts.venue ?? ""),
      source_url: sourceUrl,
      source_name: sourceName,
      kind,
      summary: plainText(facts.description, SUMMARY_MAX) ?? "",
      local,
      source_id,
      source_event_id: facts.source_event_id,
    });
  }
  return listings.sort(listingOrder);
}

/** One set of listings for the draft: the same item from two sources is listed once. */
export function mergeListings(listings: DraftListing[]): DraftListing[] {
  const seen = new Set<string>();
  return [...listings].sort(listingOrder).filter((listing) => !seen.has(listing.id) && seen.add(listing.id));
}

/** The public listings at publish time: drops past upcoming items, withdrawn items and source references. */
export function publishedListings(listings: DraftListing[], publishToday: string | undefined, decisions: Record<string, Withdrawal>): SourceListing[] {
  const withdrawn = new Set(Object.values(decisions).flatMap((decision) => decision.source_refs.map(([source, event]) => `${source}\0${event}`)));
  return listings
    .filter((listing) => !(publishToday && isUpcoming(listing.kind) && listing.event_date < publishToday))
    .filter((listing) => !withdrawn.has(`${listing.source_id}\0${listing.source_event_id}`))
    .map(({ source_id: _source, source_event_id: _event, ...entry }) => entry);
}
