"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Source = {
  id: string;
  kind: "library" | "government" | "state-newsroom";
  category: string;
  name: string;
  location: string;
  region?: string;
  url?: string;
  platform?: string;
  tenant?: string;
};
type Stage = {
  status: string;
  error?: string;
  started_at?: string;
  completed_at?: string;
  drive_file_id?: string;
};
type Run = {
  _id: string;
  source_id: string;
  source_name: string;
  location_id: string;
  location_name: string;
  period_start: string;
  period_end: string;
  status: string;
  current_stage: string | null;
  stages: Record<string, Stage>;
  created_at: string;
};
type Ingestion = {
  location_id: string;
  last_ingested_at?: string;
  period_start?: string;
  period_end?: string;
  status?: string;
};
type Location = { id: string; name: string };

async function responseData(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
  return data;
}

function displayDate(value?: string) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function stageName(stage: string | null) {
  return stage ? stage.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Complete";
}

export default function SourcePipelineManagement({ sourceId }: { sourceId: string }) {
  const [source, setSource] = useState<Source | null>(null);
  const [selected, setSelected] = useState(false);
  const [ingestion, setIngestion] = useState<Ingestion[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [artifacts, setArtifacts] = useState<Record<string, unknown>>({});
  const [expandedRun, setExpandedRun] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refreshSource = useCallback(async () => {
    const data = await responseData(await fetch(
      `/api/data-gathering-pipeline/sources/${encodeURIComponent(sourceId)}`,
      { cache: "no-store" },
    ));
    setSource(data.source as Source);
    setSelected(data.selected as boolean);
    setIngestion(data.ingestion as Ingestion[]);
    setRuns(data.runs as Run[]);
  }, [sourceId]);

  const refreshLocations = useCallback(async () => {
    const data = await responseData(await fetch("/api/data-gathering-pipeline/locations", { cache: "no-store" }));
    const available = data.locations as Location[];
    const sourceData = await responseData(await fetch(
      `/api/data-gathering-pipeline/sources/${encodeURIComponent(sourceId)}`,
      { cache: "no-store" },
    ));
    const options = sourceData.source.kind === "government"
      ? available.filter((location) => location.id === sourceData.source.location)
      : available;
    setLocations(options);
    setLocationId((current) => options.some((location) => location.id === current)
      ? current : options[0]?.id ?? "");
  }, [sourceId]);

  useEffect(() => {
    void Promise.all([refreshSource(), refreshLocations()]).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [refreshSource, refreshLocations]);

  async function queueRun() {
    setBusy("queue");
    setError("");
    setNotice("");
    try {
      const data = await responseData(await fetch("/api/data-gathering-pipeline/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, locationId }),
      }));
      await refreshSource();
      setNotice(`Ingestion run queued. Trigger its ${stageName(data.run.current_stage)} stage when ready.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  async function triggerStage(run: Run, stage: string) {
    setBusy(run._id);
    setError("");
    setNotice("");
    try {
      await responseData(await fetch(
        `/api/data-gathering-pipeline/runs/${encodeURIComponent(run._id)}/stages/${stage}`,
        { method: "POST" },
      ));
      await refreshSource();
      setNotice(`${stageName(stage)} stage completed.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      await refreshSource().catch(() => undefined);
    } finally {
      setBusy("");
    }
  }

  async function toggleArtifacts(run: Run) {
    if (expandedRun === run._id) {
      setExpandedRun("");
      return;
    }
    setExpandedRun(run._id);
    if (artifacts[run._id] !== undefined) return;
    setBusy(`artifacts:${run._id}`);
    setError("");
    try {
      const data = await responseData(await fetch(
        `/api/data-gathering-pipeline/sources/${encodeURIComponent(sourceId)}/runs/${encodeURIComponent(run._id)}`,
        { cache: "no-store" },
      ));
      setArtifacts((current) => ({ ...current, [run._id]: data.artifacts }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setExpandedRun("");
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <p><Link href="/sources">← All sources</Link></p>
      {error && <p className="alert" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {source && (
        <>
          <section className="panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">{source.category} · {source.id}</p>
                <h2>{source.name}</h2>
                <p>{source.location}{source.region ? ` · ${source.region}` : ""}</p>
                {source.url && <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>}
                {source.platform && <p>{source.platform} · tenant {source.tenant}</p>}
              </div>
              <span className={`state ${selected ? "active" : ""}`}>
                {selected ? "Selected for reader channel" : "Not selected for reader channel"}
              </span>
            </div>
            <label className="field pipeline-location">
              <span>Ingestion location</span>
              <select value={locationId} onChange={(event) => setLocationId(event.target.value)}
                disabled={!locations.length || source.kind === "government"}>
                {!locations.length && <option value="">No locations available</option>}
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>{location.name}</option>
                ))}
              </select>
              <small>Locations are loaded from `locations.json` in the output channel’s Drive folder.</small>
            </label>
            {!selected && <p className="alert" role="status">
              Select this source on the <Link href="/output-channel">output channel page</Link> before queueing an ingestion run.
            </p>}
            <button type="button" disabled={!selected || !locationId || busy !== ""}
              onClick={() => void queueRun()}>
              {busy === "queue" ? "Queueing…" : "Queue ingestion"}
            </button>
          </section>

          <section className="panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">MongoDB · source_ingestion_state</p>
                <h2>Latest ingestion</h2>
              </div>
            </div>
            {!ingestion.length ? <p>No successful gather has been recorded for this source.</p> : (
              <div className="pipeline-runs">
                {ingestion.map((entry) => (
                  <article className="pipeline-run" key={entry.location_id}>
                    <strong>{entry.location_id}</strong>
                    <span>Status: {entry.status ?? "unknown"}</span>
                    <span>Last gathered: {displayDate(entry.last_ingested_at)}</span>
                    {entry.period_start && <span>Period: {entry.period_start}–{entry.period_end}</span>}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">MongoDB · data_gathering_runs</p>
                <h2>Run history</h2>
                <p>Gather and normalize run independently; trigger each available stage as a separate request.</p>
              </div>
              <button className="secondary" type="button" disabled={busy !== ""}
                onClick={() => void refreshSource().catch((caught: unknown) =>
                  setError(caught instanceof Error ? caught.message : String(caught)))}>
                Refresh history
              </button>
            </div>
            {!runs.length && <p>No runs queued for this source yet.</p>}
            <div className="pipeline-runs">
              {runs.map((run) => {
                const currentStage = run.current_stage;
                const stage = currentStage ? run.stages[currentStage] : undefined;
                const stale = run.status === "running" && stage?.started_at &&
                  Date.now() - new Date(stage.started_at).getTime() > 10 * 60 * 1000;
                return (
                  <article className="pipeline-run" key={run._id}>
                    <div className="pipeline-run-heading">
                      <div>
                        <strong>{run.location_name}</strong>
                        <small>{run.period_start}–{run.period_end} · created {displayDate(run.created_at)}</small>
                      </div>
                      <span className={`state ${run.status === "completed" ? "active" : ""}`}>
                        {run.status} · {stageName(currentStage)}
                      </span>
                    </div>
                    {currentStage && (run.status !== "running" || stale) && (
                      <button type="button" disabled={busy !== ""}
                        onClick={() => void triggerStage(run, currentStage)}>
                        {busy === run._id ? "Running…" : `${stale ? "Retry stalled" : "Run"} ${stageName(currentStage)} stage`}
                      </button>
                    )}
                    {Object.entries(run.stages).map(([name, record]) => (
                      <small className={record.status === "failed" ? "stage-error" : "stage-summary"} key={name}>
                        {stageName(name)}: {record.status}
                        {record.error ? ` — ${record.error}` : ""}
                        {record.completed_at ? ` · ${displayDate(record.completed_at)}` : ""}
                      </small>
                    ))}
                    <button className="secondary" type="button" disabled={busy !== ""}
                      onClick={() => void toggleArtifacts(run)}>
                      {busy === `artifacts:${run._id}` ? "Loading artifacts…" :
                        expandedRun === run._id ? "Hide Drive artifacts" : "View Drive artifacts"}
                    </button>
                    {expandedRun === run._id && (
                      <pre className="artifact-preview">
                        {JSON.stringify(artifacts[run._id] ?? "Loading…", null, 2)}
                      </pre>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        </>
      )}
    </>
  );
}
