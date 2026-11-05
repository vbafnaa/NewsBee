import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, rm } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { Store, groupUrl, nextOccurrence, validSchedule, type Group, type Run } from './store.js';
import { manualLookbackHours, type ManualLookbackHours } from './manual-lookback.js';
import { collect, connect, connected } from './browser.js';
import { ActivityLog } from './activity.js';
import { diagnoseLayout } from './gemini.js';
import type { RunDiagnostics } from './diagnostics.js';

try { loadEnvFile(resolve('.local/config.env')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

const port = Number(process.env.NEWS_COLLECTOR_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const host = `127.0.0.1:${port}`;
const store = new Store(resolve('.local/data'));
const screenshotRoot = resolve('.local/data/screenshots');
async function pruneScreenshots() {
  const snapshot = store.snapshot();
  const runs = new Map(snapshot.runs.map(run => [run.id, new Set(run.posts?.map(post => post.screenshot).filter(Boolean) || [])]));
  for (const post of snapshot.posts) if (post.screenshotRunId && post.screenshot) {
    if (!runs.has(post.screenshotRunId)) runs.set(post.screenshotRunId, new Set());
    runs.get(post.screenshotRunId)?.add(post.screenshot);
  }
  for (const directory of await readdir(screenshotRoot, { withFileTypes: true }).catch(() => [])) {
    if (!directory.isDirectory() || !/^[a-f0-9-]{36}$/.test(directory.name)) continue;
    const folder = resolve(screenshotRoot, directory.name);
    if (!runs.has(directory.name)) { await rm(folder, { recursive: true, force: true }); continue; }
    const files = await readdir(folder);
    for (const file of files) if (/^(?:chronological|recent)-\d{1,2}-\d{1,3}\.png$/.test(file) && !runs.get(directory.name)?.has(file)) await rm(resolve(folder, file), { force: true });
  }
}
const csrf = randomUUID();
let running = false;
let draining = false;
let drainTask: Promise<void> | undefined;
let stopping = false;
let lastError: string | undefined;
const active = new Set<string>();
const activity = new ActivityLog();

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 8192) throw new Error('Request too large'); }
  const parsed: unknown = data ? JSON.parse(data) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request');
  return parsed as Record<string, unknown>;
}
async function enqueue(groupId: string, lookbackHours: ManualLookbackHours): Promise<Run> {
  const queuedAt = new Date().toISOString();
  const entry: Run = { id: randomUUID(), groupId, lookbackHours, queuedAt, status: 'queued', count: 0, posts: [] };
  await store.update(s => {
    if (!s.groups.some(g => g.id === groupId)) throw new Error('Unknown group');
    if (s.runs.filter(r => r.status === 'queued').length >= 50) throw new Error('Run queue is full (50 pending runs)');
    s.runs.push(entry);
    const group = s.groups.find(g => g.id === groupId)!;
    if (group.schedule && group.nextRunAt && Date.parse(group.nextRunAt) <= Date.parse(queuedAt)) group.nextRunAt = nextOccurrence(group.schedule, Date.parse(queuedAt));
  });
  scheduleDrain();
  return entry;
}
async function run(entry: Run, group: Group): Promise<void> {
  running = true; active.add(group.id);
  const started = Date.now();
  const elapsed = () => ({ elapsedMs: Date.now() - started });
  activity.add(group.id, 'started', entry.id);
  let scanning = false;
  const heartbeat = setInterval(() => { if (scanning) activity.add(group.id, 'waiting', entry.id, elapsed()); }, 10000);
  let status = 'failed'; let reason: string | undefined; let count = 0; let diagnostics: RunDiagnostics | undefined;
  try {
    const result = await collect(group, stage => { scanning = stage.startsWith('scanning'); activity.add(group.id, stage, entry.id, elapsed()); }, entry.lookbackHours ?? 168, entry.cutoffAt, entry.id);
    scanning = false;
    status = result.status;
    diagnostics = result.diagnostics;
    activity.add(group.id, 'layout', entry.id, { ...elapsed(), layout: result.layout });
    if (status === 'partial_disconnect') reason = 'The browser scan stopped early (connection loss or timeout); posts from completed scans were saved. Check Chrome and queue another run to cover the missing portion.';
    else if (status === 'partial_second_step') reason = 'The recent-activity second step failed or required sign-in; the chronological scan was retained. Review the run diagnostics and retry.';
    else if (status === 'partial_comments_only') reason = 'Comment-labeled articles were detected, but no original post bodies were verified. Gemini is not needed to classify this result.';
    else if (status === 'partial_feed_unloaded') reason = 'Feed articles remained empty placeholders after waiting for hydration; retry when the group feed has loaded. Gemini cannot inspect the missing content.';
    else if (result.posts.length === 0 && (status.startsWith('partial') || status === 'layout_unsupported') && process.env.GEMINI_LAYOUT_ASSIST === '1' && process.env.GEMINI_API_KEY) {
      activity.add(group.id, 'analyzing', entry.id, elapsed());
      reason = await diagnoseLayout(result.layout, { enabled: true, apiKey: process.env.GEMINI_API_KEY });
    }
    if (status === 'login_required') reason = 'Log in or complete the browser challenge manually';
    else if (status.startsWith('partial')) { activity.add(group.id, 'saving', entry.id, elapsed()); count = await store.recordRunPosts(group, entry.id, result.posts); }
  } catch (error) { reason = error instanceof Error ? error.message : 'Collection failed'; lastError = reason; }
  finally {
    clearInterval(heartbeat);
    const finishedAt = new Date().toISOString();
    try { await store.update(s => { const r = s.runs.find(x => x.id === entry.id); if (r) Object.assign(r, { finishedAt, status, count, reason, diagnostics }); const g = s.groups.find(x => x.id === group.id); if (g) { g.lastRun = finishedAt; g.lastStatus = status; if (g.schedule && g.nextRunAt && Date.parse(g.nextRunAt) <= Date.parse(finishedAt)) g.nextRunAt = nextOccurrence(g.schedule, Date.parse(finishedAt)); } }); }
    finally { activity.add(group.id, status === 'failed' ? 'failed' : 'completed', entry.id, { ...elapsed(), status, count }); running = false; active.delete(group.id); }
  }
  await pruneScreenshots().catch(() => undefined);
}
async function drain(): Promise<void> {
  if (draining || stopping) return;
  draining = true;
  try {
    while (!stopping) {
      const entry = store.snapshot().runs.find(r => r.status === 'queued');
      if (!entry) break;
      const group = store.snapshot().groups.find(g => g.id === entry.groupId);
      if (!group) {
        await store.update(s => { const r = s.runs.find(x => x.id === entry.id); if (r) Object.assign(r, { status: 'cancelled', finishedAt: new Date().toISOString(), reason: 'Group no longer exists' }); });
        continue;
      }
      const claimed = await store.claimRun(entry.id);
      if (!claimed) continue;
      try { await run(claimed, group); }
      catch (error) {
        lastError = error instanceof Error ? error.message : 'Run could not be saved';
        await store.update(s => {
          const r = s.runs.find(x => x.id === entry.id);
          if (r?.status === 'running') Object.assign(r, { status: 'failed', finishedAt: new Date().toISOString(), reason: lastError });
        });
      }
    }
  } finally { draining = false; }
}
function scheduleDrain() {
  if (drainTask || stopping) return;
  let failed = false;
  drainTask = drain().catch(error => { failed = true; lastError = error instanceof Error ? error.message : 'Queue failed'; })
    .finally(() => { drainTask = undefined; if (!failed && !stopping && store.snapshot().runs.some(r => r.status === 'queued')) scheduleDrain(); });
}
async function recoverRunning(reason: string) {
  if (!store.snapshot().runs.some(r => r.status === 'running')) return;
  await store.update(s => { for (const r of s.runs) if (r.status === 'running') Object.assign(r, { status: 'failed', finishedAt: new Date().toISOString(), reason }); });
}
async function tick() {
  if (stopping) return;
  await store.cleanup();
  if (!drainTask && !running) await recoverRunning('Run interrupted before completion');
  scheduleDrain();
  if (store.snapshot().paused || stopping) return;
  if ((await store.queueDueRuns()).length) scheduleDrain();
}

