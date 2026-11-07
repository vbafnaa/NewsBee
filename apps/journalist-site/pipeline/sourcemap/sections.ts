/**
 * Newsletter sections. Every item is placed in one section; ranking and quotas run per
 * section, and the reader edition map groups sources and items by section.
 *
 * A section comes from, in order: an explicit section on the item, the source's section
 * hint, the story kind's default, then keyword rules (first match wins). The kinds and keywords
 * are in the playbook, in each category's file.
 */
import { ruleSet } from "../playbook";

export const SECTIONS = [
  { id: "events", label: "Events and things to do" },
  { id: "civic", label: "Council and government" },
  { id: "schools", label: "Schools and youth" },
  { id: "sports", label: "Local sports" },
  { id: "safety", label: "Police, fire and safety" },
  { id: "real_estate", label: "Real estate and development" },
  { id: "business", label: "Business openings and closings" },
  { id: "obituaries", label: "Obituaries and milestones" },
  { id: "community", label: "Community and neighbours" },
  { id: "weather", label: "Weather and alerts" },
  { id: "news", label: "Other local news" },
] as const;

export type SectionId = typeof SECTIONS[number]["id"];
/** The categories a map run must cover. Weather stays a section, outside this list. */
export const CATEGORIES = ["events", "civic", "schools", "sports", "safety", "real_estate", "business", "community", "news", "obituaries"] as const satisfies readonly SectionId[];
export const SECTION_IDS = new Set<string>(SECTIONS.map((section) => section.id));
export const SECTION_LABELS: Record<SectionId, string> = Object.fromEntries(SECTIONS.map((section) => [section.id, section.label])) as Record<SectionId, string>;

/** Candidates per section sent to authoring, and stories per section published. */
export const CANDIDATES_PER_SECTION = 20;
export const PUBLISHED_PER_SECTION = 10;
/** Items ranked by the model per section (rule-ordered first). */
export const RATED_PER_SECTION = 30;
/** At most this many items from one source per section. */
export const MAX_PER_SOURCE_IN_SECTION = 5;
/** City- and county-wide items are kept only in these sections, at most this many per edition. */
export const WIDER_SECTIONS = new Set<SectionId>(["civic", "safety", "weather", "sports"]);
export const MAX_WIDER_ITEMS = 3;

export function isSection(value: unknown): value is SectionId {
  return typeof value === "string" && SECTION_IDS.has(value);
}
export function sectionLabel(id: string | null | undefined) {
  return isSection(id) ? SECTION_LABELS[id] : SECTION_LABELS.news;
}

/** The default section for each story kind. */
export const KIND_SECTIONS: Record<string, SectionId> = Object.fromEntries(ruleSet("story_kinds").flatMap((rule) => rule.values!.map((kind) => [kind, rule.section as SectionId])));

/** Keyword rules; the first match wins. */
const RULES = ruleSet("item_keywords").map((rule): [SectionId, RegExp] => [rule.section as SectionId, rule.test]);

export function keywordSection(text: string): SectionId | null {
  for (const [section, pattern] of RULES) if (pattern.test(text)) return section;
  return null;
}

/**
 * The item's section. Kinds with a fixed meaning (meetings, alerts, obituaries, incidents)
 * keep their kind's section; general news and posts follow the keywords, then the source.
 */
const FIXED_KINDS = new Set(ruleSet("fixed_kinds").flatMap((rule) => rule.values!));
export function sectionFor(item: { kind?: string; title: string; description?: string | null; section_id?: unknown }, sourceHint?: string | null): SectionId {
  if (isSection(item.section_id)) return item.section_id;
  const kind = item.kind ?? "event";
  if (FIXED_KINDS.has(kind)) return KIND_SECTIONS[kind] ?? "news";
  const keyword = keywordSection(`${item.title} ${item.description ?? ""}`);
  if (keyword) return keyword;
  if (isSection(sourceHint)) return sourceHint;
  return KIND_SECTIONS[kind] ?? "news";
}
