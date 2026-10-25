/** Used by publication and the reader, including editions written before sectioning existed. */
export function isUpcoming(kind: string | undefined) {
  return kind === "event" || kind === "meeting_preview";
}

export function newsletterOrder(a: { kind?: string; local?: boolean; rank: number | null }, b: { kind?: string; local?: boolean; rank: number | null }) {
  return Number(isUpcoming(a.kind)) - Number(isUpcoming(b.kind))
    || Number(a.local === false) - Number(b.local === false)
    || (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);
}

export function newsletterSections<T extends { kind?: string; local?: boolean; rank: number | null }>(items: T[]) {
  const ordered = [...items].sort(newsletterOrder);
  return { news: ordered.filter((item) => !isUpcoming(item.kind)), upcoming: ordered.filter((item) => isUpcoming(item.kind)) };
}

/**
 * A listing: one collected item published as source facts, without model writing. Every
 * eligible item a source returns is listed; only the front-page stories are model-written.
 */
export type SourceListing = {
  id: string;
  title: string;
  event_date: string;
  schedule_text: string;
  venue: string;
  source_url: string;
  source_name: string;
  /** A story kind, such as "event", "meeting_outcome" or "state_news". */
  kind: string;
  /** The source's own description, shortened; never model-written. */
  summary: string;
  /** False for items from nearby towns or the wider region. */
  local: boolean;
};

/** Reader tabs, in display order. "home" is the full edition; the rest filter it. */
export const SECTIONS = [
  { id: "home", label: "Home" },
  { id: "events", label: "Events" },
  { id: "news", label: "Top News" },
  { id: "council", label: "Council" },
  { id: "schools", label: "Schools" },
  { id: "safety", label: "Public Safety" },
  { id: "development", label: "Real Estate & Development" },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];

/** The tab a story belongs to, by its kind. */
export function sectionOf(kind: string | undefined): Exclude<SectionId, "home"> {
  switch (kind ?? "event") {
    case "event": return "events";
    case "meeting_preview":
    case "meeting_outcome": return "council";
    case "school_sports": return "schools";
    case "safety_notice":
    case "earthquake": return "safety";
    case "housing_market":
    case "development": return "development";
    default: return "news";
  }
}

/** Listings grouped by day, in date order. */
export function calendarDays(entries: SourceListing[]) {
  const days = new Map<string, SourceListing[]>();
  for (const entry of [...entries].sort((a, b) => a.event_date.localeCompare(b.event_date))) {
    days.set(entry.event_date, [...(days.get(entry.event_date) ?? []), entry]);
  }
  return [...days].map(([date, items]) => ({ date, items }));
}
