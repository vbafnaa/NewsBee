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
    { code: "SA5", label: "Other (explain)" },
  ],
  reject: [
    { code: "SR1", label: "Not about this place" },
    { code: "SR2", label: "Old news or outside the window" },
    { code: "SR3", label: "Duplicate of another story" },
    { code: "SR4", label: "Not a story (navigation page, listing, ad)" },
    { code: "SR5", label: "Too thin to write up" },
    { code: "SR6", label: "Not newsworthy for residents" },
    { code: "SR7", label: "Private or sensitive" },
    { code: "SR8", label: "Other (explain)" },
  ],
} as const;

export type StoryDecision = "accept" | "reject";
export type StoryReasonCode = (typeof STORY_REASONS)[keyof typeof STORY_REASONS][number]["code"];
export const STORY_OTHER_CODES: string[] = ["SA5", "SR8"];

export const storyDecisionOf = (code: string | null | undefined) =>
  STORY_REASONS.accept.some((reason) => reason.code === code) ? "accept" as const : STORY_REASONS.reject.some((reason) => reason.code === code) ? "reject" as const : null;
export const storyReasonLabel = (code: string | null | undefined) => [...STORY_REASONS.accept, ...STORY_REASONS.reject].find((reason) => reason.code === code)?.label ?? null;
