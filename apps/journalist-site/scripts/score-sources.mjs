#!/usr/bin/env node
/**
 * Scores a location's source map against a list people researched by hand. The list stays out
 * of the code: it is test data for one trial, and the pipeline must find sources for any place.
 *
 *   node scripts/score-sources.mjs <location id> <file of URLs, one per line>
 *
 * A source counts as found on the exact page, the same dataset, or an endpoint of that page.
 * Same-site matches are listed apart, because a home page isn't the page someone asked for.
 * Reads NEWSBEE_MONGODB_URI and NEWSBEE_MONGODB_DB, or the local stack's database. Read-only.
 */
import { readFile } from "node:fs/promises";
import { MongoClient } from "mongodb";

const [locationId, file] = process.argv.slice(2);
if (!locationId || !file) { console.error("Usage: node scripts/score-sources.mjs <location id> <file of URLs>"); process.exit(1); }

const normal = (url) => { try { const parsed = new URL(url); return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`; } catch { return ""; } };
const host = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const dataset = (url) => /\/([a-z0-9]{4}-[a-z0-9]{4})(?:\/|$)/.exec(url ?? "")?.[1] ?? null;

const wanted = [...new Set((await readFile(file, "utf8")).split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]).filter((line) => line.startsWith("http")))];
const client = await MongoClient.connect(process.env.NEWSBEE_MONGODB_URI ?? "mongodb://127.0.0.1:27027");
const map = await client.db(process.env.NEWSBEE_MONGODB_DB ?? "newsbee").collection("source_map").find({ location_id: locationId, status: { $ne: "rejected" } }).toArray();
await client.close();

const pages = new Set(map.flatMap((source) => [normal(source.url), normal(source.feed_url)]).filter(Boolean));
const hosts = new Set(map.map((source) => host(source.url)).filter(Boolean));
const datasets = new Set(map.map((source) => dataset(source.url)).filter(Boolean));
const found = [], sameSite = [], missed = [];
for (const url of wanted) {
  const id = dataset(url);
  if (pages.has(normal(url)) || (id && datasets.has(id))) found.push(url);
  else if (hosts.has(host(url))) sameSite.push(url);
  else missed.push(url);
}
const wantedHosts = new Set(wanted.map(host));
const extras = map.filter((source) => source.url && !wantedHosts.has(host(source.url)));
const yielding = map.filter((source) => (source.health?.items_local ?? 0) > 0);
const share = (count) => `${count} of ${wanted.length} (${wanted.length ? Math.round(count / wanted.length * 100) : 0}%)`;

console.log(`${locationId}: ${map.length} sources on the map, ${yielding.length} have returned a local item`);
console.log(`Found: ${share(found.length)}`);
console.log(`Same site, different page: ${share(sameSite.length)}`);
console.log(`Missed: ${share(missed.length)}`);
for (const [label, list] of [["FOUND", found], ["SAME SITE", sameSite], ["MISSED", missed]]) for (const url of list) console.log(`  ${label.padEnd(9)} ${url}`);
console.log(`\nOn the map but not on the list, for people to review (${extras.length}):`);
for (const source of extras) console.log(`  ${source.status} ${source.source_tier ?? "-"} ${source.scope ?? "-"} ${source.source_kind ?? "-"} ${source.url}`);
