import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import type { Group } from './store.js';

const state = vi.hoisted(() => ({ commands: [] as string[], openedUrls: [] as string[], scripts: [] as string[], failFirstOpen: true, failRunCodeAt: 0, checkpointData: undefined as unknown, responses: [] as string[] }));
vi.mock('node:child_process', () => {
  const execFile = Object.assign(() => undefined, {
    [Symbol.for('nodejs.util.promisify.custom')]: async (_file: string, args: string[]) => {
      const action = args[2];
      state.commands.push(action);
      if (action === 'tab-new') state.openedUrls.push(args[3]);
      if (action === 'run-code') {
        const script = await readFile(args[3].slice('--filename='.length), 'utf8');
        state.scripts.push(script);
        if (state.scripts.length === state.failRunCodeAt) {
          if (state.checkpointData) {
            const encoded = script.match(/, ("(?:\\.|[^"\\])*")\)$/)?.[1];
            if (!encoded) throw new Error('Checkpoint URL missing');
            const response = await fetch(JSON.parse(encoded), { method: 'POST', body: JSON.stringify(state.checkpointData) });
            if (!response.ok) throw new Error('Checkpoint request failed');
          }
          throw new Error('extension connection closed');
        }
      }
      if (action === 'tab-new' && state.failFirstOpen) {
        state.failFirstOpen = false;
        throw new Error('extension connection closed');
      }
      return { stdout: action === 'run-code' ? `### Result\n${state.responses.shift() || '{"status":"partial_feed","posts":[]}'}\n` : '', stderr: '' };
    },
  });
  return { execFile };
});

const originalDir = process.cwd();
const originalToken = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
afterEach(() => {
  process.chdir(originalDir);
  if (originalToken === undefined) delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  else process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = originalToken;
  vi.resetModules();
});