function deletionRange(url: URL): { from?: string; to?: string } {
  const parse = (key: string): string | undefined => {
    const value = url.searchParams.get(key);
    if (value === null) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`Invalid ${key} date`);
    return value;
  };
  if ([...url.searchParams.keys()].some(key => key !== 'from' && key !== 'to')) throw new Error('Unexpected date range parameter');
  const from = parse('from'); const to = parse('to');
  if (from && to && from >= to) throw new Error('End date must be after start date');
  return { from, to };
}
async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`)) { json(res, 403, { error: 'Local origin only' }); return; }
  const method = req.method || 'GET';
  if (!['GET','HEAD'].includes(method) && req.headers['x-collector-token'] !== csrf) { json(res, 403, { error: 'Invalid local request token' }); return; }
  const path = url.pathname;
  if (method === 'GET' && path === '/api/status') return json(res, 200, { connected: connected(), running, queued: store.snapshot().runs.filter(r => r.status === 'queued').length, paused: store.snapshot().paused, lastError, token: csrf, scheduleCheckMinutes: 1, manualLookbackHours: 1, scheduledLookback: 'previous_run' });
  if (method === 'GET' && path === '/api/groups') return json(res, 200, { groups: store.snapshot().groups });
  if (method === 'GET' && path === '/api/posts') return json(res, 200, store.posts(url.searchParams.get('groupId') || undefined, url.searchParams.get('q')?.slice(0,200), Math.min(1000, Math.max(0, Number(url.searchParams.get('page') || 0) || 0))));
  const linkMatch = path.match(/^\/api\/groups\/([a-f0-9-]+)\/posts\/(local-[a-f0-9]{64})\/permalink$/);
  if (method === 'PATCH' && linkMatch) {
    const value = await body(req);
    if (typeof value.permalink !== 'string' || Object.keys(value).some(key => key !== 'permalink')) throw new Error('Provide one post permalink');
    return json(res, 200, { post: await store.linkPost(linkMatch[1], linkMatch[2], value.permalink) });
  }
  if (method === 'GET' && path === '/api/export') {
    const groupId = url.searchParams.get('groupId');
    const group = store.snapshot().groups.find(g => g.id === groupId);
    if (!group) return json(res, 404, { error: 'Unknown group' });
    const rangeUrl = new URL(url); rangeUrl.searchParams.delete('groupId');
    const { from, to } = deletionRange(rangeUrl);
    const posts = store.snapshot().posts.filter(p => p.groupId === group.id && (!from || p.observedAt >= from) && (!to || p.observedAt < to));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="group-posts-${group.id}.json"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    return res.end(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), group: { id: group.id, name: group.name, url: group.url }, range: { from: from || null, toExclusive: to || null }, posts }, null, 2));
  }
  if (method === 'GET' && path === '/api/runs') return json(res, 200, { runs: store.runs() });
  const attachmentMatch = path.match(/^\/api\/runs\/([a-f0-9-]+)\/diagnostics$/);
  if (method === 'GET' && attachmentMatch) {
    const run = store.run(attachmentMatch[1]);
    if (!run?.diagnostics) return json(res, 404, { error: 'Diagnostic attachment unavailable for this run' });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="run-${run.id}-diagnostics.json"`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    return res.end(JSON.stringify({ runId: run.id, status: run.status, diagnostics: run.diagnostics }, null, 2));
  }
  const screenshotMatch = path.match(/^\/api\/runs\/([a-f0-9-]{36})\/screenshots\/((?:chronological|recent)-\d{1,2}-\d{1,3}\.png)$/);
  if (method === 'GET' && screenshotMatch) {
    const [runId, filename] = screenshotMatch.slice(1);
    const run = store.run(runId);
    const inRun = run?.posts?.some(post => !post.publishedAt && post.screenshot === filename);
    const inArchive = store.snapshot().posts.some(post => !post.publishedAt && post.screenshotRunId === runId && post.screenshot === filename);
    if (!inRun && !inArchive) return json(res, 404, { error: 'Screenshot unavailable' });
    try {
      const image = await readFile(resolve(screenshotRoot, runId, filename));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
      return res.end(image);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return json(res, 404, { error: 'Screenshot unavailable' });
      throw error;
    }
  }
  const runMatch = path.match(/^\/api\/runs\/([a-f0-9-]+)$/);
  if (method === 'GET' && runMatch) { const run = store.run(runMatch[1]); return run ? json(res, 200, { run }) : json(res, 404, { error: 'Run not found' }); }
  if (method === 'GET' && path === '/api/activity') return json(res, 200, { entries: activity.snapshot() });
  if (method === 'POST' && path === '/api/connect') { await connect(); return json(res, 200, { connected: true }); }
  if (method === 'POST' && path === '/api/pause') { const value = await body(req); if (typeof value.paused !== 'boolean') throw new Error('Invalid pause value'); await store.update(s => { s.paused = value.paused as boolean; }); return json(res, 200, { paused: value.paused }); }
  if (method === 'POST' && path === '/api/groups') { const value = await body(req); if (typeof value.url !== 'string' || typeof value.name !== 'string') throw new Error('Group URL and name required'); groupUrl(value.url); const group = await store.addGroup(value.url, value.name); return json(res, 201, group); }
  const match = path.match(/^\/api\/groups\/([a-f0-9-]+)(?:\/(run|runs|posts|schedule))?$/);
  if (match) {
    const group = store.snapshot().groups.find(g => g.id === match[1]);
    if (!group) return json(res, 404, { error: 'Unknown group' });
    if (method === 'PATCH' && !match[2]) {
      const value = await body(req);
      if (typeof value.name !== 'string' || Object.keys(value).some(key => key !== 'name')) throw new Error('Only the group name can be changed');
      return json(res, 200, { group: await store.renameGroup(group.id, value.name) });
    }
    if (method === 'PATCH' && match[2] === 'schedule') {
      const value = await body(req);
      if (!validSchedule(value)) throw new Error('Provide a valid hourly, daily or weekly schedule');
      return json(res, 200, { group: await store.updateSchedule(group.id, value) });
    }
    if (method === 'POST' && match[2] === 'run') {
      const value = await body(req);
      const entry = await enqueue(group.id, manualLookbackHours(value));
      return json(res, 202, { run: entry });
    }
    if (method === 'DELETE' && !match[2]) {
      if (active.has(group.id)) return json(res, 409, { error: 'Wait for the current run before deleting the group' });
      try {
        await store.deleteGroup(group.id);
        await pruneScreenshots();
        activity.clearGroup(group.id);
        return json(res, 200, { deleted: true });
      } catch (error) {
        if (error instanceof Error && error.message === 'Wait for the current run before deleting the group') return json(res, 409, { error: error.message });
        throw error;
      }
    }
    if (method === 'DELETE' && match[2] === 'runs') {
      if (active.has(group.id)) return json(res, 409, { error: 'Wait for the current run before clearing runs' });
      try {
        const { from, to } = deletionRange(url);
        const removed = await store.clearRuns(group.id, from, to);
        await pruneScreenshots();
        if (!from && !to) activity.clearGroup(group.id);
        return json(res, 200, { removed });
      } catch (error) {
        if (error instanceof Error && error.message === 'Wait for the current run before clearing runs') return json(res, 409, { error: error.message });
        throw error;
      }
    }
    if (method === 'DELETE' && match[2] === 'posts') {
      if (active.has(group.id)) return json(res, 409, { error: 'Wait for the current run before clearing posts' });
      const { from, to } = deletionRange(url);
      try {
        const removed = await store.purge(group.id, from, to);
        await pruneScreenshots();
        return json(res, 200, { removed });
      } catch (error) {
        if (error instanceof Error && error.message === 'Wait for the current run before clearing posts') return json(res, 409, { error: error.message });
        throw error;
      }
    }
  }
  return json(res, 404, { error: 'Not found' });
}
async function serve(res: ServerResponse, path: string) {
  const root = resolve('ui/dist');
  const file = path === '/' || path === '/groups' || path === '/export' || /^\/groups\/new\/?$/.test(path) || /^\/groups\/[a-f0-9-]+(?:\/runs\/[a-f0-9-]+)?\/?$/.test(path) ? resolve(root, 'index.html') : resolve(root, `.${path}`);
  if (!(file === root || file.startsWith(root + sep))) return json(res, 404, { error: 'Not found' });
  try {
    const contents = await readFile(file);
    const mime: Record<string,string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': (mime[extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" }); res.end(contents);
  } catch { json(res, 404, { error: 'Build the dashboard with npm run build first' }); }
}
await store.init();
await recoverRunning('Collector restarted before this run finished');
await pruneScreenshots();
scheduleDrain();
void tick().catch(error => { lastError = error instanceof Error ? error.message : 'Scheduler failed'; });
const server = createServer((req,res) => { const url = new URL(req.url || '/', `http://${host}`); if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`)) return json(res, 403, { error: 'Local origin only' }); const job = url.pathname.startsWith('/api/') ? api(req,res,url) : req.method === 'GET' ? serve(res,url.pathname) : Promise.resolve(json(res,404,{error:'Not found'})); job.catch(error => json(res, 400, { error: error instanceof Error ? error.message : 'Request failed' })); });
server.listen(port, '127.0.0.1', () => console.log(`Collector dashboard: http://${host}`));
const timer = setInterval(() => { void tick().catch(error => { lastError = error instanceof Error ? error.message : 'Scheduler failed'; }); }, 60_000);
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (drainTask) await drainTask;
  await store.close();
}
process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
