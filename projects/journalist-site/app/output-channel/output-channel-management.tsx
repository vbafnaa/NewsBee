"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

type OutputChannel = {
  id: string;
  name: string;
  url: string;
  driveFolderId: string;
  selectedLocationIds: string[];
  enabled: boolean;
};
type Location = { id: string; name: string };

async function readResponse(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
  return data;
}

export default function OutputChannelManagement() {
  const [channels, setChannels] = useState<OutputChannel[]>([]);
  const [channel, setChannel] = useState<OutputChannel | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState({ id: "", name: "", url: "" });

  useEffect(() => {
    void (async () => {
      try {
        const data = await readResponse(await fetch("/api/output-channel", { cache: "no-store" }));
        setChannels(data.channels);
        setChannel(data.channels.find((item: OutputChannel) => item.id === data.channel.id) ?? data.channels[0]);
        setLocations(data.locations);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!channel) return;
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const data = await readResponse(await fetch("/api/output-channel", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: channel.id,
          name: channel.name,
          url: channel.url,
          enabled: channel.enabled,
          selectedLocationIds: channel.selectedLocationIds,
        }),
      }));
      setChannel(data.channel);
      setChannels((current) => current.map((item) => item.id === data.channel.id ? data.channel : item));
      setNotice("Channel saved. Its location directory was updated.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create");
    setError("");
    setNotice("");
    try {
      const data = await readResponse(await fetch("/api/output-channel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draft.id.trim(), name: draft.name.trim(), url: draft.url.trim() }),
      }));
      setChannels((current) => [...current, data.channel].sort((a, b) => a.id.localeCompare(b.id)));
      setChannel(data.channel);
      setDraft({ id: "", name: "", url: "" });
      setNotice(`Channel created with folder ${data.channel.driveFolderId}. Select its locations and save.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  function toggle(locationId: string, checked: boolean) {
    if (!channel) return;
    const selected = checked
      ? [...new Set([...channel.selectedLocationIds, locationId])]
      : channel.selectedLocationIds.filter((id) => id !== locationId);
    setChannel({ ...channel, selectedLocationIds: selected });
  }

  return (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <section className="panel">
        <div className="section-heading">
          <h2>{channel?.name ?? "Output channel"}</h2>
          <label className="field channel-picker">
            <span>Output channel</span>
            <select value={channel?.id ?? ""} disabled={busy !== ""}
              onChange={(event) => setChannel(channels.find((item) => item.id === event.target.value) ?? null)}>
              {channels.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
            </select>
          </label>
        </div>
        {channel && (
          <form className="channel-form" onSubmit={(event) => void save(event)}>
            <label className="field">
              <span>Channel name</span>
              <input required maxLength={120} value={channel.name}
                onChange={(event) => setChannel({ ...channel, name: event.target.value })} />
            </label>
            <label className="field">
              <span>Reader site URL</span>
              <input type="url" required maxLength={2048} value={channel.url}
                onChange={(event) => setChannel({ ...channel, url: event.target.value })} />
            </label>
            <p className="muted">Folder: <code>{channel.driveFolderId}</code></p>
            <label className="channel-toggle">
              <input type="checkbox" checked={channel.enabled}
                onChange={(event) => setChannel({ ...channel, enabled: event.target.checked })} />
              <span>Enabled (disabled channels receive no new editions)</span>
            </label>
            <fieldset>
              <legend>Locations this channel publishes</legend>
              {!locations.length && <p>No locations onboarded yet.</p>}
              {locations.map((location) => (
                <label className="channel-toggle" key={location.id}>
                  <input type="checkbox" checked={channel.selectedLocationIds.includes(location.id)}
                    onChange={(event) => toggle(location.id, event.target.checked)} />
                  <span>{location.name}</span>
                </label>
              ))}
            </fieldset>
            <div><button type="submit" disabled={busy !== ""}>{busy === "save" ? "Saving…" : "Save channel"}</button></div>
          </form>
        )}
      </section>

      <section className="panel">
        <h2>Create an output channel</h2>
        <form className="channel-form" onSubmit={(event) => void create(event)}>
          <label className="field">
            <span>Channel ID</span>
            <input required maxLength={64} pattern="[a-z0-9][a-z0-9-]{1,63}" placeholder="community-news"
              value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
          </label>
          <label className="field">
            <span>Channel name</span>
            <input required maxLength={120} value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label className="field">
            <span>Reader site URL</span>
            <input required type="url" maxLength={2048} placeholder="https://reader.example.org"
              value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
          </label>
          <div><button type="submit" disabled={busy !== ""}>{busy === "create" ? "Creating…" : "Create channel"}</button></div>
        </form>
      </section>
    </>
  );
}
