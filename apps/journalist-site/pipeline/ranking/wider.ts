import { compareKeys, type Story } from "../editions/stories";

export const TIER_ORDER: Record<string, number> = { local: 0, region: 1, nearby: 2 };
export const PRACTICAL = /\b(closures?|closes?|closed|closing|detours?|lanes?|ferr(?:y|ies)|roads?|highways?|bridges?|I-\d+|SR \d+|traffic|construction|recalls?|outbreaks?|vaccin\w*|flu|advisor(?:y|ies)|warnings?|scams?|fraud|grants?|funding|deadlines?|apply|applications?|benefits?|wildfires?|burn bans?|floods?|flooding|storms?|snow|power|water|schools?|consumers?|refunds?|settlements?|prices?|rent|housing|jobs?|wages?|fees?|tolls?)\b/i;
export const CEREMONIAL = /\b(appoint\w*|reappoint\w*|proclam\w*|honou?rs?|commemorat\w*|condolences?|half-staff|trade mission|travels?|statement|nominat\w*|welcomes?|congratulat\w*)\b/i;

function tier(story: Story) { return TIER_ORDER[String(story.facts.tier)] ?? Object.keys(TIER_ORDER).length; }
function signal(story: Story, name: string, fallback = 0) {
  const signals = story.facts.signals as Record<string, number | string> | undefined;
  const value = signals?.[name];
  return value === undefined || value === null ? fallback : Number(value);
}
function dateOrdinal(story: Story) { return Date.parse(`${story.first.event_date}T00:00:00Z`) / 86400000; }

type Group = string | null | undefined;
export function spread(stories: Story[], group: (story: Story) => Group): Story[] {
  const counts = new Map<string, number>();
  return stories.map((story, position) => {
    const level = tier(story), value = group(story), key = `${level}\u0000${value ?? "<null>"}`;
    const index = counts.get(key) ?? 0; counts.set(key, index + 1);
    return { story, key: [level, index, position] as const };
  }).sort((a, b) => compareKeys(a.key, b.key)).map(({ story }) => story);
}

export function hazards(stories: Story[]): Story[] {
  return [...stories].sort((a, b) => compareKeys(
    [tier(a), -signal(a, "magnitude"), signal(a, "distance_km"), -signal(a, "felt"), -dateOrdinal(a)],
    [tier(b), -signal(b, "magnitude"), signal(b, "distance_km"), -signal(b, "felt"), -dateOrdinal(b)],
  ));
}

export function stateNewsScore(story: Story) {
  const description = typeof story.facts.description === "string" ? story.facts.description : "";
  return reportingScore(story.title, description);
}
export function reportingScore(title: string, description: string) {
  return (PRACTICAL.test(title) ? 20 : PRACTICAL.test(description) ? 10 : 0) - (CEREMONIAL.test(title) ? 30 : 0);
}
export function stateNews(stories: Story[]): Story[] {
  const ordered = [...stories].sort((a, b) => compareKeys([tier(a), -stateNewsScore(a), -dateOrdinal(a)], [tier(b), -stateNewsScore(b), -dateOrdinal(b)]));
  return spread(ordered, (story) => typeof story.first?.venue === "string" ? story.first.venue : undefined);
}
function trendStrength(story: Story) {
  return story.facts.kind === "social_trend" ? signal(story, "post_count") : signal(story, "ratio") * 1000 + signal(story, "recent_daily_views") / 1e6;
}
export function trending(stories: Story[]): Story[] {
  const ordered = [...stories].sort((a, b) => compareKeys(
    [tier(a), -stateNewsScore(a), -dateOrdinal(a), -trendStrength(a)],
    [tier(b), -stateNewsScore(b), -dateOrdinal(b), -trendStrength(b)],
  ));
  return spread(ordered, (story) => typeof story.facts.kind === "string" ? story.facts.kind : undefined);
}
