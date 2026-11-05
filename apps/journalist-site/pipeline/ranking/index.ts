import { compareKeys, type Story } from "../editions/stories";
import { connectorFor } from "../connectors/registry";
import type { Ranker } from "../connectors/types";
import * as wider from "./wider";

export type { Ranker } from "../connectors/types";

/** Each connector's own ranker, by source type; unknown types fall back to soonest-first. */
export function rankerFor(kind: string): Ranker {
  return connectorFor(kind)?.rank ?? soonest;
}
export const sourceType = (sourceId: string) => sourceId.split(":", 1)[0];
export function soonest(stories: Story[]) { return [...stories].sort((a, b) => compareKeys([a.first.event_date, a.title], [b.first.event_date, b.title])); }
export function rank(kind: string, stories: Story[]) { return rankerFor(kind)(stories); }
export const hazards = wider.hazards;
export const stateNews = wider.stateNews;
export const trending = wider.trending;
