"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { adminApi } from "@/lib/admin-client";
import ChannelEditionCreator from "./channel-edition-creator";

type Location = { id: string; name: string };
type DestinationType = "reader" | "video";
type Destination = { type: DestinationType; url: string };
type Channel = {
  id: string;
  name: string;
  destinations: Destination[];
  enabled: boolean;
  selectedLocationIds: string[];
  driveFolderId: string;
};
type Data = {
  channels: Channel[];
  locations: Location[];
  requiresGoogleDriveAuthorization: boolean;
  googleDriveConnected: boolean;
};
type Draft = Omit<Channel, "id" | "driveFolderId">;

const emptyDraft: Draft = { name: "", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: [] };
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const destinationTypes: DestinationType[] = ["reader", "video"];
const destinationLabels: Record<DestinationType, string> = { reader: "Reader site / edition feed", video: "Video publishing" };

function toggleDestination(destinations: Destination[], type: DestinationType): Destination[] {
  const found = destinations.some((destination) => destination.type === type);
  if (found) return destinations.length > 1 ? destinations.filter((destination) => destination.type !== type) : destinations;
  return [...destinations, { type, url: "" }];
}

function setDestinationUrl(destinations: Destination[], type: DestinationType, url: string) {
  return destinations.map((destination) => destination.type === type ? { ...destination, url } : destination);
}

