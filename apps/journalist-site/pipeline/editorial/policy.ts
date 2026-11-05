import { httpsLink } from "../connectors/common";
import { ALL_KINDS } from "./kinds";

export const POLICY = "floor_v3";
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
  return result;
}

export function sourceErrors(urls: string[]) { return urls.length && urls.every((url) => httpsLink(url) !== null) ? [] : ["missing_source_link"]; }
