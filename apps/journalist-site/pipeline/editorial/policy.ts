import { httpsLink } from "../connectors/common";
import { ALL_KINDS } from "./kinds";

export const POLICY = "floor_v4_event_dates";
export const SENSITIVE = /\b(alleg(?:ation|ations|ed|edly)|arrest(?:ed|s)?|charged with|suspect(?:s)?|(?:sexual assault|domestic violence|eviction) (?:case|hearing|proceedings?)|(?:suicide|homicide) investigation|disciplinary|medical records?)\b/i;
export const PRIVATE = /\((tenant|landlord|appellant|petitioner|respondent|claimant|grievant)\)|security deposit case|effective date of benefit|retirement application|disability retirement|personnel matter|workers'? compensation claim/i;
export { ALL_KINDS as KINDS } from "./kinds";
export const MINOR = /\b(juvenile|minor (?:child|victim|defendant)|(?:boy|girl|teen(?:ager)?|child|student),? (?:aged? )?1[0-7]\b|\b(?:1[0-7]|[1-9])-year-old)\b/i;
export type EditorialStory = { title: string; description?: string | null; kind?: string; [key: string]: unknown };
/**
 * Eligibility before writing. Crime, arrests, deaths and court cases are ordinary stories now;
 * the floor rules (editorial/floor.ts) shape how they are written. Only private matters
 * (tenancy, benefits, personnel) and items with no source text are held.
 */
export function errors(story: EditorialStory): string[] {
  const result: string[] = [];
  if (!ALL_KINDS.has(story.kind ?? "event")) result.push("unsupported_story_kind");
  const content = `${story.title} ${story.description ?? ""}`;
  if (PRIVATE.test(content)) result.push("private_matter");
  if (!(story.description ?? "").trim()) result.push("insufficient_source_context");
  result.push(...eventDateErrors(story));
  return result;
}

export function sourceErrors(urls: string[]) { return urls.length && urls.every((url) => httpsLink(url) !== null) ? [] : ["missing_source_link"]; }


const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function calendarDates(value: string) {
  return [...value.matchAll(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi)]
    .filter((match) => Number(match[2]) >= 1 && Number(match[2]) <= 31)
    .map((match) => `${MONTHS.indexOf(match[1].toLowerCase().slice(0, 3)) + 1}-${Number(match[2])}`);
}
/** Flag explicit disagreements; do not guess a date or rewrite source evidence. */
export function eventDateErrors(story: EditorialStory): string[] {
  if (!["event", "meeting_preview"].includes(story.kind ?? "event")) return [];
  const titleDates = calendarDates(story.title);
  if (!titleDates.length) return [];
  const date = typeof story.first_date === "string" ? story.first_date : typeof story.event_date === "string" ? story.event_date : null;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !titleDates.includes(`${Number(date.slice(5, 7))}-${Number(date.slice(8, 10))}`)) return ["conflicting_event_dates"];
  // Only compare the opening event statement, not deadlines/history later in the article.
  const opening = (story.description ?? "").split(/[.!?]\s|\n/, 1)[0];
  const bodyDates = calendarDates(opening);
  return /\b(?:meeting|event|session|workshop|gathering)\b/i.test(opening) && bodyDates.length === 1 && !titleDates.includes(bodyDates[0]) ? ["conflicting_event_dates"] : [];
}
