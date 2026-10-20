import { httpsLink } from "../connectors/common";

export const POLICY = "private_poc_v2";
export const SENSITIVE = /\b(alleg(?:ation|ations|ed|edly)|arrest(?:ed|s)?|charged with|suspect(?:s)?|(?:sexual assault|domestic violence|eviction) (?:case|hearing|proceedings?)|(?:suicide|homicide) investigation|disciplinary|medical records?)\b/i;
export const PRIVATE = /\((tenant|landlord|appellant|petitioner|respondent|claimant|grievant)\)|security deposit case|effective date of benefit|retirement application|disability retirement|personnel matter|workers'? compensation claim/i;
export const KINDS = new Set(["event", "meeting_preview", "meeting_outcome", "state_news", "earthquake", "trending_topic", "social_trend"]);
export type EditorialStory = { title: string; description?: string | null; kind?: string; [key: string]: unknown };
export function errors(story: EditorialStory): string[] {
  const result: string[] = [];
  if (!KINDS.has(story.kind ?? "event")) result.push("unsupported_story_kind");
  const content = `${story.title} ${story.description ?? ""}`;
  if (SENSITIVE.test(content) || PRIVATE.test(content)) result.push("sensitive_requires_editor");
  if (!(story.description ?? "").trim()) result.push("insufficient_source_context");
  return result;
}
export function sourceErrors(urls: string[]) { return urls.length && urls.every((url) => httpsLink(url) !== null) ? [] : ["missing_source_link"]; }
