/**
 * Housing market from the Census Building Permits Survey place files: new residential units
 * authorized in the location's own Census place (matched on state FIPS and place code, so
 * Redmond, OR is never read as Redmond, WA). Market data only: no listings, sales or owners.
 */
import { monthName } from "../common";
import type { CollectedEvent, Connector, ConnectorContext, SourceResult, SourceTask } from "../types";
import { decode, fetchBytes, runCollector, skip, SourceUnavailable } from "../parents/shared";

export const BPS_BASE = "https://www2.census.gov/econ/bps/Place";
export const MONTHS_BACK = 4;
const ACCEPT_TEXT = "text/plain, text/csv";
const REGIONS: Record<string, [string, string]> = {};
for (const [folder, prefix, states] of [
  ["Northeast Region", "ne", "09 23 25 33 34 36 42 44 50"],
  ["Midwest Region", "mw", "17 18 19 20 26 27 29 31 38 39 46 55"],
  ["South Region", "so", "01 05 10 11 12 13 21 22 24 28 37 40 45 47 48 51 54"],
  ["West Region", "we", "02 04 06 08 15 16 30 32 35 41 49 53 56"],
] as const) for (const state of states.split(" ")) REGIONS[state] = [folder, prefix];

export type PlaceRow = { state: string; place: string; name: string; units: number; single: number; multi: number; value: number };
export type Period = { year: number; month: number };

export function placeGeoid(geoid: string | null | undefined): { state: string; place: string } | null {
  const match = /^(\d{2})(\d{5})$/.exec(String(geoid ?? "").trim());
  return match ? { state: match[1], place: match[2] } : null;
}
export function fileUrl(state: string, period: Period, kind: "c" | "y") {
  const [folder, prefix] = REGIONS[state];
  return `${BPS_BASE}/${encodeURIComponent(folder)}/${prefix}${String(period.year % 100).padStart(2, "0")}${String(period.month).padStart(2, "0")}${kind}.txt`;
}
function monthsBefore(today: string, months: number): Period {
  const [year, month] = today.split("-").map(Number);
  const index = year * 12 + (month - 1) - months;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}
const lastDay = (period: Period) => new Date(Date.UTC(period.year, period.month, 0)).toISOString().slice(0, 10);

/** Rows for one Census place. Places split across counties appear on several rows and are summed. */
export function parsePlace(text: string, state: string, place: string): PlaceRow | null {
  let found: PlaceRow | null = null;
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(",").map((cell) => cell.trim());
    if (cells.length < 29 || !/^\d{6}$/.test(cells[0]) || cells[1] !== state || cells[5] !== place) continue;
    // Monthly files have 12 count columns after the name, year-to-date files 24 (estimated, then reported).
    const nameEnd = 17 + ((cells.length - 29) % 12);
    const counts = cells.slice(nameEnd, nameEnd + 12).map((cell) => Number.parseInt(cell, 10) || 0);
    const single = counts[1], multi = counts[10];
    const units = single + counts[4] + counts[7] + multi;
    const value = counts[2] + counts[5] + counts[8] + counts[11];
    const name = cells.slice(16, nameEnd).join(", ");
    const prev: PlaceRow | null = found as PlaceRow | null;
    found = prev ? { ...prev, units: prev.units + units, single: prev.single + single, multi: prev.multi + multi, value: prev.value + value }
      : { state, place, name, units, single, multi, value };
  }
  return found;
}

export const housingConnector: Connector = {
  type: "housing",
  sources(location) {
    const geoid = placeGeoid(location.census_geoid);
    return geoid && REGIONS[geoid.state] && !location.community ? [{ source_id: "housing:census-bps", name: "New home permits (Census)", type: "housing" }] : [];
  },
  collect(task, context) { return runCollector(task, context, (record) => collectHousing(task, context, record)); },
};

async function fetchText(context: ConnectorContext, url: string): Promise<string | null> {
  try { return decode(await fetchBytes(context, url, ACCEPT_TEXT)); }
  catch (error) { if (error instanceof SourceUnavailable && error.status === "failed") return null; throw error; }
}

