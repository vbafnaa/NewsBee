/** Rankers for the connectors ported from the NewsBee exploration pipeline. Local items lead. */
import { compareKeys, type Story } from "../editions/stories";
import { TIER_ORDER, spread } from "./wider";

function tier(story: Story) { return TIER_ORDER[String(story.facts.tier)] ?? Object.keys(TIER_ORDER).length; }
function signal(story: Story, name: string) {
  const value = (story.facts.signals as Record<string, unknown> | undefined)?.[name];
  return value === undefined || value === null || Number.isNaN(Number(value)) ? 0 : Number(value);
}
function day(story: Story) { return Date.parse(`${story.first.event_date}T00:00:00Z`) / 86400000; }
const venue = (story: Story) => story.first?.venue;

/** Sentences, then convictions, then charges; newest first; one office at a time. */
export function justice(stories: Story[]): Story[] {
  const ordered = [...stories].sort((a, b) => compareKeys([tier(a), -signal(a, "stage"), -day(a), a.title], [tier(b), -signal(b, "stage"), -day(b), b.title]));
  return spread(ordered, venue);
}

/** New businesses before relocations and ownership changes, newest first. */
export function business(stories: Story[]): Story[] {
  return [...stories].sort((a, b) => compareKeys([tier(a), -signal(a, "new"), -day(a), a.title], [tier(b), -signal(b, "new"), -day(b), b.title]));
}

/** Events soonest first and news newest first, spread across the sites they came from. */
export function localSites(stories: Story[]): Story[] {
  const news = (story: Story) => (story.kind === "local_news" ? 1 : 0);
  const ordered = [...stories].sort((a, b) => compareKeys(
    [tier(a), news(a), news(a) ? -day(a) : day(a), a.title],
    [tier(b), news(b), news(b) ? -day(b) : day(b), b.title],
  ));
  return spread(ordered, venue);
}

/** Death notices newest first. */
export function remembrance(stories: Story[]): Story[] {
  return [...stories].sort((a, b) => compareKeys([tier(a), -day(a), a.title], [tier(b), -day(b), b.title]));
}

/** Upcoming neighbour events soonest first, then news newest first. */
export function community(stories: Story[]): Story[] {
  return [...stories].sort((a, b) => compareKeys(
    [tier(a), -signal(a, "upcoming"), signal(a, "upcoming") ? day(a) : -day(a), a.title],
    [tier(b), -signal(b, "upcoming"), signal(b, "upcoming") ? day(b) : -day(b), b.title],
  ));
}
