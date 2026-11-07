/**
 * The fixed reasons for a source label. Codes are stable, so decisions can be counted across runs:
 * reword a label if needed, but never reuse a code. This file has no server imports, so the browser
 * and the store share it.
 */
export const REASONS = {
  accept: [
    { code: "A1", label: "Primary local record (official)" },
    { code: "A2", label: "Local original reporting" },
    { code: "A3", label: "Fills a topic gap" },
    { code: "A4", label: "Local organisation or business publishing its own updates" },
    { code: "A5", label: "Useful as a link only (lookup or dashboard)" },
    { code: "A6", label: "Other (explain)" },
  ],
  reject: [
    { code: "R1", label: "Not about this place" },
    { code: "R2", label: "Stale, not publishing" },
    { code: "R3", label: "Repost or aggregator" },
    { code: "R4", label: "Duplicate of a source already on the map" },
    { code: "R5", label: "Can't be read (blocked, JavaScript only, login)" },
    { code: "R6", label: "Paywall, terms or permission" },
    { code: "R7", label: "Wrong topic or not news" },
    { code: "R8", label: "Low quality or spam" },
    { code: "R9", label: "Other (explain)" },
  ],
} as const;

export type ReasonCode = (typeof REASONS)[keyof typeof REASONS][number]["code"];
export const OTHER_CODES: string[] = ["A6", "R9"];

export const isOtherReason = (code: string | null | undefined) => OTHER_CODES.includes(code ?? "");
export const decisionOf = (code: string) => REASONS.accept.some((reason) => reason.code === code) ? "accept" as const : REASONS.reject.some((reason) => reason.code === code) ? "reject" as const : null;
export const reasonLabel = (code: string | null | undefined) => [...REASONS.accept, ...REASONS.reject].find((reason) => reason.code === code)?.label ?? null;
