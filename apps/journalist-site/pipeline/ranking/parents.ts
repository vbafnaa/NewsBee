/** Rankers for the parent-and-homeowner connectors. Local items always lead nearby ones. */
import { compareKeys, type Story } from "../editions/stories";
import { TIER_ORDER, spread } from "./wider";

export const FAMILY = /\b(famil(?:y|ies)|kids?|child(?:ren)?|youth|teens?|parents?|toddlers?|all ages|camps?|playground|parks?|festival|fair|parade|celebration|market|movies?|concert|story ?time|swim|pool)\b/i;
export const CHAMPIONSHIP = /\b(state (?:champions?|championships?|titles?|tournaments?)|champions?|championships?|playoffs?|semifinals?|finals?|district titles?|league titles?|undefeated)\b/i;

function tier(story: Story) { return TIER_ORDER[String(story.facts.tier)] ?? Object.keys(TIER_ORDER).length; }
function signal(story: Story, name: string, fallback = 0) {
  const signals = story.facts.signals as Record<string, number | string> | undefined;
  const value = signals?.[name];
  return value === undefined || value === null || Number.isNaN(Number(value)) ? fallback : Number(value);
}
function dateOrdinal(story: Story) { return Date.parse(`${story.first.event_date}T00:00:00Z`) / 86400000; }
function text(story: Story) { return `${story.title} ${typeof story.facts.description === "string" ? story.facts.description : ""}`; }

/** Soonest first, family-friendly events ahead of routine ones on the same day. */
export function civicCalendar(stories: Story[]): Story[] {
  return [...stories].sort((a, b) => compareKeys(
    [tier(a), a.first.event_date, FAMILY.test(text(a)) ? 0 : 1, a.title],
    [tier(b), b.first.event_date, FAMILY.test(text(b)) ? 0 : 1, b.title],
  ));
}

/** Health-based violations first, then the largest population served, then newest. */
export function homeSafety(stories: Story[]): Story[] {
  return [...stories].sort((a, b) => compareKeys(
    [tier(a), -signal(a, "health_based"), -signal(a, "open"), -signal(a, "population_served"), -dateOrdinal(a)],
    [tier(b), -signal(b, "health_based"), -signal(b, "open"), -signal(b, "population_served"), -dateOrdinal(b)],
  ));
}

/** Newest period first, then the place with more new units. */
export function housing(stories: Story[]): Story[] {
  return [...stories].sort((a, b) => compareKeys(
    [tier(a), -dateOrdinal(a), -signal(a, "units")],
    [tier(b), -dateOrdinal(b), -signal(b, "units")],
  ));
}

/** Most housing units first, then closest, then newest filing. */
export function development(stories: Story[]): Story[] {
  return [...stories].sort((a, b) => compareKeys(
    [tier(a), -signal(a, "units"), signal(a, "distance_km", 999), -dateOrdinal(a), a.title],
    [tier(b), -signal(b, "units"), signal(b, "distance_km", 999), -dateOrdinal(b), b.title],
  ));
}

/** Championship and playoff news ahead of routine items, newest first, spread across sports. */
export function athletics(stories: Story[]): Story[] {
  const ordered = [...stories].sort((a, b) => compareKeys(
    [tier(a), CHAMPIONSHIP.test(a.title) ? 0 : 1, -dateOrdinal(a), a.title],
    [tier(b), CHAMPIONSHIP.test(b.title) ? 0 : 1, -dateOrdinal(b), b.title],
  ));
  return spread(ordered, (story) => typeof story.facts.section === "string" ? story.facts.section : undefined);
}
