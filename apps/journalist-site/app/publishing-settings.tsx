"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

type ReaderChannel = {
  id: string;
  name: string;
  url: string;
  selectedLocationIds: string[];
  enabled: boolean;
};
type Location = { id: string; name: string };

async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
  return data;
}

export default function PublishingSettings({ locationsKey }: { locationsKey: string }) {
  const [expanded, setExpanded] = useState(false);
  const [channel, setChannel] = useState<ReaderChannel | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (window.location.hash === "#publishing-settings") setExpanded(true);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setChannel(null);
    setError("");
    setNotice("");
    void (async () => {
      try {
        const data = await readResponse<{ channel: ReaderChannel; locations: Location[] }>(await fetch("/api/output-channel", {
          cache: "no-store",
          signal: controller.signal,
        }));
        if (!controller.signal.aborted) {
          setChannel(data.channel);
          setLocations(data.locations);
        }
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => controller.abort();
  }, [expanded, locationsKey]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!channel) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await readResponse<{ channel: ReaderChannel }>(await fetch("/api/output-channel", {
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
      setNotice("Publishing settings saved. The reader's location directory was updated.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  function toggle(locationId: string, checked: boolean) {
    if (!channel) return;
    const selectedLocationIds = checked
      ? [...new Set([...channel.selectedLocationIds, locationId])]
      : channel.selectedLocationIds.filter((id) => id !== locationId);
    setChannel({ ...channel, selectedLocationIds });
  }

  return (
    <details className="panel publishing-settings" id="publishing-settings" open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>Publishing settings</summary>
      {expanded && <>
        <p>New locations are enabled for publishing automatically and appear after their first published edition. Uncheck a location to keep it off the reader site.</p>
        {error && <p className="alert" role="alert">{error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        {!channel && !error && <p role="status">Loading publishing settings...</p>}
        {!channel && error && <p>Close and reopen publishing settings to try again.</p>}
        {channel && <form className="publishing-form" onSubmit={(event) => void save(event)}>
          <fieldset disabled={saving} className="publishing-fields">
            <legend className="eyebrow">Reader site</legend>
            <label className="field">
              <span>Reader site URL</span>
              <input type="url" required maxLength={2048} value={channel.url}
                onChange={(event) => setChannel({ ...channel, url: event.target.value })} />
            </label>
            <label className="publishing-toggle">
              <input type="checkbox" checked={channel.enabled}
                onChange={(event) => setChannel({ ...channel, enabled: event.target.checked })} />
              <span>Publishing enabled (disabled sites receive no new editions)</span>
            </label>
            <fieldset>
              <legend>Locations enabled for publishing</legend>
              {!locations.length && <p>Add a location in Runs &amp; locations first.</p>}
              {locations.map((location) => (
                <label className="publishing-toggle" key={location.id}>
                  <input type="checkbox" checked={channel.selectedLocationIds.includes(location.id)}
                    onChange={(event) => toggle(location.id, event.target.checked)} />
                  <span>{location.name}</span>
                </label>
              ))}
            </fieldset>
            <div><button type="submit">{saving ? "Saving..." : "Save publishing settings"}</button></div>
          </fieldset>
        </form>}
      </>}
    </details>
  );
}
