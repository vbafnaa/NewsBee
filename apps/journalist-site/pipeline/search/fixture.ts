/**
 * A local-only search provider, to exercise the agentic flow without a paid key. It answers
 * from the location's own source map, and from a `site:` target in the query. Anything it finds
 * is still fetched and checked. It says nothing about how well real search would do.
 */
import type { Db } from "mongodb";
import { runContext } from "../core/run-options";
import { sourceMap } from "../sourcemap/store";
import type { SearchResult } from "./provider";

const SECTION_TOPICS: Record<string, string> = { safety: "crime", obituaries: "deaths", events: "events", real_estate: "home_sales", schools: "sports", sports: "sports" };

export async function fixtureResults(db: Db, query: string, topic: string | null): Promise<SearchResult[]> {
  const hosted = /(?<!-)site:([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/i.exec(query)?.[1];
  const locationId = runContext()?.locationId;
  const mapped = locationId ? await sourceMap(db).find({ location_id: locationId, reader: "web", url: { $ne: null } }, { projection: { url: 1, name: 1, section: 1 } }).limit(60).toArray() : [];
  const known = mapped.filter((record) => !topic || SECTION_TOPICS[record.section] === topic).map((record) => [record.url!, record.name] as [string, string]);
  const list = hosted ? [[`https://${hosted}/`, hosted] as [string, string], ...known.filter(([url]) => url.includes(hosted))] : known;
  return list.slice(0, 8).map(([url, title], index) => ({ url, title, snippet: `Fixture result for: ${query}`.slice(0, 200), date: null, position: index + 1 }));
}
