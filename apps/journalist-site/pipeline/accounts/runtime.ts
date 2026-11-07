import { effectiveCredentialProfile } from "./credentials";
import { adminBackup, assertBindingCurrent, assertGlobalAdmission, capabilityReasons, credentialContext, personalSettings, userDefaultOptions } from "./execution";
import { lightSettings, rankingSettings, type Settings } from "../core/config";
import { ExecutionBlocked } from "../core/execution-errors";
import { fetchTransport, type HttpTransport } from "../core/http";
import { safeError } from "../core/redaction";
import { createRuntime, FallbackRuntime, retryAfterSeconds, type ModelRuntime, type StructuredOptions, type JsonSchema, type ModelCallSink } from "../model/runtime";
import { mongoUsageSink } from "../model/usage";
import type { OrchestratorDeps } from "../orchestration/orchestrator";
import { RunConflict, type PipelineRun } from "../orchestration/runs";
import type { Principal } from "./identity";

export const NO_MODEL: ModelRuntime = {
  provider: "unconfigured", model: null,
  health: async () => ({ status: "not_configured", detail: "Configure your own providers in My API settings. Shared newsroom reads do not call providers." }),
  generate: async () => { throw new ExecutionBlocked("No execution identity was resolved for this model call."); },
  generateStructured: async () => { throw new ExecutionBlocked("No execution identity was resolved for this model call."); },
};

function providerTransport(transport: HttpTransport, check: () => Promise<void>, settings: Settings): HttpTransport {
  const secrets = [
    ...settings.modelProviders.map((provider) => provider.apiKey),
    settings.tavilySearchApiKey, ...Object.entries(settings.integrations).filter(([name]) => /Key$/.test(name)).map(([, value]) => value),
  ].filter((value): value is string => Boolean(value));
  const scrub = (value: string) => secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), value);
  return async (request) => {
    await check();
    try {
      const response = await transport(request);
      const body = new TextDecoder().decode(response.body);
      if (response.status < 400) {
        const clean = scrub(body);
        return { ...response, url: scrub(response.url), headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, scrub(value)])), body: clean === body ? response.body : new TextEncoder().encode(clean) };
      }
      const hint = response.status === 400 && /max_completion_tokens/.test(body) ? "use max_completion_tokens"
        : response.status === 400 && /temperature/.test(body) && /unsupported/i.test(body) ? "temperature unsupported"
        : /content_policy_violation|provider_policy_refusal/.test(body) ? "provider_policy_refusal" : "";
      const retry = response.status === 429 ? retryAfterSeconds(response.headers, body) : 0;
      return { ...response, body: new TextEncoder().encode(`HTTP ${response.status}${hint ? `: ${hint}` : ""}${retry ? ` {"retryDelay":"${retry}s"}` : ""}`) };
    } catch (error) {
      if (error instanceof ExecutionBlocked) throw error;
      const message = safeError(scrub(error instanceof Error ? error.message : String(error)));
      if (error instanceof Error) { error.message = message; throw error; }
      throw new Error(message);
    }
  };
}

class CheckedModel implements ModelRuntime {
  constructor(private inner: ModelRuntime, private check: () => Promise<void>, private failed: (error: unknown) => void = () => undefined, private allowHealth = true) {}
  get provider() { return this.inner.provider; }
  get model() { return this.inner.model; }
  get servedModel() { return this.inner.servedModel ?? this.inner.model; }
  async health() {
    if (!this.allowHealth) return { status: "not_configured" as const, detail: "Admin backup is never used for provider checks; it is inference-only for this approved final run." };
    await this.check(); return this.inner.health();
  }
  async generate(prompt: string) {
    await this.check();
    try { return await this.inner.generate(prompt); } catch (error) { this.failed(error); throw error; }
  }
  async generateStructured(prompt: string, schema: JsonSchema, options?: StructuredOptions) {
    await this.check();
    try { return await this.inner.generateStructured(prompt, schema, options); } catch (error) { this.failed(error); throw error; }
  }
}

