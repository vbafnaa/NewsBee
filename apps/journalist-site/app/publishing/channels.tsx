"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { adminApi, ApiError } from "@/lib/admin-client";
import ChannelStories from "./channel-stories";

type Location = { id: string; name: string; ready: boolean; preparation_state?: string; missing_prerequisites?: string[]; remedy?: { href: string; label: string } };
type DestinationType = "reader" | "video";
type Destination = { type: DestinationType; url: string };
type Channel = {
  id: string;
  name: string;
  destinations: Destination[];
  enabled: boolean;
  selectedLocationIds: string[];
  allowedLocationIds: string[];
  lifecycleRevision: number;
  driveFolderId: string;
  canWrite?: boolean;
  supportExpiresAt?: number | null;
  accessMode?: "direct" | "inspection" | "support";
};
type DirectoryEntry = Pick<Channel, "id" | "name" | "enabled" | "selectedLocationIds"> & {
  destinations: { type: DestinationType }[]; accessMode: "direct" | "inspection";
};
type Data = {
  channels: Channel[];
  directory: DirectoryEntry[];
  locations: Location[];
  requiresGoogleDriveAuthorization: boolean;
  googleDriveConnected: boolean;
  canManageAllowedCommunities: boolean;
  canCreateNewsrooms?: boolean;
};
type Draft = Pick<Channel, "name" | "destinations" | "enabled" | "selectedLocationIds">;
type PendingCreation = { requestKey: string; draft: Draft };

const emptyDraft: Draft = { name: "", destinations: [{ type: "reader", url: "" }, { type: "video", url: "" }], enabled: true, selectedLocationIds: [] };
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const destinationLabels: Record<DestinationType, string> = { reader: "Reader site / edition feed", video: "Video publishing" };

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
        <button type="button" className="secondary" disabled={!location.ready} onClick={() => {
          onChange([...selected, location.id]);
          setQuery("");
        }}>{location.ready ? `Add ${location.name}` : `${location.name} · ${location.preparation_state ?? "Preparing"}`}</button>
        {!location.ready && <p className="chart-caption">{location.missing_prerequisites?.join(" ") || "This community is not Ready yet."} {location.remedy && <Link href={location.remedy.href}>{location.remedy.label}</Link>}</p>}
      </li>)}
      {matches.length === 0 && <li className="chart-caption">No matching communities.</li>}
    </ul>}
  </>;
}

