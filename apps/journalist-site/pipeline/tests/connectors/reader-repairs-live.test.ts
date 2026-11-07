/** Opt-in, read-only connector audit using the archived independent discovery map. */
import { it } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchTransport } from "../../core/http";
import { Fetcher } from "../../connectors/fetcher";
import { webConnector } from "../../connectors/web";
import { newsSearchConnector } from "../../connectors/newssearch";
import { communityFeeds, discoverReports } from "../../connectors/wider/trend-context";
import { resolveTrendRegion } from "../../connectors/wider/regions";
import { reportingSearches } from "../../connectors/wider/trend-discovery";
import type { ConnectorContext, SourceTask } from "../../connectors/types";
it.skipIf(process.env.NEWSBEE_READER_LIVE !== "1")("audits repaired readers against real endpoints", async () => {
  const root = resolve('../..');
  const evidence = resolve(root, 'research/evidence/reader_repairs', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(evidence, { recursive: true });
  const load = (name: string) => JSON.parse(readFileSync(resolve(root, 'research/evidence/directory_independent', name + '.json'), 'utf8'));
  const location = load('locations')[0];
  const sources = load('source_map');
  const log = { info() {}, warn() {}, error() {} };
  const db = { collection: () => ({ find: () => ({ limit: () => ({ toArray: async () => sources.filter((s: { reader: string; section: string; status: string }) => s.reader === 'web' && s.section === 'community' && ['active','pinned'].includes(s.status)) }) }), updateOne: async () => {} }) };
  const ctx = { today: '2026-11-06', location, db, transport: fetchTransport, fetcher: new Fetcher(fetchTransport), settings: { integrations: {} }, log } as unknown as ConnectorContext;
  const results: unknown[] = [];
  const save = () => writeFileSync(resolve(evidence, 'results.json'), JSON.stringify({ checked_at: new Date().toISOString(), scope: 'Real connectors, archived independent source map; no orchestration, locality model, publication or database writes', results }, null, 2));
  for (const url of ['https://wedgwoodes.seattleschools.org/calendar/', 'https://www.spl.org/hours-and-locations/northeast-branch/northeast-branch-events']) {
    const source = sources.find((s: { url: string }) => s.url === url);
    if (!source) throw new Error('URL not found in independent map: ' + url);
    const task = { source_id: source.source_id, name: source.name, type: 'web', params: { ...source.params, url, inside_area: false } } as SourceTask;
    results.push({ component: url, ...await webConnector.collect(task, { ...ctx, deadline: Date.now() + 75000 }) }); save();
  }
  try {
    const fallback = await communityFeeds(ctx);
    const place = resolveTrendRegion(location, { WA: { name: 'Washington', places: { Seattle: [47.6062, -122.3321] } } });
    const reporting = await discoverReports(ctx, place, reportingSearches(place), fallback.feeds);
    results.push({ component: 'community_reporting', fallback, ...reporting });
  } catch (error) { results.push({ component: 'community_reporting', error: String(error) }); }
  save();
  try { results.push({ component: 'gdelt', ...await newsSearchConnector.collect({ source_id: 'newssearch:gdelt', name: 'GDELT', type: 'newssearch', params: { backend: 'gdelt' } }, ctx) }); }
  catch (error) { results.push({ component: 'gdelt', error: String(error), status: (error as {status?: number}).status, retryAfterSeconds: (error as {retryAfterSeconds?: number}).retryAfterSeconds }); }
  save(); console.log('Live audit saved:', evidence);
}, 300000);
