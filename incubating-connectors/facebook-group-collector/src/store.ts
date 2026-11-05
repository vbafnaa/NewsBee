import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safeDiagnostics, type RunDiagnostics } from './diagnostics.js';

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export type Schedule = { cadence: 'hourly' | 'daily' | 'weekly'; time: string; dayOfWeek?: number };
export type Group = { id: string; url: string; name: string; enabled?: boolean; approvedAt?: string; lastRun?: string; lastStatus?: string; schedule?: Schedule; nextRunAt?: string };
export type ReactionKind = 'Like' | 'Love' | 'Care' | 'Haha' | 'Wow' | 'Sad' | 'Angry';
export type Reactions = { total?: number; kinds: ReactionKind[]; counts: Partial<Record<ReactionKind, number>> };
export type Post = { id: string; groupId: string; text: string; commentCount?: number; reactions?: Reactions; contentVerified?: boolean; permalink?: string; sourceLinks: string[]; rawTime?: string; publishedAt?: string; observedAt: string; truncated?: boolean; screenshot?: string; screenshotRunId?: string; postHtml?: string };
export type Run = { id: string; groupId: string; lookbackHours?: 1 | 168 | 720; cutoffAt?: string; queuedAt?: string; startedAt?: string; finishedAt?: string; status: string; count: number; reason?: string; posts?: Post[]; diagnostics?: RunDiagnostics };
export function lastRunCutoff(runs: Run[], groupId: string, currentRunId: string, now: number): string {
  const previous = runs.filter(r => r.id !== currentRunId && r.groupId === groupId && r.startedAt && r.finishedAt && r.status !== 'failed' && r.status !== 'cancelled' && r.status !== 'login_required' && r.status !== 'partial_disconnect' && Date.parse(r.startedAt) < now)
    .sort((a, b) => Date.parse(b.startedAt!) - Date.parse(a.startedAt!))[0];
  return previous?.startedAt || new Date(now - 168 * 60 * 60 * 1000).toISOString();
}
export type State = { version: 1; groups: Group[]; posts: Post[]; runs: Run[]; paused: boolean };
const empty = (): State => ({ version: 1, groups: [], posts: [], runs: [], paused: false });

