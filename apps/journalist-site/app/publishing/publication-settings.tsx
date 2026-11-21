"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import { usePublicationWriteAccess, type PublicationWriteAccess } from "@/lib/use-publication-write-access";
import {
  defaultPublicationSettings,
  type PublicationSettingsView,
  type SponsorPlacement,
  type SponsorSlot,
} from "../../../../shared/publication-settings";

type SettingsResponse = {
  publication: PublicationWriteAccess & { id: string; name: string; role: "owner" | "editor" | "privileged" };
  settings: PublicationSettingsView;
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const emptySponsor = (slot: SponsorSlot): SponsorPlacement => ({
  id: slot,
  slot,
  sponsor_name: "",
  headline: "",
  body: "",
  landing_url: "",
  image_url: null,
  enabled: false,
});

export default function PublicationSettingsPanel({ publicationId, publicationName }: { publicationId: string; publicationName: string }) {
  const [settings, setSettings] = useState<PublicationSettingsView>(() => defaultPublicationSettings(publicationName));
  const [savedSettings, setSavedSettings] = useState(settings);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [access, setAccess] = useState<PublicationWriteAccess | null>(null);
  const canWrite = usePublicationWriteAccess(access);
  const load = useCallback(async () => {
    setLoading(true);
    setNotice("");
    try {
      const result = await adminApi<SettingsResponse>(`output-channels/${encodeURIComponent(publicationId)}/settings`);
      setSettings(result.settings);
      setSavedSettings(result.settings);
      setAccess(result.publication);
      setLoaded(true);
      setError("");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, [publicationId]);
  useEffect(() => { setLoaded(false); void load(); }, [load]);

  async function save(block: "profile" | "generation_preferences" | "sponsor_placements") {
    if (!canWrite) { setError("Settings are read-only. Refresh access before saving; your edits have been kept."); return; }
    setBusy(block); setError(""); setNotice("");
    try {
      const result = await adminApi<{ settings: PublicationSettingsView }>(`output-channels/${encodeURIComponent(publicationId)}/settings`, {
        method: "PATCH",
        body: JSON.stringify({
          [block]: {
            expected_revision: settings[block].revision,
            values: settings[block].values,
          },
        }),
      });
      setSettings((current) => ({ ...current, [block]: result.settings[block] }));
      setSavedSettings((current) => ({ ...current, [block]: result.settings[block] }));
      setNotice(block === "generation_preferences"
        ? "Writing preferences saved for future generated stories. Existing drafts and manual reporting are unchanged."
        : `${block === "profile" ? "Profile" : "Sponsor placements"} saved. Private preview uses the saved values; the next explicit publication captures them. Past releases are unchanged.`);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy("");
    }
  }

  const sponsorAt = (slot: SponsorSlot) => settings.sponsor_placements.values.find((placement) => placement.slot === slot) ?? emptySponsor(slot);
  const dirty = (block: "profile" | "generation_preferences" | "sponsor_placements") =>
    JSON.stringify(settings[block].values) !== JSON.stringify(savedSettings[block].values);
  const updateSponsor = (slot: SponsorSlot, update: Partial<SponsorPlacement>) => {
    const current = sponsorAt(slot);
    const next = { ...current, ...update };
    const placements = settings.sponsor_placements.values.filter((placement) => placement.slot !== slot);
    const hasContent = Boolean(next.sponsor_name || next.headline || next.body || next.landing_url || next.image_url);
    setSettings({ ...settings, sponsor_placements: { ...settings.sponsor_placements, values: hasContent ? [...placements, next] : placements } });
  };

  if (!loaded) return <section className="panel publication-settings" aria-labelledby="publication-settings-title">
    <h2 id="publication-settings-title">Newsroom profile</h2>
    {error && <p className="alert" role="alert">{error}</p>}
    {loading ? <p role="status">Loading newsroom settings...</p>
      : <button type="button" onClick={() => void load()}>Retry</button>}
  </section>;

  return <section className="panel publication-settings" aria-labelledby="publication-settings-title">
    <div className="section-heading">
      <div>
        <h2 id="publication-settings-title">Newsroom profile</h2>
        <p>Reader branding: the display name, description, homepage link and logo are captured when you explicitly publish an edition. Private preview uses the current saved profile. Saving here does not publish or change past releases.</p>
      </div>
    </div>
    {error && <div role="alert">
      <p className="alert">{error}</p>
      <button type="button" className="secondary" disabled={busy !== "" || loading} onClick={() => {
        if (window.confirm("Reload saved settings and discard unsaved changes in this panel?")) void load();
      }}>Reload saved settings</button>
    </div>}
    {loading && <p role="status">Loading newsroom settings...</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!canWrite && <p className="notice" role="status">Read-only inspection or expired support. Unsaved changes are kept.</p>}

    <fieldset aria-labelledby="publication-settings-title" disabled={!canWrite || busy !== "" || loading}>
      <p className="chart-caption">The display name is public Reader branding; operators manage the internal newsroom name separately. The homepage link does not change the Reader address.</p>
      {dirty("profile") && <p className="chart-caption" role="status">Unsaved profile changes</p>}
      <div className="filters">
        <label className="field">Display name<input maxLength={120} value={settings.profile.values.display_name}
          onChange={(event) => setSettings({ ...settings, profile: { ...settings.profile, values: { ...settings.profile.values, display_name: event.target.value } } })} /></label>
        <label className="field">Homepage URL<input type="url" placeholder="https://example.org" value={settings.profile.values.homepage_url ?? ""}
          onChange={(event) => setSettings({ ...settings, profile: { ...settings.profile, values: { ...settings.profile.values, homepage_url: event.target.value || null } } })} /></label>
        <label className="field">Logo image URL<input type="url" placeholder="https://example.org/logo.png" value={settings.profile.values.logo_url ?? ""}
          onChange={(event) => setSettings({ ...settings, profile: { ...settings.profile, values: { ...settings.profile.values, logo_url: event.target.value || null } } })} /></label>
      </div>
      <label className="field">Description<textarea maxLength={500} value={settings.profile.values.description ?? ""}
        onChange={(event) => setSettings({ ...settings, profile: { ...settings.profile, values: { ...settings.profile.values, description: event.target.value || null } } })} /></label>
      <button disabled={busy !== ""} onClick={() => void save("profile")}>{busy === "profile" ? "Saving…" : "Save profile"}</button>
    </fieldset>

    <details className="publication-settings-disclosure">
      <summary>Writing preferences{dirty("generation_preferences") ? " - unsaved changes" : ""}</summary>
    <fieldset disabled={!canWrite || busy !== "" || loading}>
      <legend>Future generation preferences</legend>
      <p className="chart-caption">Applies to stories in future generation runs only, not existing drafts or manual reporting. Edit the combined edition's headline and intro in Editions. Reviews never retrain the model or silently change these preferences.</p>
      <div className="filters">
        <label className="field">Voice<select value={settings.generation_preferences.values.voice}
          onChange={(event) => setSettings({ ...settings, generation_preferences: { ...settings.generation_preferences, values: { ...settings.generation_preferences.values, voice: event.target.value as "neutral" | "warm" | "formal" } } })}>
          <option value="neutral">Neutral</option><option value="warm">Warm community news</option><option value="formal">Formal newspaper</option>
        </select></label>
        <label className="field">Story length<select value={settings.generation_preferences.values.story_length}
          onChange={(event) => setSettings({ ...settings, generation_preferences: { ...settings.generation_preferences, values: { ...settings.generation_preferences.values, story_length: event.target.value as "brief" | "standard" | "detailed" } } })}>
          <option value="brief">Brief</option><option value="standard">Standard</option><option value="detailed">Detailed when supported</option>
        </select></label>
      </div>
      <p className="chart-caption">Revision {settings.generation_preferences.revision}. Ranking, sources, evidence and citations are unchanged by these preferences.</p>
      <button disabled={busy !== ""} onClick={() => void save("generation_preferences")}>{busy === "generation_preferences" ? "Saving…" : "Save generation preferences"}</button>
    </fieldset>
    </details>

    <details className="publication-settings-disclosure" id="sponsor-placements">
      <summary>Sponsor placements{dirty("sponsor_placements") ? " - unsaved changes" : ""}</summary>
    <fieldset disabled={!canWrite || busy !== "" || loading}>
      <legend>Fixed sponsor placements</legend>
      <p className="chart-caption">Saved enabled placements appear in private preview and are captured by the next explicit publication; past releases do not change. Sponsor blocks are always labeled Sponsored, never enter editorial ranking or model input, and can appear only in these two fixed home-page slots.</p>
      {(["home_after_top_news", "home_before_newsroom"] as const).map((slot) => {
        const placement = sponsorAt(slot);
        return <div className="panel" key={slot}>
          <p><strong>Sponsored</strong> · {slot === "home_after_top_news" ? "After Top News" : "Before Newsroom"}</p>
          <div className="filters">
            <label className="field">Sponsor name<input maxLength={120} value={placement.sponsor_name} onChange={(event) => updateSponsor(slot, { sponsor_name: event.target.value })} /></label>
            <label className="field">Headline<input maxLength={160} value={placement.headline} onChange={(event) => updateSponsor(slot, { headline: event.target.value })} /></label>
            <label className="field">Landing URL<input type="url" value={placement.landing_url} onChange={(event) => updateSponsor(slot, { landing_url: event.target.value })} /></label>
            <label className="field">Image URL (optional)<input type="url" value={placement.image_url ?? ""} onChange={(event) => updateSponsor(slot, { image_url: event.target.value || null })} /></label>
          </div>
          <label className="field">Sponsor copy<textarea maxLength={500} value={placement.body} onChange={(event) => updateSponsor(slot, { body: event.target.value })} /></label>
          <label className="checkbox-label"><input type="checkbox" checked={placement.enabled} onChange={(event) => updateSponsor(slot, { enabled: event.target.checked })} /><span>Enable this labeled slot for future publications</span></label>
        </div>;
      })}
      <button disabled={busy !== ""} onClick={() => void save("sponsor_placements")}>{busy === "sponsor_placements" ? "Saving…" : "Save sponsor placements"}</button>
    </fieldset>
    </details>
  </section>;
}
