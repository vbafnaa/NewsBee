"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";

type SourceKind = "library" | "government" | "state-newsroom";
type ConfiguredSource = {
  id: string;
  kind: SourceKind;
  category: string;
  name: string;
  location: string;
  region?: string;
  url?: string;
  platform?: string;
  tenant?: string;
};

const folders: { kind: SourceKind; title: string; description: string }[] = [
  { kind: "library", title: "Library websites", description: "Library source URLs" },
  { kind: "government", title: "Government platforms", description: "Legistar and CivicClerk sources" },
  { kind: "state-newsroom", title: "State newsroom feeds", description: "State agency RSS feeds" },
];

async function send(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
  return data;
}

export default function SourceManagement() {
  const [sources, setSources] = useState<ConfiguredSource[] | null>(null);
  const [kind, setKind] = useState<SourceKind>("library");
  const [selectedKind, setSelectedKind] = useState<SourceKind | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await send("/api/source-configs", { cache: "no-store" });
      setSources(data.sources as ConfiguredSource[]);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const location = String(values.get("location") ?? "").trim();
    const source = {
      kind,
      name: kind === "government" ? location : String(values.get("name") ?? "").trim(),
      location,
      region: String(values.get("region") ?? "").trim(),
      url: String(values.get("url") ?? "").trim(),
      platform: String(values.get("platform") ?? ""),
      tenant: String(values.get("tenant") ?? "").trim(),
    };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await send("/api/source-configs", { method: "POST", body: JSON.stringify(source) });
      setNotice("Source added.");
      setSelectedKind(kind);
      form.reset();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function updateSource(event: FormEvent<HTMLFormElement>, source: ConfiguredSource) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const payload = {
      id: source.id,
      kind: source.kind,
      name: String(values.get("name") ?? "").trim(),
      url: String(values.get("url") ?? "").trim(),
      platform: String(values.get("platform") ?? ""),
      tenant: String(values.get("tenant") ?? "").trim(),
    };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await send("/api/source-configs", { method: "PATCH", body: JSON.stringify(payload) });
      setNotice(`Updated ${source.name}.`);
      setEditing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function removeSource(source: ConfiguredSource) {
    if (!window.confirm(`Remove "${source.name}" from the source configuration?`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await send("/api/source-configs", {
        method: "DELETE",
        body: JSON.stringify({ id: source.id }),
      });
      setNotice(`Removed ${source.name}.`);
      if (editing === source.id) setEditing(null);
      await load();
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
            <h2>Add a source</h2>
            <p>Changes are saved to MongoDB; ingestion still reads the repository config files.</p>
          </div>
        </div>
        <form className="source-form" onSubmit={(event) => void createSource(event)}>
          <label className="field">
            <span>Source type</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as SourceKind)}>
              <option value="library">Library website</option>
              <option value="government">Government meeting platform</option>
              <option value="state-newsroom">State newsroom feed</option>
            </select>
          </label>
          {kind === "library" && (
            <label className="field">
              <span>Library identifier</span>
              <input name="location" required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                placeholder="WA0060" />
            </label>
          )}
          {kind === "government" && (
            <label className="field">
              <span>Location identifier</span>
              <input name="location" required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                placeholder="auburn-wa" />
            </label>
          )}
          {kind === "state-newsroom" && (
            <label className="field">
              <span>Existing state code</span>
              <input name="region" required maxLength={20} pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                placeholder="WA" />
            </label>
          )}
          {kind !== "government" && (
            <label className="field">
              <span>{kind === "library" ? "Library name" : "Newsroom name"}</span>
              <input name="name" required maxLength={120} />
            </label>
          )}
          {kind === "government" && (
            <>
              <label className="field">
                <span>Platform</span>
                <select name="platform" defaultValue="legistar">
                  <option value="legistar">Legistar</option>
                  <option value="civicclerk">CivicClerk</option>
                </select>
              </label>
              <label className="field">
                <span>Platform tenant</span>
                <input name="tenant" required maxLength={63} pattern="[a-z0-9][a-z0-9-]*"
                  placeholder="cityname" />
              </label>
            </>
          )}
          {kind !== "government" && (
            <label className="field source-url">
              <span>{kind === "library" ? "Website URL" : "RSS/feed URL"}</span>
              <input name="url" type="url" required pattern="https://.*" placeholder="https://example.org/" />
            </label>
          )}
          <button type="submit" disabled={busy}>Add source</button>
        </form>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">MongoDB · source_configs</p>
            <h2>{selectedKind ? folders.find((folder) => folder.kind === selectedKind)?.title : "Source folders"}</h2>
            <p>{selectedKind ? "Manage sources in this folder." : "Choose a folder to browse and manage its sources."}</p>
          </div>
          <div className="source-actions">
            {selectedKind && (
              <button className="secondary" type="button" onClick={() => setSelectedKind(null)}>
                All folders
              </button>
            )}
            <button className="secondary" type="button" onClick={() => void load()} disabled={busy}>Refresh</button>
          </div>
        </div>
        {sources === null ? <p>Loading source configurations...</p> :
          !selectedKind ? (
            <div className="folder-grid">
              {folders.map((folder) => {
                const count = sources.filter((source) => source.kind === folder.kind).length;
                return (
                  <button className="folder-card" type="button" key={folder.kind}
                    onClick={() => { setSelectedKind(folder.kind); setKind(folder.kind); }}>
                    <span className="folder-icon" aria-hidden="true">📁</span>
                    <span className="folder-copy">
                      <strong>{folder.title}</strong>
                      <small>{folder.description}</small>
                    </span>
                    <span className="folder-count">{count}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="source-list">
              {sources.filter((source) => source.kind === selectedKind).map((source) => (
                <article className="source-card" key={source.id}>
                  <div className="source-summary">
                    <div>
                      <span className="source-type">{source.category}</span>
                      <h3>{source.name}</h3>
                      <p>{source.location}</p>
                      {source.url && <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>}
                      {source.platform && <p>{source.platform} · tenant {source.tenant}</p>}
                    </div>
                    <div className="source-actions">
                      <button className="secondary" type="button" disabled={busy}
                        onClick={() => setEditing(editing === source.id ? null : source.id)}>
                        {editing === source.id ? "Cancel" : "Edit"}
                      </button>
                      <button className="danger" type="button" disabled={busy}
                        onClick={() => void removeSource(source)}>Remove</button>
                    </div>
                  </div>
                  {editing === source.id && (
                    <form className="source-edit-form" onSubmit={(event) => void updateSource(event, source)}>
                      {source.kind === "government" ? (
                        <>
                          <p>Location identifier: <strong>{source.location}</strong></p>
                          <input type="hidden" name="name" value={source.name} />
                        </>
                      ) : (
                        <label className="field">
                          <span>Name</span>
                          <input name="name" required maxLength={120} defaultValue={source.name} />
                        </label>
                      )}
                      {source.kind === "government" ? (
                        <>
                          <label className="field">
                            <span>Platform</span>
                            <select name="platform" defaultValue={source.platform}>
                              <option value="legistar">Legistar</option>
                              <option value="civicclerk">CivicClerk</option>
                            </select>
                          </label>
                          <label className="field">
                            <span>Platform tenant</span>
                            <input name="tenant" required maxLength={63}
                              pattern="[a-z0-9][a-z0-9-]*" defaultValue={source.tenant} />
                          </label>
                        </>
                      ) : (
                        <label className="field source-url">
                          <span>{source.kind === "library" ? "Website URL" : "RSS/feed URL"}</span>
                          <input name="url" type="url" required pattern="https://.*"
                            defaultValue={source.url} />
                        </label>
                      )}
                      <button type="submit" disabled={busy}>Save changes</button>
                    </form>
                  )}
                </article>
              ))}
              {sources.every((source) => source.kind !== selectedKind) && (
                <p>This folder is empty. Use “Add a source” above to add an entry.</p>
              )}
            </div>
          )}
      </section>
    </>
  );
}
