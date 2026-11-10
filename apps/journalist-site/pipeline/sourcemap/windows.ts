/**
 * The reader registry's lookup windows: how far back and ahead each kind of source is
 * read. News-like sources read since the location's last edition (capped), so a weekly
 * edition reads about a week; event-like sources read ahead. A source on the map may
 * override its type's window (a monthly newsletter site needs 35 days).
 *
 * The first edition for a location uses the cap as its look-back (`since: last_edition`
 * falls back to min(7 days, cap) in core/time.lookupRanges; types that need longer first
 * windows say so with `firstDays`).
 */
import type { LookupWindow } from "../connectors/types";

export type WindowKind =
  | "news" | "safety_calls" | "courts" | "records" | "meeting_previews" | "meeting_outcomes"
  | "events" | "obituaries" | "reader_stories" | "alerts" | "earthquakes" | "releases";

export const WINDOWS: Record<WindowKind, LookupWindow & { label: string }> = {
  news: { label: "Since last edition, up to 14 days back", back: { since: "last_edition", maxDays: 14 } },
  safety_calls: { label: "Since last edition, up to 7 days back", back: { since: "last_edition", maxDays: 7 } },
  courts: { label: "Since last edition, up to 14 days back", back: { since: "last_edition", maxDays: 14 } },
  records: { label: "Since last edition, up to 21 days back (filings post late)", back: { since: "last_edition", maxDays: 21 } },
  meeting_previews: { label: "Up to 14 days ahead", ahead: { days: 14 } },
  meeting_outcomes: { label: "Since last edition, up to 35 days back (minutes post late)", back: { since: "last_edition", maxDays: 35 } },
  events: { label: "Up to 30 days ahead", ahead: { days: 30 } },
  obituaries: { label: "Since last edition, up to 14 days back", back: { since: "last_edition", maxDays: 14 } },
  reader_stories: { label: "Up to 14 days since approval", back: { days: 14 } },
  alerts: { label: "Active now", back: { days: 1 } },
  earthquakes: { label: "Since last edition, up to 7 days back", back: { since: "last_edition", maxDays: 7 } },
  releases: { label: "New releases only, up to 180 days back", back: { days: 180 } },
};

/** A website or feed: news back, events ahead. */
export const WEB_WINDOW: LookupWindow = { back: WINDOWS.news.back, ahead: WINDOWS.events.ahead };
export const MEETINGS_WINDOW: LookupWindow = { back: WINDOWS.meeting_outcomes.back, ahead: WINDOWS.meeting_previews.ahead };

/** Open-data datasets by topic. */
export function datasetWindow(topic: string): LookupWindow {
  if (topic === "police" || topic === "fire") return WINDOWS.safety_calls;
  return WINDOWS.records;
}

/** A source's window: its own override, else its reader type's. */
export function effectiveWindow(base: LookupWindow, override?: LookupWindow | null): LookupWindow {
  if (!override) return base;
  return { back: override.back ?? base.back, ahead: override.ahead ?? base.ahead };
}

export function describeWindow(window: LookupWindow) {
  const parts: string[] = [];
  if (window.back) parts.push("days" in window.back ? `${window.back.days} days back` : `since last edition (up to ${window.back.maxDays} days back)`);
  if (window.ahead) parts.push(`${window.ahead.days} days ahead`);
  return parts.join(", ") || "no window";
}
