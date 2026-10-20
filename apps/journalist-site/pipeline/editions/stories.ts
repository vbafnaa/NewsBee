/**
 * Port of editions/stories.py. Deduplication layer: collapse repeated events from any
 * source into one story, keeping every occurrence, so the edition never repeats an item.
 */
import { createHash } from "node:crypto";
import type { CollectedEvent } from "../connectors/types";

export const MAX_OCCURRENCES_SHOWN = 4;
const NOISE = /[^a-z0-9]+/g;
const YEAR = /,\s*\d{4}(?=,|$)/g;
export const NEWS_LINES: Record<string, string> = {
  state_news: "Published {when} by {source}.",
  earthquake: "Recorded {when}. Where: {source}.",
  trending_topic: "Published {when} by {source}.",
  social_trend: "Published {when} by {source}.",
};

export type Occurrence = {
  source_id: string;
  source_event_id: string;
  event_date: string;
  schedule_text: string;
  venue: string;
  room: string | null;
  source_url: string;
};

/** A stored event: the source that produced it plus its connector facts. */
export type SourceEvent = { source_id: string; facts: CollectedEvent };

export class Story {
  occurrences: Occurrence[] = [];
  constructor(
    public id: string,
    public title: string,
    public description: string | null,
    public kind = "event",
    public facts: CollectedEvent = {} as CollectedEvent,
  ) {}

  get first(): Occurrence {
    return this.occurrences[0];
  }

  get venues(): string[] {
    return [...new Set(this.occurrences.map((item) => item.venue))];
  }

  get recurring(): boolean {
    return this.occurrences.length > 1;
  }
}

export function storyKey(title: string) {
  return title.toLowerCase().replace(NOISE, " ").trim();
}

export function storyId(key: string) {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);
}

/** Python tuple ordering on strings (code point order, not locale). */
export function compareText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareKeys(a: readonly (string | number | boolean)[], b: readonly (string | number | boolean)[]) {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === right) continue;
    if (typeof left === "string" && typeof right === "string") return compareText(left, right);
    return Number(left) < Number(right) ? -1 : 1;
  }
  return a.length - b.length;
}

function sameOccurrence(a: Occurrence, b: Occurrence) {
  return (
    a.source_id === b.source_id &&
    a.source_event_id === b.source_event_id &&
    a.event_date === b.event_date &&
    a.schedule_text === b.schedule_text &&
    a.venue === b.venue &&
    a.room === b.room &&
    a.source_url === b.source_url
  );
}

/** Stored events -> stories ordered by first date then title. */
export function collapse(events: SourceEvent[]): Story[] {
  const stories = new Map<string, Story>();
  for (const event of events) {
    const facts = event.facts;
    const kind = (facts.kind as string | undefined) ?? "event";
    let key = storyKey(facts.title);
    if (kind !== "event") key = `${kind}:${facts.event_date}:${key}`;
    if (facts.trend_context && ["trending_topic", "social_trend"].includes(kind)) key = `reported:${facts.event_date}:${facts.source_url}`;
    let story = stories.get(key);
    if (!story) {
      story = new Story(storyId(key), facts.title, null, kind, facts);
      stories.set(key, story);
    }
    const description = facts.description;
    if (description && description.length > (story.description ?? "").length) story.description = description;
    const occurrence: Occurrence = {
      source_id: event.source_id,
      source_event_id: facts.source_event_id,
      event_date: facts.event_date,
      schedule_text: facts.schedule_text,
      venue: facts.venue,
      room: facts.room ?? null,
      source_url: facts.source_url,
    };
    if (!story.occurrences.some((item) => sameOccurrence(item, occurrence))) story.occurrences.push(occurrence);
  }
  for (const story of stories.values()) {
    story.occurrences.sort((a, b) => compareKeys([a.event_date, a.schedule_text, a.venue], [b.event_date, b.schedule_text, b.venue]));
  }
  return [...stories.values()].sort((a, b) => compareKeys([a.first.event_date, a.title], [b.first.event_date, b.title]));
}

function place(item: Occurrence) {
  return item.venue + (item.room ? `, ${item.room}` : "");
}

function withoutYear(text: string) {
  return text.replace(YEAR, "");
}

/** Fixed, factual When/Where text (never model-written). */
export function whenWhere(story: Story): string {
  const template = NEWS_LINES[story.kind];
  if (template) {
    const item = story.first;
    return template.replace("{when}", withoutYear(item.schedule_text)).replace("{source}", item.venue);
  }
  const shown = story.occurrences.slice(0, MAX_OCCURRENCES_SHOWN);
  if (story.occurrences.length === 1) {
    const item = shown[0];
    return `When: ${withoutYear(item.schedule_text)}. Where: ${place(item)}.`;
  }
  const parts = shown.map((item) => `${withoutYear(item.schedule_text)} at ${place(item)}`);
  const more = story.occurrences.length - shown.length;
  return `When and where: ${parts.join("; ")}${more ? `; plus ${more} more` : ""}.`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function weekLabel(start: string, end: string) {
  const [, firstMonth, firstDay] = start.split("-").map(Number);
  const [, lastMonth, lastDay] = end.split("-").map(Number);
  if (firstMonth === lastMonth) return `${MONTHS[firstMonth - 1]} ${firstDay}\u2013${lastDay}`;
  return `${MONTHS[firstMonth - 1]} ${firstDay}\u2013${MONTHS[lastMonth - 1]} ${lastDay}`;
}
