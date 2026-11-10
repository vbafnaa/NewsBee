"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProviderConfig } from "@/pipeline/core/config";

type Provider = Partial<ProviderConfig> & Pick<ProviderConfig, "name" | "kind">;
type Profile = {
  version: number; source: "personal" | "environment"; revoked: boolean; automatic: boolean;
  config: { modelProviders: Provider[]; lightModel: string; modelDailyCalls: number; integrations: Record<string, string | null>; tavilySearchApiKey: string | null } | null;
  capabilities: { model: boolean; paidSearch: boolean };
  configurationError: string | null;
};
type EnvironmentDefaults = NonNullable<Profile["config"]> & { configurationError?: string | null };
/** Every paid service a run can use, by what it does. Bright Data opens pages with the key and zones under Dorking. TypeSafe and OpenRouter are parked (Jev). */
const groups: Array<{ title: string; note?: string; keys: string[] }> = [
  { title: "Dorking (Google operator search)", keys: ["serpapiKey", "searchapiKey", "brightdataKey", "brightdataZone", "brightdataUnlockerZone"] },
  { title: "Search", keys: ["exaKey", "tavilySearchApiKey"] },
  { title: "Opening pages", note: "Bright Data opens pages with its API key and Web Unlocker zone above.", keys: ["scrapingbeeKey", "jinaKey"] },
  { title: "Home sales", keys: ["attomKey"] },
  { title: "Video production", keys: ["falKey"] },
  { title: "Parked: Jev classification", keys: ["typesafeKey", "openrouterKey"] },
];
const integrationLabels: Record<string, string> = {
  tavilySearchApiKey: "Tavily API key",
  serpapiKey: "SerpApi API key",
  searchapiKey: "SearchApi API key",
  brightdataKey: "Bright Data API key",
  brightdataZone: "Bright Data SERP zone (search)",
  brightdataUnlockerZone: "Bright Data Web Unlocker zone (opening pages)",
  exaKey: "Exa API key",
  scrapingbeeKey: "ScrapingBee API key",
  typesafeKey: "TypeSafe API key",
  openrouterKey: "OpenRouter API key",
  attomKey: "ATTOM API key",
  jinaKey: "Jina API key",
  falKey: "fal.ai API key",
};
export default function AccountSettings({ owner }: { owner: boolean }) {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [environmentDefaults, setEnvironmentDefaults] = useState<EnvironmentDefaults | null>(null);
  const [source, setSource] = useState<"personal" | "environment">(owner ? "environment" : "personal");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [lightModel, setLightModel] = useState("gemini-flash-lite-latest");
  const [daily, setDaily] = useState(800);
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const [typesafeBase, setTypesafeBase] = useState("https://api.typesafe.ai");
  const [jevModel, setJevModel] = useState("jev-1.13");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [ownerConfigured, setOwnerConfigured] = useState(true);
  function apply(value: Profile | null, defaults?: EnvironmentDefaults | null) {
    setEnvironmentDefaults(owner ? defaults ?? null : null);
    setSource(owner ? value?.source ?? "environment" : "personal");
    setProfile(value); setSecrets({});
    setProviders(value?.config?.modelProviders.map((p) => ({ ...p, apiKey: "" })) ?? []);
    setLightModel(value?.config?.lightModel ?? defaults?.lightModel ?? "gemini-flash-lite-latest");
    setDaily(value?.config?.modelDailyCalls ?? defaults?.modelDailyCalls ?? 800);
    setTypesafeBase(value?.config?.integrations.typesafeBase ?? defaults?.integrations.typesafeBase ?? "https://api.typesafe.ai");
    setJevModel(value?.config?.integrations.jevModel ?? defaults?.integrations.jevModel ?? "jev-1.13"); setLoaded(true);
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/account/settings", { cache: "no-store", signal: controller.signal }).then(async (r) => {
      const data = await r.json(); if (!r.ok) throw new Error(data.detail);
      if (!controller.signal.aborted) { apply(data.profile, data.environmentDefaults); setOwnerConfigured(data.ownerConfigured); }
    }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);
  async function save(method: "PUT" | "DELETE") {
    setBusy(true); setError(""); setNotice("");
    try {
      const { tavilySearchApiKey, ...integrations } = secrets;
      const response = await fetch("/api/account/settings", { method, headers: { "Content-Type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify({ source, config: source === "personal" ? {
          modelProviders: providers, lightModel, modelDailyCalls: daily, tavilySearchApiKey,
          integrations: { ...integrations, typesafeBase, jevModel },
        } : undefined }) } : {}) });
      const data = await response.json(); if (!response.ok) throw new Error(data.detail);
      apply(data.profile, data.environmentDefaults); setNotice(method === "DELETE" ? "Profile revoked. Unfinished runs using it cannot continue." : `Saved ${data.profile.source === "environment" ? "deployment defaults" : "personal profile"} (version ${data.profile.version}). Unfinished runs using the previous version must be explicitly reconnected.`);
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Settings could not be saved"); } finally { setBusy(false); }
  }
  const patchProvider = (index: number, patch: Partial<Provider>) => setProviders((rows) => rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  return <>
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <section className="panel"><h2>Your execution profile</h2>
      <p>{!loaded ? "Loading execution profile..." : !profile ? owner ? "No active profile. Choose deployment defaults or add personal keys." : "No personal profile. Add your own API keys to enable provider-backed actions." : profile.revoked ? `Revoked · version ${profile.version}` : profile.source === "environment" ? "Owner deployment defaults" : `Personal encrypted profile${owner ? " with owner deployment fallback" : ""} · version ${profile.version}`}</p>
      <p className="chart-caption">{loaded && profile && !profile.revoked && <>Model {profile.capabilities.model ? "configured" : "not configured"} · Paid search {profile.capabilities.paidSearch ? "configured" : "off"}. </>}Configuration checks only; no provider calls.</p>
      {profile?.configurationError && <p className="alert" role="alert">{profile.configurationError}</p>}
      {!owner && !ownerConfigured && <p className="alert">Workspace owner not configured. Ask your administrator to complete owner setup; your account remains an editor.</p>}
      <p>{owner ? "Only the configured owner may use deployment API credentials. Personal keys override matching deployment values; clearing an override returns to the deployment default." : "You must supply personal API keys for the services your actions use. Deployment API credentials are owner-only; clearing a key disables that service."} Keys are write-only: blank fields keep saved personal values. Revoke disables the entire profile.</p>
      <form onSubmit={(event) => { event.preventDefault(); void save("PUT"); }}>
        {owner && <label className="field">Credential source<select disabled={!loaded || busy} value={source} onChange={(e) => setSource(e.target.value as typeof source)}><option value="personal">My personal keys (owner overrides)</option><option value="environment">Deployment defaults (owner only)</option></select></label>}
        {owner && source !== profile?.source && <p role="status">Unsaved credential source. Save this choice before leaving this page.</p>}
        {source === "environment" && <p>The configured owner uses deployment defaults automatically without a saved profile. Save to explicitly select them after a personal or revoked profile.</p>}
        {owner && environmentDefaults?.configurationError && <p className="alert" role="alert">{environmentDefaults.configurationError}</p>}
        {source === "personal" && <>
          <h3>Model providers (ordered fallback)</h3>
          <p className="chart-caption">{owner ? "Your providers override matching deployment providers. Other deployment providers remain available afterward (owner only)." : "Add your own providers to run AI pipeline work. Only your configured personal providers are tried."}</p>
          {owner && environmentDefaults?.modelProviders.filter((provider) => !providers.some((saved) => saved.name === provider.name)).map((provider) =>
            <button key={provider.name} type="button" className="secondary" onClick={() => setProviders((rows) => [...rows, { ...provider, apiKey: "" }])}>Add personal override for {provider.name}</button>)}
          {providers.map((provider, i) => <fieldset key={i}><legend>Provider {i + 1}</legend>
            <label className="field">Name<input required value={provider.name} onChange={(e) => patchProvider(i, { name: e.target.value })} /></label>
            <label className="field">Kind<select value={provider.kind} onChange={(e) => patchProvider(i, { kind: e.target.value as Provider["kind"] })}><option>gemini</option><option>openai</option><option>ollama</option></select></label>
            <label className="field">Model<input required value={provider.model ?? ""} onChange={(e) => patchProvider(i, { model: e.target.value })} /></label>
            <label><input type="checkbox" checked={provider.vision ?? provider.kind === "gemini"} onChange={(e) => patchProvider(i, { vision: e.target.checked })} /> Supports image input (confirm with your provider)</label>
            <label className="field">Light model (optional, for extraction, discovery and the model check)<input value={provider.lightModel ?? ""} placeholder={provider.kind === "gemini" ? lightModel : "Uses the model above"} onChange={(e) => patchProvider(i, { lightModel: e.target.value || null })} /></label>
            <label className="field">Base URL<input type="url" required value={provider.baseUrl ?? ""} onChange={(e) => patchProvider(i, { baseUrl: e.target.value })} /></label>
            <label className="field">API key {profile?.config?.modelProviders.find((p) => p.name === provider.name)?.apiKey ? "(personal key saved)" : owner && environmentDefaults?.modelProviders.find((p) => p.name === provider.name)?.apiKey ? "(using owner deployment default)" : "(not configured)"}<input type="password" autoComplete="new-password" value={provider.apiKey ?? ""} onChange={(e) => patchProvider(i, { apiKey: e.target.value })} /></label>
            {profile?.config?.modelProviders.find((p) => p.name === provider.name)?.apiKey && <button type="button" className="secondary" onClick={() => patchProvider(i, { apiKey: null })}>Clear personal key{owner ? " and use deployment default" : ""}{provider.apiKey === null ? " (pending)" : ""}</button>}
            <label className="field">Custom authentication header (optional)<input value={provider.authHeader ?? ""} onChange={(e) => patchProvider(i, { authHeader: e.target.value || null })} /></label>
            <button type="button" className="secondary" onClick={() => setProviders((rows) => rows.filter((_, n) => n !== i))}>Remove provider</button>
          </fieldset>)}
          <button type="button" className="secondary" onClick={() => setProviders((rows) => [...rows, { name: `provider${rows.length + 1}`, kind: "gemini", model: "", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "" }])}>Add provider</button>
          <label className="field">Default light model for Gemini providers<input value={lightModel} required onChange={(e) => setLightModel(e.target.value)} /></label>
          <p className="chart-caption">Personal providers are tried in the order above. Each provider&rsquo;s light model, if set, runs before it for light work.</p>
          <label className="field">Model daily calls<input type="number" min={0} max={1000000} value={daily} onChange={(e) => setDaily(Number(e.target.value))} /></label>
          <details className="location-settings"><summary>Search, opening and data keys</summary>
          <p>Models are the providers above, in order; the model check and the agent use each one&rsquo;s light model. Add only the personal keys needed for the services you use.</p>
          {groups.map((group) => <fieldset key={group.title}><legend>{group.title}</legend>{group.note && <p className="chart-caption">{group.note}</p>}
            {group.keys.map((key) => {
              const personalKey = key === "tavilySearchApiKey" ? profile?.config?.tavilySearchApiKey : profile?.config?.integrations[key];
              const defaultKey = owner && (key === "tavilySearchApiKey" ? environmentDefaults?.tavilySearchApiKey : environmentDefaults?.integrations[key]);
              return <div key={key}><label className="field">{integrationLabels[key]} {personalKey ? "(personal key saved)" : defaultKey ? "(using owner deployment default)" : "(not configured)"}<input type="password" autoComplete="new-password" value={secrets[key] ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, [key]: e.target.value }))} /></label>{personalKey && <button className="secondary" type="button" onClick={() => setSecrets((s) => ({ ...s, [key]: null }))}>Clear personal key{owner ? " and use deployment default" : ""}{secrets[key] === null ? " (pending)" : ""}</button>}</div>;
            })}
            {group.keys.includes("typesafeKey") && <>
              <label className="field">TypeSafe base URL<input type="url" value={typesafeBase} onChange={(e) => setTypesafeBase(e.target.value)} /></label>
              <label className="field">Jev model<input value={jevModel} onChange={(e) => setJevModel(e.target.value)} /></label>
            </>}
          </fieldset>)}
          </details>
        </>}
        <p>Replacing or revoking a profile invalidates its prior version for unfinished runs.</p>
        <button disabled={busy || !loaded} type="submit">{busy ? "Saving…" : source === "environment" ? "Save deployment defaults" : "Save personal profile"}</button>
      </form>
      <button className="secondary" disabled={busy || !loaded || !profile || profile.revoked} type="button" onClick={() => { if (window.confirm("Revoke this profile and stop unfinished runs from using it?")) void save("DELETE"); }}>Revoke entire profile</button>
    </section>
  </>;
}
