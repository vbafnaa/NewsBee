import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Status = { connected: boolean; running: boolean; queued?: number; paused: boolean; token?: string; lastError?: string };
type Schedule = { cadence: 'hourly' | 'daily' | 'weekly'; time: string; dayOfWeek?: number };
type Group = { id: string; url: string; name: string; lastRun?: string; lastStatus?: string; schedule?: Schedule; nextRunAt?: string };
type Post = { id: string; groupId: string; text: string; commentCount?: number; reactions?: { total?: number; kinds: string[]; counts: Record<string, number> }; contentVerified?: boolean; permalink?: string; sourceLinks?: string[]; publishedAt?: string; rawTime?: string; observedAt?: string; expiresAt?: string; truncated?: boolean; screenshot?: string; screenshotRunId?: string; postHtml?: string };
type Run = { id: string; groupId: string; lookbackHours?: 1 | 168 | 720; cutoffAt?: string; queuedAt?: string; startedAt?: string; finishedAt?: string; status: string; count: number; reason?: string; posts?: Post[]; diagnostics?: { version: number; articles?: { scan: number; label: 'comment' | 'other'; text: string; html: string }[] } };
type ActivityEntry = { id: number | string; at: string; runId?: string; groupId: string; stage: string; message: string };
let localToken = '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const mutation = !!options?.method && options.method.toUpperCase() !== 'GET';
  if (mutation && !localToken) throw new Error('Collector token unavailable. Refresh the status before making changes.');
  const response = await fetch(path, {
    ...options,
    headers: { ...(options?.body ? { 'Content-Type': 'application/json' } : {}), ...(mutation ? { 'X-Collector-Token': localToken } : {}), ...options?.headers },
  });
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json() as { error?: string; message?: string };
      detail = body.error || body.message || '';
    } catch { /* An error response may not be JSON. */ }
    throw new Error(detail || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function dateTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function safeLink(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

function recentActivityUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.set('sorting_setting', 'RECENT_ACTIVITY');
  return url.toString();
}

function groupUrl(value: string): string | undefined {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.protocol === 'https:' && ['facebook.com', 'www.facebook.com'].includes(url.hostname.toLowerCase()) && /^\/groups\/[a-z0-9._-]+\/?$/i.test(url.pathname) ? url.href : undefined;
  } catch { return undefined; }
}