export default function PublishingChannels({ focusLocationId, email, channelId, surface = "newsroom", creationOnly = false }: {
  focusLocationId?: string;
  email: string;
  channelId?: string;
  surface?: "newsroom" | "admin";
  canDelete?: boolean;
  creationOnly?: boolean;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [editionRefreshKey, setEditionRefreshKey] = useState(0);
  const [createdChannel, setCreatedChannel] = useState<Pick<Channel, "id" | "name"> | null>(null);
  const [pendingCreation, setPendingCreation] = useState<PendingCreation | null>(null);
  const [creationStorageError, setCreationStorageError] = useState("");
  const [now, setNow] = useState(Date.now);
  const router = useRouter();
  const storageKey = `newsbee:newsroom-creation:${email}`;

  useEffect(() => {
    if (channelId) return;
    try {
      const saved = window.sessionStorage.getItem(storageKey);
      if (saved) {
        const pending = JSON.parse(saved) as PendingCreation;
        if (!pending.requestKey || !pending.draft?.name || !Array.isArray(pending.draft.selectedLocationIds)) {
          throw new Error("The saved newsroom creation request is invalid.");
        }
        setPendingCreation(pending); setDraft(pending.draft);
      }
    } catch (cause) { setCreationStorageError(errorText(cause)); }
  }, [channelId, storageKey]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await adminApi<Data>(`output-channels${channelId ? `?channelId=${encodeURIComponent(channelId)}` : ""}`));
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [channelId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!data || !focusLocationId) return;
    const channel = data.channels.find((item) => item.selectedLocationIds.includes(focusLocationId));
    if (channel) document.getElementById(`channel-${encodeURIComponent(channel.id)}`)?.scrollIntoView({ block: "start" });
  }, [data, focusLocationId]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create"); setError(""); setNotice(""); setCreatedChannel(null);
    try {
      const pending = pendingCreation ?? { requestKey: crypto.randomUUID(), draft };
      window.sessionStorage.setItem(storageKey, JSON.stringify(pending));
      setPendingCreation(pending);
      const result = await adminApi<{ channel: Channel }>("output-channels", { method: "POST", body: JSON.stringify({ ...pending.draft, requestKey: pending.requestKey }) });
      window.sessionStorage.removeItem(storageKey);
      setPendingCreation(null);
      setDraft(emptyDraft);
      setCreatedChannel(result.channel);
      setNotice(result.channel.selectedLocationIds.length
        ? "Newsroom created. Open it to prepare an edition."
        : "Newsroom created. Coverage setup is still needed before starting an edition.");
      setData((current) => current && ({ ...current,
        directory: [...current.directory.filter((item) => item.id !== result.channel.id), { ...result.channel, accessMode: "direct" }],
      }));
      router.refresh();
    } catch (cause) {
      setError(errorText(cause));
      if (cause instanceof ApiError && cause.status === 422) {
        window.sessionStorage.removeItem(storageKey); setPendingCreation(null);
      }
    } finally { setBusy(""); }
  }

  async function save(channel: Channel) {
    setBusy(channel.id); setError(""); setNotice("");
    try {
      const result = await adminApi<{ channel: Channel }>("output-channels", {
        method: "PATCH",
        body: JSON.stringify({
          id: channel.id,
          name: channel.name,
          destinations: channel.destinations,
          enabled: channel.enabled,
          selectedLocationIds: channel.selectedLocationIds,
          lifecycleRevision: channel.lifecycleRevision,
          ...(surface === "admin" && data?.canManageAllowedCommunities ? { allowedLocationIds: channel.allowedLocationIds } : {}),
        }),
      });
      setNotice(surface === "admin"
        ? `${channel.name} newsroom settings saved. No edition was approved or published.`
        : "Newsroom coverage saved for future editions. Reload the newsroom before starting another edition to refresh its choices; save any unfinished work first. Existing drafts and published releases are unchanged. No edition was approved or published.");
      setEditionRefreshKey((key) => key + 1);
      setData((current) => current && ({ ...current,
        channels: current.channels.map((item) => item.id === channel.id ? { ...item, ...result.channel } : item),
      }));
      router.refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally { setBusy(""); }
  }

  function updateChannel(id: string, update: Partial<Channel>) {
    setData((current) => current && ({ ...current, channels: current.channels.map((channel) => channel.id === id ? { ...channel, ...update } : channel) }));
  }

  function locationChoices(selected: string[], onChange: (ids: string[]) => void, allowed?: string[]) {
    if (!data?.locations.length) return <p className="chart-caption">Add locations before choosing which communities this newsroom covers.</p>;
    return <fieldset className="channel-locations">
      <legend>Newsroom coverage for future editions</legend>
      <p className="chart-caption">Select Ready communities within this newsroom’s allowed boundary. New editions can choose a subset of this saved coverage; this does not change an existing draft or release.</p>
      <LocationPicker locations={data.locations.filter((location) =>
        !allowed || allowed.includes(location.id) || selected.includes(location.id))}
        selected={selected} onChange={onChange} />
    </fieldset>;
  }

  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {creationStorageError && <p className="alert" role="alert">Cannot safely restore the saved creation request: {creationStorageError} Reload this tab or ask an operator to check the newsroom list before starting another request.</p>}
    {error && !data && <button type="button" className="secondary" disabled={busy !== ""} onClick={() => void load()}>Retry loading newsrooms</button>}
    {error && data && channelId && <button type="button" className="secondary" disabled={busy !== ""} onClick={() => {
      if (window.confirm("Discard your unsaved newsroom settings and reload saved values?")) void load();
    }}>Reload saved settings (discard edits)</button>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {creationOnly && createdChannel && <p><Link className="button" href={`/newsroom/${encodeURIComponent(createdChannel.id)}`}>Open {createdChannel.name}</Link></p>}
    {!data && !error && <p role="status">Loading newsrooms…</p>}
    {data && !channelId && data.canCreateNewsrooms && <section className="panel">
      <h2>New newsroom</h2>
      <p>Choose initial Ready communities, or create a newsroom awaiting coverage setup. Creating a newsroom does not publish an edition.</p>
      <form className="output-channel-form" onSubmit={(event) => void create(event)}>
        <fieldset disabled={busy !== "" || Boolean(pendingCreation)}>
        <div className="channel-fields">
          <label className="field">Newsroom name<input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        </div>
        {locationChoices(draft.selectedLocationIds, (ids) => setDraft({ ...draft, selectedLocationIds: ids }))}
        {surface === "admin" && data.requiresGoogleDriveAuthorization && <div className="drive-oauth-status">
          {data.googleDriveConnected
            ? <p role="status">Google Drive connected as {email}.</p>
            : <p>Google Drive is the default when connected; otherwise the channel will use MongoDB.</p>}
          <button type="button" className="secondary" onClick={() => void signIn("google", { redirectTo: surface === "admin" ? "/admin/publications" : "/newsroom" }, {
            scope: "openid email profile https://www.googleapis.com/auth/drive",
            access_type: "offline",
            prompt: "consent",
            login_hint: email,
          })}>{data.googleDriveConnected ? "Reconnect Google Drive" : "Connect Google Drive"}</button>
        </div>}
        </fieldset>
        {pendingCreation && <p role="status">Creation has not been confirmed. Retry uses the same saved details and will not create another newsroom.</p>}
        <button disabled={busy !== "" || Boolean(creationStorageError)}>{busy === "create" ? "Creating…" : pendingCreation ? "Retry newsroom creation" : "Create newsroom"}</button>
      </form>
    </section>}
    {!creationOnly && !channelId && data?.directory.length === 0 && <p>No newsrooms yet.</p>}
    {channelId && data && !data.channels.some((channel) => channel.id === channelId) && <p className="alert" role="alert">This newsroom no longer exists or is not available to your account.</p>}
    {!creationOnly && channelId && data?.channels.map((channel) => <section className="panel output-channel" id={`channel-${encodeURIComponent(channel.id)}`} key={channel.id}>
      <p className="breadcrumbs"><a href={surface === "admin" ? "/admin/publications" : "/newsroom"}>Newsrooms</a> / {channel.name}</p>
      <div className="section-heading">
        <div><p className="eyebrow">{surface === "admin" ? "Publication support" : "Newsroom settings"}</p><h2>{surface === "admin" ? "Coverage and newsroom lifecycle" : "Available communities for future editions"}</h2><p>{surface === "admin" && `${channel.destinations.map((destination) => destinationLabels[destination.type]).join(" + ")} · `}{channel.selectedLocationIds.length} selected communities</p></div>
        <span className={`status-badge ${channel.enabled ? "tone-ok" : ""}`}>{channel.enabled ? "Enabled" : "Paused"}</span>
      </div>
      {channel.accessMode !== "direct" && <p role="status">{channel.canWrite && channel.supportExpiresAt && channel.supportExpiresAt > now
        ? `Audited support access expires ${new Date(channel.supportExpiresAt).toLocaleString()}.`
        : "Read-only inspection. Enter deliberate newsroom-bound support to make changes."}</p>}
      <fieldset disabled={busy !== "" || !channel.canWrite || Boolean(channel.supportExpiresAt && channel.supportExpiresAt <= now)}>
      {surface === "admin" && <>
      <div className="channel-fields">
        <label className="field">Newsroom name<input required maxLength={120} value={channel.name} onChange={(event) => updateChannel(channel.id, { name: event.target.value })} /></label>
      </div>
      <label className="checkbox-label channel-enabled"><input type="checkbox" checked={channel.enabled} onChange={(event) => updateChannel(channel.id, { enabled: event.target.checked })} /><span>Enable this newsroom for future publication</span></label>
      <p className="chart-caption">This is the newsroom lifecycle switch, not a destination selector. Disabling blocks future newsroom generation and publication.</p>
      {data.canManageAllowedCommunities && <fieldset className="channel-locations">
        <legend>Allowed communities · workspace administration</legend>
        <p className="chart-caption">This boundary limits edition coverage. Removing a community also removes it from the current selection.</p>
        <LocationPicker locations={data.locations}
          selected={channel.allowedLocationIds} onChange={(ids) => updateChannel(channel.id, {
            allowedLocationIds: ids, selectedLocationIds: channel.selectedLocationIds.filter((id) => ids.includes(id)),
          })} />
      </fieldset>}
      </>}
      {locationChoices(channel.selectedLocationIds, (ids) => updateChannel(channel.id, { selectedLocationIds: ids }), channel.allowedLocationIds)}
      {surface === "newsroom" && <p className="chart-caption">Workspace owners and administrators manage the allowed-community boundary, newsroom name and lifecycle.
        {data.canManageAllowedCommunities && <> <Link href={`/admin/publications/${encodeURIComponent(channel.id)}`}>Manage this newsroom</Link>.</>}
      </p>}
      {surface === "admin" && channel.destinations.some(({ type }) => type === "reader") && <p className="chart-caption">Channel feed {channel.driveFolderId.startsWith("mongo:") ? "storage (MongoDB)" : "folder (Google Drive)"}: <code>{channel.driveFolderId}</code></p>}
      <p className="chart-caption">Saving these settings does not approve or publish an edition. Publication requires an explicit action in Editions.</p>
      <div className="card-actions">
        <button disabled={busy !== ""} onClick={() => void save(channel)}>{busy === channel.id ? "Saving…" : surface === "admin" ? "Save newsroom settings" : "Save newsroom coverage"}</button>
      </div>
      </fieldset>
      {surface === "admin" && <p className="chart-caption"><Link href="/admin/publications">Manage newsroom archive and restore</Link>. Historical editions are retained.</p>}
      {surface === "admin" && <details><summary>Advanced legacy maintenance</summary><p>Historical per-story tools are not the normal edition publisher. <Link href={`/newsroom/${encodeURIComponent(channel.id)}`}>Open newsroom Editions</Link>.</p>
        {channel.canWrite && (!channel.supportExpiresAt || channel.supportExpiresAt > now)
          ? <ChannelStories key={`${channel.id}-${editionRefreshKey}`} channelId={channel.id} />
          : <p>Legacy mutation tools are unavailable during read-only inspection or expired support.</p>}
      </details>}
    </section>)}
    {!creationOnly && !channelId && data?.directory.map((channel) => <section className="panel output-channel-summary" id={`channel-${encodeURIComponent(channel.id)}`} key={channel.id}>
        <div className="section-heading">
          <div><h2>{channel.name}</h2><p>{channel.destinations.map((destination) => destinationLabels[destination.type]).join(" + ")} · {channel.selectedLocationIds.length} selected communities</p></div>
          <span className={`status-badge ${channel.enabled && channel.selectedLocationIds.length ? "tone-ok" : ""}`}>{!channel.selectedLocationIds.length ? "Coverage setup needed" : channel.enabled ? "Enabled" : "Paused"}</span>
        </div>
        <p>{channel.accessMode === "direct" ? "Direct newsroom access" : "Read-only inspection · no membership"}</p>
        <Link className="button" href={`/newsroom/${encodeURIComponent(channel.id)}`}>{channel.accessMode === "direct" ? "Open newsroom" : "Inspect newsroom"}</Link>
        {surface === "admin" && <div className="card-actions"><Link href={`/admin/access?publicationId=${encodeURIComponent(channel.id)}`}>Manage journalists</Link><Link href={`/admin/publication-governance?publicationId=${encodeURIComponent(channel.id)}`}>Governance</Link><details><summary>Advanced legacy maintenance</summary><Link href={`/admin/publications/${encodeURIComponent(channel.id)}`}>Coverage, destinations and historical tools</Link></details></div>}
      </section>)}
  </>;
}
