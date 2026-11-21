/**
 * Website depth 1 against depth 2 on a location's real websites: runs the web reader on each active
 * website source on the local source map at both depths and prints what each found, what only depth 2
 * found, and what both cost in requests. Reads the local database (`npm run local`); writes only to a
 * throwaway database that is dropped afterwards. The plain flow makes no model or paid calls; with
 * --agentic the configured light model reads the pages the rules can't (at most two per source).
 *
 *   npm run web:depth -- --location osm-r237814-wa [--sources downtownmoseslake,bigbend] [--agentic] [--out depth.json]
 */
import { existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { MongoClient } from "mongodb";
import { readSite } from "../pipeline/connectors/web";
import { Fetcher } from "../pipeline/connectors/fetcher";
import { sourceResult, type CollectedEvent, type DroppedItem } from "../pipeline/connectors/types";
import { getLocation } from "../pipeline/communities/locations";
import { lightSettings, loadSettings } from "../pipeline/core/config";
import { fetchTransport, type HttpTransport } from "../pipeline/core/http";
import { defaultRunOptions, withRunContext } from "../pipeline/core/run-options";
import { createRuntime } from "../pipeline/model/runtime";
import { taskFor, type SourceRecord } from "../pipeline/sourcemap/store";

const { values } = parseArgs({ options: {
  location: { type: "string" }, sources: { type: "string" }, agentic: { type: "boolean", default: false },
  out: { type: "string" }, concurrency: { type: "string", default: "4" }, mongo: { type: "string", default: "mongodb://127.0.0.1:27027" },
} });
if (!values.location) throw new Error("Use --location <location id>; add --sources <part of a URL,...> to read only some sources.");
// Keys for --agentic come from the git-ignored .env.local, as for `npm run local`.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const client = await MongoClient.connect(values.mongo!, { serverSelectionTimeoutMS: 5000 });
const scratch = client.db("newsbee-depth-compare");
try {
  await scratch.dropDatabase();
  const live = client.db("newsbee");
  const location = await getLocation(live, values.location);
  const only = (values.sources ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const sources = (await live.collection<SourceRecord>("source_map").find({ location_id: values.location, status: "active", reader: "web" }).toArray())
    .filter((source) => !only.length || only.some((part) => (source.url ?? "").includes(part)));
  const settings = loadSettings({ ...process.env, NEWSBEE_MODE: "local" });
  let modelCalls = 0;
  const agentModel = values.agentic ? createRuntime(lightSettings(settings, { NODE_ENV: process.env.NODE_ENV }), fetchTransport, undefined, { role: "agent", sink: async () => { modelCalls += 1; } }) : null;
  const today = new Date().toISOString().slice(0, 10);
  console.log(`${location.name}: ${sources.length} website sources, ${values.agentic ? "agentic" : "plain (no model calls)"}`);

  const read = async (source: SourceRecord, depth: 1 | 2) => {
    const deadline = Date.now() + 150_000;
    let requests = 0;
    const transport: HttpTransport = async (request) => { requests += 1; return fetchTransport(request); };
    const record = sourceResult(source.source_id, source.name, "ingested", "");
    const dropped: DroppedItem[] = [];
    const context = { today, transport, fetcher: new Fetcher(transport, undefined, true, deadline), settings, db: scratch, location, deadline,
      log: { info() {}, warn() {}, error() {} }, ...(agentModel ? { agentModel } : {}) } as never;
    const options = { ...defaultRunOptions(process.env), flow: values.agentic ? "agentic" as const : "current" as const, scrape_depth: depth, ...(values.agentic ? {} : { paid: {} }) };
    let items: CollectedEvent[] = [];
    try { items = await withRunContext({ db: scratch, runId: `depth-${depth}`, locationId: location.id, options } as never, () => readSite(taskFor(source), context, record, dropped)); }
    catch (error) { record.detail = `failed: ${error instanceof Error ? error.message : String(error)}`; }
    return { requests, detail: record.detail, items, dropped };
  };

  const results: Array<{ source: SourceRecord; one: Awaited<ReturnType<typeof read>>; two: Awaited<ReturnType<typeof read>> }> = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, async () => {
    while (next < sources.length) {
      const source = sources[next++];
      const one = await read(source, 1), two = await read(source, 2);
      results.push({ source, one, two });
      console.log(`${String(results.length).padStart(3)}/${sources.length} ${source.name.slice(0, 48).padEnd(48)} depth 1: ${String(one.items.length).padStart(3)} items, ${String(one.requests).padStart(3)} requests | depth 2: ${String(two.items.length).padStart(3)} items, ${String(two.requests).padStart(3)} requests`);
    }
  }));

  const key = (item: CollectedEvent) => `${item.source_url}|${item.title}`;
  const total = (pick: (row: typeof results[number]) => number) => results.reduce((sum, row) => sum + pick(row), 0);
  console.log(`\nDepth 1: ${total((row) => row.one.items.length)} items, ${total((row) => row.one.requests)} requests. Depth 2: ${total((row) => row.two.items.length)} items, ${total((row) => row.two.requests)} requests.${values.agentic ? ` ${modelCalls} model calls.` : ""}`);
  console.log("Only at depth 2:");
  for (const { source, one, two } of results) {
    const seen = new Set(one.items.map(key));
    for (const item of two.items.filter((found) => !seen.has(key(found)))) console.log(`  ${item.event_date} ${(item.kind ?? "").padEnd(12)} ${item.title.slice(0, 70)} (${source.name}; ${item.found_via ?? item.found_by ?? "read"}${item.found_on ? ` on ${item.found_on}` : ""})`);
  }
  const reasons = new Map<string, number>();
  for (const { two } of results) for (const row of two.dropped) { const reason = String(row.reason).split(/[:(]/)[0].trim(); reasons.set(reason, (reasons.get(reason) ?? 0) + 1); }
  console.log("Left out at depth 2, by reason:", [...reasons].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${reason} ${count}`).join(", ") || "none");
  if (values.out) writeFileSync(values.out, JSON.stringify(results.map(({ source, one, two }) => ({ source: source.name, url: source.url, one, two })), null, 1));
} finally {
  await scratch.dropDatabase().catch(() => undefined);
  await client.close();
}
