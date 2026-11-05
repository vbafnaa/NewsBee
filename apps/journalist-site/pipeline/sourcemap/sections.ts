/**
 * Newsletter sections. Every item is placed in one section; ranking and quotas run per
 * section, and the reader edition map groups sources and items by section.
 *
 * A section comes from, in order: an explicit section on the item, the source's section
 * hint, the story kind's default, then keyword rules (first match wins).
 */
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
export const KIND_SECTIONS: Record<string, SectionId> = {
  event: "events",
  meeting_preview: "civic",
  meeting_outcome: "civic",
  state_news: "civic",
  earthquake: "weather",
  weather_alert: "weather",
  safety_notice: "weather",
  trending_topic: "news",
  social_trend: "news",
  housing_market: "real_estate",
  development: "real_estate",
  home_sale: "real_estate",
  building_permit: "real_estate",
  school_sports: "sports",
  game_result: "sports",
  court_case: "safety",
  safety_incident: "safety",
  local_news: "news",
  news_report: "news",
  business_opening: "business",
  public_record: "civic",
  obituary: "obituaries",
  reader_story: "community",
};

/** Keyword rules (from the exploration app, extended); the first match wins. */
const RULES: Array<[SectionId, RegExp]> = [
  // Event roundups ("things to do this weekend", "your agenda this week") before topic words in their listings.
  ["events", /things to do|this weekend|\bevents (in|this|to)\b|agenda this week|what'?s happening|weekend guide|\bcalendar\b/i],
  ["obituaries", /obituar|passed away|celebration of life|memorial service|in loving memory|\bfuneral\b|\bdied\b|\bwedding anniversary\b|\bturns 100\b/i],
  ["safety", /\bpolice\b|sheriff|arrest|\bcrash|collision|\bfire\b|shooting|stabb|burglar|theft|robber|\b911\b|\bmedics?\b|aid response|rescue|\bcrime|missing person|suspect|charged with|\bcourt\b/i],
  ["weather", /weather|\bstorm|windstorm|flood|heat wave|\bsmoke\b|air quality|advisory|snow|king tide|earthquake|power outage/i],
  ["sports", /athlet|varsity|football|soccer|basketball|volleyball|baseball|softball|wrestling|swim meet|track and field|cross country|playoff|final score|\bdefeated\b|\bleague\b.*\b(game|match|season)\b/i],
  ["real_estate", /real estate|home sale|\bsold for\b|listing|\bpermit|zoning|rezone|land use|development|construction|housing|apartment|townhome|\bparcel|demolition|single-family/i],
  ["schools", /\bschool|student|teacher|\bpta\b|ptsa|graduat|scholar|national merit|athlet|varsity|football|soccer|basketball|volleyball|swim meet|playoff|homecoming|\byouth\b|\bkids?\b/i],
  ["civic", /council|commission|\bboard\b|ordinance|\bcity\b|county|\blevy\b|budget|\bvote|election|hearing|mayor|legislat|agenda|public comment|311|code enforcement/i],
  ["business", /now open|grand opening|\bopens\b|opening|closing|\bcloses\b|restaurant|\bcafe|bakery|brewery|\bshop\b|\bstore\b|business|liquor|licen[cs]e|inspection|layoff|ribbon cutting/i],
  ["events", /festival|concert|\bmarket\b|\bfair\b|\bclass\b|workshop|storytime|\btour\b|exhibit|screening|\bwalk\b|fun run|meetup|celebrat|\bevent|parade|cleanup|volunteer/i],
  ["community", /neighbou?r|community council|association|volunteer|good deed|local hero|club\b/i],
];

export function keywordSection(text: string): SectionId | null {
  for (const [section, pattern] of RULES) if (pattern.test(text)) return section;
  return null;
}

/**
 * The item's section. Kinds with a fixed meaning (meetings, alerts, obituaries, incidents)
 * keep their kind's section; general news and posts follow the keywords, then the source.
 */
const FIXED_KINDS = new Set(["meeting_preview", "meeting_outcome", "earthquake", "weather_alert", "safety_notice", "court_case", "safety_incident", "housing_market", "development", "home_sale", "building_permit", "game_result", "business_opening", "obituary", "school_sports", "reader_story", "event"]);
export function sectionFor(item: { kind?: string; title: string; description?: string | null; section_id?: unknown }, sourceHint?: string | null): SectionId {
  if (isSection(item.section_id)) return item.section_id;
  const kind = item.kind ?? "event";
  if (FIXED_KINDS.has(kind)) return KIND_SECTIONS[kind] ?? "news";
  const keyword = keywordSection(`${item.title} ${item.description ?? ""}`);
  if (keyword) return keyword;
  if (isSection(sourceHint)) return sourceHint;
  return KIND_SECTIONS[kind] ?? "news";
}
