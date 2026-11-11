/**
 * The fixed reasons for an editor's Accept or Reject on a story a run pulled. Separate from the
 * source map's reasons (`sourcemap/reasons.ts`) and prefixed S, so story and source labels never
 * mix in an export. Codes are stable, so decisions can be counted across runs: reword a label if
 * needed, but never reuse a code. No server imports, so the browser and the store share it.
 */
export const STORY_REASONS = {
  accept: [
    { code: "SA1", label: "Local and newsworthy" },
    { code: "SA2", label: "Useful notice for residents (closure, deadline, safety, service change)" },
    { code: "SA3", label: "Worth-going local event" },
    { code: "SA4", label: "Fills a section that would be empty" },
    { code: "SA6", label: "Public decision or record (council, school board, court, permit)" },
    { code: "SA7", label: "Local sports result or school achievement" },
    { code: "SA8", label: "Obituary or milestone" },
    { code: "SA9", label: "Community or human-interest story" },
    { code: "SA10", label: "Business opening, closing or change" },
    { code: "SA11", label: "Safety, weather or emergency information" },
    { code: "SA12", label: "Original local reporting" },
    { code: "SA5", label: "Other (explain)" },
  ],
  reject: [
    { code: "SR1", label: "Not about this place" },
    { code: "SR9", label: "About a nearby town, not this place" },
    { code: "SR2", label: "Old news or outside the window" },
    { code: "SR10", label: "Event already happened, or its date is wrong" },
    { code: "SR3", label: "Duplicate of another story" },
    { code: "SR11", label: "Already printed in an earlier edition" },
    { code: "SR4", label: "Not a story (navigation page, listing, ad)" },
    { code: "SR12", label: "Advertising, sponsored or promotional" },
    { code: "SR13", label: "Opinion, editorial or letter" },
    { code: "SR5", label: "Too thin to write up" },
    { code: "SR14", label: "Paywalled or can't be read" },
    { code: "SR6", label: "Not newsworthy for residents" },
    { code: "SR15", label: "Routine listing or recurring notice with nothing new" },
    { code: "SR7", label: "Private or sensitive" },
    { code: "SR8", label: "Other (explain)" },
  ],
} as const;

/**
 * An accepted story needs a newsletter category (a section id from `sourcemap/sections.ts`), so a
 * story the pipeline dropped before placing it still says where it belongs. A rejected one may have one.
 */
export const CATEGORY_REQUIRED_FOR: ReadonlySet<string> = new Set(["accept"]);

export type StoryDecision = "accept" | "reject";
export type StoryReasonCode = (typeof STORY_REASONS)[keyof typeof STORY_REASONS][number]["code"];
export const STORY_OTHER_CODES: string[] = ["SA5", "SR8"];

export const storyDecisionOf = (code: string | null | undefined) =>
  STORY_REASONS.accept.some((reason) => reason.code === code) ? "accept" as const : STORY_REASONS.reject.some((reason) => reason.code === code) ? "reject" as const : null;
export const storyReasonLabel = (code: string | null | undefined) => [...STORY_REASONS.accept, ...STORY_REASONS.reject].find((reason) => reason.code === code)?.label ?? null;
