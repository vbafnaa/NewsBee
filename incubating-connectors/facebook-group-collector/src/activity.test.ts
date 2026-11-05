import { expect, it } from 'vitest';
import { ActivityLog } from './activity.js';

it('keeps a bounded, timestamped activity log without browser output', () => {
  const log = new ActivityLog(2, () => Date.parse('2026-01-15T00:00:00Z'));
  log.add('group-1', 'started');
  log.add('group-1', 'scanning');
  log.add('group-1', 'completed');
  expect(log.snapshot()).toEqual([
    { id: 2, at: '2026-01-15T00:00:00.000Z', groupId: 'group-1', stage: 'scanning', message: 'feed_scan_start max_scans=45 max_posts=250 cutoff_days=7' },
    { id: 3, at: '2026-01-15T00:00:00.000Z', groupId: 'group-1', stage: 'completed', message: 'run_finished' },
  ]);
  const copy = log.snapshot();
  copy[0].message = 'changed';
  expect(log.snapshot()[0].message).toBe('feed_scan_start max_scans=45 max_posts=250 cutoff_days=7');
});

it('clears only the selected group activity without reusing entry IDs', () => {
  const log = new ActivityLog();
  log.add('group-1', 'started', 'run-1');
  log.add('group-2', 'started', 'run-2');
  log.clearGroup('group-1');
  log.add('group-1', 'started', 'run-3');
  expect(log.snapshot().map(entry => [entry.id, entry.runId])).toEqual([[2, 'run-2'], [3, 'run-3']]);
});

it('renders only bounded numeric diagnostics and fixed status tokens', () => {
  const log = new ActivityLog();
  log.add('group-1', 'layout', 'run-1', { elapsedMs: 1200, status: 'private page text', layout: { scans: 3, feedSeen: 3, articlesSeen: 6, commentArticlesSeen: 6, commentLinksSeen: 4, postLinksSeen: 0, messageNodesSeen: 0, timeNodesSeen: 0, fallbackNodesSeen: 0, privatePost: 'secret' } });
  log.add('group-1', 'waiting', 'run-1', { elapsedMs: 15000 });
  log.add('group-1', 'completed', 'run-1', { elapsedMs: 20000, status: 'partial_comments_only', count: 0 });
  expect(log.snapshot().map(entry => entry.message)).toEqual([
    'feed_scan_structure elapsed_ms=1200 scans=3 feedSeen=3 articlesSeen=6 commentArticlesSeen=6 commentLinksSeen=4 postLinksSeen=0 messageNodesSeen=0 timeNodesSeen=0 fallbackNodesSeen=0',
    'feed_scan_waiting per_scroll_counts=unavailable elapsed_ms=15000',
    'run_finished elapsed_ms=20000 status=partial_comments_only saved_posts=0',
  ]);
  expect(JSON.stringify(log.snapshot())).not.toMatch(/secret|private page text/);
});
