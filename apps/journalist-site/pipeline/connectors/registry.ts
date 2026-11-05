/**
 * Every connector the orchestrator can run, by source type. A connector describes itself
 * (meta, lookup window, ranker); the inventory, rankers, coverage note and edition
 * contract are all derived from this map, so adding a source type means adding its
 * connector here and its name to SourceType, nothing else.
 */
import type { LocationProfile, SourceTask, SourceType, Connector } from "./types";
import type { Settings } from "../core/config";
import { libraryConnector } from "./library";
import { meetingsConnector } from "./meetings";
import { hazardsConnector, trendingConnector } from "./wider";
import { homeSafetyConnector } from "./homesafety";
import { housingConnector } from "./housing";
import { remembranceConnector } from "./remembrance";
import { justiceConnector } from "./justice";
import { communityConnector } from "./neighbours";
import { webConnector } from "./web";
import { openDataConnector } from "./opendata";
import { newsSearchConnector } from "./newssearch";
import { propertyConnector } from "./property";
import { sweepConnector } from "./sweep";

/**
 * The reader registry. Each reader knows how to read one kind of source and how far back
 * and ahead to look (its window); which sources a location has lives in the source map.
 */
export const CONNECTORS: Record<SourceType, Connector> = {
  web: webConnector,
  opendata: openDataConnector,
  newssearch: newsSearchConnector,
  sweep: sweepConnector,
  property: propertyConnector,
  library: libraryConnector,
  meetings: meetingsConnector,
  hazards: hazardsConnector,
  trending: trendingConnector,
  homesafety: homeSafetyConnector,
  housing: housingConnector,
  remembrance: remembranceConnector,
  justice: justiceConnector,
  community: communityConnector,
};

/** The sources the API readers would run for a location (written to the source map by the "national" and "library" discovery methods). */
export function selectSources(location: LocationProfile, settings: Settings, connectors: Record<SourceType, Connector> = CONNECTORS): SourceTask[] {
  return (Object.keys(connectors) as SourceType[]).flatMap((type) => connectors[type].sources(location, settings));
}

/** Registered source types, in registry order. */
export const SOURCE_TYPES = Object.keys(CONNECTORS) as SourceType[];

/** The connector for a source type, or undefined for an unknown type. */
export function connectorFor(type: string): Connector | undefined {
  return (CONNECTORS as Record<string, Connector>)[type];
}

/** Every story kind any registered connector produces (the edition contract's kinds). */
export function storyKinds(connectors: Record<string, Connector> = CONNECTORS) {
  return new Set(Object.values(connectors).flatMap((connector) => connector.meta.storyKinds));
}

/** The connector source types whose results appear under a coverage group. */
export function coverageTypes(group: Connector["meta"]["coverage"]["group"], connectors: Record<string, Connector> = CONNECTORS) {
  return Object.values(connectors).filter((connector) => connector.meta.coverage.group === group);
}

/** A task's window: its reader's (by task, for open-data topics), then the source's own override. */
export function windowOf(connector: Connector, task: SourceTask) {
  const base = connector.windowFor?.(task) ?? connector.window ?? {};
  const override = task.params?.window as Connector["window"] | undefined;
  return override ? { back: override.back ?? base.back, ahead: override.ahead ?? base.ahead } : base;
}