function LocationPicker({ locations, selected, onChange }: {
  locations: Location[]; selected: string[]; onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const selectedSet = new Set(selected);
  const matches = query.trim()
    ? locations.filter((location) => !selectedSet.has(location.id) && location.name.toLowerCase().includes(query.trim().toLowerCase()))
    : [];
  return <>
    <ul className="channel-location-pills" aria-label="Selected communities">
      {selected.map((id) => {
        const name = locations.find((location) => location.id === id)?.name ?? id;
        return <li className="channel-location-pill" key={id}>
          <span>{name}</span>
          <button type="button" aria-label={`Remove ${name}`} onClick={() => onChange(selected.filter((value) => value !== id))}>×</button>
        </li>;
      })}
      {selected.length === 0 && <li className="chart-caption">No communities selected.</li>}
    </ul>
    <label className="field">Find a community to add
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by location name" />
    </label>
    {query.trim() && <ul className="channel-location-results" aria-label="Matching communities">
      {matches.map((location) => <li key={location.id}>
        <button type="button" className="secondary" onClick={() => {
          onChange([...selected, location.id]);
          setQuery("");
        }}>Add {location.name}</button>
      </li>)}
      {matches.length === 0 && <li className="chart-caption">No matching communities.</li>}
    </ul>}
  </>;
}

export default function PublishingChannels({ focusLocationId, owner, email, channelId }: {
  focusLocationId?: string; owner: boolean; email: string; channelId?: string;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [editionRefreshKey, setEditionRefreshKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setData(await adminApi<Data>("output-channels"));
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!data || !focusLocationId) return;
    const channel = data.channels.find((item) => item.selectedLocationIds.includes(focusLocationId));
    if (channel) document.getElementById(`channel-${encodeURIComponent(channel.id)}`)?.scrollIntoView({ block: "start" });
  }, [data, focusLocationId]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create"); setError(""); setNotice("");
    try {
      await adminApi("output-channels", { method: "POST", body: JSON.stringify(draft) });
      setDraft(emptyDraft);
      setNotice("Publishing channel created.");
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally { setBusy(""); }
  }

  function connectGoogleDrive() {
    void signIn("google", { redirectTo: window.location.href }, {
      scope: "openid email profile https://www.googleapis.com/auth/drive",
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "select_account consent",
      login_hint: email,
    });
  }

  async function save(channel: Channel) {
    setBusy(channel.id); setError(""); setNotice("");
    try {
      await adminApi("output-channels", {
        method: "PATCH",
        body: JSON.stringify({
          id: channel.id,
          name: channel.name,
          destinations: channel.destinations,
          enabled: channel.enabled,
          selectedLocationIds: channel.selectedLocationIds,
        }),
      });
      setNotice(`${channel.name} saved.`);
      setEditionRefreshKey((key) => key + 1);
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally { setBusy(""); }
  }

  async function remove(channel: Channel) {
    if (!window.confirm(`Delete ${channel.name} and its generated channel files?`)) return;
    setBusy(channel.id); setError(""); setNotice("");
    try {
      await adminApi("output-channels", { method: "DELETE", body: JSON.stringify({ id: channel.id }) });
      setNotice(`${channel.name} deleted.`);
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally { setBusy(""); }
  }

  function updateChannel(id: string, update: Partial<Channel>) {
    setData((current) => current && ({ ...current, channels: current.channels.map((channel) => channel.id === id ? { ...channel, ...update } : channel) }));
  }

  function locationChoices(selected: string[], onChange: (ids: string[]) => void) {
    if (!data?.locations.length) return <p className="chart-caption">Add locations before choosing which communities this channel covers.</p>;
    return <fieldset className="channel-locations">
      <legend>Communities covered</legend>
      <p className="chart-caption">Associate locations with this channel. Video destinations expose video creation for selected locations.</p>
      <LocationPicker locations={data.locations} selected={selected} onChange={onChange} />
    </fieldset>;
  }

  function destinationChoices(destinations: Destination[], onChange: (destinations: Destination[]) => void) {
    return <>
      <fieldset className="channel-destinations">
        <legend>Publishing destinations</legend>
        {destinationTypes.map((type) => <label className="checkbox-label" key={type}>
          <input type="checkbox" checked={destinations.some((destination) => destination.type === type)}
            onChange={() => onChange(toggleDestination(destinations, type))} />
          <span>{destinationLabels[type]}</span>
        </label>)}
      </fieldset>
      {destinations.map((destination) => <label className="field" key={destination.type}>
        {destinationLabels[destination.type]} URL (optional)
        <input type="url" maxLength={2048} placeholder="https://example.org" value={destination.url}
          onChange={(event) => onChange(setDestinationUrl(destinations, destination.type, event.target.value))} />
      </label>)}
    </>;
  }

  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!data && !error && <p role="status">Loading publishing channels…</p>}
    {data && !channelId && <section className="panel">
      <h2>Create a publishing channel</h2>
      <p>Choose one or both publishing destinations and associate communities with this channel.</p>
      <form className="output-channel-form" onSubmit={(event) => void create(event)}>
        <div className="channel-fields">
          <label className="field">Channel name<input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          {destinationChoices(draft.destinations, (destinations) => setDraft({ ...draft, destinations }))}
        </div>
        {locationChoices(draft.selectedLocationIds, (ids) => setDraft({ ...draft, selectedLocationIds: ids }))}
        {data.requiresGoogleDriveAuthorization && <div className="drive-oauth-status">
          {data.googleDriveConnected
            ? <p role="status">Google Drive connected as {email}.</p>
            : <><p>Connect Google Drive with this account to create the channel folder in the pipeline Shared Drive.</p>
              <button type="button" className="secondary" onClick={connectGoogleDrive}>Connect Google Drive</button></>}
        </div>}
        <button disabled={busy !== "" || (data.requiresGoogleDriveAuthorization && !data.googleDriveConnected)}>{busy === "create" ? "Creating…" : "Create channel"}</button>
      </form>
    </section>}
    {data?.channels.length === 0 && <p>No publishing channels yet.</p>}
    {channelId && data && !data.channels.some((channel) => channel.id === channelId) && <p className="alert" role="alert">This channel no longer exists or is not available to your account.</p>}
    {data?.channels.filter((channel) => !channelId || channel.id === channelId).map((channel) => channelId
      ? <section className="panel output-channel" id={`channel-${encodeURIComponent(channel.id)}`} key={channel.id}>
      <p className="breadcrumbs"><a href="/publishing">Publishing channels</a> / {channel.name}</p>
      <div className="section-heading">
        <div><h2>{channel.name}</h2><p>{channel.destinations.map((destination) => destinationLabels[destination.type]).join(" + ")} · {channel.enabled ? "Enabled" : "Paused"} · {channel.selectedLocationIds.length} selected communities</p></div>
        <span className={`status-badge ${channel.enabled ? "tone-ok" : ""}`}>{channel.enabled ? "Enabled" : "Paused"}</span>
      </div>
      <div className="channel-fields">
        <label className="field">Channel name<input required maxLength={120} value={channel.name} onChange={(event) => updateChannel(channel.id, { name: event.target.value })} /></label>
        {destinationChoices(channel.destinations, (destinations) => updateChannel(channel.id, { destinations }))}
      </div>
      <label className="checkbox-label channel-enabled"><input type="checkbox" checked={channel.enabled} onChange={(event) => updateChannel(channel.id, { enabled: event.target.checked })} /><span>Publish to this channel</span></label>
      {locationChoices(channel.selectedLocationIds, (ids) => updateChannel(channel.id, { selectedLocationIds: ids }))}
      {channel.destinations.some(({ type }) => type === "reader") && <p className="chart-caption">Channel feed folder: <code>{channel.driveFolderId}</code></p>}
      {channel.destinations.some(({ type }) => type === "reader") && <p className="chart-caption">Newly selected communities with a published edition are copied into this channel when saved. New editions and corrections are sent automatically.</p>}
      <div className="card-actions">
        <button disabled={busy !== ""} onClick={() => void save(channel)}>{busy === channel.id ? "Saving…" : "Save channel"}</button>
        <button type="button" className="danger" disabled={busy !== ""} onClick={() => void remove(channel)}>Delete channel</button>
      </div>
      <ChannelEditionCreator key={`${channel.id}-${editionRefreshKey}`} channelId={channel.id} owner={owner} />
    </section>
      : <section className="panel output-channel-summary" id={`channel-${encodeURIComponent(channel.id)}`} key={channel.id}>
        <div className="section-heading">
          <div><h2>{channel.name}</h2><p>{channel.destinations.map((destination) => destinationLabels[destination.type]).join(" + ")} · {channel.selectedLocationIds.length} selected communities</p></div>
          <span className={`status-badge ${channel.enabled ? "tone-ok" : ""}`}>{channel.enabled ? "Enabled" : "Paused"}</span>
        </div>
        <Link className="button" href={`/publishing/${encodeURIComponent(channel.id)}`}>Open channel workspace</Link>
      </section>)}
  </>;
}
