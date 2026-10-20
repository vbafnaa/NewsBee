"use client";

import Link from "next/link";
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
  if (stage === "rank") return "Aggregate and rank";
  return stage.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function prettyDate(value: string | undefined) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export default function OutputChannelManagement() {
  const [channel, setChannel] = useState<OutputChannel | null>(null);
  const [channels, setChannels] = useState<OutputChannel[]>([]);
  const [savedSourceIds, setSavedSourceIds] = useState<string[]>([]);
  const [sources, setSources] = useState<ConfiguredSource[]>([]);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [error, setError] = useState("");
  const [pipelineError, setPipelineError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [newChannelId, setNewChannelId] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelUrl, setNewChannelUrl] = useState("");

  async function refreshRuns(channelId = channel?.id) {
    if (!channelId) return;
    const data = await readResponse(await fetch(
      `/api/data-gathering-pipeline/runs?channelId=${encodeURIComponent(channelId)}`,
      { cache: "no-store" },
    ));
    setRuns(data.runs as PipelineRun[]);
  }

  async function refreshLocations() {
    const data = await readResponse(await fetch("/api/data-gathering-pipeline/locations", { cache: "no-store" }));
    const available = data.locations as Location[];
    setLocations(available);
    setLocationId((current) => available.some((location) => location.id === current)
      ? current : available[0]?.id ?? "");
  }

  async function refreshChannelData(channelId: string) {
    const [sourceData, runData] = await Promise.all([
      fetch(`/api/data-gathering-pipeline/sources?channelId=${encodeURIComponent(channelId)}`, {
        cache: "no-store",
      }).then(readResponse),
      fetch(`/api/data-gathering-pipeline/runs?channelId=${encodeURIComponent(channelId)}`, {
        cache: "no-store",
      }).then(readResponse),
    ]);
    setSources(sourceData.sources as ConfiguredSource[]);
    setRuns(runData.runs as PipelineRun[]);
  }

  useEffect(() => {
    void (async () => {
      try {
        const channelData = await readResponse(await fetch("/api/output-channel", { cache: "no-store" }));
        const available = channelData.channels as OutputChannel[];
        const initial = (available.find((item) => item.id === channelData.channel.id) ??
          available[0]) as OutputChannel;
        setChannels(available);
        setChannel(initial);
        setSavedSourceIds(initial.selectedSourceIds);
        await refreshChannelData(initial.id);
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

  async function selectChannel(channelId: string) {
    const selected = channels.find((item) => item.id === channelId);
    if (!selected) return;
    setChannel(selected);
    setSavedSourceIds(selected.selectedSourceIds);
    setError("");
    setPipelineError("");
    try {
      await refreshChannelData(selected.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

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
          id: channel.id,
          name: String(values.get("name") ?? ""),
          url: String(values.get("url") ?? ""),
          selectedSourceIds: channel.selectedSourceIds,
          enabled: values.get("enabled") === "on",
        }),
      });
      const data = await readResponse(response);
      setChannel(data.channel as OutputChannel);
      setChannels((current) => current.map((item) =>
        item.id === data.channel.id ? data.channel as OutputChannel : item));
      setSavedSourceIds(data.channel.selectedSourceIds as string[]);
      setNotice("Output channel settings and selected sources saved.");
      await refreshSources(channel.id);
      await refreshLocations().catch((caught: unknown) => {
        setPipelineError(caught instanceof Error ? caught.message : String(caught));
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  async function createChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create-channel");
    setError("");
    setNotice("");
    try {
      const channelData = await readResponse(await fetch("/api/output-channel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: newChannelId.trim(),
          name: newChannelName.trim(),
          url: newChannelUrl.trim(),
        }),
      }));
      const created = channelData.channel as OutputChannel;
      setChannels((current) => [...current, created].sort((left, right) => left.id.localeCompare(right.id)));
      setChannel(created);
      setSavedSourceIds(created.selectedSourceIds);
      setNewChannelId("");
      setNewChannelName("");
      setNewChannelUrl("");
      await refreshChannelData(created.id);
      setNotice(`Output channel created. Its Drive folder ID is ${created.driveFolderId}. Share it with the reader site's service account.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  async function refreshSources(channelId = channel?.id) {
    if (!channelId) return;
    const data = await readResponse(await fetch(
      `/api/data-gathering-pipeline/sources?channelId=${encodeURIComponent(channelId)}`,
      { cache: "no-store" },
    ));
    setSources(data.sources as ConfiguredSource[]);
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
        body: JSON.stringify({ locationId, channelId: channel?.id }),
      }));
      await refreshRuns();
      setNotice("Channel aggregation queued. Run its Aggregate and rank stage to combine selected source data.");
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
  const pipelineSettingsUnsaved = selectionUnsaved;

  return (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">MongoDB · output_channels</p>
            <h2>{channel?.name ?? "Newsbee reader site"}</h2>
            <p>Each output channel owns a Drive folder that is created automatically and cannot be changed here.</p>
          </div>
          <label className="field channel-picker">
            <span>Output channel</span>
            <select value={channel?.id ?? ""} onChange={(event) => void selectChannel(event.target.value)}
              disabled={!channels.length || busy !== "" || selectionUnsaved}>
              {channels.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
            </select>
          </label>
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
            <p className="muted">
              Channel Drive folder: <code>{channel.driveFolderId}</code>. Published editions and
              channel-specific intermediate artifacts are stored there.
            </p>
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
            <p className="eyebrow">New destination</p>
            <h2>Create an output channel</h2>
            <p>The system creates a Drive folder under the configured pipeline Drive folder and copies its locations index there.</p>
          </div>
        </div>
        <form className="channel-form" onSubmit={(event) => void createChannel(event)}>
          <label className="field">
            <span>Channel ID</span>
            <input required maxLength={64} pattern="[a-z0-9][a-z0-9-]{1,63}"
              value={newChannelId} onChange={(event) => setNewChannelId(event.target.value)}
              placeholder="community-news" />
            <small>Use 2–64 lowercase letters, numbers, and hyphens.</small>
          </label>
          <label className="field">
            <span>Channel name</span>
            <input required maxLength={120} value={newChannelName}
              onChange={(event) => setNewChannelName(event.target.value)} />
          </label>
          <label className="field source-url">
            <span>Reader site URL</span>
            <input required type="url" maxLength={2048} value={newChannelUrl}
              onChange={(event) => setNewChannelUrl(event.target.value)} placeholder="https://reader.example.org" />
          </label>
          <div><button type="submit" disabled={busy !== ""}>
            {busy === "create-channel" ? "Creating…" : "Create channel and Drive folder"}
          </button></div>
        </form>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Source selection</p>
            <h2>Sources for this channel</h2>
            <p>Select which independently ingested sources this channel will aggregate into editions. Manage ingestion from each source page.</p>
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
                  <Link className="button secondary" href={`/sources/${encodeURIComponent(source.id)}`}>
                    Manage ingestion
                  </Link>
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
            <p className="eyebrow">Stage 2 · channel aggregation</p>
            <h2>Aggregate source data into an edition</h2>
            <p>Each button makes one API call. This channel aggregates completed source artifacts from the shared pipeline Drive folder and writes its edition outputs to this channel’s Drive folder.</p>
          </div>
        </div>
        {pipelineError && <p className="alert" role="alert">{pipelineError}</p>}
        {pipelineSettingsUnsaved && <p className="alert" role="status">
          Save this channel’s source selection before starting aggregation.
        </p>}
        <label className="field pipeline-location">
          <span>Location</span>
          <select value={locationId} onChange={(event) => setLocationId(event.target.value)} disabled={!locations.length}>
            {!locations.length && <option value="">No locations loaded</option>}
            {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </select>
          <small>Loaded from `locations.json` in the shared pipeline Drive folder.</small>
        </label>
        {pipelineError && !locations.length && <p>Check Drive credentials and confirm the service account can read the pipeline folder.</p>}
        <div className="pipeline-actions">
          <button type="button" className="secondary" disabled={!locationId || busy !== "" ||
            pipelineSettingsUnsaved || !channel?.selectedSourceIds.length}
            onClick={() => void createEditionRun()}>
            {busy === "edition" ? "Queueing aggregation…" : "Queue channel aggregation"}
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
                    <strong>Edition · {run.location_name}</strong>
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
