export type LiveJob = {
  id: string; kind: string; status: string; attempts: number; created_at: number; available_at?: number; started_at: number | null; completed_at: number | null;
  log_file: string | null; log_error: string | null; error: string | null; discovery_label?: string;
  dispatch_error?: string | null; dispatch_error_at?: number | null; dispatched_at?: number | null;
};
export type LiveRun = {
  status: string; created_at: number; completed_at: number | null; error: string | null;
  trigger: { kind: string; by: string }; execution_blocked?: { reason: string; at: number };
  stage_transitions?: Array<{ status: string; by: string; at: number }>;
};
export type LiveDetail = {
  run: LiveRun; jobs: LiveJob[];
  health: { diagnostics?: { issues: Array<{ severity: string; message: string }> } | null };
};

const label = (value: string) => value.replaceAll("_", " ");
const stamp = (seconds: number) => new Date(seconds * 1000).toLocaleString();
const line = (time: number, text: string) => ({ time, text: `[${stamp(time)}] ${text}` });

export function formatLiveLog(detail: LiveDetail, logs: Record<string, string>, logErrors: Record<string, string>): string {
  const { run, jobs } = detail;
  const entries = [line(run.created_at, `Triggered ${label(run.trigger.kind)} by ${run.trigger.by}. Collecting sources started.`)];
  for (const transition of run.stage_transitions ?? []) entries.push(line(transition.at, `Stage ${label(transition.status)} triggered by ${transition.by}.`));
  for (const job of jobs) {
    const name = job.kind === "discover" && job.discovery_label ? `Discover ${job.discovery_label}` : label(job.kind);
    entries.push(line(job.created_at, `${name}: queued.`));
    if (job.started_at) entries.push(line(job.started_at, `${name}: ${job.status === "running" ? "executing" : "attempt started"} (attempt ${job.attempts}).`));
    if (job.status === "pending" && job.attempts) entries.push(line(job.available_at ?? job.created_at, `${name}: waiting to retry.`));
    if (job.dispatch_error && (job.dispatch_error_at ?? 0) > (job.dispatched_at ?? 0))
      entries.push(line(job.dispatch_error_at!, `${name}: dispatch failed — ${job.dispatch_error}`));
    for (const raw of (logs[job.id] ?? "").split("\n")) {
      if (!raw.trim()) continue;
      try {
        const record: unknown = JSON.parse(raw);
        if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Not a log record");
        const { time, level, component, event, ...fields } = record as Record<string, unknown>;
        const at = typeof time === "string" ? Date.parse(time) / 1000 : NaN;
        const extra = Object.entries(fields).filter(([key]) => !["run_id", "location_id", "job_id"].includes(key));
        const text = `${name}: ${[level, component, event].filter((part) => typeof part === "string").join(" · ")}${extra.length ? ` — ${extra.map(([key, value]) => `${label(key)}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join("; ")}` : ""}`;
        entries.push(Number.isFinite(at) ? line(at, text) : { time: job.started_at ?? job.created_at, text });
      } catch {
        entries.push({ time: job.started_at ?? job.created_at, text: `${name}: ${raw}` });
      }
    }
    if (job.completed_at) entries.push(line(job.completed_at, `${name}: ${job.status}${job.error ? ` — ${job.error}` : ""}.`));
    else if (job.error) entries.push(line(job.started_at ?? job.created_at, `${name}: ${job.status} — ${job.error}.`));
    if (job.log_error) entries.push(line(job.completed_at ?? job.created_at, `${name}: log save failed — ${job.log_error}`));
    if (logErrors[job.id]) entries.push(line(job.completed_at ?? job.created_at, `${name}: log unavailable — ${logErrors[job.id]}`));
  }
  if (run.execution_blocked) entries.push(line(run.execution_blocked.at, `Run could not start: ${run.execution_blocked.reason}`));
  for (const issue of detail.health.diagnostics?.issues ?? []) {
    if (issue.severity !== "info") entries.push(line(run.completed_at ?? run.created_at, `${issue.severity}: ${issue.message}`));
  }
  if (run.error) entries.push(line(run.completed_at ?? run.created_at, `Run ${run.status}: ${run.error}`));
  else if (run.completed_at) entries.push(line(run.completed_at, `Run ${run.status}.`));
  if (!jobs.length && run.status === "mapping" && !run.execution_blocked) entries.push(line(run.created_at, "Waiting for source collection jobs to be scheduled."));
  return entries.sort((a, b) => a.time - b.time).map((entry) => entry.text).join("\n");
}
