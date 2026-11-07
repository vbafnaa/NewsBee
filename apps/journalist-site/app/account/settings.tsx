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
const optional = ["serpapiKey", "searchapiKey", "brightdataKey", "brightdataZone", "exaKey", "scrapingbeeKey", "typesafeKey", "openrouterKey", "attomKey", "jinaKey"] as const;
const integrationLabels: Record<string, string> = {
  tavilySearchApiKey: "Tavily API key",
  serpapiKey: "SerpApi API key",
  searchapiKey: "SearchApi API key",
  brightdataKey: "Bright Data API key",
  brightdataZone: "Bright Data zone",
  exaKey: "Exa API key",
  scrapingbeeKey: "ScrapingBee API key",
  typesafeKey: "TypeSafe API key",
  openrouterKey: "OpenRouter API key",
  attomKey: "ATTOM API key",
  jinaKey: "Jina API key",
};
export default function AccountSettings({ owner }: { owner: boolean }) {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
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
  function apply(value: Profile | null) {
    setProfile(value); setSource(value?.source ?? "personal"); setSecrets({});
    setProviders(value?.config?.modelProviders.map((p) => ({ ...p, apiKey: "" })) ?? []);
    setLightModel(value?.config?.lightModel ?? "gemini-flash-lite-latest"); setDaily(value?.config?.modelDailyCalls ?? 800);
    setTypesafeBase(value?.config?.integrations.typesafeBase ?? "https://api.typesafe.ai");
    setJevModel(value?.config?.integrations.jevModel ?? "jev-1.13"); setLoaded(true);
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/account/settings", { cache: "no-store", signal: controller.signal }).then(async (r) => {
      const data = await r.json(); if (!r.ok) throw new Error(data.detail);
      if (!controller.signal.aborted) { apply(data.profile); setOwnerConfigured(data.ownerConfigured); }
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
      apply(data.profile); setNotice(method === "DELETE" ? "Profile revoked. Unfinished runs using it cannot continue." : `Saved ${data.profile.source === "environment" ? "deployment defaults" : "personal profile"} (version ${data.profile.version}). Unfinished runs using the previous version must be explicitly reconnected.`);
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Settings could not be saved"); } finally { setBusy(false); }
  }
  const patchProvider = (index: number, patch: Partial<Provider>) => setProviders((rows) => rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  return <>
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <section className="panel"><h2>Your execution profile</h2>
      <p>{!loaded ? "Loading execution profile..." : !profile ? owner ? "No active profile. Choose deployment defaults or add personal keys." : "Add a model provider to run pipelines; deployment keys are owner-only." : profile.revoked ? `Revoked · version ${profile.version}` : `${profile.automatic ? "Automatic owner deployment defaults — no personal keys or profile save required" : profile.source === "environment" ? "Deployment defaults explicitly selected" : "Personal encrypted profile"} · version ${profile.version}`}</p>
      <p className="chart-caption">{loaded && profile && !profile.revoked && <>Model {profile.capabilities.model ? "configured" : "not configured"} · Paid search {profile.capabilities.paidSearch ? "configured" : "off"}. </>}Configuration checks only; no provider calls.</p>
      {profile?.configurationError && <p className="alert" role="alert">{profile.configurationError}</p>}
      {profile?.source === "environment" && !profile.revoked && !profile.capabilities.model && !profile.configurationError && <p className="alert">Deployment defaults have no model with both a model name and API key. Configure NEWSBEE_MODEL_PROVIDERS and the selected provider&apos;s model/API key on the server, or optionally save personal keys. No profile save is needed to use configured automatic defaults.</p>}
      {!owner && !ownerConfigured && <p className="alert">Workspace owner not configured. Ask your administrator to complete owner setup; your account remains an editor.</p>}
      <p>Keys are write-only. Blank fields preserve saved keys; “Remove saved key” explicitly removes one. Revoke disables the entire profile. Editors never inherit owner keys.</p>
      <form onSubmit={(event) => { event.preventDefault(); void save("PUT"); }}>
        {owner && <label className="field">Credential source<select disabled={!loaded || busy} value={source} onChange={(e) => { setSource(e.target.value as typeof source); setNotice(""); }}><option value="personal">My personal keys (optional owner override)</option><option value="environment">Deployment defaults (owner only)</option></select></label>}
        {source !== (profile?.source ?? "personal") && <p role="status">Unsaved credential source. Click {source === "environment" ? "Save deployment defaults" : "Save personal profile"} to persist this choice before leaving this page.</p>}
        {source === "environment" && <p>{profile?.automatic ? "Existing deployment credentials already apply automatically to your exact configured owner account. Saving is optional and creates an explicit versioned selection." : "Save to replace an existing personal or revoked profile with deployment defaults."} Editors never inherit them. Direct owner deployment-funded work may use test, training or final purpose; the separately approved editor Admin backup remains final-only.</p>}
        {source === "personal" && <>
          <h3>Model providers (ordered fallback)</h3>
          {providers.map((provider, i) => <fieldset key={i}><legend>Provider {i + 1}</legend>
            <label className="field">Name<input required value={provider.name} onChange={(e) => patchProvider(i, { name: e.target.value })} /></label>
            <label className="field">Kind<select value={provider.kind} onChange={(e) => patchProvider(i, { kind: e.target.value as Provider["kind"] })}><option>gemini</option><option>openai</option><option>ollama</option></select></label>
            <label className="field">Model<input required value={provider.model ?? ""} onChange={(e) => patchProvider(i, { model: e.target.value })} /></label>
            <label className="field">Base URL<input type="url" required value={provider.baseUrl ?? ""} onChange={(e) => patchProvider(i, { baseUrl: e.target.value })} /></label>
            <label className="field">API key {profile?.config?.modelProviders.find((p) => p.name === provider.name)?.apiKey ? "(saved)" : "(not saved)"}<input type="password" autoComplete="new-password" value={provider.apiKey ?? ""} onChange={(e) => patchProvider(i, { apiKey: e.target.value })} /></label>
            <button type="button" className="secondary" onClick={() => patchProvider(i, { apiKey: null })}>Remove saved key{provider.apiKey === null ? " (pending)" : ""}</button>
            <label className="field">Custom authentication header (optional)<input value={provider.authHeader ?? ""} onChange={(e) => patchProvider(i, { authHeader: e.target.value || null })} /></label>
            <button type="button" className="secondary" onClick={() => setProviders((rows) => rows.filter((_, n) => n !== i))}>Remove provider</button>
          </fieldset>)}
          <button type="button" className="secondary" onClick={() => setProviders((rows) => [...rows, { name: `provider${rows.length + 1}`, kind: "gemini", model: "", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "" }])}>Add provider</button>
          <label className="field">Light model<input value={lightModel} required onChange={(e) => setLightModel(e.target.value)} /></label>
          <label className="field">Model daily calls<input type="number" min={0} max={1000000} value={daily} onChange={(e) => setDaily(Number(e.target.value))} /></label>
          <details className="location-settings"><summary>Optional search &amp; integration keys</summary>
          {["tavilySearchApiKey", ...optional].map((key) => <div key={key}><label className="field">{integrationLabels[key]} {(key === "tavilySearchApiKey" ? profile?.config?.tavilySearchApiKey : profile?.config?.integrations[key]) ? "(saved)" : "(off)"}<input type="password" autoComplete="new-password" value={secrets[key] ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, [key]: e.target.value }))} /></label><button className="secondary" type="button" onClick={() => setSecrets((s) => ({ ...s, [key]: null }))}>Remove saved key{secrets[key] === null ? " (pending)" : ""}</button></div>)}
          <label className="field">TypeSafe base URL<input type="url" value={typesafeBase} onChange={(e) => setTypesafeBase(e.target.value)} /></label>
          <label className="field">Jev model<input value={jevModel} onChange={(e) => setJevModel(e.target.value)} /></label>
          </details>
        </>}
        <p>Replacing or revoking a profile invalidates its prior version for unfinished runs.</p>
        <button disabled={busy || !loaded} type="submit">{busy ? "Saving…" : source === "environment" ? profile?.automatic ? "Save explicit deployment selection (optional)" : "Save deployment defaults" : "Save personal profile"}</button>
      </form>
      <button className="secondary" disabled={busy || !loaded || !profile || profile.revoked} type="button" onClick={() => { if (window.confirm("Revoke this profile and stop unfinished runs from using it?")) void save("DELETE"); }}>Revoke entire profile</button>
    </section>
  </>;
}
