// Human-assisted intake, explicitly NOT independent discovery. Local-only, no publication.
// Run after saving the unseeded snapshot: node research/validate_registry_sources.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const base = 'http://127.0.0.1:3001';
const location = 'osm-r13915552-wa';
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const inventory = read('evidence/human_inventory.json');
const machine = read('evidence/improved_independent/source_map.json');
const output = new URL('evidence/assisted_validation/', import.meta.url);
mkdirSync(output, { recursive: true });
function key(raw) {
  const u = new URL(raw); const host = u.hostname.replace(/^www\./, '');
  const id = u.pathname.match(/\b([a-z0-9]{4}-[a-z0-9]{4})\b/);
  return host + (id && host.startsWith('data.') ? '/dataset/' + id[1] : u.pathname.replace(/\/$/, '') + u.search);
}
const known = new Set(machine.flatMap(s => [s.url, s.feed_url].filter(Boolean).map(key)));
const results = [], jobs = [];
for (const row of inventory) {
  const n = row.registry_rows[0];
  const reason = row.Category.includes('Obituaries') ? 'No publisher permission documented for obituary intake; not fabricated'
    : [129,134].includes(n) ? 'Physical notices/archive, not digitized contents'
    : n === 136 ? 'Discussion-feed access not established'
    : n === 135 ? 'Historical archive, not a current-news intake target'
    : known.has(key(row.URL)) ? 'Already present in independent map; preserve automated provenance' : null;
  if (reason) results.push({ registry_rows: row.registry_rows, url: row.URL, status: 'not_attempted', reason });
  else jobs.push(row);
}
function save() { writeFileSync(new URL('results.json', output), JSON.stringify({ mode: 'human-assisted registry intake', base, location, updated_at: new Date().toISOString(), results }, null, 2)); }
save();
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const row = jobs[next++];
    let section = row.Category.includes('Schools') ? 'schools' : row.Category.includes('Crime') ? 'safety' : row.Category.includes('Home sales') ? 'real_estate' : row.Category.includes('Businesses') ? 'business' : row.Category.includes('Government') ? 'civic' : row.Category.includes('Events') ? 'events' : row.Category.includes('Sports') ? 'sports' : 'community';
    const dataset = /(?:data\.seattle\.gov|data\.kingcounty\.gov).*\b[a-z0-9]{4}-[a-z0-9]{4}\b/.test(row.URL);
    const body = { name: row.Source.slice(0,120), url: row.URL, type: dataset ? 'opendata' : 'web', section, inside_area: false,
      ...(dataset ? { topic: section === 'safety' ? 'police' : section === 'business' ? 'inspections' : 'permits', filter: 'radius' } : {}),
      note: `Human-assisted comparison intake. Registry rows ${row.registry_rows.join(', ')}. Source candidate only; item locality and usefulness remain to be checked. No publication authorized.` };
    try {
      const response = await fetch(`${base}/api/admin/locations/${location}/links`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      const result = await response.json();
      results.push({ registry_rows: row.registry_rows, url: row.URL, status: response.ok ? 'validated_and_saved' : 'rejected', http_status: response.status, input: body, result });
      console.log(JSON.stringify({ url: row.URL, status: results.at(-1).status, events: result.link?.validated_events, detail: result.detail ?? result.link?.detail }));
    } catch (error) { results.push({ registry_rows: row.registry_rows, url: row.URL, status: 'request_failed', reason: String(error) }); }
    save();
  }
}
await Promise.all(Array.from({ length: 3 }, worker));
console.log(JSON.stringify({ completed: results.length, saved: results.filter(x => x.status === 'validated_and_saved').length }));
