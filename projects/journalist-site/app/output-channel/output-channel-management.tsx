"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

type OutputChannel = { id: string; name: string; url: string; driveFolderId: string; enabled: boolean };

async function readResponse(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
  return data;
}

export default function OutputChannelManagement() {
  const [channel, setChannel] = useState<OutputChannel | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/output-channel", { cache: "no-store" })
      .then(readResponse)
      .then((data) => setChannel(data.channel as OutputChannel))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!channel) return;
    const values = new FormData(event.currentTarget);
    setBusy(true);
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
          enabled: values.get("enabled") === "on",
        }),
      });
      const data = await readResponse(response);
      setChannel(data.channel as OutputChannel);
      setNotice("Output channel settings saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

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
              <small>The reader site loads its location index and edition JSON files from this folder.</small>
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
              <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save channel"}</button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