function limited(value: string | undefined, length: number): string {
  if (!value) return '';
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function route(): { groupId: string; runId: string | null; adding: boolean; exporting: boolean } {
  const path = window.location.pathname;
  const match = /^\/groups\/([a-f0-9-]+)(?:\/runs\/([a-f0-9-]+))?\/?$/.exec(path);
  return { groupId: match?.[1] || '', runId: match?.[2] || null, adding: path === '/groups/new', exporting: path === '/export' };
}
function rangeQuery(from: string, to: string): string {
  const query = new URLSearchParams();
  if (from) query.set('from', new Date(`${from}T00:00:00`).toISOString());
  if (to) { const end = new Date(`${to}T00:00:00`); end.setDate(end.getDate() + 1); query.set('to', end.toISOString()); }
  return query.toString() ? `?${query}` : '';
}

function isActive(run: Run): boolean { return run.status === 'queued' || run.status === 'running'; }

function PostCard({ post, runId, onLink }: { post: Post; runId?: string; onLink?: (post: Post, url: string) => Promise<void> }) {
  const [linkUrl, setLinkUrl] = useState('');
  const [linkError, setLinkError] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const permalink = safeLink(post.permalink);
  const imageRunId = runId || post.screenshotRunId;
  const screenshot = !post.publishedAt && imageRunId && /^[a-f0-9-]{36}$/.test(imageRunId) && /^(?:chronological|recent)-\d{1,2}-\d{1,3}\.png$/.test(post.screenshot || '') ? `/api/runs/${imageRunId}/screenshots/${post.screenshot}` : undefined;
  const links = Array.isArray(post.sourceLinks) ? post.sourceLinks.slice(0, 8) : [];
  return <article className="post-card">
    <div className="post-meta"><span>Post ID: {post.id.startsWith('local-') ? `${post.id} (local fallback)` : post.id}</span><span aria-hidden="true">·</span>{post.publishedAt ? <span>Published <time dateTime={post.publishedAt}>{dateTime(post.publishedAt)}</time></span> : <span>Published time unknown{post.rawTime ? ` (${limited(post.rawTime, 80)})` : ''}</span>}</div>
    <h3>{post.contentVerified ? 'Post content' : 'Unverified prior capture'}</h3>
    <p className="post-text">{limited(post.text, 4000) || 'No text captured.'}</p>
    {screenshot && <a href={screenshot} target="_blank" rel="noopener noreferrer" aria-label="Open screenshot of post with unknown publication time"><img className="post-screenshot" src={screenshot} alt="Screenshot of the post as displayed during collection" loading="lazy" /></a>}
    {runId && !post.publishedAt && post.postHtml && <details className="article-capture"><summary>Captured post HTML (text only)</summary><p className="caution">This may include visible replies and member details; keep it local.</p><pre>{post.postHtml}</pre></details>}
    {!post.contentVerified && <p className="caution">This capture may be a comment rather than the original post.</p>}
    {post.truncated && <p className="caution">Post preview truncated during collection.</p>}
    <p className="post-footnote">Comments: {post.commentCount ?? 'unknown'} · Reactions: {post.reactions?.total ?? 'unknown'} · Types: {post.reactions?.kinds?.length ? post.reactions.kinds.map(kind => `${kind}${post.reactions?.counts?.[kind] !== undefined ? ` (${post.reactions?.counts?.[kind]})` : ''}`).join(', ') : 'unknown'} (type counts shown only when available)</p>
    <div className="source-links">{links.map((link, index) => { const href = safeLink(link); return href && <a key={index} href={href} target="_blank" rel="noopener noreferrer">Source {index + 1} ↗</a>; })}{permalink && <a href={permalink} target="_blank" rel="noopener noreferrer">View original ↗</a>}</div>
    {!permalink && onLink && post.id.startsWith('local-') && <details><summary>Add verified original link</summary><form onSubmit={async event => {
      event.preventDefault(); setLinkError(''); setLinkBusy(true);
      try { await onLink(post, linkUrl); } catch (error) { setLinkError((error as Error).message); }
      finally { setLinkBusy(false); }
    }}><input type="url" aria-label="Original Facebook post URL" placeholder="https://www.facebook.com/groups/…/posts/…/" required value={linkUrl} onChange={event => setLinkUrl(event.target.value)} /><button type="submit" disabled={linkBusy}>Save original link</button>{linkError && <p role="alert" className="caution">{linkError}</p>}</form></details>}
    <p className="post-footnote">Observed {dateTime(post.observedAt)}{post.text.length > 4000 ? ' · Text preview limited' : ''}</p>
  </article>;
}

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [selectedGroup, setSelectedGroup] = useState(() => route().groupId);
  const [currentId, setCurrentId] = useState<string | null>(() => route().runId);
  const [addingGroup, setAddingGroup] = useState(() => route().adding);
  const [exporting, setExporting] = useState(() => route().exporting);
  const [exportGroup, setExportGroup] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [posts, setPosts] = useState<Post[]>([]);
  const [postTotal, setPostTotal] = useState(0);
  const [postPage, setPostPage] = useState(0);
  const [postError, setPostError] = useState('');
  const [detail, setDetail] = useState<Run | null>(null);
  const [detailTab, setDetailTab] = useState<'activity' | 'posts' | 'diagnostics' | 'articles'>('activity');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [editingGroup, setEditingGroup] = useState('');
  const [editedName, setEditedName] = useState('');
  const [scheduleDraft, setScheduleDraft] = useState<Schedule>({ cadence: 'daily', time: '09:00' });
  const [scheduleGroup, setScheduleGroup] = useState('');
  const [manualLookbackHours, setManualLookbackHours] = useState<1 | 168 | 720>(1);
  const [formError, setFormError] = useState('');

  const loadOverview = useCallback(async () => {
    const sources: { key: string; path: string; apply: (body: any) => void }[] = [
      { key: 'status', path: '/api/status', apply: (body: Status) => { localToken = body.token || ''; setStatus(body); } },
      { key: 'groups', path: '/api/groups', apply: (body: { groups: Group[] }) => setGroups(body.groups) },
      { key: 'runs', path: '/api/runs', apply: (body: { runs: Run[] }) => setRuns(body.runs) },
      { key: 'activity', path: '/api/activity', apply: (body: { entries: ActivityEntry[] }) => setActivity(body.entries) },
    ];
    await Promise.all(sources.map(async ({ key, path, apply }) => {
      try {
        apply(await request(path));
        setErrors(previous => ({ ...previous, [key]: '' }));
      } catch (error) {
        setErrors(previous => ({ ...previous, [key]: (error as Error).message }));
      } finally {
        setLoaded(previous => ({ ...previous, [key]: true }));
      }
    }));
  }, []);

  const loadPosts = useCallback(async (signal?: AbortSignal) => {
    if (!selectedGroup) return;
    try {
      const result = await request<{ posts: Post[]; total: number }>(`/api/posts?groupId=${encodeURIComponent(selectedGroup)}&page=${postPage}`, { signal });
      if (signal?.aborted || route().groupId !== selectedGroup) return;
      setPosts(result.posts); setPostTotal(result.total); setPostError('');
    } catch (error) { if (!signal?.aborted && route().groupId === selectedGroup) setPostError((error as Error).message); }
  }, [selectedGroup, postPage]);

  useEffect(() => {
    const controller = new AbortController();
    void loadPosts(controller.signal);
    const timer = window.setInterval(() => { void loadPosts(controller.signal); }, 5_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [loadPosts]);

  const loadDetail = useCallback(async (id: string, signal?: AbortSignal) => {
    try {
      const body = await request<{ run: Run }>(`/api/runs/${encodeURIComponent(id)}`, { signal });
      if (signal?.aborted) return;
      setDetail(body.run);
      setDetailError('');
    } catch (error) {
      if (!signal?.aborted) setDetailError((error as Error).message);
    } finally {
      if (!signal?.aborted) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    const timer = window.setInterval(() => { void loadOverview(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [loadOverview]);

  useEffect(() => {
    const onPopState = () => { const next = route(); setSelectedGroup(next.groupId); setCurrentId(next.runId); setAddingGroup(next.adding); setExporting(next.exporting); setPostPage(0); setPosts([]); setPostTotal(0); setPostError(''); };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!currentId) { setDetail(null); setDetailError(''); return; }
    const controller = new AbortController();
    setDetail(null);
    setDetailLoading(true);
    setDetailError('');
    void loadDetail(currentId, controller.signal);
    return () => controller.abort();
  }, [currentId, loadDetail]);

  useEffect(() => {
    if (!currentId || !detail || !isActive(detail)) return;
    const timer = window.setInterval(() => { void loadDetail(currentId); }, 3_000);
    return () => window.clearInterval(timer);
  }, [currentId, detail?.status, loadDetail]);

  async function linkOriginal(post: Post, permalink: string) {
    const { post: updated } = await request<{ post: Post }>(`/api/groups/${encodeURIComponent(post.groupId)}/posts/${encodeURIComponent(post.id)}/permalink`, {
      method: 'PATCH', body: JSON.stringify({ permalink }),
    });
    setPosts(previous => previous.map(entry => entry.groupId === post.groupId && entry.id === post.id ? updated : entry));
    setDetail(previous => previous?.posts ? { ...previous, posts: previous.posts.map(entry => entry.groupId === post.groupId && entry.id === post.id ? { ...entry, id: updated.id, permalink: updated.permalink } : entry) } : previous);
  }

  function navigate(groupId = '', runId: string | null = null, page?: 'new' | 'export') {
    const path = page === 'new' ? '/groups/new' : page === 'export' ? '/export' : groupId ? `/groups/${encodeURIComponent(groupId)}${runId ? `/runs/${encodeURIComponent(runId)}` : ''}` : '/groups';
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setSelectedGroup(groupId);
    setCurrentId(runId);
    setAddingGroup(page === 'new');
    setExporting(page === 'export');
    setPostPage(0);
    setPosts([]); setPostTotal(0); setPostError('');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  async function act(key: string, operation: () => Promise<unknown>, success: string) {
    setBusy(key); setActionError(''); setNotice('');
    try {
      await operation();
      setNotice(success);
      await loadOverview();
      await loadPosts();
    } catch (error) {
      setActionError((error as Error).message);
    } finally { setBusy(''); }
  }

  async function queueRun(groupId: string) {
    const group = groups.find(item => item.id === groupId);
    if (!group) return;
    await act('queue', async () => {
      const body = await request<{ run: Run }>(`/api/groups/${encodeURIComponent(groupId)}/run`, { method: 'POST', body: JSON.stringify({ lookbackHours: manualLookbackHours }) });
      if (!body.run?.id) throw new Error('The server did not return a run ID.');
      navigate(groupId, body.run.id);
      setDetail(body.run);
      setDetailLoading(true);
      void loadDetail(body.run.id);
    }, `Run queued for ${group.name}.`);
  }

  async function addGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = groupUrl(newUrl.trim());
    if (!url) { setFormError('Enter an HTTPS facebook.com/groups/ URL.'); return; }
    if (!newName.trim()) { setFormError('Give this group a name.'); return; }
    setFormError('');
    await act('add', async () => {
      const group = await request<Group>('/api/groups', { method: 'POST', body: JSON.stringify({ url, name: newName.trim() }) });
      setNewUrl(''); setNewName('');
      navigate(group.id);
    }, 'Group added. Queue a run to collect its posts.');
  }

  async function renameGroup(event: FormEvent<HTMLFormElement>, group: Group) {
    event.preventDefault();
    await act(`rename-${group.id}`, async () => {
      const result = await request<{ group: Group }>(`/api/groups/${encodeURIComponent(group.id)}`, { method: 'PATCH', body: JSON.stringify({ name: editedName.trim() }) });
      setGroups(previous => previous.map(item => item.id === group.id ? result.group : item));
      setEditingGroup('');
      setEditedName('');
    }, `Group renamed to ${editedName.trim()}.`);
  }

  async function saveSchedule(event: FormEvent<HTMLFormElement>, group: Group) {
    event.preventDefault();
    const schedule = scheduleGroup === group.id ? scheduleDraft : group.schedule || { cadence: 'daily', time: '09:00' };
    await act(`schedule-${group.id}`, async () => {
      const result = await request<{ group: Group }>(`/api/groups/${encodeURIComponent(group.id)}/schedule`, { method: 'PATCH', body: JSON.stringify(schedule) });
      setGroups(previous => previous.map(item => item.id === group.id ? result.group : item));
      setScheduleGroup('');
    }, 'Schedule saved. The service will queue runs automatically while it is running.');
  }

  async function clearData(kind: 'runs' | 'posts', group: Group) {
    if (fromDate && toDate && fromDate > toDate) { setActionError('End date must not be before start date.'); return; }
    const label = kind === 'runs' ? 'run history and diagnostics' : 'saved posts and their run snapshots';
    if (!window.confirm(`Permanently delete ${label} for ${group.name} ${fromDate || toDate ? `observed/queued from ${fromDate || 'the beginning'} through ${toDate || 'the latest date'}` : 'for all dates'}? This cannot be undone.`)) return;
    await act(`clear-${kind}`, () => request(`/api/groups/${encodeURIComponent(group.id)}/${kind}${rangeQuery(fromDate, toDate)}`, { method: 'DELETE' }), `${label} cleared for ${group.name}.`);
    if (kind === 'runs' && currentId) navigate(group.id);
    if (kind === 'posts') { setPostPage(0); void loadPosts(); }
  }

  const groupNames = new Map(groups.map(group => [group.id, group.name]));
  const currentGroup = groups.find(group => group.id === selectedGroup);
  const visibleRuns = [...runs].sort((a, b) => Date.parse(b.queuedAt || b.startedAt || '') - Date.parse(a.queuedAt || a.startedAt || ''));
  const filteredRuns = visibleRuns.filter(run => run.groupId === selectedGroup);
  const detailActivity = activity.filter(entry => entry.runId === currentId).slice(-100);
  const canMutate = !!localToken && !busy;
  const visibleSchedule = scheduleGroup === currentGroup?.id ? scheduleDraft : currentGroup?.schedule || { cadence: 'daily' as const, time: '09:00' };

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark" aria-hidden="true">▦</span><strong>Group Collector</strong><span className="brand-divider" /><span className="brand-subtitle">Collection workspace</span></div><span className="local-label"><span className="local-dot" /> LOCAL · PRIVATE</span></header>
    <div className="app-body">
      <aside className="sidebar" aria-label="Workspace navigation">
        <p className="nav-heading">WORKSPACE</p>
        <a href="/groups" className={`nav-item ${!currentId && !addingGroup && !selectedGroup && !exporting ? 'is-active' : ''}`} onClick={event => { event.preventDefault(); navigate(); }}><span aria-hidden="true">▤</span> All groups <span className="nav-count">{groups.length}</span></a>
        <a href="/groups/new" className={`nav-item ${addingGroup ? 'is-active' : ''}`} onClick={event => { event.preventDefault(); navigate('', null, 'new'); }}><span aria-hidden="true">＋</span> Add a group</a>
        <a href="/export" className={`nav-item ${exporting ? 'is-active' : ''}`} onClick={event => { event.preventDefault(); navigate('', null, 'export'); }}><span aria-hidden="true">⇩</span> Export posts</a>
        <p className="nav-heading group-heading">GROUPS <span>{groups.length}</span></p>
        {!loaded.groups && <p className="nav-hint">Loading groups…</p>}
        {errors.groups && <p className="nav-error" role="alert">{errors.groups}</p>}
        {loaded.groups && !errors.groups && groups.length === 0 && <p className="nav-hint">Add a group to get started.</p>}
        <div className="group-nav">{groups.map(group => <a key={group.id} href={`/groups/${group.id}`} title={group.name} className={`nav-item ${selectedGroup === group.id ? 'is-active' : ''}`} aria-current={selectedGroup === group.id ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate(group.id); }}><span className="group-dot" aria-hidden="true" /><span className="nav-name">{limited(group.name, 120)}</span></a>)}</div>
        <p className="nav-heading settings-heading">SETTINGS</p>
          <div className="sidebar-settings" aria-label="Collector settings"><span><span className={`status-dot ${status?.connected ? 'good' : 'warning'}`} />Chrome: {!loaded.status ? 'Checking…' : status?.connected ? 'Connected' : 'Not connected'}</span><span>Collector: {status?.running ? 'Running' : 'Idle'}</span><span>Queued: {status?.queued ?? 0}</span><span>Scheduler: {status?.paused ? 'Paused' : 'Active'}</span><button type="button" disabled={!canMutate} onClick={() => void act('connect', () => request('/api/connect', { method: 'POST' }), 'Chrome connection requested.')}>{busy === 'connect' ? 'Connecting…' : 'Connect Chrome'}</button><button type="button" disabled={!canMutate || !status} onClick={() => void act('pause', () => request('/api/pause', { method: 'POST', body: JSON.stringify({ paused: !status?.paused }) }), `Scheduler ${status?.paused ? 'resumed' : 'paused'}.`)}>{status?.paused ? 'Resume scheduler' : 'Pause scheduler'}</button></div>
        <p className="nav-footnote">Runs on your machine.<br />No Newsbee connection.</p>
      </aside>
      <main className="main-content">
        <div className="page-heading"><div className="breadcrumbs"><a href="/groups" onClick={event => { event.preventDefault(); navigate(); }}>Groups</a><span aria-hidden="true">/</span><span>{currentId ? `${currentGroup?.name || 'Group'} / Run details` : addingGroup ? 'Add a group' : exporting ? 'Export posts' : currentGroup?.name || 'All groups'}</span></div><h1>{currentId ? 'Run details' : addingGroup ? 'Add a group' : exporting ? 'Export saved posts' : currentGroup?.name || 'Group management'}</h1><p>{currentId ? 'Collection snapshot, diagnostics and activity for this group.' : addingGroup ? 'Register a group before queuing a collection run.' : exporting ? 'Download a group’s saved posts as JSON for use elsewhere.' : currentGroup ? 'Saved posts, collection history and data management.' : 'Add, browse and manage your groups.'}</p></div>
        <div className="content-wrap">
          {errors.status && <div className="alert error" role="alert">Status unavailable: {errors.status} <button type="button" onClick={() => void loadOverview()}>Retry</button></div>}
          {status?.lastError && <div className="alert error" role="alert">Collector error: {limited(status.lastError, 500)}</div>}
          {actionError && <div className="alert error" role="alert">Action failed: {actionError} <button type="button" onClick={() => setActionError('')}>Dismiss</button></div>}
          {notice && <div className="alert success" role="status">{notice} <button type="button" onClick={() => setNotice('')}>Dismiss</button></div>}

          {currentId ? <>
            <a className="back-link" href={`/groups/${selectedGroup}`} onClick={event => { event.preventDefault(); navigate(selectedGroup); }}>← Back to group</a>
            {detailError && <div className="alert error" role="alert">Could not load run: {detailError} <button type="button" onClick={() => { setDetailLoading(true); void loadDetail(currentId); }}>Retry</button></div>}
            {detailLoading && !detail && <div className="empty-state" role="status">Loading run details…</div>}
            {detail && <>
              <section className="panel detail-summary" aria-labelledby="summary-title"><div className="panel-title"><div><span className="eyebrow">RUN {limited(detail.id, 80)}</span><h2 id="summary-title">{groupNames.get(detail.groupId) || 'Group collection'}</h2></div><span className={`status-pill ${detail.status.toLowerCase()}`}>{detail.status}</span></div><div className="detail-metrics"><div><span>Queued</span><strong>{dateTime(detail.queuedAt)}</strong></div><div><span>Started</span><strong>{dateTime(detail.startedAt)}</strong></div><div><span>Finished</span><strong>{dateTime(detail.finishedAt)}</strong></div><div><span>Posts captured</span><strong>{detail.count ?? 0}</strong></div><div><span>Lookback</span><strong>{detail.cutoffAt ? `Scheduled since ${dateTime(detail.cutoffAt)}` : detail.lookbackHours === 1 ? '1 hour' : detail.lookbackHours === 720 ? '30 days' : '7 days'}</strong></div></div>{detail.reason && <p className="run-reason" role="status">{limited(detail.reason, 500)}</p>}<div className="panel-actions"><button type="button" onClick={() => { setDetailLoading(true); void loadDetail(currentId); void loadOverview(); }} disabled={detailLoading}>{detailLoading ? 'Refreshing…' : 'Refresh run'}</button>{isActive(detail) && <span role="status">Refreshing automatically while {detail.status}.</span>}</div></section>
                            <div className="detail-tabs" role="tablist" aria-label="Run details sections">
                              <button id="activity-tab" type="button" role="tab" aria-selected={detailTab === 'activity'} aria-controls="activity-panel" onClick={() => setDetailTab('activity')}>Run activity</button>
                              <button id="posts-tab" type="button" role="tab" aria-selected={detailTab === 'posts'} aria-controls="posts-panel" onClick={() => setDetailTab('posts')}>Captured posts ({detail.posts?.length ?? 0})</button>
                              <button id="diagnostics-tab" type="button" role="tab" aria-selected={detailTab === 'diagnostics'} aria-controls="diagnostics-panel" onClick={() => setDetailTab('diagnostics')}>Run diagnostics</button>
                              <button id="articles-tab" type="button" role="tab" aria-selected={detailTab === 'articles'} aria-controls="articles-panel" onClick={() => setDetailTab('articles')}>Encountered articles ({detail.diagnostics?.articles?.length ?? 0})</button>
                            </div>
                            {detailTab === 'activity' && <section id="activity-panel" role="tabpanel" aria-labelledby="activity-tab" className="panel" tabIndex={0}><div className="panel-title"><div><span className="eyebrow">LIVE PROGRESS</span><h2>Run activity</h2></div></div>{errors.activity && <div className="alert error" role="alert">Activity unavailable: {errors.activity}</div>}{detailActivity.length ? <ol className="activity-list" aria-live="polite">{detailActivity.map(entry => <li key={entry.id}><time dateTime={entry.at}>{entry.at}</time>{'  '}<strong>{limited(entry.stage.toUpperCase(), 60)}</strong>{'  '}{limited(entry.message, 500)}</li>)}</ol> : <p className="panel-note">{!loaded.activity ? 'Loading activity?' : 'No progress entries for this run yet.'}</p>}<p className="panel-note">Elapsed-time heartbeats and aggregate layout counts are shown. Per-scroll counts, browser output and post content are not logged.</p></section>}
                            {detailTab === 'posts' && <section id="posts-panel" role="tabpanel" aria-labelledby="posts-tab" className="panel" tabIndex={0}><div className="panel-title"><div><span className="eyebrow">RUN SNAPSHOT</span><h2>Captured posts</h2></div><span className="subtle-count">{detail.posts?.length ?? 0} shown</span></div>{detail.posts?.length ? <div className="post-list">{detail.posts.slice(0, 300).map((post, index) => <PostCard key={`${post.id}-${index}`} post={post} runId={detail.id} />)}{detail.posts.length > 300 && <p className="list-note">Showing the first 300 posts in this run.</p>}</div> : <div className="empty-state">{detail.posts === undefined ? 'This run predates per-run snapshots. Its original posts are not available in run details.' : isActive(detail) ? 'No posts captured yet. This snapshot updates as the run progresses.' : 'No posts were captured in this run.'}</div>}</section>}
                            {detailTab === 'diagnostics' && <section id="diagnostics-panel" role="tabpanel" aria-labelledby="diagnostics-tab" className="panel" tabIndex={0}><div className="panel-title"><div><span className="eyebrow">RUN ATTACHMENT</span><h2>Run diagnostics</h2></div></div>{detail.diagnostics ? <><p className="panel-note">Per-scan counts and article rejection reasons. New runs also include bounded raw feed HTML, visible page text, and captured article markup. This may contain private group content; keep the JSON local.</p><div className="diagnostic-actions"><a className="run-link" href={`/api/runs/${encodeURIComponent(detail.id)}/diagnostics`} download={`run-${detail.id}-diagnostics.json`}>Download diagnostic JSON</a><details className="diagnostic-preview"><summary>View diagnostic JSON here</summary><pre>{JSON.stringify({ runId: detail.id, status: detail.status, diagnostics: detail.diagnostics }, null, 2)}</pre></details></div></> : <p className="panel-note">{isActive(detail) ? 'Generated after the browser scan completes.' : 'No diagnostic attachment for this run. Earlier runs cannot be reconstructed; queue a new run to capture one.'}</p>}</section>}
                            {detailTab === 'articles' && <section id="articles-panel" role="tabpanel" aria-labelledby="articles-tab" className="panel captured-articles" tabIndex={0}><div className="panel-title"><div><span className="eyebrow">RAW CAPTURE</span><h2>Encountered articles ({detail.diagnostics?.articles?.length ?? 0})</h2></div></div>{detail.diagnostics?.articles ? <><p className="panel-note">Diagnostic captures, not accepted posts. Comment-labeled articles remain excluded from post counts. Text and markup may contain private group information.</p>{detail.diagnostics.articles.map((article, index) => <details className="article-capture" key={index}><summary>Scan {article.scan + 1} · {article.label === 'comment' ? 'Comment' : 'Other article'} · {article.text.slice(0, 100) || '(no text)'}</summary><pre>{article.text}</pre><details><summary>Captured HTML (text only)</summary><pre>{article.html}</pre></details></details>)}{!detail.diagnostics.articles.length && <p className="panel-note">No article elements were captured. Inspect the page views in the diagnostic JSON for login, challenge, or empty-feed pages.</p>}</> : <p className="panel-note">{isActive(detail) ? 'Captured after the browser scan completes.' : 'No encountered articles were retained for this run.'}</p>}</section>}

            </>}
          </> : addingGroup ? <>
            <a className="back-link" href="/groups" onClick={event => { event.preventDefault(); navigate(); }}>← Back to groups</a>
            <section className="panel add-group-panel" aria-labelledby="add-title"><div className="panel-title"><div><span className="eyebrow">SOURCES</span><h2 id="add-title">Add a group</h2></div></div><p className="panel-note">Only collect from groups you have permission to access.</p><form className="add-form" onSubmit={event => void addGroup(event)}><label htmlFor="group-url">Facebook group URL</label><input id="group-url" type="url" required placeholder="https://facebook.com/groups/?" value={newUrl} onChange={event => setNewUrl(event.target.value)} /><label htmlFor="group-name">Display name</label><input id="group-name" type="text" maxLength={100} required placeholder="e.g. Neighborhood updates" value={newName} onChange={event => setNewName(event.target.value)} />{formError && <p className="form-error" role="alert">{formError}</p>}<button className="primary-button" disabled={!canMutate} type="submit">{busy === 'add' ? 'Adding…' : 'Add group'}</button></form></section>
          </> : exporting ? <>
            <section className="panel add-group-panel"><div className="panel-title"><div><span className="eyebrow">EXPORT</span><h2>Download saved posts</h2></div></div>
              <div className="add-form"><label htmlFor="export-group">Group</label><select id="export-group" value={groups.some(group => group.id === exportGroup) ? exportGroup : groups[0]?.id || ''} onChange={event => setExportGroup(event.target.value)}>{groups.map(group => <option value={group.id} key={group.id}>{group.name}</option>)}</select>
                <label htmlFor="export-from">Observed from (optional)</label><input id="export-from" type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} />
                <label htmlFor="export-to">Observed through (optional)</label><input id="export-to" type="date" value={toDate} onChange={event => setToDate(event.target.value)} />
                {fromDate && toDate && fromDate > toDate && <p className="form-error" role="alert">End date must not be before start date.</p>}
                {groups.length > 0 && (!fromDate || !toDate || fromDate <= toDate) ? <a className="primary-button export-button" href={`/api/export?groupId=${encodeURIComponent(groups.some(group => group.id === exportGroup) ? exportGroup : groups[0].id)}${rangeQuery(fromDate, toDate).replace('?', '&')}`} download>Export JSON</a> : !groups.length ? <p>Add a group to export posts.</p> : null}
              </div><p className="panel-note">Exports include all saved posts observed in the selected inclusive calendar-date range. No dates means all posts. JSON may include private group content; review authorization and privacy requirements before uploading it elsewhere.</p>
            </section>
          </> : currentGroup ? <>
            <section className="panel manual-run-panel" aria-labelledby="manual-run-title">
              <div className="panel-title"><div><span className="eyebrow">COLLECTION</span><h2 id="manual-run-title">Queue a run</h2></div></div>
              <p className="panel-note">Choose how far back to scan. Automatic runs resume from the previous completed run (seven days on the first run).</p>
              <div className="manual-run-controls"><label htmlFor="manual-lookback">Manual lookback</label><select id="manual-lookback" value={manualLookbackHours} onChange={event => setManualLookbackHours(Number(event.target.value) as 1 | 168 | 720)}><option value={1}>1 hour</option><option value={168}>7 days</option><option value={720}>30 days</option></select><button className="queue-run-button" type="button" disabled={!canMutate} onClick={() => void queueRun(currentGroup.id)}>{busy === 'queue' ? 'Queuing…' : 'Queue run'}</button></div>
            </section>
            <section className="panel group-settings-panel"><div className="panel-title"><div><span className="eyebrow">MANAGEMENT</span><h2>Group settings</h2></div></div>
              <div className="setting-item group-detail-settings">
                {editingGroup === currentGroup.id ? <form className="rename-form" onSubmit={event => void renameGroup(event, currentGroup)}><label htmlFor="group-display-name">Display name</label><input id="group-display-name" maxLength={100} required value={editedName} onChange={event => setEditedName(event.target.value)} /><div className="setting-actions"><button type="submit" disabled={!canMutate || !editedName.trim()}>Save name</button><button type="button" onClick={() => setEditingGroup('')}>Cancel</button></div></form> : <><strong>{currentGroup.name}</strong><p>Last run: {dateTime(currentGroup.lastRun)}{currentGroup.lastStatus ? ` · ${currentGroup.lastStatus}` : ''}</p><div className="setting-actions"><a href={recentActivityUrl(currentGroup.url)} target="_blank" rel="noopener noreferrer">View group ↗</a><button type="button" disabled={!canMutate} onClick={() => { setEditingGroup(currentGroup.id); setEditedName(currentGroup.name); }}>Edit name</button></div></>}
                <form className="schedule-form" onSubmit={event => void saveSchedule(event, currentGroup)}><strong>Automatic collection</strong><p>Runs in the background while this service and your signed-in Chrome with the extension remain open. Times use this machine’s local timezone. A paused scheduler skips runs; manual runs still work.</p><div className="schedule-fields"><label>Repeat<select aria-label="Repeat" value={visibleSchedule.cadence} onChange={event => { setScheduleGroup(currentGroup.id); setScheduleDraft({ cadence: event.target.value as Schedule['cadence'], time: event.target.value === 'hourly' ? '00:00' : visibleSchedule.time, ...(event.target.value === 'weekly' ? { dayOfWeek: visibleSchedule.dayOfWeek ?? 1 } : {}) }); }}><option value="hourly">Every hour</option><option value="daily">Every day</option><option value="weekly">Every week</option></select></label>{visibleSchedule.cadence === 'weekly' && <label>Day<select aria-label="Day" value={visibleSchedule.dayOfWeek ?? 1} onChange={event => { setScheduleGroup(currentGroup.id); setScheduleDraft({ ...visibleSchedule, dayOfWeek: Number(event.target.value) }); }}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}{visibleSchedule.cadence === 'hourly' ? <span>At the start of each hour</span> : <label>Local time<input aria-label="Local time" type="time" required value={visibleSchedule.time} onChange={event => { setScheduleGroup(currentGroup.id); setScheduleDraft({ ...visibleSchedule, time: event.target.value }); }} /></label>}</div><p>Next run: {dateTime(currentGroup.nextRunAt)}{status?.paused ? ' (paused)' : ''}</p><button type="submit" disabled={!canMutate || !visibleSchedule.time || scheduleGroup !== currentGroup.id}>Save schedule</button></form>
                <div className="management-range"><strong>Clear data by date range</strong><p>Run history uses queued date; saved posts use first observed date. Leave dates blank to clear everything for this group.</p><div className="range-fields"><label>From <input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} /></label><label>Through <input type="date" value={toDate} onChange={event => setToDate(event.target.value)} /></label></div><div className="setting-actions"><button className="danger-action" type="button" disabled={!canMutate || runs.some(run => run.groupId === currentGroup.id && run.status === 'running')} onClick={() => void clearData('runs', currentGroup)}>Clear history</button><button className="danger-action" type="button" disabled={!canMutate || runs.some(run => run.groupId === currentGroup.id && run.status === 'running')} onClick={() => void clearData('posts', currentGroup)}>Clean saved posts</button></div></div>
                <div className="setting-actions delete-group"><button className="danger-action" type="button" disabled={!canMutate || runs.some(run => run.groupId === currentGroup.id && run.status === 'running')} onClick={() => { if (window.confirm(`Permanently delete ${currentGroup.name} and all saved posts, run history and diagnostics? This cannot be undone.`)) void act('delete-group', async () => { await request(`/api/groups/${encodeURIComponent(currentGroup.id)}`, { method: 'DELETE' }); navigate(); }, `${currentGroup.name} deleted.`); }}>Delete group and all its data</button></div>
              </div>
            </section>
            <section className="panel group-settings-panel" aria-labelledby="saved-posts-title"><div className="panel-title"><div><span className="eyebrow">ARCHIVE</span><h2 id="saved-posts-title">All saved posts</h2></div><span className="subtle-count">{postTotal} total</span></div>{postError && <div className="alert error" role="alert">Could not load posts: {postError}</div>}{!postError && posts.length ? <div className="post-list">{posts.map(post => <PostCard key={post.id} post={post} onLink={linkOriginal} />)}</div> : !postError && <div className="empty-state">No saved posts for this group yet.</div>}<div className="panel-actions"><button type="button" onClick={() => setPostPage(page => page - 1)} disabled={postPage === 0}>Previous</button><span>Page {postPage + 1} of {Math.max(1, Math.ceil(postTotal / 50))}</span><button type="button" onClick={() => setPostPage(page => page + 1)} disabled={(postPage + 1) * 50 >= postTotal}>Next</button><button type="button" onClick={() => void loadPosts()}>Refresh posts</button></div></section>
            <section className="panel runs-panel" aria-labelledby="runs-title"><div className="panel-title"><div><span className="eyebrow">HISTORY</span><h2 id="runs-title">Collection runs</h2></div><span className="subtle-count">{filteredRuns.length} runs</span></div>{errors.runs && <div className="alert error" role="alert">Could not load runs: {errors.runs}</div>}{!filteredRuns.length && !errors.runs ? <div className="empty-state">No runs yet. Queue a run above.</div> : <div className="table-scroll"><table className="run-table"><thead><tr><th>Run</th><th>Queued</th><th>Started</th><th>Finished</th><th>Posts</th><th>Status</th><th>Results</th></tr></thead><tbody>{filteredRuns.map(run => <tr key={run.id}><td><a className="run-link" href={`/groups/${currentGroup.id}/runs/${run.id}`} title={run.id} onClick={event => { event.preventDefault(); navigate(currentGroup.id, run.id); }}>{limited(run.id, 32)}</a></td><td>{dateTime(run.queuedAt)}</td><td>{dateTime(run.startedAt)}</td><td>{dateTime(run.finishedAt)}</td><td>{run.count}</td><td><span className={`status-pill ${run.status.toLowerCase()}`}>{run.status}</span></td><td><a className="run-link" href={`/groups/${currentGroup.id}/runs/${run.id}`} onClick={event => { event.preventDefault(); navigate(currentGroup.id, run.id); }}>View results</a></td></tr>)}</tbody></table></div>}</section>
          </> : <>
            <section className="panel"><div className="panel-title"><div><span className="eyebrow">SOURCES</span><h2>Groups</h2></div><a href="/groups/new" onClick={event => { event.preventDefault(); navigate('', null, 'new'); }}>+ Add a group</a></div>
              {!groups.length ? <div className="empty-state"><strong>No groups yet</strong><p>Add a group to collect and browse its saved posts.</p></div> : <div className="settings-list">{groups.map(group => <div className="setting-item" key={group.id}><div className="setting-heading"><strong><a href={`/groups/${group.id}`} onClick={event => { event.preventDefault(); navigate(group.id); }}>{group.name}</a></strong><span>{runs.filter(run => run.groupId === group.id).length} runs</span></div><p>{group.url} · Last run: {dateTime(group.lastRun)}</p><div className="setting-actions"><a href={`/groups/${group.id}`} onClick={event => { event.preventDefault(); navigate(group.id); }}>View details and saved posts</a><a href={recentActivityUrl(group.url)} target="_blank" rel="noopener noreferrer">View on Facebook ↗</a></div></div>)}</div>}
            </section>
          </>}
          <footer className="footer">Local-only collection · Saved posts and run history remain until you manually clear them. Manual scans default to one hour; scheduled scans start at the prior run time. Feed coverage is best-effort.<br />Optional Gemini (Google AI Studio): configure .local/config.env as described in the README and restart the app. Never paste your key into this page.</footer>
        </div>
      </main>
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
