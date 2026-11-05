/**
 * "Today" in the location's calendar. Stage 1 used the local machine's date; serverless
 * runs on UTC, so each state maps to its most populous time zone instead.
 */
import { addDays } from "../connectors/common";

const STATE_ZONES: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago",
  UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver", PR: "America/Puerto_Rico",
};

export const WINDOW_DAYS = 7;

export function stateZone(state: string) {
  return STATE_ZONES[state.toUpperCase()] ?? "America/New_York";
}

export function localToday(state: string, now: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: stateZone(state),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Port of pipelines/events.window: the next WINDOW_DAYS days, starting tomorrow. */
export function ingestWindow(today: string): [string, string] {
  const first = addDays(today, 1);
  return [first, addDays(first, WINDOW_DAYS - 1)];
}

/**
 * First day of the edition period a run on `today` belongs to. Runs within one edition
 * window of each other (a rerun or restart in the same week) share a period: they may print
 * the same stories, and they look back to the edition before that period.
 */
export function editionPeriodStart(today: string) {
  return addDays(today, -(WINDOW_DAYS - 1));
}

/** Concrete date ranges for a connector's lookup window, both inclusive YYYY-MM-DD. */
export type LookupRanges = { back: [string, string] | null; ahead: [string, string] | null };

type Window = {
  back?: { days: number } | { since: "last_edition"; maxDays: number };
  ahead?: { days: number };
};

/**
 * Turn a connector's lookup window into date ranges. Looking back ends today; "since last
 * edition" starts on the day the location's last published edition was based on (the
 * published-story ledger drops anything that edition already printed), capped at maxDays
 * so a skipped week is caught up. A location's first edition looks back one edition window
 * (WINDOW_DAYS). Looking ahead starts tomorrow.
 */
export function lookupRanges(window: Window, today: string, lastEditionDay: string | null = null): LookupRanges {
  let back: [string, string] | null = null;
  if (window.back && "days" in window.back) back = [addDays(today, -window.back.days), today];
  else if (window.back) {
    const earliest = addDays(today, -window.back.maxDays);
    const firstEdition = addDays(today, -Math.min(WINDOW_DAYS, window.back.maxDays));
    const since = !lastEditionDay ? firstEdition : lastEditionDay > earliest ? lastEditionDay : earliest;
    back = [since < today ? since : today, today];
  }
  const ahead: [string, string] | null = window.ahead ? [addDays(today, 1), addDays(today, window.ahead.days)] : null;
  return { back, ahead };
}

/**
 * A connector's lookup ranges in this context: the orchestrator's, or (outside a run) its
 * window measured from today as for a location's first edition.
 */
export function rangesFor(context: { today: string; range?: LookupRanges }, window: Window): LookupRanges {
  return context.range ?? lookupRanges(window, context.today, null);
}