export function groupUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['www.facebook.com', 'facebook.com'].includes(url.hostname) || url.username || url.password || url.port || !/^\/groups\/[a-zA-Z0-9._-]+\/?$/.test(url.pathname)) throw new Error('Enter a Facebook group URL such as https://www.facebook.com/groups/vietseattle');
  return `https://www.facebook.com${url.pathname.replace(/\/$/, '')}`;
}
function groupName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 100) throw new Error('Provide a group name (up to 100 characters)');
  return name;
}
export function validSchedule(value: unknown): value is Schedule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const schedule = value as Record<string, unknown>;
  if (!['hourly', 'daily', 'weekly'].includes(String(schedule.cadence)) || typeof schedule.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) return false;
  if (Object.keys(schedule).some(key => !['cadence', 'time', 'dayOfWeek'].includes(key))) return false;
  if (schedule.cadence === 'hourly') return schedule.time === '00:00' && schedule.dayOfWeek === undefined;
  return schedule.cadence === 'daily' ? schedule.dayOfWeek === undefined : Number.isInteger(schedule.dayOfWeek) && (schedule.dayOfWeek as number) >= 0 && (schedule.dayOfWeek as number) <= 6;
}
export function nextOccurrence(schedule: Schedule, after: number): string {
  if (!validSchedule(schedule) || !Number.isFinite(after)) throw new Error('Invalid schedule');
  const date = new Date(after);
  if (schedule.cadence === 'hourly') {
    const hourStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours());
    return new Date(hourStart.getTime() + 60 * 60 * 1000 * (Math.floor((after - hourStart.getTime()) / (60 * 60 * 1000)) + 1)).toISOString();
  }
  const [hour, minute] = schedule.time.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, hour, minute);
    if ((schedule.cadence === 'daily' || candidate.getDay() === schedule.dayOfWeek) && candidate.getTime() > after) return candidate.toISOString();
  }
  throw new Error('Unable to find next scheduled run');
}
export function postUrl(value: string, group: Group): string | null {
  try {
    const url = new URL(value, 'https://www.facebook.com');
    if (url.protocol !== 'https:' || !['www.facebook.com', 'facebook.com'].includes(url.hostname)) return null;
    const slug = new URL(group.url).pathname.split('/')[2];
    const match = url.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)\/?$/);
    if (!match || match[1].toLowerCase() !== slug.toLowerCase()) return null;
    return `https://www.facebook.com/groups/${slug}/posts/${match[2]}/`;
  } catch { return null; }
}
function updateStatistics(existing: Post, incoming: Post): Post {
  return {
    ...existing,
    rawTime: existing.rawTime ?? incoming.rawTime,
    publishedAt: existing.publishedAt ?? incoming.publishedAt,
    screenshot: existing.publishedAt || incoming.publishedAt ? undefined : incoming.screenshot ?? existing.screenshot,
    screenshotRunId: existing.publishedAt || incoming.publishedAt ? undefined : incoming.screenshot ? incoming.screenshotRunId : existing.screenshotRunId,
    commentCount: incoming.commentCount ?? existing.commentCount,
    reactions: incoming.reactions ? {
      total: incoming.reactions.total ?? existing.reactions?.total,
      kinds: incoming.reactions.kinds.length ? incoming.reactions.kinds : existing.reactions?.kinds || [],
      counts: { ...existing.reactions?.counts, ...incoming.reactions.counts },
    } : existing.reactions,
  };
}
export function normalizePost(input: Partial<Post>, group: Group, now = Date.now()): Post | null {
  const permalink = input.permalink ? postUrl(input.permalink, group) || undefined : undefined;
  const text = input.text?.trim().slice(0, 12000);
  if ((input.permalink && !permalink) || !text) return null;
  const id = permalink ? permalink.match(/\/posts\/(\d+)\//)![1] : `local-${createHash('sha256').update(JSON.stringify([group.id, text])).digest('hex')}`;
  const sourceLinks = (input.sourceLinks || []).filter((link): link is string => {
    try { const u = new URL(link); return u.protocol === 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1'; } catch { return false; }
  }).slice(0, 12);
  const kinds: ReactionKind[] = ['Like', 'Love', 'Care', 'Haha', 'Wow', 'Sad', 'Angry'];
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1000000000;
  const reactions = input.reactions && typeof input.reactions === 'object' ? {
    total: count(input.reactions.total) ? input.reactions.total : undefined,
    kinds: [...new Set((Array.isArray(input.reactions.kinds) ? input.reactions.kinds : []).filter(kind => kinds.includes(kind)))],
    counts: Object.fromEntries(kinds.filter(kind => count(input.reactions?.counts?.[kind])).map(kind => [kind, input.reactions!.counts[kind]])),
  } : undefined;
  const date = input.publishedAt ? Date.parse(input.publishedAt) : NaN;
  return { id, groupId: group.id, permalink, text, commentCount: count(input.commentCount) ? input.commentCount : undefined, reactions, contentVerified: input.contentVerified === true, sourceLinks, rawTime: input.rawTime?.slice(0, 150), publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : undefined, observedAt: new Date(now).toISOString(), truncated: !!input.truncated, screenshot: !Number.isFinite(date) && /^(?:chronological|recent)-\d{1,2}-\d{1,3}\.png$/.test(input.screenshot || '') ? input.screenshot : undefined, postHtml: !Number.isFinite(date) && typeof input.postHtml === 'string' ? input.postHtml : undefined };
}
function validate(raw: unknown): State {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid collector data file');
  const s = raw as State;
  if (s.version !== 1 || !Array.isArray(s.groups) || !Array.isArray(s.posts) || !Array.isArray(s.runs) || typeof s.paused !== 'boolean') throw new Error('Invalid collector data file');
  for (const g of s.groups) if (!g || typeof g.id !== 'string' || typeof g.url !== 'string' || typeof g.name !== 'string' || (g.enabled !== undefined && typeof g.enabled !== 'boolean') || (g.approvedAt !== undefined && typeof g.approvedAt !== 'string') || (g.schedule !== undefined && !validSchedule(g.schedule)) || (g.nextRunAt !== undefined && (typeof g.nextRunAt !== 'string' || !Number.isFinite(Date.parse(g.nextRunAt)) || new Date(g.nextRunAt).toISOString() !== g.nextRunAt)) || groupUrl(g.url) !== g.url) throw new Error('Invalid group data');
  const validPost = (p: Post) => !!p && typeof p.id === 'string' && typeof p.groupId === 'string' && typeof p.text === 'string' && Array.isArray(p.sourceLinks) && (p.screenshot === undefined || (!p.publishedAt && /^(?:chronological|recent)-\d{1,2}-\d{1,3}\.png$/.test(p.screenshot))) && (p.screenshotRunId === undefined || (p.screenshot !== undefined && /^[a-f0-9-]{36}$/.test(p.screenshotRunId))) && (p.postHtml === undefined || (!p.publishedAt && typeof p.postHtml === 'string')) && s.groups.some(g => g.id === p.groupId && (p.permalink === undefined ? /^local-[a-f0-9]{64}$/.test(p.id) : postUrl(p.permalink, g) !== null));
  for (const p of s.posts) if (!validPost(p)) throw new Error('Invalid post data');
  for (const r of s.runs) {
    if (!r || typeof r.id !== 'string' || typeof r.groupId !== 'string' || typeof r.status !== 'string' || typeof r.count !== 'number' || (r.lookbackHours !== undefined && ![1, 168, 720].includes(r.lookbackHours)) || (r.cutoffAt !== undefined && (typeof r.cutoffAt !== 'string' || !Number.isFinite(Date.parse(r.cutoffAt)) || new Date(r.cutoffAt).toISOString() !== r.cutoffAt)) || (r.queuedAt !== undefined && typeof r.queuedAt !== 'string') || (r.startedAt !== undefined && typeof r.startedAt !== 'string') || (r.finishedAt !== undefined && typeof r.finishedAt !== 'string') || (r.posts !== undefined && (!Array.isArray(r.posts) || r.posts.some(p => !validPost(p) || p.groupId !== r.groupId)))) throw new Error('Invalid run data');
    if (r.diagnostics !== undefined) {
      const sanitized = safeDiagnostics(r.diagnostics);
      if (!sanitized) throw new Error('Invalid run diagnostics');
      r.diagnostics = sanitized;
    }
  }
  return s;
}

function archivePost(posts: Post[], post: Post): boolean {
  const index = posts.findIndex(existing => existing.groupId === post.groupId && existing.id === post.id);
  const fallback = index < 0 ? posts.findIndex(existing => existing.groupId === post.groupId && existing.text === post.text && (!existing.permalink || !post.permalink)) : -1;
  const truncated = index < 0 && fallback < 0 ? posts.findIndex(existing => {
    const prefix = existing.text.replace(/\s*(?:See more|Xem thêm)(?:\s*\.)?\s*$/i, '').trim();
    return existing.groupId === post.groupId && !existing.permalink && existing.truncated && prefix.length >= 30 && post.text.startsWith(prefix) && post.text.length > existing.text.length;
  }) : -1;
  const found = index >= 0 ? index : fallback >= 0 ? fallback : truncated;
  if (found < 0) { posts.push(post); return true; }
  const existing = posts[found];
  const updated = updateStatistics(existing, post);
  posts[found] = truncated >= 0 ? { ...updated, id: post.id, text: post.text, permalink: post.permalink, sourceLinks: post.sourceLinks, publishedAt: post.publishedAt ?? existing.publishedAt, truncated: post.truncated } : post.permalink && !existing.permalink ? { ...updated, id: post.id, permalink: post.permalink } : updated;
  return false;
}

function syncHistoricalPermalinks(state: State): void {
  for (const run of state.runs) {
    for (const post of run.posts || []) {
      if (post.permalink) continue;
      const matches = state.posts.filter(entry => entry.groupId === run.groupId && entry.text === post.text && entry.permalink);
      if (matches.length !== 1 || run.posts?.some(entry => entry.id === matches[0].id)) continue;
      post.id = matches[0].id;
      post.permalink = matches[0].permalink;
    }
  }
}

export class Store {
  private state = empty();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly lock: string;
  private lockHandle?: Awaited<ReturnType<typeof open>>;
  constructor(private readonly directory: string, private readonly clock: () => number = Date.now) { this.file = join(directory, 'collector.json'); this.lock = join(directory, 'collector.lock'); }
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    // 'wx' prevents concurrent instances from writing the same JSON file.
    this.lockHandle = await open(this.lock, 'wx', 0o600);
    await this.lockHandle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    try { this.state = validate(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await this.close(); throw error; } }
    await this.cleanup();
  }
  async close(): Promise<void> { await this.queue; if (this.lockHandle) { await this.lockHandle.close(); this.lockHandle = undefined; await rm(this.lock, { force: true }); } }
  snapshot(): State { return structuredClone(this.state); }
  runs(): Omit<Run, 'posts' | 'diagnostics'>[] { return this.state.runs.slice().reverse().map(({ posts: _posts, diagnostics: _diagnostics, ...run }) => ({ ...run })); }
  run(id: string): Run | undefined {
    const run = this.state.runs.find(r => r.id === id);
    if (!run) return;
    return structuredClone(run);
  }
  async claimRun(id: string): Promise<Run | undefined> {
    let claimed = false;
    await this.update(s => {
      const run = s.runs.find(entry => entry.id === id && entry.status === 'queued');
      if (!run) return;
      const startedAt = new Date(this.clock()).toISOString();
      if (run.lookbackHours === undefined) run.cutoffAt = lastRunCutoff(s.runs, run.groupId, run.id, Date.parse(startedAt));
      Object.assign(run, { status: 'running', startedAt });
      claimed = true;
    });
    return claimed ? this.run(id) : undefined;
  }
  posts(groupId?: string, q?: string, page = 0): { posts: Post[]; total: number } {
    const filtered = this.state.posts.filter(p => (!groupId || p.groupId === groupId) && (!q || p.text.toLocaleLowerCase().includes(q.toLocaleLowerCase()))).sort((a,b) => b.observedAt.localeCompare(a.observedAt));
    return { total: filtered.length, posts: structuredClone(filtered.slice(Math.max(0,page) * 50, Math.max(0,page) * 50 + 50)) };
  }
  async linkPost(groupId: string, localId: string, url: string): Promise<Post> {
    const group = this.state.groups.find(entry => entry.id === groupId);
    if (!group || !/^local-[a-f0-9]{64}$/.test(localId)) throw new Error('Unknown local post');
    const permalink = /^https:\/\//i.test(url) ? postUrl(url, group) : null;
    if (!permalink) throw new Error('Enter a permalink to a post in this group');
    const id = permalink.match(/\/posts\/(\d+)\//)![1];
    await this.update(state => {
      const post = state.posts.find(entry => entry.groupId === groupId && entry.id === localId && !entry.permalink);
      if (!post) throw new Error('Unknown local post');
      if (state.posts.some(entry => entry.groupId === groupId && entry.id === id)) throw new Error('That post permalink is already saved');
      for (const run of state.runs.filter(entry => entry.groupId === groupId)) {
        if (run.posts?.some(entry => entry.id === localId) && run.posts.some(entry => entry.id === id)) throw new Error('That post permalink is already in the run');
      }
      Object.assign(post, { id, permalink });
      for (const run of state.runs.filter(entry => entry.groupId === groupId)) {
        for (const entry of run.posts || []) if (entry.id === localId && !entry.permalink) Object.assign(entry, { id, permalink });
      }
    });
    return this.state.posts.find(entry => entry.groupId === groupId && entry.id === id)!;
  }
  async update(fn: (draft: State) => void): Promise<State> {
    const op = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      fn(draft); validate(draft);
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(draft)); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, this.file);
        this.state = draft;
      } finally { await rm(temp, { force: true }); }
      return this.snapshot();
    });
    this.queue = op.catch(() => undefined);
    return op;
  }
  async cleanup(): Promise<void> {
    await this.update(s => {
      s.groups = s.groups.map(({ enabled: _enabled, ...group }) => {
        if (!group.schedule) group.schedule = { cadence: 'daily', time: '09:00' };
        if (!group.nextRunAt) group.nextRunAt = nextOccurrence(group.schedule, this.clock());
        return group;
      });
      const archive: Post[] = [];
      for (const p of s.posts) {
        const { comments: _comments, expiresAt: _expiresAt, ...post } = p as Post & { comments?: string[]; expiresAt?: string };
        archivePost(archive, post as Post);
      }
      s.posts = archive;
      for (const run of s.runs) if (run.posts) run.posts = run.posts.map(p => {
        const { comments: _comments, expiresAt: _expiresAt, ...post } = p as Post & { comments?: string[]; expiresAt?: string };
        return post as Post;
      });
      syncHistoricalPermalinks(s);
    });
    const candidates: { postId: string; groupId: string; runId: string; filename: string }[] = [];
    for (const run of [...this.state.runs].reverse()) for (const post of run.posts || []) {
      if (!post.screenshot || post.publishedAt || !/^[a-f0-9-]{36}$/.test(run.id)) continue;
      const saved = this.state.posts.find(p => p.groupId === run.groupId && !p.publishedAt && !p.screenshot &&
        (p.id === post.id || (p.text === post.text && (!p.permalink || !post.permalink))));
      if (!saved || candidates.some(c => c.groupId === saved.groupId && c.postId === saved.id)) continue;
      const image = await stat(join(this.directory, 'screenshots', run.id, post.screenshot)).catch(() => undefined);
      if (image?.isFile()) candidates.push({ postId: saved.id, groupId: saved.groupId, runId: run.id, filename: post.screenshot });
    }
    if (candidates.length) await this.update(s => {
      for (const candidate of candidates) {
        const post = s.posts.find(p => p.groupId === candidate.groupId && p.id === candidate.postId && !p.publishedAt && !p.screenshot);
        if (post) { post.screenshot = candidate.filename; post.screenshotRunId = candidate.runId; }
      }
    });
  }
  async addGroup(url: string, name: string): Promise<Group> {
    const canonical = groupUrl(url);
    const schedule: Schedule = { cadence: 'daily', time: '09:00' };
    const group: Group = { id: randomUUID(), url: canonical, name: groupName(name), schedule, nextRunAt: nextOccurrence(schedule, this.clock()) };
    await this.update(s => { if (s.groups.some(g => g.url === canonical)) throw new Error('Group already configured'); s.groups.push(group); });
    return group;
  }
  async deleteGroup(id: string): Promise<void> {
    await this.update(s => {
      if (!s.groups.some(group => group.id === id)) throw new Error('Unknown group');
      if (s.runs.some(run => run.groupId === id && run.status === 'running')) throw new Error('Wait for the current run before deleting the group');
      s.groups = s.groups.filter(group => group.id !== id);
      s.posts = s.posts.filter(post => post.groupId !== id);
      s.runs = s.runs.filter(run => run.groupId !== id);
    });
  }
  async renameGroup(id: string, name: string): Promise<Group> {
    const cleaned = groupName(name);
    let updated: Group | undefined;
    await this.update(s => {
      const group = s.groups.find(g => g.id === id);
      if (!group) throw new Error('Unknown group');
      group.name = cleaned;
      updated = structuredClone(group);
    });
    return updated!;
  }
  async updateSchedule(id: string, schedule: Schedule): Promise<Group> {
    if (!validSchedule(schedule)) throw new Error('Invalid schedule');
    let updated: Group | undefined;
    await this.update(s => {
      const group = s.groups.find(g => g.id === id);
      if (!group) throw new Error('Unknown group');
      group.schedule = structuredClone(schedule);
      group.nextRunAt = nextOccurrence(schedule, this.clock());
      updated = structuredClone(group);
    });
    return updated!;
  }
  async queueDueRuns(): Promise<Run[]> {
    const queued: Run[] = [];
    await this.update(s => {
      if (s.paused) return;
      const now = this.clock();
      for (const group of s.groups) {
        if (!group.schedule || !group.nextRunAt || Date.parse(group.nextRunAt) > now) continue;
        if (s.runs.filter(r => r.status === 'queued').length >= 50) break;
        if (!s.runs.some(r => r.groupId === group.id && (r.status === 'queued' || r.status === 'running'))) {
          const entry: Run = { id: randomUUID(), groupId: group.id, queuedAt: new Date(now).toISOString(), status: 'queued', count: 0, posts: [] };
          s.runs.push(entry);
          queued.push(entry);
        }
        group.nextRunAt = nextOccurrence(group.schedule, now);
      }
    });
    return queued;
  }
  async savePosts(group: Group, entries: Partial<Post>[]): Promise<number> {
    let added = 0;
    await this.update(s => { if (!s.groups.some(g => g.id === group.id)) return;
      for (const entry of entries) {
              const post = normalizePost(entry, group, this.clock());
              if (post) {
                const { screenshot: _screenshot, screenshotRunId: _screenshotRunId, postHtml: _postHtml, ...archiveEntry } = post;
                if (archivePost(s.posts, archiveEntry)) added++;
              }
      }
      syncHistoricalPermalinks(s);
    });
    return added;
  }
  async recordRunPosts(group: Group, runId: string, entries: Partial<Post>[]): Promise<number> {
    let count = 0;
    await this.update(s => {
      const run = s.runs.find(r => r.id === runId && r.groupId === group.id && r.status === 'running');
      if (!run) throw new Error('Run is not active');
      const unique = new Map<string, Post>();
      for (const entry of entries.slice(0, 250)) {
        const post = normalizePost(entry, group, this.clock());
        if (post) unique.set(post.id, post);
      }
      run.posts = [...unique.values()];
      count = run.posts.length;
      for (const { postHtml: _postHtml, ...post } of run.posts) archivePost(s.posts, post.screenshot ? { ...post, screenshotRunId: runId } : post);
      syncHistoricalPermalinks(s);
    });
    return count;
  }
  async purge(groupId: string, from?: string, to?: string): Promise<number> {
    let removed = 0;
    await this.update(s => {
      if (!s.groups.some(g => g.id === groupId)) throw new Error('Unknown group');
      if (s.runs.some(r => r.groupId === groupId && r.status === 'running')) throw new Error('Wait for the current run before clearing posts');
      const matches = (p: Post) => p.groupId === groupId && (!from || p.observedAt >= from) && (!to || p.observedAt < to);
      const deleted = new Set(s.posts.filter(matches).map(p => p.id));
      removed = deleted.size;
      s.posts = s.posts.filter(p => !matches(p));
      for (const run of s.runs) if (run.groupId === groupId) {
        if (run.posts) run.posts = run.posts.filter(p => !deleted.has(p.id));
        if (run.status === 'queued' && !from && !to) Object.assign(run, { status: 'cancelled', finishedAt: new Date(this.clock()).toISOString(), reason: 'Group posts cleared before run started' });
      }
    });
    return removed;
  }
  async clearRuns(groupId: string, from?: string, to?: string): Promise<number> {
    let removed = 0;
    await this.update(s => {
      const group = s.groups.find(g => g.id === groupId);
      if (!group) throw new Error('Unknown group');
      if (s.runs.some(r => r.groupId === groupId && r.status === 'running')) throw new Error('Wait for the current run before clearing runs');
      const matches = (r: Run) => r.groupId === groupId && (!from || (r.queuedAt || r.startedAt || '') >= from) && (!to || (r.queuedAt || r.startedAt || '') < to);
      removed = s.runs.filter(matches).length;
      s.runs = s.runs.filter(r => !matches(r));
      const latest = [...s.runs].reverse().find(r => r.groupId === groupId && r.finishedAt);
      if (latest) { group.lastRun = latest.finishedAt; group.lastStatus = latest.status; }
      else { delete group.lastRun; delete group.lastStatus; }
    });
    return removed;
  }
}
