"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

type OutputChannel = {
  id: string;
  name: string;
  url: string;
  driveFolderId: string;
  selectedSourceIds: string[];
  enabled: boolean;
};
type ConfiguredSource = {
  id: string;
  kind: "library" | "government" | "state-newsroom";
  category: string;
  name: string;
  location: string;
  region?: string;
  url?: string;
  platform?: string;
  tenant?: string;
  selected: boolean;
  ingestion: Array<{
    locationId: string;
    lastIngestedAt: string;
    periodStart: string;
    periodEnd: string;
    status: string;
  }>;
};
type PipelineRun = {
  _id: string;
  kind: "source" | "edition";
  source_id?: string;
  source_name?: string;
  location_id: string;
  location_name: string;
  period_start: string;
  period_end: string;
  status: "ready" | "running" | "failed" | "completed";
  current_stage: string | null;
  stages: Record<string, { status: string; error?: string; started_at?: string; completed_at?: string }>;
  created_at: string;
};
type Location = { id: string; name: string };

async function readResponse(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
  return data;
}

function stageName(stage: string | null) {
  if (!stage) return "Complete";
  return stage.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function prettyDate(value: string | undefined) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export default function OutputChannelManagement() {
  const [channel, setChannel] = useState<OutputChannel | null>(null);
  const [savedSourceIds, setSavedSourceIds] = useState<string[]>([]);
  const [savedDriveFolderId, setSavedDriveFolderId] = useState("");
  const [sources, setSources] = useState<ConfiguredSource[]>([]);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [error, setError] = useState("");
  const [pipelineError, setPipelineError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  async function refreshRuns() {
    const data = await readResponse(await fetch("/api/data-gathering-pipeline/runs", { cache: "no-store" }));
    setRuns(data.runs as PipelineRun[]);
  }

  async function refreshLocations() {
    const data = await readResponse(await fetch("/api/data-gathering-pipeline/locations", { cache: "no-store" }));
    const available = data.locations as Location[];
    setLocations(available);
    setLocationId((current) => available.some((location) => location.id === current)
      ? current : available[0]?.id ?? "");
  }

  useEffect(() => {
    void (async () => {
      try {
        const [channelData, sourceData, runData] = await Promise.all([
          fetch("/api/output-channel", { cache: "no-store" }).then(readResponse),
          fetch("/api/data-gathering-pipeline/sources", { cache: "no-store" }).then(readResponse),
          fetch("/api/data-gathering-pipeline/runs", { cache: "no-store" }).then(readResponse),
        ]);
        setChannel(channelData.channel as OutputChannel);
        setSavedSourceIds(channelData.channel.selectedSourceIds as string[]);
        setSavedDriveFolderId(channelData.channel.driveFolderId as string);
        setSources(sourceData.sources as ConfiguredSource[]);
        setRuns(runData.runs as PipelineRun[]);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      try {
        await refreshLocations();
      } catch (caught) {
        setPipelineError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!channel) return;
    const values = new FormData(event.currentTarget);
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/output-channel", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: String(values.get("name") ?? ""),
          url: String(values.get("url") ?? ""),
          driveFolderId: String(values.get("driveFolderId") ?? ""),
          selectedSourceIds: channel.selectedSourceIds,
          enabled: values.get("enabled") === "on",
        }),
      });
      const data = await readResponse(response);
      setChannel(data.channel as OutputChannel);
      setSavedSourceIds(data.channel.selectedSourceIds as string[]);
      setSavedDriveFolderId(data.channel.driveFolderId as string);
      setNotice("Output channel settings and selected sources saved.");
      await refreshSources();
      await refreshLocations().catch((caught: unknown) => {
        setPipelineError(caught instanceof Error ? caught.message : String(caught));
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  async function refreshSources() {
    const data = await readResponse(await fetch("/api/data-gathering-pipeline/sources", { cache: "no-store" }));
    setSources(data.sources as ConfiguredSource[]);
  }

  async function triggerSource(sourceId: string) {
    if (!locationId) return;
    setBusy(`source:${sourceId}`);
    setPipelineError("");
    setNotice("");
    try {
      const data = await readResponse(await fetch("/api/data-gathering-pipeline/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, locationId }),
      }));
      await refreshRuns();
      setNotice(`Source run ready. Trigger its ${stageName(data.run.current_stage)} stage to continue.`);
    } catch (caught) {
      setPipelineError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  async function triggerStage(run: PipelineRun, stage: string) {
    setBusy(`stage:${run._id}`);
    setPipelineError("");
    setNotice("");
    try {
      await readResponse(await fetch(
        `/api/data-gathering-pipeline/runs/${encodeURIComponent(run._id)}/stages/${stage}`,
        { method: "POST" },
      ));
      await Promise.all([refreshRuns(), refreshSources()]);
      setNotice(`${stageName(stage)} stage completed.`);
    } catch (caught) {
      setPipelineError(caught instanceof Error ? caught.message : String(caught));
      await refreshRuns().catch(() => undefined);
    } finally {
      setBusy("");
    }
  }

  async function createEditionRun() {
    setBusy("edition");
    setPipelineError("");
    setNotice("");
    try {
      await readResponse(await fetch("/api/data-gathering-pipeline/editions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId }),
      }));
      await refreshRuns();
      setNotice("Edition run created. Trigger its Rank stage to continue.");
    } catch (caught) {
      setPipelineError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  function toggleSource(sourceId: string, checked: boolean) {
    if (!channel) return;
    const selectedSourceIds = checked
      ? [...new Set([...channel.selectedSourceIds, sourceId])]
      : channel.selectedSourceIds.filter((id) => id !== sourceId);
    setChannel({ ...channel, selectedSourceIds });
  }

  const selectedRuns = runs.filter((run) => !locationId || run.location_id === locationId);
  const selectionUnsaved = channel
    ? [...channel.selectedSourceIds].sort().join("\n") !== [...savedSourceIds].sort().join("\n")
    : false;
  const folderUnsaved = Boolean(channel && savedDriveFolderId && channel.driveFolderId !== savedDriveFolderId);
  const pipelineSettingsUnsaved = selectionUnsaved || folderUnsaved;

  return (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">MongoDB · output_channels</p>
            <h2>{channel?.name ?? "Newsbee reader site"}</h2>
            <p>There is currently one output channel. Its identifier is <code>reader-site</code>.</p>
          </div>
          {channel && <span className={channel.enabled ? "state active" : "state"}>
            {channel.enabled ? "Enabled" : "Disabled"}
          </span>}
        </div>
        {!channel && !error && <p>Loading channel settings…</p>}
        {channel && (
          <form className="channel-form" onSubmit={(event) => void save(event)}>
            <label className="field">
              <span>Channel name</span>
              <input name="name" required maxLength={120} value={channel.name}
                onChange={(event) => setChannel({ ...channel, name: event.target.value })} />
            </label>
            <label className="field">
              <span>Reader site URL</span>
              <input name="url" type="url" required maxLength={2048} value={channel.url}
                onChange={(event) => setChannel({ ...channel, url: event.target.value })} />
              <small>Keep this aligned with the reader site’s deployed domain; the dashboard uses it as the channel link.</small>
            </label>
            <label className="field">
              <span>Google Drive folder ID</span>
              <input name="driveFolderId" required maxLength={200} pattern="[A-Za-z0-9_-]{10,200}"
                value={channel.driveFolderId}
                onChange={(event) => setChannel({ ...channel, driveFolderId: event.target.value })} />
              <small>Published edition JSON files and a hidden `.newsbee-pipeline` folder are stored under this Drive folder.</small>
            </label>
            <label className="channel-toggle">
              <input name="enabled" type="checkbox" checked={channel.enabled}
                onChange={(event) => setChannel({ ...channel, enabled: event.target.checked })} />
              <span>
                <strong>Reader channel enabled</strong>
                <small>When disabled, the reader API stops serving published editions.</small>
              </span>
            </label>
            <div>
              <button type="submit" disabled={busy !== ""}>{busy === "save" ? "Saving…" : "Save channel"}</button>
            </div>
          </form>
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Source selection</p>
            <h2>Sources for this channel</h2>
            <p>Choose which sources this channel can run. Each source gets its own folder under the channel’s Drive folder.</p>
          </div>
        </div>
        {!sources.length && !error && <p>No configured sources are available.</p>}
        <div className="pipeline-sources">
          {sources.map((source) => {
            const selected = Boolean(channel?.selectedSourceIds.includes(source.id));
            const ingestion = source.ingestion.find((entry) => entry.locationId === locationId) ??
              source.ingestion[0];
            return (
              <article className="pipeline-source" key={source.id}>
                <label className="source-select">
                  <input type="checkbox" checked={selected} disabled={!channel}
                    onChange={(event) => toggleSource(source.id, event.target.checked)} />
                  <span>
                    <strong>{source.name}</strong>
                    <small>{source.category} · {source.location}</small>
                  </span>
                </label>
                <div className="source-actions">
                  <button className="secondary" type="button"
                    disabled={!selected || !locationId || busy !== "" || pipelineSettingsUnsaved ||
                      !savedSourceIds.includes(source.id) ||
                      (source.kind === "government" && source.location !== locationId)}
                    onClick={() => void triggerSource(source.id)}>
                    {busy === `source:${source.id}` ? "Creating…" :
                      source.kind === "government" && source.location !== locationId ? "Location mismatch" : "Start source run"}
                  </button>
                </div>
                {ingestion && (
                  <small className="ingestion-note">
                    Last successful gather: {prettyDate(ingestion.lastIngestedAt)}
                    {ingestion.periodStart && ` · ${ingestion.periodStart}–${ingestion.periodEnd}`}
                  </small>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Manual pipeline stages</p>
            <h2>Run status and edition stages</h2>
            <p>Each button makes one API call. Source artifacts are written to the selected channel’s Drive folder.</p>
          </div>
        </div>
        {pipelineError && <p className="alert" role="alert">{pipelineError}</p>}
        {pipelineSettingsUnsaved && <p className="alert" role="status">
          Save the selected sources and Drive folder changes before starting a run.
        </p>}
        <label className="field pipeline-location">
          <span>Location</span>
          <select value={locationId} onChange={(event) => setLocationId(event.target.value)} disabled={!locations.length}>
            {!locations.length && <option value="">No locations loaded</option>}
            {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </select>
          <small>Loaded from `locations.json` in the configured output-channel Drive folder.</small>
        </label>
        {pipelineError && !locations.length && <p>Check Drive credentials and confirm the service account can read the channel folder.</p>}
        <div className="pipeline-actions">
          <button type="button" className="secondary" disabled={!locationId || busy !== "" ||
            pipelineSettingsUnsaved || !channel?.selectedSourceIds.length}
            onClick={() => void createEditionRun()}>
            {busy === "edition" ? "Creating…" : "Create edition from completed sources"}
          </button>
        </div>
        {!selectedRuns.length && <p>No runs for this location yet.</p>}
        <div className="pipeline-runs">
          {selectedRuns.map((run) => {
            const busyRun = busy === `stage:${run._id}`;
            const stageStatus = run.current_stage ? run.stages[run.current_stage] : undefined;
            const stale = run.status === "running" && stageStatus?.started_at &&
              Date.now() - new Date(stageStatus.started_at).getTime() > 10 * 60 * 1000;
            return (
              <article className="pipeline-run" key={run._id}>
                <div className="pipeline-run-heading">
                  <div>
                    <strong>{run.kind === "source" ? run.source_name : `Edition · ${run.location_name}`}</strong>
                    <small>{run.location_name} · {run.period_start}–{run.period_end}</small>
                  </div>
                  <span className={`state ${run.status === "completed" ? "active" : ""}`}>
                    {run.status} · {stageName(run.current_stage)}
                  </span>
                </div>
                {run.current_stage && (run.status !== "running" || stale) && (
                  <button type="button" disabled={busy !== ""}
                    onClick={() => void triggerStage(run, run.current_stage!)}>
                    {busyRun ? "Running…" : `${stale ? "Retry stalled" : "Run"} ${stageName(run.current_stage)} stage`}
                  </button>
                )}
                {Object.entries(run.stages).map(([stage, status]) => (
                  <small className={status.status === "failed" ? "stage-error" : "stage-summary"} key={stage}>
                    {stageName(stage)}: {status.status}{status.error ? ` — ${status.error}` : ""}
                  </small>
                ))}
                <small className="muted">Created {prettyDate(run.created_at)}</small>
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}