it('reattaches automatically when a queued run finds a stale Chrome connection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-browser-'));
  try {
    await mkdir(join(dir, 'src'));
    await copyFile(join(originalDir, 'src/browser-script.js'), join(dir, 'src/browser-script.js'));
    process.chdir(dir);
    process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = 'test-token';
    state.commands = [];
    state.openedUrls = [];
    state.scripts = [];
    state.failFirstOpen = true;
    state.failRunCodeAt = 0;
    state.checkpointData = undefined;
    state.responses = [];
    const { collect } = await import('./browser.js');
    const group = { id: 'test', name: 'Test', url: 'https://www.facebook.com/groups/test' } as Group;
    const stages: string[] = [];
    const scan = { scan: 0, feed: true, articles: 1, outsideFeedArticles: 0, commentArticles: 0, commentLinks: 0, postLinks: 1, messageNodes: 1, fallbackNodes: 0, candidateItems: 1, newItems: 1, recentItems: 1, olderItems: 0 };
    const diagnostics = { version: 1, scans: [scan], samples: [], pageViews: [], articles: [] };
    state.responses = [
      JSON.stringify({ status: 'partial_feed', posts: [{ text: 'First', publishedAt: '2026-01-01T00:00:00.000Z' }], diagnostics }),
      JSON.stringify({ status: 'partial_feed', posts: [{ permalink: 'https://www.facebook.com/groups/test/posts/1/', text: 'First' }, { text: 'Old top post', publishedAt: '2025-01-01T00:00:00.000Z' }], diagnostics }),
    ];
    const result = await collect(group, stage => stages.push(stage));
    expect(result).toMatchObject({ status: 'partial_feed', posts: [{ permalink: 'https://www.facebook.com/groups/test/posts/1/', text: 'First', publishedAt: '2026-01-01T00:00:00.000Z' }, { text: 'Old top post' }] });
    expect(result.diagnostics?.scans.map(scan => [scan.scan, scan.sort])).toEqual([[0, 'CHRONOLOGICAL'], [1, 'RECENT_ACTIVITY']]);
    expect(result.diagnostics?.steps).toEqual([{ sort: 'CHRONOLOGICAL', status: 'partial_feed', posts: 1 }, { sort: 'RECENT_ACTIVITY', status: 'partial_feed', posts: 2 }]);
    expect(state.commands).toEqual(['attach', 'tab-new', 'attach', 'tab-new', 'run-code', 'tab-close', 'tab-new', 'run-code', 'tab-close']);
    expect(state.openedUrls.map(url => new URL(url).searchParams.get('sorting_setting'))).toEqual(['CHRONOLOGICAL', 'CHRONOLOGICAL', 'RECENT_ACTIVITY']);
    expect(stages).toEqual(['connecting', 'opening_chronological', 'connecting', 'opening_chronological', 'scanning_chronological', 'opening_recent', 'scanning_recent']);
    expect(state.scripts[0]).toMatch(/\(page, 168, "[^"]+", false, "http:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+"\)$/);
    expect(state.scripts[1]).toMatch(/\(page, 168, "[^"]+", true, "http:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+"\)$/);
    expect(state.scripts[0].match(/\(page, 168, ("[^"]+")/ )?.[1]).toBe(state.scripts[1].match(/\(page, 168, ("[^"]+")/ )?.[1]);
    await collect(group, undefined, 1);
    await collect(group, undefined, 720, '2026-01-15T00:00:00.000Z');
    expect(state.scripts[2]).toMatch(/\(page, 1, "[^"]+", false, "[^"]+"\)$/);
    expect(state.scripts[4]).toMatch(/\(page, 720, "2026-01-15T00:00:00.000Z", false, "[^"]+"\)$/);
    for (const generated of state.scripts) {
      expect(new Script(`(${generated})`).runInNewContext()).toBeTypeOf('function');
    }
    expect(await readdir(join(dir, '.local/browser'))).not.toContain('collection-run.js');
  } finally {
    process.chdir(originalDir);
    await rm(dir, { recursive: true, force: true });
  }
});

it('recovers completed scans from a failed browser command and merges a partial second step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-browser-checkpoint-'));
  try {
    await mkdir(join(dir, 'src'));
    await copyFile(join(originalDir, 'src/browser-script.js'), join(dir, 'src/browser-script.js'));
    process.chdir(dir);
    process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = 'test-token';
    state.commands = [];
    state.scripts = [];
    state.failFirstOpen = false;
    state.failRunCodeAt = 1;
    const scan = { scan: 0, feed: true, articles: 1, outsideFeedArticles: 0, commentArticles: 0, commentLinks: 0, postLinks: 1, messageNodes: 1, fallbackNodes: 0, candidateItems: 1, newItems: 1, recentItems: 1, olderItems: 0 };
    const diagnostics = { version: 1, scans: [scan], samples: [], pageViews: [], articles: [] };
    const first = { permalink: 'https://www.facebook.com/groups/test/posts/1/', text: 'First post', publishedAt: '2026-01-01T00:00:00.000Z' };
    state.checkpointData = { posts: [first], layout: { scans: 1 }, diagnostics };
    const { collect } = await import('./browser.js');
    const group = { id: 'test', name: 'Test', url: 'https://www.facebook.com/groups/test' } as Group;
    const runId = '12345678-1234-1234-1234-123456789abc';
    const partial = await collect(group, undefined, 168, undefined, runId);
    expect(partial).toMatchObject({ status: 'partial_disconnect', posts: [first] });
    expect(partial.diagnostics?.scans).toHaveLength(1);
    expect(state.scripts).toHaveLength(1);
    expect((await readdir(join(dir, '.local/browser'))).filter(file => file.startsWith('checkpoint-'))).toEqual([]);

    state.scripts = [];
    state.failRunCodeAt = 2;
    state.responses = [JSON.stringify({ status: 'partial_feed', posts: [first], diagnostics })];
    state.checkpointData = { posts: [{ text: 'Recent top post' }], layout: { scans: 1 }, diagnostics };
    const merged = await collect(group, undefined, 168, undefined, runId);
    expect(merged).toMatchObject({ status: 'partial_disconnect', posts: [first, { text: 'Recent top post' }] });
    expect(merged.diagnostics?.steps).toEqual([{ sort: 'CHRONOLOGICAL', status: 'partial_feed', posts: 1 }, { sort: 'RECENT_ACTIVITY', status: 'partial_disconnect', posts: 1 }]);
  } finally {
    process.chdir(originalDir);
    await rm(dir, { recursive: true, force: true });
  }
});
