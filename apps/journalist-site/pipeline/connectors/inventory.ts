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
  statenews: { name: "Community and state newsrooms", formats: "Reviewed local publisher and agency RSS/Atom feeds, filtered for community relevance", manual: true },
  trending: { name: "Locally reported stories", formats: "Automated community, coverage-term and selected-venue searches on Bluesky, discovered community RSS/Atom feeds, and optional Wikipedia attention discovery; recent reporting with explicit community evidence required", manual: false },
    civiccalendar: { name: "City & parks calendars", formats: "CivicPlus calendar iCalendar feeds from the city website, community and parks categories only", manual: true },
    homesafety: { name: "Home & water safety", formats: "EPA Safe Drinking Water health-based violations for community water systems serving the county", manual: false },
    housing: { name: "Housing market", formats: "Census Building Permits Survey monthly place file (new residential units and value)", manual: false },
    development: { name: "Development & permits", formats: "Socrata open-data building permit datasets within 15 km (new construction, demolition, multi-unit)", manual: false },
    athletics: { name: "School athletics", formats: "Reviewed state athletic association RSS feeds; team-level results only, no student names", manual: false },
    neighborhood: { name: "Neighborhood sites found automatically", formats: "RSS/Atom feeds and event calendars (iCalendar, Trumba) of schools, libraries, community centers, faith communities, museums, parks and local news sites found inside the area through OpenStreetMap and Wikipedia, rediscovered weekly", manual: false },
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
    locations: locations.map(({ id, name, systems, community, source_coverage }) => ({
      id, name, systems: systems.map(({ fscskey, name, branches }) => ({ fscskey, name, branches })),
      community: community ? { parent_name: community.parent_name, jurisdiction_resolved: !community.geography || !!community.parent_kind,
        coverage_terms: community.coverage_terms, newsrooms: community.newsrooms } : null,
      source_coverage,
    })),
    sources, cached_links: cached.filter((link) => locations.some((location) => location.id === link.location_id)),
    manual_links: saved.filter((link) => locations.some((location) => location.id === link.location_id)),
  };
}

export type ConnectorInventory = Awaited<ReturnType<typeof connectorInventory>>;
