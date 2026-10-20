import type { Db } from "mongodb";
import type { Settings } from "../core/config";
import { listLocations } from "../communities/locations";
import { COLLECTIONS } from "../storage/mongo";
import { runs } from "../orchestration/runs";
import { CONNECTORS, selectSources } from "./registry";
import { manualLinks, manualTask } from "./manual-links";
import type { CachedLinks, SourceType } from "./types";

const DETAILS: Record<SourceType, { name: string; formats: string; manual: boolean }> = {
  library: { name: "Library events", formats: "Trumba RSS, iCalendar, JSON-LD event pages and BiblioCommons", manual: true },
  meetings: { name: "Government meetings", formats: "Legistar and CivicClerk tenant APIs", manual: true },
  hazards: { name: "Weather & earthquakes", formats: "National Weather Service alerts and USGS earthquake feeds", manual: false },
  statenews: { name: "State newsrooms", formats: "Agency RSS and Atom feeds, filtered for local relevance", manual: true },
  trending: { name: "Locally reported stories", formats: "Wikipedia topic discovery and Bluesky reporting links; town plus 15 miles, recent local reporting required", manual: false },
};

export async function connectorInventory(db: Db, settings: Settings) {
  const [locations, saved, cached] = await Promise.all([
    listLocations(db), manualLinks(db).find({}).sort({ created_at: 1 }).toArray(),
    db.collection<CachedLinks>(COLLECTIONS.linkCache).find({}).toArray(),
  ]);
  const sources = (await Promise.all(locations.map(async (location) => {
    const latest = await runs(db).findOne({ location_id: location.id }, { sort: { created_at: -1 } });
    const tasks = [...selectSources(location, settings), ...saved.filter((link) => link.location_id === location.id).map(manualTask)];
    return tasks.map((task) => ({
      ...task, location_id: location.id, location_name: location.name,
      enabled: !["hazards", "statenews", "trending"].includes(task.type) || settings.widerSources,
      latest: latest?.sources.find((source) => source.source_id === task.source_id) ?? null,
    }));
  }))).flat();
  return {
    connectors: Object.values(CONNECTORS).map(({ type }) => ({ id: type, ...DETAILS[type] })),
    locations: locations.map(({ id, name, systems }) => ({ id, name, systems: systems.map(({ fscskey, name }) => ({ fscskey, name })) })),
    sources, cached_links: cached.filter((link) => locations.some((location) => location.id === link.location_id)),
    manual_links: saved.filter((link) => locations.some((location) => location.id === link.location_id)),
  };
}

export type ConnectorInventory = Awaited<ReturnType<typeof connectorInventory>>;
