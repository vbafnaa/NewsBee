import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Group, Post } from './store.js';
import { safeDiagnostics, type RunDiagnostics } from './diagnostics.js';
const exec = promisify(execFile);
const cli = resolve('node_modules/@playwright/cli/playwright-cli.js');
const script = resolve('src/browser-script.js');
const runtime = resolve('.local/browser');
const config = join(runtime, 'config.json');
const session = 'newsbee-group-collector';
let ready = false;
export type Extraction = { status: string; posts: Partial<Post>[]; layout?: unknown; diagnostics?: RunDiagnostics };

async function checkpointReceiver() {
  let saved: Extraction | undefined;
  const key = randomUUID();
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== `/${key}` || req.socket.remoteAddress !== '127.0.0.1') { res.writeHead(404).end(); return; }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 128 * 1024 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Extraction;
      const diagnostics = safeDiagnostics(payload.diagnostics);
      if (!Array.isArray(payload.posts) || payload.posts.length > 250 || !diagnostics) { res.writeHead(400).end(); return; }
      saved = { status: 'partial_disconnect', posts: payload.posts, layout: payload.layout, diagnostics };
      res.writeHead(204).end();
    } catch { if (!res.headersSent) res.writeHead(400).end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Checkpoint receiver unavailable');
  return { url: `http://127.0.0.1:${address.port}/${key}`, get saved() { return saved; }, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function token(): string {
  const value = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  if (!value) throw new Error('Extension token unavailable. Set PLAYWRIGHT_MCP_EXTENSION_TOKEN in the app process.');
  return value;
}
async function command(args: string[], timeout = 45000): Promise<string> {
  const secret = token();
  try {
    const { stdout } = await exec(process.execPath, [cli, `-s=${session}`, ...args, ...(args[0] === 'attach' ? [`--config=${config}`] : [])], { cwd: runtime, env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: secret }, timeout, maxBuffer: 128 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    ready = false;
    const message = String((error as {message?: string}).message || '');
    if (/unsupported protocol|protocol version/i.test(message)) throw new Error('Browser extension protocol incompatible; update the Playwright CLI and extension.');
    if ((error as { killed?: boolean }).killed || /timeout|ETIMEDOUT/i.test(message)) throw new Error('Browser scan timed out. Check Chrome and retry the run.');
    if (/not open|extension connection/i.test(message)) throw new Error('Chrome extension disconnected. Check that Chrome and the extension are running.');
    throw new Error('Browser command failed. Check the extension and Chrome connection.');
  } finally {
    // The CLI may write page snapshots even when outputMode is stdout.
    const files = await readdir(runtime).catch(() => []);
    await Promise.all(files.filter(file => /^(?:page-.*\.yml|console-.*\.log)$/.test(file)).map(file => rm(join(runtime, file), { force: true }).catch(() => undefined)));
    await rm(join(runtime, '.playwright-cli'), { recursive: true, force: true }).catch(() => undefined);
  }
}
export async function connect(): Promise<void> {
  if (ready) return;
  await mkdir(runtime, { recursive: true });
  await writeFile(config, JSON.stringify({ outputDir: runtime, outputMode: 'stdout', snapshot: { mode: 'none' } }), { mode: 0o600 });
  await command(['attach', '--extension=chrome']);
  ready = true;
}
export function connected(): boolean { return ready; }
export async function collect(group: Group, progress?: (stage: 'connecting' | 'opening_recent' | 'scanning_recent' | 'opening_chronological' | 'scanning_chronological') => void, lookbackHours: 1 | 168 | 720 = 168, cutoffAt?: string, runId?: string): Promise<Extraction> {
  if (![1, 168, 720].includes(lookbackHours) || (cutoffAt !== undefined && (!Number.isFinite(Date.parse(cutoffAt)) || new Date(cutoffAt).toISOString() !== cutoffAt))) throw new Error('Invalid collection cutoff');
  if (runId !== undefined && !/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid run ID');
  const cutoff = cutoffAt ?? new Date(Date.now() - lookbackHours * 3600000).toISOString();
  const source = await readFile(script, 'utf8');
  async function step(sort: 'RECENT_ACTIVITY' | 'CHRONOLOGICAL', firstTen: boolean): Promise<Extraction> {
    progress?.(sort === 'CHRONOLOGICAL' ? 'opening_chronological' : 'opening_recent');
    const url = new URL(group.url);
    url.searchParams.set('sorting_setting', sort);
    try {
      await command(['tab-new', url.toString()]);
    } catch {
      progress?.('connecting');
      await connect();
      progress?.(sort === 'CHRONOLOGICAL' ? 'opening_chronological' : 'opening_recent');
      await command(['tab-new', url.toString()]);
    }
    const runScript = join(runtime, 'collection-run.js');
    const checkpoint = await checkpointReceiver();
    try {
      await writeFile(runScript, `async (page) => (${source})(page, ${lookbackHours}, ${JSON.stringify(cutoff)}, ${firstTen}, ${JSON.stringify(checkpoint.url)})`);
      progress?.(sort === 'CHRONOLOGICAL' ? 'scanning_chronological' : 'scanning_recent');
      let output: string;
      try { output = await command(['run-code', `--filename=${runScript}`], 600000); }
      catch (error) {
        const saved = checkpoint.saved;
        if (!saved) throw error;
        return saved;
      }
      const match = output.match(/### Result\r?\n([^\r\n]+)\r?\n/);
      if (!match) throw new Error('Unrecognized browser response');
      const result = JSON.parse(match[1]) as Extraction;
      if (!Array.isArray(result.posts) || typeof result.status !== 'string') throw new Error('Unrecognized browser response');
      if (result.diagnostics !== undefined) {
        const sanitized = safeDiagnostics(result.diagnostics);
        if (!sanitized) throw new Error('Invalid structural diagnostics');
        result.diagnostics = sanitized;
      }
      return result;
    } finally {
      await rm(runScript, { force: true }).catch(() => undefined);
      await checkpoint.close();
      try { await command(['tab-close']); } catch { /* A disconnected extension may already have closed the tab. */ }
      await rm(join(runtime, '.playwright-cli'), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  progress?.('connecting');
  await connect();
  const chronological = await step('CHRONOLOGICAL', false);
  if (chronological.status === 'login_required' || chronological.status === 'partial_disconnect') return chronological;
  let recent: Extraction;
  try { recent = await step('RECENT_ACTIVITY', true); }
  catch { return { ...chronological, status: 'partial_second_step', diagnostics: chronological.diagnostics && { ...chronological.diagnostics, steps: [{ sort: 'CHRONOLOGICAL', status: chronological.status, posts: chronological.posts.length }, { sort: 'RECENT_ACTIVITY', status: 'failed', posts: 0 }] } }; }
  const merged = new Map<string, Partial<Post>>();
  for (const post of [...chronological.posts, ...recent.posts]) {
    const bodyKey = `body:${post.text}`;
    const linked = [...merged.entries()].filter(([, existing]) => existing.permalink && existing.text === post.text);
    const key = post.permalink ? new URL(post.permalink).pathname : linked.length === 1 ? linked[0][0] : bodyKey;
    const previous = merged.get(key) ?? (post.permalink && linked.length === 0 ? merged.get(bodyKey) : undefined);
    if (post.permalink && previous && merged.has(bodyKey)) merged.delete(bodyKey);
    merged.set(key, previous ? { ...previous, permalink: post.permalink ?? previous.permalink, publishedAt: previous.publishedAt ?? post.publishedAt, rawTime: previous.rawTime ?? post.rawTime,
      postHtml: previous.publishedAt || post.publishedAt ? undefined : post.postHtml ?? previous.postHtml,
      screenshot: previous.publishedAt || post.publishedAt ? undefined : post.screenshot ?? previous.screenshot,
      commentCount: post.commentCount ?? previous.commentCount, reactions: { total: post.reactions?.total ?? previous.reactions?.total,
        kinds: post.reactions?.kinds?.length ? post.reactions.kinds : previous.reactions?.kinds || [], counts: { ...previous.reactions?.counts, ...post.reactions?.counts } } } : post);
  }
  const a = chronological.diagnostics;
  const b = recent.diagnostics;
  const offset = a?.scans.length ?? 0;
  const reindex = <T extends { scan: number }>(items: T[] = []) => items.map(item => ({ ...item, scan: item.scan + offset }));
  const diagnostics = a && b ? safeDiagnostics({ version: 1,
    scans: [...a.scans.map(scan => ({ ...scan, sort: 'CHRONOLOGICAL' })), ...reindex(b.scans).map(scan => ({ ...scan, sort: 'RECENT_ACTIVITY' }))],
    samples: [...a.samples, ...reindex(b.samples)].slice(0, 24),
    pageViews: [a.pageViews?.[0], b.pageViews?.[0] && { ...b.pageViews[0], scan: b.pageViews[0].scan + offset }].filter(Boolean),
    articles: [...(a.articles || []), ...reindex(b.articles)].slice(0, 120),
    steps: [{ sort: 'CHRONOLOGICAL', status: chronological.status, posts: chronological.posts.length }, { sort: 'RECENT_ACTIVITY', status: recent.status, posts: recent.posts.length }],
  }) : a;
  const layout = Object.fromEntries(Object.keys((recent.layout || {}) as object).map(key => [key, Number((recent.layout as Record<string, number>)[key] || 0) + Number((chronological.layout as Record<string, number> | undefined)?.[key] || 0)]));
  const status = recent.status === 'partial_disconnect' ? 'partial_disconnect' :
    recent.status === 'login_required' ? 'partial_second_step' :
    [...merged.values()].some(post => !post.publishedAt) ? 'partial_unknown_time' :
    chronological.status === 'partial_limit' ? chronological.status : merged.size ? 'partial_feed' : chronological.status;
  return { status, posts: [...merged.values()], layout, diagnostics };
}
