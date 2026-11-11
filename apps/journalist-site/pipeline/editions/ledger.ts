/**
 * Published-story ledger: every story a location's edition has printed, so consecutive
 * editions don't repeat themselves.
 *
 * A story is identified by its merge group (editions/assemble.ts): the same story arriving
 * from a different source, or with a slightly different headline next week, is the same
 * story. Each printed story keeps the distinctive tokens it was printed with (names,
 * numbers, dates), so a later copy that brings new facts is printed again as an update,
 * while a copy with nothing new is dropped.
 *
 *   - news: printed before with nothing new -> dropped; with 2+ new facts -> an update.
 *   - events: printed at most twice per date (first mention, then a "this week" reminder if
 *     the first mention was 7+ days ahead); a recurring event at most once every 4 weeks.
 *
 * Only earlier edition periods count: runs in the same week (a rerun or restart that
 * replaces that week's edition) may print the same stories again.
 */
import type { Db } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import { addDays } from "../connectors/common";

export const NEW_FACTS_FOR_UPDATE = 2;
export const REMINDER_LEAD_DAYS = 7;
export const RECURRING_GAP_DAYS = 28;

export type PublishedStory = {
  _id: string;
  location_id: string;
  story_key: string;
  story_id: string;
  legacy_story_id?: string;
  event_date: string;
  kind: string | null;
  edition_id: string;
  /** `today` of the run that first published it; its edition period is derived from this. */
  edition_day: string;
  published_at: number;
  tokens?: string[];
  headline?: string;
};

export function ledgerKey(story: { id: string; event_date: string }) {
  return `${story.id}@${story.event_date}`;
}

export function publishedStories(db: Db) {
  return db.collection<PublishedStory>(COLLECTIONS.publishedStories);
}

/** Distinctive tokens of a story: capitalised words, numbers and dates in its text. */
export function storyTokens(text: string) {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/\b(?:[A-Z][a-z'’-]{2,}|\d[\d,.:/-]*)\b/g)) tokens.add(match[0].toLowerCase().replace(/[,.]$/, ""));
  return [...tokens].slice(0, 80);
}

export type LedgerDecision = { keep: true; update_of?: string | null; reminder?: boolean } | { keep: false; reason: string; printed_on: string };

/** What the ledger says about a candidate story. */
export function ledgerDecision(history: PublishedStory[], story: { event_date: string; news: boolean; tokens: string[] }, today: string, periodStart: string): LedgerDecision {
  const earlier = history.filter((entry) => entry.edition_day < periodStart).sort((a, b) => b.edition_day.localeCompare(a.edition_day));
  if (!earlier.length) return { keep: true };
  if (story.news) {
    const printed = new Set(earlier.flatMap((entry) => entry.tokens ?? []));
    const fresh = story.tokens.filter((token) => !printed.has(token));
    if (fresh.length >= NEW_FACTS_FOR_UPDATE && earlier[0].tokens?.length) return { keep: true, update_of: earlier[0].edition_id };
    return { keep: false, reason: "already printed with nothing new", printed_on: earlier[0].edition_day };
  }
  const sameDate = earlier.filter((entry) => entry.event_date === story.event_date);
  if (sameDate.length >= 2) return { keep: false, reason: "already printed twice", printed_on: sameDate[0].edition_day };
  if (sameDate.length === 1) {
    const first = sameDate[0];
    const leadDays = (Date.parse(`${story.event_date}T00:00:00Z`) - Date.parse(`${first.edition_day}T00:00:00Z`)) / 86400_000;
    const soon = story.event_date <= addDays(today, REMINDER_LEAD_DAYS);
    if (leadDays >= REMINDER_LEAD_DAYS && soon) return { keep: true, reminder: true };
    return { keep: false, reason: "already printed", printed_on: first.edition_day };
  }
  const recent = earlier.find((entry) => entry.edition_day >= addDays(today, -RECURRING_GAP_DAYS));
  if (recent) return { keep: false, reason: "recurring event printed in the last 4 weeks", printed_on: recent.edition_day };
  return { keep: true };
}

export async function ledgerHistory(db: Db, locationId: string, storyIds: string[]) {
  const map = new Map<string, PublishedStory[]>();
  if (!storyIds.length) return map;
  const ids = [...new Set(storyIds)];
  const found = await publishedStories(db).find({ location_id: locationId, $or: [{ story_id: { $in: ids } }, { legacy_story_id: { $in: ids } }] }).toArray();
  for (const entry of found) for (const id of new Set([entry.story_id, entry.legacy_story_id].filter((id): id is string => Boolean(id)))) map.set(id, [...(map.get(id) ?? []), entry]);
  return map;
}

/** Story keys this location published in an edition period before `periodStart` (kept for older callers). */
export async function alreadyPublished(db: Db, locationId: string, keys: string[], periodStart: string) {
  if (!keys.length) return new Set<string>();
  const found = await publishedStories(db)
    .find({ _id: { $in: keys.map((key) => `${locationId}:${key}`) }, edition_day: { $lt: periodStart } }, { projection: { story_key: 1 } })
    .toArray();
  return new Set(found.map((item) => item.story_key));
}

/**
 * Record an edition's items as published by a run on `editionDay`. Idempotent, and a story
 * keeps the day it was first published, so a same-week rerun doesn't move it forward.
 */
export async function recordPublished(
  db: Db,
  editionDay: string,
  edition: { id: string; location_id: string; published_at?: unknown; items?: readonly unknown[] },
  tokensById: Map<string, string[]> = new Map(),
) {
  const publishedAt = typeof edition.published_at === "number" ? edition.published_at : Date.now() / 1000;
  const writes = (edition.items ?? []).flatMap((value) => {
    const item = (value ?? {}) as { story_id?: unknown; event_date?: unknown; kind?: unknown; headline?: unknown; legacy_story_id?: unknown };
    if (typeof item.story_id !== "string" || typeof item.event_date !== "string") return [];
    const storyKey = `${ledgerKey({ id: item.story_id, event_date: item.event_date })}@${editionDay}`;
    return [{
      updateOne: {
        filter: { _id: `${edition.location_id}:${storyKey}` },
        update: { $setOnInsert: {
          location_id: edition.location_id, story_key: storyKey, story_id: item.story_id, ...(typeof item.legacy_story_id === "string" ? { legacy_story_id: item.legacy_story_id } : {}), event_date: item.event_date,
          kind: typeof item.kind === "string" ? item.kind : null, edition_id: edition.id, edition_day: editionDay, published_at: publishedAt,
          tokens: tokensById.get(item.story_id) ?? [], headline: typeof item.headline === "string" ? item.headline : "",
        } },
        upsert: true,
      },
    }];
  });
  if (writes.length) await publishedStories(db).bulkWrite(writes, { ordered: false });
  return writes.length;
}
