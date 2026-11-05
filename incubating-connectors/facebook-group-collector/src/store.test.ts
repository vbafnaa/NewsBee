import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RETENTION_MS, Store, groupUrl, lastRunCutoff, nextOccurrence, normalizePost, postUrl, validSchedule } from './store.js';
import { safeDiagnostics } from './diagnostics.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup(now = Date.parse('2026-01-15T00:00:00Z')) {
  const dir = await mkdtemp(join(tmpdir(), 'group-collector-')); dirs.push(dir);
  const store = new Store(dir, () => now); await store.init();
  const group = await store.addGroup('https://www.facebook.com/groups/vietseattle/', 'Vietnamese Seattle');
  return { dir, store, group };
}
it('accepts only canonical Facebook group and group-post URLs', () => {
  expect(groupUrl('https://facebook.com/groups/vietseattle/?foo=bar')).toBe('https://www.facebook.com/groups/vietseattle');
  for (const url of ['http://facebook.com/groups/vietseattle', 'https://evil.com/groups/vietseattle', 'https://www.facebook.com/groups/vietseattle/posts/12']) expect(() => groupUrl(url)).toThrow();
  const group = { id: 'g', url: 'https://www.facebook.com/groups/vietseattle', name: 'Test' };
  expect(postUrl('https://www.facebook.com/groups/vietseattle/permalink/123/?ref=share', group)).toBe('https://www.facebook.com/groups/vietseattle/posts/123/');
  expect(postUrl('https://www.facebook.com/groups/other/posts/123/', group)).toBeNull();
});
it('adds groups without an approval acknowledgement and loads legacy group records', async () => {
  const { dir, store, group } = await setup();
  expect(group).not.toHaveProperty('approvedAt');
  await store.close();
  const file = join(dir, 'collector.json');
  const legacy = JSON.parse(await readFile(file, 'utf8'));
  legacy.groups[0].approvedAt = '2026-01-15T00:00:00.000Z';
  legacy.groups[0].enabled = false;
  await writeFile(file, JSON.stringify(legacy));
  const reopened = new Store(dir); await reopened.init();
  expect(reopened.snapshot().groups[0]).toMatchObject({ id: group.id, approvedAt: legacy.groups[0].approvedAt });
  expect(reopened.snapshot().groups[0]).not.toHaveProperty('enabled');
  expect((JSON.parse(await readFile(file, 'utf8')) as { groups: object[] }).groups[0]).not.toHaveProperty('enabled');
  await reopened.close();
});
it('renames only the group display name and preserves existing runs and posts', async () => {
  const { dir, store, group } = await setup();
  await store.update(s => { s.runs.push({ id: 'run-1', groupId: group.id, queuedAt: '2026-01-15T00:00:00.000Z', status: 'partial', count: 0 }); });
  await store.savePosts(group, [{ text: 'Local event' }]);
  const updated = await store.renameGroup(group.id, '  New display name  ');
  expect(updated).toMatchObject({ id: group.id, url: group.url, name: 'New display name' });
  expect(store.run('run-1')?.groupId).toBe(group.id);
  expect(store.posts().posts[0].groupId).toBe(group.id);
  expect(group.name).toBe('Vietnamese Seattle');
  for (const invalid of ['', '   ', 'x'.repeat(101)]) await expect(store.renameGroup(group.id, invalid)).rejects.toThrow('Provide a group name');
  await expect(store.renameGroup('missing', 'Valid')).rejects.toThrow('Unknown group');
  expect(store.snapshot().groups[0].name).toBe('New display name');
  await store.close();
  const restored = new Store(dir, () => Date.parse('2026-01-15T00:00:00Z')); await restored.init();
  expect(restored.snapshot().groups[0]).toMatchObject({ id: group.id, url: group.url, name: 'New display name' });
  expect(restored.run('run-1')?.groupId).toBe(group.id);
  await restored.close();
});
it('clears only one group run history including queued snapshots and diagnostics while retaining posts', async () => {
  const { dir, store, group } = await setup();
  const other = await store.addGroup('https://www.facebook.com/groups/other', 'Other group');
  const time = '2026-01-15T00:00:00.000Z';
  await store.savePosts(group, [{ text: 'Saved community post' }]);
  await store.savePosts(other, [{ text: 'Other post' }]);
  await store.update(s => {
    s.groups[0].lastRun = time;
    s.groups[0].lastStatus = 'partial';
    s.groups[1].lastRun = time;
    s.runs.push(
      { id: 'queued', groupId: group.id, queuedAt: time, status: 'queued', count: 0 },
      { id: 'finished', groupId: group.id, queuedAt: time, status: 'partial', count: 1, posts: [s.posts[0]], diagnostics: { version: 1, scans: [], samples: [] } },
      { id: 'other-run', groupId: other.id, queuedAt: time, status: 'partial', count: 1, posts: [s.posts[1]] },
    );
  });
  expect(await store.clearRuns(group.id)).toBe(2);
  expect(await store.clearRuns(group.id)).toBe(0);
  expect(store.runs().map(run => run.id)).toEqual(['other-run']);
  expect(store.snapshot().groups[0]).not.toHaveProperty('lastRun');
  expect(store.snapshot().groups[0]).not.toHaveProperty('lastStatus');
  expect(store.snapshot().groups[1].lastRun).toBe(time);
  expect(store.posts().total).toBe(2);
  await expect(store.clearRuns('unknown')).rejects.toThrow('Unknown group');
  await store.close();
  const restored = new Store(dir, () => Date.parse(time)); await restored.init();
  expect(restored.run('finished')).toBeUndefined();
  expect(restored.run('queued')).toBeUndefined();
  expect(restored.run('other-run')).toBeDefined();
  expect(restored.posts().total).toBe(2);
  await restored.close();
});
it('refuses to clear a running group without changing its history or saved posts', async () => {
  const { store, group } = await setup();
  await store.savePosts(group, [{ text: 'Keep me' }]);
  await store.update(s => { s.runs.push({ id: 'in-progress', groupId: group.id, queuedAt: '2026-01-15T00:00:00.000Z', status: 'running', count: 0 }); });
  await expect(store.clearRuns(group.id)).rejects.toThrow('Wait for the current run');
  expect(store.run('in-progress')).toBeDefined();
  expect(store.posts().total).toBe(1);
  await store.close();
});
it('deduplicates and atomically persists posts without automatic expiry', async () => {
  const now = Date.parse('2026-01-15T00:00:00Z');
  const { dir, store, group } = await setup(now);
  const entry = { permalink: 'https://www.facebook.com/groups/vietseattle/posts/123/', text: 'Community event', sourceLinks: ['https://example.org/event'] };
  expect(await store.savePosts(group, [entry, entry])).toBe(1);
  expect(await store.savePosts(group, [{ ...entry, text: 'Updated event', commentCount: 12 }])).toBe(0);
  expect(store.posts().posts[0]).toMatchObject({ id: '123', text: 'Community event', commentCount: 12, sourceLinks: ['https://example.org/event'] });
  const disk = JSON.parse(await readFile(join(dir, 'collector.json'), 'utf8'));
  expect(disk.posts).toHaveLength(1);
  await expect(new Store(dir).init()).rejects.toThrow();
  await store.close();
  const reopened = new Store(dir, () => now); await reopened.init();
  expect(reopened.posts().total).toBe(1);
  await reopened.close();
});
it('persists counts and reaction kinds without comment text', async () => {
  const { store, group } = await setup();
  const entry = { permalink: 'https://www.facebook.com/groups/vietseattle/posts/123/', text: 'Community event', commentCount: 12, reactions: { total: 25, kinds: ['Like', 'Love'] as ('Like' | 'Love')[], counts: { Like: 20 } }, contentVerified: true };
  await store.savePosts(group, [entry]);
  expect(store.posts().posts[0]).toMatchObject({ text: 'Community event', commentCount: 12, reactions: { total: 25, kinds: ['Like', 'Love'], counts: { Like: 20 } }, contentVerified: true });
  expect(store.posts(undefined, 'snacks').posts).toEqual([]);
  expect(store.posts().posts[0]).not.toHaveProperty('comments');
  await store.close();
});
it('replaces an archived linkless teaser when a later scan expands See more', async () => {
  const { store, group } = await setup();
  const prefix = 'Neighborhood gathering this Saturday at the community center';
  await store.savePosts(group, [{ text: `${prefix} See more`, truncated: true, contentVerified: true }]);
  const oldId = store.posts().posts[0].id;
  await store.savePosts(group, [{ text: `${prefix} with food and live music for all ages.`, truncated: false, contentVerified: true }]);
  expect(store.posts().posts).toHaveLength(1);
  expect(store.posts().posts[0]).toMatchObject({ text: `${prefix} with food and live music for all ages.`, truncated: false });
  expect(store.posts().posts[0].id).not.toBe(oldId);
  await store.close();
});
it('uses the latest completed run start for scheduled collection and ignores disconnected or failed runs', () => {
  const now = Date.parse('2026-01-15T10:00:00.000Z');
  const runs = [
    { id: 'old', groupId: 'g', startedAt: '2026-01-14T09:00:00.000Z', finishedAt: '2026-01-14T09:30:00.000Z', status: 'partial_unknown_time', count: 1 },
    { id: 'failed', groupId: 'g', startedAt: '2026-01-15T08:00:00.000Z', finishedAt: '2026-01-15T08:30:00.000Z', status: 'failed', count: 0 },
    { id: 'disconnected', groupId: 'g', startedAt: '2026-01-15T08:45:00.000Z', finishedAt: '2026-01-15T09:00:00.000Z', status: 'partial_disconnect', count: 2 },
    { id: 'other', groupId: 'elsewhere', startedAt: '2026-01-15T09:00:00.000Z', finishedAt: '2026-01-15T09:15:00.000Z', status: 'partial', count: 3 },
    { id: 'current', groupId: 'g', startedAt: '2026-01-15T10:00:00.000Z', status: 'running', count: 0 },
  ];
  expect(lastRunCutoff(runs, 'g', 'current', now)).toBe('2026-01-14T09:00:00.000Z');
  expect(lastRunCutoff(runs, 'new', 'first', now)).toBe(new Date(now - 168 * 3600000).toISOString());
});
it('claims scheduled runs with a persisted previous-run cutoff and leaves manual runs at one hour', async () => {
  const now = Date.parse('2026-01-15T10:00:00.000Z');
  const { store, group } = await setup(now);
  const previous = '2026-01-14T09:00:00.000Z';
  await store.update(s => { s.runs.push(
    { id: 'previous', groupId: group.id, startedAt: previous, finishedAt: '2026-01-14T09:10:00.000Z', status: 'partial', count: 1 },
    { id: 'scheduled', groupId: group.id, queuedAt: new Date(now).toISOString(), status: 'queued', count: 0 },
    { id: 'manual', groupId: group.id, lookbackHours: 1, queuedAt: new Date(now).toISOString(), status: 'queued', count: 0 },
  ); });
  expect(await store.claimRun('scheduled')).toMatchObject({ status: 'running', startedAt: new Date(now).toISOString(), cutoffAt: previous });
  expect(store.run('scheduled')?.cutoffAt).toBe(previous);
  expect(await store.claimRun('scheduled')).toBeUndefined();
  expect(await store.claimRun('manual')).toMatchObject({ status: 'running', lookbackHours: 1 });
  expect(store.run('manual')?.cutoffAt).toBeUndefined();
  await store.close();
});
it('deduplicates a linkless post despite shifting relative-time estimates', () => {
  const group = { id: 'g', url: 'https://www.facebook.com/groups/vietseattle', name: 'Test' };
  const first = normalizePost({ text: 'News', rawTime: '2h', publishedAt: '2026-01-15T02:00:00Z' }, group, Date.parse('2026-01-15T04:00:00Z'));
  const second = normalizePost({ text: 'News', rawTime: '2h', publishedAt: '2026-01-15T02:00:05Z' }, group, Date.parse('2026-01-15T04:00:05Z'));
  expect(first?.id).toBe(second?.id);
  expect(first?.permalink).toBeUndefined();
});
it('retains posts older than seven days when an incremental scan finds them', () => {
  const now = Date.parse('2026-01-15T00:00:00Z');
  const group = { id: 'g', url: 'https://www.facebook.com/groups/vietseattle', name: 'Test' };
  const date = now - 6 * 86400000;
  const post = normalizePost({ permalink: 'https://www.facebook.com/groups/vietseattle/posts/123/', text: 'Event', publishedAt: new Date(date).toISOString() }, group, now);
  expect(post?.publishedAt).toBe(new Date(date).toISOString());
  expect(post).not.toHaveProperty('expiresAt');
  expect(normalizePost({ permalink: post!.permalink, text: 'Event', publishedAt: new Date(now - RETENTION_MS).toISOString() }, group, now)?.publishedAt).toBe(new Date(now - RETENTION_MS).toISOString());
});
it('keeps saved posts indefinitely and removes legacy expiry metadata on restart', async () => {
  let now = Date.parse('2026-01-15T00:00:00Z');
  const { dir, store, group } = await setup(now);
  const entry = { permalink: 'https://www.facebook.com/groups/vietseattle/posts/123/', text: 'Event' };
  expect(normalizePost({ ...entry, publishedAt: new Date(now - RETENTION_MS - 1).toISOString() }, group, now)).not.toBeNull();
  await store.savePosts(group, [entry]);
  await store.close();
  const file = join(dir, 'collector.json');
  const legacy = JSON.parse(await readFile(file, 'utf8'));
  legacy.posts[0].expiresAt = new Date(now + RETENTION_MS).toISOString();
  await writeFile(file, JSON.stringify(legacy));
  now += RETENTION_MS * 3;
  const reopened = new Store(dir, () => now); await reopened.init();
  expect(reopened.posts().total).toBe(1);
  expect(reopened.posts().posts[0]).not.toHaveProperty('expiresAt');
  await reopened.close();
});
it('clears posts and run history by group and inclusive time windows', async () => {
  const { store, group } = await setup();
  const other = await store.addGroup('https://www.facebook.com/groups/other', 'Other');
  const early = '2026-01-10T00:00:00.000Z'; const late = '2026-01-15T00:00:00.000Z';
  await store.update(s => {
    const post = normalizePost({ text: 'Early post' }, group)!;
    s.posts.push({ ...post, observedAt: early }, { ...post, id: 'local-' + 'a'.repeat(64), text: 'Late post', observedAt: late }, { ...post, groupId: other.id, id: 'local-' + 'b'.repeat(64), observedAt: early });
    s.runs.push({ id: 'early', groupId: group.id, queuedAt: early, status: 'partial', count: 1, posts: [s.posts[0]] }, { id: 'late', groupId: group.id, queuedAt: late, status: 'partial', count: 1, posts: [s.posts[1]] }, { id: 'other', groupId: other.id, queuedAt: early, status: 'partial', count: 1, posts: [s.posts[2]] });
  });
  expect(await store.purge(group.id, early, late)).toBe(1);
  expect(store.posts(group.id).posts.map(p => p.text)).toEqual(['Late post']);
  expect(store.run('early')?.posts).toEqual([]);
  expect(await store.clearRuns(group.id, early, late)).toBe(1);
  expect(store.run('late')).toBeDefined();
  expect(store.run('other')).toBeDefined();
  await store.close();
});
it('deletes a group and all its data, but refuses deletion during an active run', async () => {
  const { store, group } = await setup();
  await store.savePosts(group, [{ text: 'Post' }]);
  await store.update(s => { s.runs.push({ id: 'running', groupId: group.id, status: 'running', count: 0 }); });
  await expect(store.deleteGroup(group.id)).rejects.toThrow('Wait for the current run');
  expect(store.snapshot().groups).toHaveLength(1);
  await store.update(s => { s.runs[0].status = 'partial'; });
  await store.deleteGroup(group.id);
  expect(store.snapshot().groups).toEqual([]);
  expect(store.posts().total).toBe(0);
  expect(store.runs()).toEqual([]);
  await expect(store.deleteGroup(group.id)).rejects.toThrow('Unknown group');
  await store.close();
});
it('attaches a verified permalink to a local post and all matching run snapshots atomically', async () => {
  const { dir, store, group } = await setup();
  const runId = '11111111-1111-4111-8111-111111111111';
  await store.update(state => { state.runs.push({ id: runId, groupId: group.id, status: 'running', count: 0 }); });
  await store.recordRunPosts(group, runId, [{ text: 'Community update', publishedAt: '2026-01-14T00:00:00Z' }]);
  const localId = store.posts(group.id).posts[0].id;
  const link = 'https://www.facebook.com/groups/vietseattle/posts/3399521323586132/';
  await expect(store.linkPost(group.id, localId, 'https://www.facebook.com/groups/other/posts/1/')).rejects.toThrow('permalink');
  expect(store.posts(group.id).posts[0].id).toBe(localId);
  expect(await store.linkPost(group.id, localId, link)).toMatchObject({ id: '3399521323586132', permalink: link, publishedAt: '2026-01-14T00:00:00.000Z' });
  expect(store.run(runId)?.posts?.[0]).toMatchObject({ id: '3399521323586132', permalink: link });
  await expect(store.linkPost(group.id, localId, link)).rejects.toThrow('Unknown local post');
  await store.close();
  const restored = new Store(dir); await restored.init();
  expect(restored.posts(group.id).posts[0].permalink).toBe(link);
  expect(restored.run(runId)?.posts?.[0].permalink).toBe(link);
  await restored.close();
});
it('promotes historical run snapshots when a later capture recovers their permalink', async () => {
  const { dir, store, group } = await setup();
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  await store.update(state => { state.runs.push({ id: first, groupId: group.id, status: 'running', count: 0 }); });
  await store.recordRunPosts(group, first, [{ text: 'Community update', publishedAt: '2026-01-14T00:00:00Z' }]);
  const localId = store.run(first)?.posts?.[0].id;
  await store.update(state => { state.runs.push({ id: second, groupId: group.id, status: 'running', count: 0 }); });
  const permalink = 'https://www.facebook.com/groups/vietseattle/posts/123/';
  await store.recordRunPosts(group, second, [{ text: 'Community update', permalink }]);
  expect(store.run(first)?.posts?.[0]).toMatchObject({ id: '123', permalink, publishedAt: '2026-01-14T00:00:00.000Z' });
  expect(store.run(first)?.posts?.[0].id).not.toBe(localId);
  await store.close();
  const restored = new Store(dir); await restored.init();
  expect(restored.run(first)?.posts?.[0].permalink).toBe(permalink);
  await restored.close();
});
it('rejects assigning a permalink already used by another saved post', async () => {
  const { store, group } = await setup();
  const link = 'https://www.facebook.com/groups/vietseattle/posts/123/';
  await store.savePosts(group, [{ text: 'First' }, { text: 'Second', permalink: link }]);
  const localId = store.posts(group.id).posts.find(post => !post.permalink)!.id;
  await expect(store.linkPost(group.id, localId, link)).rejects.toThrow('already saved');
  expect(store.posts(group.id).posts.find(post => post.id === localId)?.permalink).toBeUndefined();
  await store.close();
});
it('preserves each run result independently while updating the shared post archive', async () => {
  const { dir, store, group } = await setup();
  const first = { id: '11111111-1111-4111-8111-111111111111', groupId: group.id, queuedAt: '2026-01-15T00:00:00.000Z', startedAt: '2026-01-15T00:00:00.000Z', status: 'running', count: 0 };
  const secondId = '22222222-2222-4222-8222-222222222222';
  await store.update(s => { s.runs.push(first); });
  const link = 'https://www.facebook.com/groups/vietseattle/posts/123/';
  expect(await store.recordRunPosts(group, first.id, [{ permalink: link, text: 'First version', screenshot: 'chronological-0-0.png' }, { text: 'No link', screenshot: 'recent-1-2.png' }])).toBe(2);
  await store.update(s => { s.runs[0].status = 'partial_feed'; s.runs[0].count = 2; s.runs.push({ ...first, id: secondId }); });
  expect(await store.recordRunPosts(group, secondId, [{ permalink: link, text: 'Second version' }])).toBe(1);
  expect(store.run(first.id)?.posts?.[0]).toMatchObject({ text: 'First version' });
  expect(store.run(first.id)?.posts?.[1]).toMatchObject({ text: 'No link', permalink: undefined, screenshot: 'recent-1-2.png' });
  expect(store.posts().posts.map(post => [post.screenshot, post.screenshotRunId])).toEqual([['chronological-0-0.png', first.id], ['recent-1-2.png', first.id]]);
  expect(normalizePost({ text: 'Bad path', screenshot: '../private.png' }, group)?.screenshot).toBeUndefined();
  expect(normalizePost({ text: 'Dated', screenshot: 'recent-0-1.png', publishedAt: '2026-01-15T00:00:00Z' }, group)?.screenshot).toBeUndefined();
  expect(store.run(secondId)?.posts?.[0]).toMatchObject({ text: 'Second version' });
  expect(store.posts().posts[0].text).toBe('First version');
  expect(store.runs()[0]).not.toHaveProperty('posts');
  await store.close();
  const restored = new Store(dir, () => Date.parse('2026-01-15T00:00:00Z')); await restored.init();
  expect(restored.run(first.id)?.posts?.[0].text).toBe('First version');
  expect(restored.run(first.id)?.posts?.[0].screenshot).toBe('chronological-0-0.png');
  expect(restored.posts().posts[0]).toMatchObject({ screenshot: 'chronological-0-0.png', screenshotRunId: first.id });
  await restored.update(s => { s.runs.find(r => r.id === secondId)!.status = 'partial_feed'; });
  await restored.clearRuns(group.id);
  expect(restored.posts().posts[0]).toMatchObject({ screenshot: 'chronological-0-0.png', screenshotRunId: first.id });
  await restored.savePosts(group, [{ permalink: link, text: 'Updated date', publishedAt: '2026-01-14T00:00:00.000Z' }]);
  expect(restored.posts().posts[0]).toMatchObject({ publishedAt: '2026-01-14T00:00:00.000Z' });
  expect(restored.posts().posts[0].screenshot).toBeUndefined();
  expect(restored.posts().posts[0].screenshotRunId).toBeUndefined();
  await restored.purge(group.id);
  expect(restored.posts().posts).toEqual([]);
  await restored.close();
});
it('retains whole undated card HTML in run snapshots but never saved posts', async () => {
  const { dir, store, group } = await setup();
  const runId = '11111111-1111-4111-8111-111111111111';
  const postHtml = '<article><span>Original</span><span>Visible reply</span></article>';
  await store.update(s => { s.runs.push({ id: runId, groupId: group.id, status: 'running', count: 0 }); });
  await store.recordRunPosts(group, runId, [{ text: 'Original', postHtml }, { text: 'Dated', postHtml, publishedAt: '2026-01-14T00:00:00Z' }]);
  expect(store.run(runId)?.posts?.[0].postHtml).toBe(postHtml);
  expect(store.run(runId)?.posts?.[1].postHtml).toBeUndefined();
  expect(store.posts().posts.every(post => post.postHtml === undefined)).toBe(true);
  await store.savePosts(group, [{ text: 'Another', postHtml }]);
  expect(store.posts().posts.every(post => post.postHtml === undefined)).toBe(true);
  await store.close();
  const restored = new Store(dir); await restored.init();
  expect(restored.run(runId)?.posts?.[0].postHtml).toBe(postHtml);
  expect(restored.posts().posts.every(post => post.postHtml === undefined)).toBe(true);
  await restored.close();
});
it('backfills existing undated archive screenshots only when the retained image exists', async () => {
  const { dir, store, group } = await setup();
  const runId = '11111111-1111-4111-8111-111111111111';
  const link = 'https://www.facebook.com/groups/vietseattle/posts/123/';
  await store.savePosts(group, [{ permalink: link, text: 'Undated' }, { text: 'No image' }, { text: 'Dated', publishedAt: '2026-01-14T00:00:00.000Z' }]);
  await store.update(s => { s.runs.push({ id: runId, groupId: group.id, status: 'partial_unknown_time', count: 3, posts: [
    { ...s.posts.find(p => p.text === 'Undated')!, screenshot: 'chronological-0-0.png' },
    { ...s.posts.find(p => p.text === 'No image')!, screenshot: 'chronological-0-1.png' },
    { ...s.posts.find(p => p.text === 'Dated')! },
  ] }); });
  await mkdir(join(dir, 'screenshots', runId), { recursive: true });
  await writeFile(join(dir, 'screenshots', runId, 'chronological-0-0.png'), 'image');
  await store.close();
  const restored = new Store(dir); await restored.init();
  expect(restored.posts().posts.find(p => p.text === 'Undated')).toMatchObject({ screenshot: 'chronological-0-0.png', screenshotRunId: runId });
  expect(restored.posts().posts.find(p => p.text === 'No image')?.screenshot).toBeUndefined();
  await restored.clearRuns(group.id);
  expect(restored.posts().posts.find(p => p.text === 'Undated')?.screenshotRunId).toBe(runId);
  await restored.close();
});
it('sanitizes and preserves run diagnostics, stripping legacy comment bodies', async () => {
  let now = Date.parse('2026-01-15T00:00:00Z');
  const { dir, store, group } = await setup(now);
  const report = { version: 1, scans: [{ scan: 0, feed: true, articles: 1, outsideFeedArticles: 0, commentArticles: 1, commentLinks: 1, postLinks: 0, messageNodes: 0, fallbackNodes: 0, candidateItems: 0, newItems: 0, recentItems: 0, olderItems: 0, secret: 'private' }], samples: [], pageViews: [{ scan: 0, feedHtml: '<div role="feed">Private post</div>', visibleText: 'Private post', secret: 'private' }], articles: [{ scan: 0, label: 'comment', text: 'Private reply', html: '<div role="article">Private reply</div>', secret: 'private' }] };
  await store.update(s => { s.runs.push({ id: 'test-run', groupId: group.id, queuedAt: new Date(now).toISOString(), status: 'partial_comments_only', count: 0, diagnostics: report as any }); });
  expect(JSON.stringify(store.run('test-run')?.diagnostics)).not.toContain('"secret"');
  expect(store.run('test-run')?.diagnostics?.pageViews?.[0].feedHtml).toContain('Private post');
  expect(store.run('test-run')?.diagnostics?.articles?.[0]).toMatchObject({ label: 'comment', text: 'Private reply' });
  expect(store.runs()[0]).not.toHaveProperty('diagnostics');
  await expect(store.update(s => { s.runs[0].diagnostics = { ...report, scans: [{ ...report.scans[0], articles: 'bad' }] } as any; })).rejects.toThrow('Invalid run diagnostics');
  await store.close();
  const file = join(dir, 'collector.json');
  const legacy = JSON.parse(await readFile(file, 'utf8'));
  legacy.posts.push({ id: '1', groupId: group.id, permalink: 'https://www.facebook.com/groups/vietseattle/posts/1/', text: 'Post', comments: ['private comment'], sourceLinks: [], observedAt: new Date(now).toISOString(), expiresAt: new Date(now + RETENTION_MS).toISOString() });
  legacy.runs[0].posts = [legacy.posts[0]];
  await writeFile(file, JSON.stringify(legacy));
  const reopened = new Store(dir, () => now); await reopened.init();
  expect(JSON.stringify(reopened.snapshot())).not.toContain('private comment');
  expect(reopened.run('test-run')?.diagnostics?.scans[0].commentArticles).toBe(1);
  expect(reopened.run('test-run')?.diagnostics?.articles?.[0].text).toBe('Private reply');
  await reopened.close();
  now += RETENTION_MS + 1;
  const expired = new Store(dir, () => now); await expired.init();
  expect(expired.run('test-run')).toBeDefined();
  await expired.close();
});
it('validates raw diagnostic capture limits and supports older structural-only reports', () => {
  const base = { version: 1, scans: [], samples: [] };
  expect(safeDiagnostics(base)).toEqual(base);
  const view = { scan: 0, feedHtml: 'x'.repeat(32000), visibleText: 'y'.repeat(8000) };
  const article = { scan: 0, label: 'other', text: 'a'.repeat(1000), html: 'b'.repeat(2000) };
  expect(safeDiagnostics({ ...base, pageViews: [view], articles: [article] })).toMatchObject({ pageViews: [view], articles: [article] });
  expect(safeDiagnostics({ ...base, pageViews: [{ ...view, feedHtml: `${view.feedHtml}x` }] })).toBeUndefined();
  expect(safeDiagnostics({ ...base, pageViews: [view, view, view] })).toBeUndefined();
  expect(safeDiagnostics({ ...base, articles: [{ ...article, html: `${article.html}x` }] })).toBeUndefined();
  expect(safeDiagnostics({ ...base, articles: Array(121).fill(article) })).toBeUndefined();
});
it('keeps individual run snapshots and legacy runs readable', async () => {
  let now = Date.parse('2026-01-15T00:00:00Z');
  const { dir, store, group } = await setup(now);
  await store.update(s => { s.runs.push({ id: 'legacy', groupId: group.id, startedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(), status: 'partial_no_posts', count: 0 }, { id: 'current', groupId: group.id, queuedAt: new Date(now).toISOString(), startedAt: new Date(now).toISOString(), status: 'running', count: 0 }); });
  await store.recordRunPosts(group, 'current', [{ permalink: 'https://www.facebook.com/groups/vietseattle/posts/123/', text: 'Now', publishedAt: new Date(now - 6 * 86400000).toISOString() }]);
  expect(store.run('legacy')?.posts).toBeUndefined();
  await store.close();
  now += 2 * 86400000;
  const reopened = new Store(dir, () => now); await reopened.init();
  expect(reopened.run('current')?.posts).toHaveLength(1);
  expect(reopened.run('legacy')).toBeDefined();
  await reopened.close();
});
it('uses post IDs to retain first-captured content while refreshing only available statistics', async () => {
  const { store, group } = await setup();
  const link = 'https://www.facebook.com/groups/vietseattle/posts/987/';
  await store.savePosts(group, [{ permalink: link, text: 'Original', commentCount: 3, reactions: { total: 4, kinds: ['Like'], counts: { Like: 4 } }, sourceLinks: ['https://example.org/first'] }]);
  await store.savePosts(group, [{ permalink: link, text: 'Edited later', commentCount: 8, reactions: { kinds: [], counts: {} }, sourceLinks: ['https://example.org/new'] }]);
  expect(store.posts().posts[0]).toMatchObject({ id: '987', text: 'Original', commentCount: 8, reactions: { total: 4, kinds: ['Like'], counts: { Like: 4 } }, sourceLinks: ['https://example.org/first'] });
  expect(store.posts().total).toBe(1);
  await store.close();
});
it('backfills an original publication time when an undated saved post is captured again', async () => {
  const { store, group } = await setup();
  await store.savePosts(group, [{ text: 'Community update', commentCount: 1 }]);
  const original = store.posts().posts[0];
  await store.savePosts(group, [{ text: 'Community update', rawTime: '4 hours ago', publishedAt: '2026-10-25T06:00:00.000Z', commentCount: 2 }]);
  expect(store.posts().posts[0]).toMatchObject({ id: original.id, observedAt: original.observedAt, rawTime: '4 hours ago', publishedAt: '2026-10-25T06:00:00.000Z', commentCount: 2 });
  await store.savePosts(group, [{ text: 'Community update', rawTime: '2 minutes ago', publishedAt: '2026-10-25T09:58:00.000Z' }]);
  expect(store.posts().posts[0].publishedAt).toBe('2026-10-25T06:00:00.000Z');
  await store.close();
});
it('deduplicates linkless posts across changing relative timestamps and upgrades when a post ID becomes available', async () => {
  const { store, group } = await setup();
  await store.savePosts(group, [{ text: 'Same message', rawTime: '2h', commentCount: 1 }]);
  await store.savePosts(group, [{ text: 'Same message', rawTime: '3h', commentCount: 2 }]);
  expect(store.posts().total).toBe(1);
  expect(store.posts().posts[0].commentCount).toBe(2);
  await store.savePosts(group, [{ permalink: 'https://www.facebook.com/groups/vietseattle/posts/555/', text: 'Same message', commentCount: 3 }]);
  expect(store.posts().posts[0]).toMatchObject({ id: '555', rawTime: '2h', commentCount: 3 });
  expect(store.posts().total).toBe(1);
  await store.close();
});
it('consolidates legacy duplicate linkless archives on startup without replacing first content', async () => {
  const { dir, store, group } = await setup();
  await store.savePosts(group, [{ text: 'Repeated message', rawTime: '2h', commentCount: 1 }]);
  await store.close();
  const file = join(dir, 'collector.json');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  raw.posts.push({ ...raw.posts[0], id: `local-${'a'.repeat(64)}`, rawTime: '3h', commentCount: 4 });
  await writeFile(file, JSON.stringify(raw));
  const reopened = new Store(dir); await reopened.init();
  expect(reopened.posts().total).toBe(1);
  expect(reopened.posts().posts[0]).toMatchObject({ rawTime: '2h', commentCount: 4 });
  await reopened.close();
});
it('validates hourly, daily and weekly local schedules and rolls to the next occurrence', () => {
  expect(validSchedule({ cadence: 'hourly', time: '00:00' })).toBe(true);
  expect(validSchedule({ cadence: 'daily', time: '09:00' })).toBe(true);
  expect(validSchedule({ cadence: 'weekly', time: '09:00', dayOfWeek: 2 })).toBe(true);
  for (const invalid of [{ cadence: 'hourly', time: '09:00' }, { cadence: 'hourly', time: '00:00', dayOfWeek: 1 }, { cadence: 'weekly', time: '09:00' }, { cadence: 'daily', time: '25:00' }, { cadence: 'daily', time: '09:00', dayOfWeek: 1 }, { cadence: 'weekly', time: '09:00', dayOfWeek: 7 }, { cadence: 'daily', time: '09:00', extra: true }]) expect(validSchedule(invalid)).toBe(false);
  const monday = new Date(2026, 0, 12, 9, 0);
  expect(nextOccurrence({ cadence: 'hourly', time: '00:00' }, monday.getTime())).toBe(new Date(2026, 0, 12, 10).toISOString());
  expect(nextOccurrence({ cadence: 'hourly', time: '00:00' }, monday.getTime() + 35 * 60_000)).toBe(new Date(2026, 0, 12, 10).toISOString());
  expect(nextOccurrence({ cadence: 'daily', time: '09:00' }, monday.getTime())).toBe(new Date(2026, 0, 13, 9).toISOString());
  expect(nextOccurrence({ cadence: 'weekly', time: '09:00', dayOfWeek: 1 }, monday.getTime())).toBe(new Date(2026, 0, 19, 9).toISOString());
});
it('persists hourly collection and queues one run per due hour', async () => {
  let now = new Date(2026, 0, 12, 9, 30).getTime();
  const dir = await mkdtemp(join(tmpdir(), 'group-collector-')); dirs.push(dir);
  let store = new Store(dir, () => now); await store.init();
  const group = await store.addGroup('https://www.facebook.com/groups/vietseattle', 'Seattle');
  expect((await store.updateSchedule(group.id, { cadence: 'hourly', time: '00:00' })).nextRunAt).toBe(new Date(2026, 0, 12, 10).toISOString());
  await store.close();
  now = new Date(2026, 0, 12, 10, 5).getTime();
  store = new Store(dir, () => now); await store.init();
  expect(store.snapshot().groups[0].schedule).toEqual({ cadence: 'hourly', time: '00:00' });
  expect(await store.queueDueRuns()).toHaveLength(1);
  expect(await store.queueDueRuns()).toHaveLength(0);
  expect(store.snapshot().groups[0].nextRunAt).toBe(new Date(2026, 0, 12, 11).toISOString());
  await store.update(s => { s.runs = []; });
  now = new Date(2026, 0, 12, 12, 10).getTime();
  expect(await store.queueDueRuns()).toHaveLength(1);
  expect(store.snapshot().groups[0].nextRunAt).toBe(new Date(2026, 0, 12, 13).toISOString());
  await store.close();
});
it('migrates legacy groups, persists weekly schedules and queues missed occurrences once after restart', async () => {
  let now = new Date(2026, 0, 12, 8).getTime();
  const dir = await mkdtemp(join(tmpdir(), 'group-collector-')); dirs.push(dir);
  let store = new Store(dir, () => now); await store.init();
  const group = await store.addGroup('https://www.facebook.com/groups/vietseattle', 'Seattle');
  expect(group.nextRunAt).toBe(new Date(2026, 0, 12, 9).toISOString());
  await store.close();
  const file = join(dir, 'collector.json');
  const legacy = JSON.parse(await readFile(file, 'utf8'));
  delete legacy.groups[0].schedule; delete legacy.groups[0].nextRunAt;
  await writeFile(file, JSON.stringify(legacy));
  store = new Store(dir, () => now); await store.init();
  expect(store.snapshot().groups[0].schedule).toEqual({ cadence: 'daily', time: '09:00' });
  const weekly = await store.updateSchedule(group.id, { cadence: 'weekly', dayOfWeek: 1, time: '09:00' });
  expect(weekly.nextRunAt).toBe(new Date(2026, 0, 12, 9).toISOString());
  await store.close();
  now = new Date(2026, 0, 14, 10).getTime();
  store = new Store(dir, () => now); await store.init();
  expect(store.snapshot().groups[0].nextRunAt).toBe(weekly.nextRunAt);
  expect(await store.queueDueRuns()).toHaveLength(1);
  expect(await store.queueDueRuns()).toHaveLength(0);
  expect(store.snapshot().groups[0].nextRunAt).toBe(new Date(2026, 0, 19, 9).toISOString());
  await store.close();
});
it('pauses due work, consumes overlapping runs, and honors the pending queue limit', async () => {
  let now = new Date(2026, 0, 12, 8).getTime();
  const dir = await mkdtemp(join(tmpdir(), 'group-collector-')); dirs.push(dir);
  const store = new Store(dir, () => now); await store.init();
  const group = await store.addGroup('https://www.facebook.com/groups/vietseattle', 'Seattle');
  now = new Date(2026, 0, 12, 10).getTime();
  await store.update(s => { s.paused = true; });
  expect(await store.queueDueRuns()).toHaveLength(0);
  await store.update(s => { s.paused = false; s.runs.push({ id: 'manual', groupId: group.id, status: 'running', count: 0 }); });
  expect(await store.queueDueRuns()).toHaveLength(0);
  expect(store.snapshot().groups[0].nextRunAt).toBe(new Date(2026, 0, 13, 9).toISOString());
  await store.update(s => { s.groups[0].nextRunAt = new Date(2026, 0, 12, 9).toISOString(); s.runs = Array.from({ length: 50 }, (_, i) => ({ id: `queued-${i}`, groupId: group.id, status: 'queued', count: 0 })); });
  expect(await store.queueDueRuns()).toHaveLength(0);
  expect(store.snapshot().groups[0].nextRunAt).toBe(new Date(2026, 0, 12, 9).toISOString());
  await store.update(s => { s.runs = []; });
  expect(await store.queueDueRuns()).toHaveLength(1);
  await store.close();
});
it('rejects malformed on-disk data instead of silently overwriting it', async () => {
  const { dir, store } = await setup(); await store.close();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'collector.json'), '{broken');
  const bad = new Store(dir); await expect(bad.init()).rejects.toThrow();
  expect(await readFile(join(dir, 'collector.json'), 'utf8')).toBe('{broken');
});
