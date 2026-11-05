import { safeLayout } from './gemini.js';

export type ActivityStage = 'started' | 'connecting' | 'opening' | 'scanning' | 'opening_recent' | 'scanning_recent' | 'opening_chronological' | 'scanning_chronological' | 'waiting' | 'layout' | 'analyzing' | 'saving' | 'completed' | 'failed';
export type ActivityEntry = { id: number; at: string; groupId: string; runId?: string; stage: ActivityStage; message: string };
export type ActivityDetail = { elapsedMs?: number; count?: number; layout?: unknown; status?: string };

const labels: Record<ActivityStage, string> = {
  started: 'run_started',
  connecting: 'chrome_connect_start',
  opening: 'group_tab_open_start',
  scanning: 'feed_scan_start max_scans=45 max_posts=250 cutoff_days=7',
  opening_recent: 'recent_activity_tab_open_start step=2',
  scanning_recent: 'recent_activity_scan_start step=2 first_feed_posts=10',
  opening_chronological: 'chronological_tab_open_start step=1',
  scanning_chronological: 'chronological_scan_start step=1 max_scans=44 max_posts=250',
  waiting: 'feed_scan_waiting per_scroll_counts=unavailable',
  layout: 'feed_scan_structure',
  analyzing: 'gemini_layout_hint_start aggregate_counts_only=true',
  saving: 'post_snapshot_save_start',
  completed: 'run_finished',
  failed: 'run_failed',
};
const statuses = new Set(['failed', 'login_required', 'layout_unsupported', 'partial_comments_only', 'partial_no_posts', 'partial_feed_unloaded', 'partial_limit', 'partial_unknown_time', 'partial_cutoff', 'partial_feed', 'partial_second_step']);

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private nextId = 1;
  constructor(private readonly limit = 100, private readonly clock: () => number = Date.now) {}
  add(groupId: string, stage: ActivityStage, runId?: string, detail: ActivityDetail = {}): void {
    const fields = [labels[stage]];
    if (Number.isSafeInteger(detail.elapsedMs) && detail.elapsedMs! >= 0) fields.push(`elapsed_ms=${Math.min(detail.elapsedMs!, 3600000)}`);
    if (detail.status && statuses.has(detail.status)) fields.push(`status=${detail.status}`);
    if (Number.isSafeInteger(detail.count) && detail.count! >= 0) fields.push(`saved_posts=${Math.min(detail.count!, 250)}`);
    if (stage === 'layout') {
      const layout = safeLayout(detail.layout);
      if (layout) for (const [key, value] of Object.entries(layout)) fields.push(`${key}=${value}`);
    }
    this.entries.push({ id: this.nextId++, at: new Date(this.clock()).toISOString(), groupId, ...(runId ? { runId } : {}), stage, message: fields.join(' ') });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }
  snapshot(): ActivityEntry[] { return this.entries.map(entry => ({ ...entry })); }
  clearGroup(groupId: string): void { this.entries = this.entries.filter(entry => entry.groupId !== groupId); }
}
