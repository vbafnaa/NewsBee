/**
 * What the source table shows. "Non-scrapable" is a display status derived from `link_only`, not a
 * SourceStatus: underneath, the source is still active, proposed or pinned, and collection skips it
 * because of `link_only`. This file has no server imports, so the browser and the store share it.
 */
import type { SourceRecord } from "./store";

export const NON_SCRAPABLE = "non-scrapable";
export const UNKNOWN_REASON = "Reason unknown";
/** These say something more useful than "non-scrapable", so they keep showing. */
const KEPT_STATUSES = ["rejected", "paused", "dormant"];

type LinkOnlyFields = Partial<Pick<SourceRecord, "link_only" | "why" | "source_kind">> & { access?: { robots?: string; rights?: string; fresh?: boolean } | null; found_by?: { detail?: string | null } };

export const displayStatus = (status: string, linkOnly?: boolean) => linkOnly && !KEPT_STATUSES.includes(status) ? NON_SCRAPABLE : status;
export const liveStatus = (source: { status: string; link_only?: boolean }) => displayStatus(source.status, source.link_only);

/** One count per source, so a non-scrapable source is never also counted as active or proposed. */
export function statusCounts(sources: Array<{ status: string; link_only?: boolean }>) {
  return sources.reduce<Record<string, number>>((all, source) => {
    const status = liveStatus(source);
    return { ...all, [status]: (all[status] ?? 0) + 1 };
  }, {});
}

/**
 * Why a link-only source isn't read, from what discovery stored. Structured fields come first; the
 * text checks match discovery's own `why` and `found_by.detail` wording, so a rewording there lands
 * on "Reason unknown" rather than a wrong reason. Platform comes before blocked and lookup because
 * platform leads also carry robots "blocked" and kind "lookup".
 */
export function nonScrapableReason(source: LinkOnlyFields) {
  if (!source.link_only) return null;
  const text = `${source.why ?? ""} ${source.found_by?.detail ?? ""}`;
  if (source.access?.rights === "link-only") return "Rights: headline and link only";
  if (/platform we don't read/i.test(text)) return "Blocked platform";
  if (source.access?.robots === "blocked" || /blocked from reading|blocked, kept as a link/i.test(text)) return "Blocked from reading";
  if (source.source_kind === "lookup" || /lookup or dashboard/i.test(text)) return "Lookup tool";
  if (source.access?.fresh === false || /no current dated items/i.test(text)) return "No current dates found";
  if (/agendas are PDFs/i.test(text)) return "Agendas are PDFs";
  return UNKNOWN_REASON;
}