async function collectHousing(task: SourceTask, context: ConnectorContext, record: SourceResult): Promise<CollectedEvent[]> {
  const geoid = placeGeoid(context.location.census_geoid);
  if (!geoid || !REGIONS[geoid.state]) throw new SourceUnavailable("no_feed", "Location has no Census place GEOID");
  record.feed_kind = "census_bps"; record.website = "https://www.census.gov/construction/bps/";
  let period: Period | null = null, monthly: string | null = null;
  for (let back = 1; back <= MONTHS_BACK && !monthly; back += 1) {
    const candidate = monthsBefore(context.today, back);
    monthly = await fetchText(context, fileUrl(geoid.state, candidate, "c"));
    if (monthly) period = candidate;
  }
  if (!monthly || !period) throw new SourceUnavailable("no_feed", `No Building Permits Survey place file in the last ${MONTHS_BACK} months`);
  record.feed_url = fileUrl(geoid.state, period, "c");
  const month = parsePlace(monthly, geoid.state, geoid.place);
  if (!month) {
    skip(record, "place_not_in_survey");
    record.detail = `${monthName(period.month)} ${period.year} file has no row for Census place ${geoid.state}${geoid.place}`;
    return [];
  }
  const ytdText = await fetchText(context, fileUrl(geoid.state, period, "y"));
  const priorText = await fetchText(context, fileUrl(geoid.state, { year: period.year - 1, month: period.month }, "y"));
  const ytd = ytdText ? parsePlace(ytdText, geoid.state, geoid.place) : null;
  const prior = priorText ? parsePlace(priorText, geoid.state, geoid.place) : null;
  if (!month.units && !ytd?.units) { skip(record, "no_new_units"); record.detail = `${month.name}: no new housing units authorized in ${monthName(period.month)} ${period.year}`; return []; }
  record.detail = `${month.name}: ${month.units} units in ${monthName(period.month)} ${period.year}${ytd ? `, ${ytd.units} year to date` : ""}`;
  return [housingFacts(month, ytd, prior, period, record.feed_url, context.location.name.split(",")[0])];
}

const money = (value: number) => value >= 1e6 ? `$${(value / 1e6).toFixed(1)} million` : `$${Math.round(value / 1000).toLocaleString("en-US")},000`;
export function housingFacts(month: PlaceRow, ytd: PlaceRow | null, prior: PlaceRow | null, period: Period, url: string, town: string): CollectedEvent {
  const label = `${monthName(period.month)} ${period.year}`;
  const units = (count: number) => `${count.toLocaleString("en-US")} new housing unit${count === 1 ? "" : "s"}`;
  let description = `The U.S. Census Bureau's Building Permits Survey reports that ${town} authorized ${units(month.units)} in ${label}`;
  const parts = [month.single ? `${month.single} single-family` : "", month.multi ? `${month.multi} in buildings with five or more units` : ""].filter(Boolean);
  description += parts.length ? ` (${parts.join(" and ")})` : "";
  description += month.value ? `, with an estimated construction value of ${money(month.value)}.` : ".";
  let change: number | null = null;
  if (ytd) {
    description += ` So far in ${period.year}, ${units(ytd.units)} have been authorized`;
    if (prior) {
      description += `, compared with ${prior.units.toLocaleString("en-US")} by the same point in ${period.year - 1}`;
      if (prior.units > 0) change = Math.round(((ytd.units - prior.units) / prior.units) * 100);
    }
    description += ".";
  }
  description += " Census permit figures are estimates and can be revised.";
  const title = ytd && prior && change !== null && Math.abs(change) >= 5
    ? `New home permits in ${town} are ${change > 0 ? "up" : "down"} ${Math.abs(change)}% this year`
    : `${town} authorized ${units(month.units)} in ${label}`;
  return {
    source_event_id: `bps:${month.state}${month.place}:${period.year}${String(period.month).padStart(2, "0")}`,
    title, event_date: lastDay(period), schedule_text: label, venue: "U.S. Census Bureau Building Permits Survey", room: null,
    source_url: url, description, kind: "housing_market", tier: "local", section: `Housing in ${town}`,
    signals: { units: month.units, ytd_units: ytd?.units ?? 0, change_pct: change ?? 0 },
  };
}
