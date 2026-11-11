"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import { formatLiveLog, type LiveDetail } from "./source-run-live-log";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export default function LiveSourceRun({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<LiveDetail | null>(null);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [logErrors, setLogErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const logRef = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const content = detail ? formatLiveLog(detail, logs, logErrors) : "";

  useEffect(() => {
    if (follow.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [content]);

  const load = useCallback(async (signal: AbortSignal) => {
    if (signal.aborted) return;
    try {
      const next = await adminApi<LiveDetail>(`runs/${encodeURIComponent(runId)}`, { signal });
      const available = next.jobs.filter((job) => job.log_file);
      const results = await Promise.allSettled(available.map(async (job) => {
        const response = await fetch(`/api/admin/jobs/${encodeURIComponent(job.id)}/log`, { cache: "no-store", signal });
        if (!response.ok) {
          const data = await response.json().catch(() => null) as { detail?: string } | null;
          throw new Error(data?.detail ?? `Request failed (${response.status})`);
        }
        return response.text();
      }));
      if (signal.aborted) return;
      const contents: Record<string, string> = {};
      const failures: Record<string, string> = {};
      results.forEach((result, index) => {
        const id = available[index].id;
        if (result.status === "fulfilled") contents[id] = result.value;
        else failures[id] = message(result.reason);
      });
      setDetail(next);
      setLogs(contents);
      setLogErrors(failures);
      setError("");
    } catch (cause) {
      if (!signal.aborted) setError(message(cause));
    }
  }, [runId]);

  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try { await load(controller.signal); } finally { busy = false; }
    };
    void refresh();
    const timer = detail === null || detail.run.status === "mapping"
      ? window.setInterval(() => { if (!document.hidden) void refresh(); }, 3_000) : null;
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { controller.abort(); if (timer) window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [detail?.run.status, load]);

  return <section className="panel" aria-label="Live source collection log">
    <div className="section-heading"><div><h2>Live run log</h2><p>Automatically records what was triggered, queued and executed. Updates every 3 seconds while collecting.</p></div>
      {detail && <span className={`status-badge tone-${detail.run.status === "mapping" ? "running" : detail.run.status === "failed" ? "failed" : "ok"}`}>{detail.run.status === "mapping" ? "Live" : detail.run.status}</span>}
    </div>
    {error && <p className="alert" role="alert">Log refresh failed: {error}</p>}
    {!detail ? <p role="status">Loading the run log…</p> : <pre ref={logRef} className="source-live-log" aria-label="Source collection events" onScroll={(event) => {
      const element = event.currentTarget;
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    }}>{content}</pre>}
  </section>;
}
