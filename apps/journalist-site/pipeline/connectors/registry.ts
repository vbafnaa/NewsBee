/**
 * Every connector the orchestrator can run, by source type. Swap or add a source type here.
 */
import type { LocationProfile, SourceTask, SourceType, Connector } from "./types";
import type { Settings } from "../core/config";
import { libraryConnector } from "./library";
import { meetingsConnector } from "./meetings";
import { hazardsConnector, stateNewsConnector, trendingConnector } from "./wider";
import { civicCalendarConnector } from "./civiccalendar";
import { homeSafetyConnector } from "./homesafety";
import { housingConnector } from "./housing";
import { developmentConnector } from "./development";
import { athleticsConnector } from "./athletics";
import { neighborhoodConnector } from "./neighborhood";

export const CONNECTORS: Record<SourceType, Connector> = {
  library: libraryConnector,
  meetings: meetingsConnector,
  hazards: hazardsConnector,
  statenews: stateNewsConnector,
  trending: trendingConnector,
  civiccalendar: civicCalendarConnector,
  homesafety: homeSafetyConnector,
  housing: housingConnector,
  development: developmentConnector,
  athletics: athleticsConnector,
  neighborhood: neighborhoodConnector,
};

/**
 * The orchestrator's source selection. For now every source type is "interesting"; a
 * later engagement feedback loop can rank and trim types per location here.
 */
export function selectSources(location: LocationProfile, settings: Settings, connectors: Record<SourceType, Connector> = CONNECTORS): SourceTask[] {
  return (Object.keys(connectors) as SourceType[]).flatMap((type) => connectors[type].sources(location, settings));
}
