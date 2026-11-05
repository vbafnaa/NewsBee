"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

type Group = { id: string; name: string; url: string; createdAt: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export default function HomePage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [createdName, setCreatedName] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    fetch("/api/groups", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load groups. Please try again.");
        return (await response.json()) as { groups: Group[] };
      })
      .then(({ groups }) => setGroups(groups))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);

  async function addGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || loading) return;
    setSaving(true);
    setSaveError("");
    setCreatedName("");
    try {
      const response = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), url: url.trim() }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Could not add the group. Check the details and try again.");
      }
      const { group } = (await response.json()) as { group: Group };
      setGroups((previous) => [group, ...previous.filter((item) => item.id !== group.id)]);
      setName("");
      setUrl("");
      setCreatedName(group.name);
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <Link className="brand" href="/" aria-label="Muse Receiver home"><span className="brand-mark" aria-hidden="true">m</span><span>Muse <strong>Receiver</strong></span></Link>
        <span className="header-caption">GROUP OBSERVATION DESK <span className="header-dot" aria-hidden="true" /> LIVE WORKSPACE</span>
      </header>
      <main className="page-wrap">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-content">
            <span className="eyebrow"><span className="eyebrow-line" /> YOUR WORKSPACE</span>
            <h1 id="hero-title">A clearer view of <em>group activity.</em></h1>
            <p>Register a Facebook group, give Muse its reporting prompt, and review observations here. Hourly collection requires an external scheduler and an authorized HTTP-capable sender; the prompt alone cannot schedule or submit reports.</p>
          </div>
          <div className="hero-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-core">✳</div><span className="art-spark spark-one">✦</span><span className="art-spark spark-two">✦</span></div>
        </section>

        <aside className="notice" role="note" aria-label="Privacy and access warning">
          <span className="notice-icon" aria-hidden="true">!</span>
          <div><strong>Public endpoint · No authentication</strong><p>Anyone can list groups, read or export their posts, and submit reports. Do not deploy private-group content without access controls and the group’s approval. Only collect and review content you’re authorized to access.</p></div>
        </aside>

        <div className="home-grid">
          <section className="panel add-panel" aria-labelledby="add-title">
            <div className="panel-heading"><span className="section-index">01 / SETUP</span><h2 id="add-title">Add a group</h2><p>Start with the group you want Muse to observe.</p></div>
            <form onSubmit={addGroup} className="group-form">
              <label htmlFor="group-name">Group name <span aria-hidden="true">*</span></label>
              <input id="group-name" name="name" type="text" autoComplete="off" required maxLength={120} placeholder="e.g. Neighborhood Gardeners" value={name} onChange={(event) => setName(event.target.value)} disabled={saving} />
              <label htmlFor="group-url">Facebook group URL <span aria-hidden="true">*</span></label>
              <input id="group-url" name="url" type="url" inputMode="url" required placeholder="https://www.facebook.com/groups/…" value={url} onChange={(event) => setUrl(event.target.value)} disabled={saving} />
              <p className="field-hint">Use the full link to the Facebook group. Adding a group does not publish or fetch posts.</p>
              {saveError && <p className="form-message error-text" role="alert">{saveError}</p>}
              {createdName && <p className="form-message success-text" role="status">“{createdName}” added. Open it below to get the Muse prompt.</p>}
              <button className="button button-primary" type="submit" disabled={saving || loading}>{saving ? "Adding group…" : "Add group"}<span aria-hidden="true">↗</span></button>
            </form>
          </section>

          <section className="panel list-panel" aria-labelledby="groups-title">
            <div className="panel-heading list-heading"><div><span className="section-index">02 / COLLECTION</span><h2 id="groups-title">Your groups</h2><p>Open a group to see its prompt and reported posts.</p></div><span className="count-pill" aria-label={`${groups.length} groups`}>{loading ? "…" : groups.length.toString().padStart(2, "0")}</span></div>
            {loading ? <div className="state-block" role="status"><span className="spinner" aria-hidden="true" /> Loading groups…</div> : loadError ? <div className="state-block state-error" role="alert"><strong>Groups unavailable</strong><p>{loadError}</p><button className="text-button" type="button" onClick={() => setReload((value) => value + 1)}>Try again →</button></div> : groups.length === 0 ? <div className="state-block state-empty"><span className="empty-glyph" aria-hidden="true">✳</span><strong>No groups yet</strong><p>Add your first group to start a collection.</p></div> : <ul className="group-list">{groups.map((group) => <li key={group.id}><Link href={`/groups/${encodeURIComponent(group.id)}`} className="group-link"><span className="group-avatar" aria-hidden="true">{group.name.charAt(0).toUpperCase() || "G"}</span><span className="group-summary"><strong>{group.name}</strong><small>{group.url}</small></span><span className="group-arrow" aria-hidden="true">↗</span></Link></li>)}</ul>}
          </section>
        </div>
      </main>
      <footer className="site-footer"><span>MUSE RECEIVER</span><span>Observe responsibly. Share intentionally.</span></footer>
    </div>
  );
}