/** Called only after a job has been claimed. No user secret is kept in shared worker deps. */
export async function runtimesForRun(base: OrchestratorDeps, run: PipelineRun): Promise<OrchestratorDeps> {
  try { await assertGlobalAdmission(base.db, run._id); }
  catch (error) {
    if (error instanceof RunConflict) throw new ExecutionBlocked("Multiple unfinished historical runs hold the newsroom. The owner must resolve the conflict before execution.");
    throw error;
  }
  const { principal, profile } = await assertBindingCurrent(base.db, run);
  const binding = run.execution!;
  const settings = personalSettings(base.settings, principal, profile);
  const check = async () => { await assertBindingCurrent(base.db, run); };
  const transport = providerTransport(base.transport ?? fetchTransport, check, settings);
  const usage = mongoUsageSink(base.db);
  const noProviderEnv = { NODE_ENV: process.env.NODE_ENV };
  const make = (selected: Settings, role: string): ModelRuntime => {
    let fallbackReason = "Personal model credentials are missing.";
    const models = selected.modelProviders.filter((provider) => Boolean(provider.apiKey && provider.model)).map((provider) =>
      new CheckedModel(createRuntime({ ...selected, modelProviders: [provider] }, transport, undefined, { role, sink: record("personal") }), check, (error) => { fallbackReason = safeError(error); }));
    function record(funding: "personal" | "admin"): ModelCallSink {
      return async (call) => {
        await usage({ ...call, sponsor_id: binding.sponsorId, credential_version: binding.credentialVersion });
        await base.db.collection("journalist_funding_audit").insertOne({
          run_id: run._id, sponsor_id: binding.sponsorId, credential_version: binding.credentialVersion,
          approval_id: funding === "admin" ? binding.approvalId : null, funding, provider: call.provider,
          model: call.model, role, ok: call.ok, reason: funding === "admin" ? fallbackReason : null, at: Date.now() / 1000,
        });
      };
    }
    if (binding.approvalId && binding.purpose === "final") {
      const backup = adminBackup();
      const backupTransport = providerTransport(base.transport ?? fetchTransport, check, { ...selected, modelProviders: [backup] });
      models.push(new CheckedModel(createRuntime({ ...selected, modelProviders: [backup] }, backupTransport, undefined, { role, sink: record("admin") }), check, undefined, false));
    }
    if (!models.length) throw new ExecutionBlocked("No authorized model credentials remain. Reconnect your API settings.");
    return models.length === 1 ? models[0] : new FallbackRuntime(models);
  };
  return {
    ...base, principal, settings, transport, runtimeForRun: undefined,
    model: make(settings, "writing"), rankingModel: make(rankingSettings(settings), "ranking"),
    lightModel: make(lightSettings(settings, noProviderEnv), "extraction"), discoveryModel: make(lightSettings(settings, noProviderEnv), "discovery"),
    agentModel: make(settings, "agent"), agentLightModel: make(lightSettings(settings, noProviderEnv), "agent"),
  };
}

/** One-off paid discovery never accepts Admin backup and always uses the request principal. */
export async function personalRequestDeps(base: OrchestratorDeps, principal: Principal, options?: Parameters<typeof capabilityReasons>[1], searchNeeded = false, modelNeeded = true) {
  const profile = await effectiveCredentialProfile(base.db, principal);
  const settings = personalSettings(base.settings, principal, profile);
  const choices = options ?? userDefaultOptions(settings);
  const reasons = capabilityReasons(settings, choices, false, searchNeeded, { ...credentialContext(principal, profile), model: modelNeeded, agent: false });
  if (reasons.length) throw new ExecutionBlocked(reasons.join(" "));
  const check = async () => {
    const latest = await effectiveCredentialProfile(base.db, principal);
    if (latest?.revoked || (latest?.version ?? 0) !== (profile?.version ?? 0) || latest?.source !== profile?.source) throw new ExecutionBlocked("API settings changed. Retry with your current configuration.");
  };
  const transport = providerTransport(base.transport ?? fetchTransport, check, settings);
  const usage = mongoUsageSink(base.db);
  const sink: ModelCallSink = (call) => usage({ ...call, sponsor_id: principal.id, credential_version: profile?.version ?? 0 });
  return {
    ...base, principal, settings, transport, requestOptions: choices, credentialVersion: profile?.version ?? 0,
    discoveryModel: settings.modelProviders.some((provider) => provider.apiKey && provider.model)
      ? new CheckedModel(createRuntime(lightSettings(settings, { NODE_ENV: process.env.NODE_ENV }), transport, undefined, { role: "discovery", sink }), check)
      : NO_MODEL,
  };
}
