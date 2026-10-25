import { compareKeys, type Story } from "../editions/stories";
import * as library from "./library";
import * as meetings from "./meetings";
import * as wider from "./wider";
import * as parents from "./parents";
import * as neighborhood from "../connectors/neighborhood";

export type Ranker = (stories: Story[]) => Story[];
export const RANKERS: Record<string, Ranker> = {
  library: library.rank,
  meetings: meetings.rank,
  hazards: wider.hazards,
  statenews: wider.stateNews,
  trending: wider.trending,
  civiccalendar: parents.civicCalendar,
  homesafety: parents.homeSafety,
  housing: parents.housing,
  development: parents.development,
  athletics: parents.athletics,
  neighborhood: neighborhood.rank,
};
export const sourceType = (sourceId: string) => sourceId.split(":", 1)[0];
export function soonest(stories: Story[]) { return [...stories].sort((a, b) => compareKeys([a.first.event_date, a.title], [b.first.event_date, b.title])); }
export function rank(kind: string, stories: Story[]) { return (RANKERS[kind] ?? soonest)(stories); }
export const hazards = wider.hazards;
export const stateNews = wider.stateNews;
export const trending = wider.trending;
