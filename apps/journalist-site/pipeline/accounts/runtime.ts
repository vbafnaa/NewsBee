import { effectiveCredentialProfile } from "./credentials";
import { assertBindingCurrent, assertGlobalAdmission, capabilityReasons, credentialContext, executionModels, personalSettings, userDefaultOptions } from "./execution";
import { lightSettings, rankingSettings, type Settings } from "../core/config";
import { ExecutionBlocked } from "../core/execution-errors";
import { fetchTransport, type HttpTransport } from "../core/http";
import { safeError } from "../core/redaction";
import { createRuntime, FallbackRuntime, ModelUnavailableError, retryAfterSeconds, type ModelRuntime, type StructuredOptions, type JsonSchema, type ModelCallSink, type VisionInput } from "../model/runtime";
import { mongoUsageSink } from "../model/usage";
import type { OrchestratorDeps } from "../orchestration/orchestrator";
import { RunConflict, type PipelineRun } from "../orchestration/runs";
import { isConfiguredOwner, type Principal } from "./identity";

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
      if (error instanceof Error) {
        // Some errors, such as a timeout's DOMException, can't take a new message.
        try { error.message = message; } catch { throw Object.assign(new Error(message), { name: error.name, cause: error }); }
        throw error;
      }
      throw new Error(message);
    }
  };
}

class CheckedModel implements ModelRuntime {
  constructor(private inner: ModelRuntime, private check: () => Promise<void>, private failed: (error: unknown) => void = () => undefined, private allowHealth = true) {}
  get provider() { return this.inner.provider; }
  get model() { return this.inner.model; }
  get servedModel() { return this.inner.servedModel ?? this.inner.model; }
  get supportsVision() { return this.inner.supportsVision === true; }
  async health() {
    if (!this.allowHealth) return { status: "not_configured" as const, detail: "This provider is not checked." };
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
  async generateVisionStructured(prompt: string, images: readonly VisionInput[], schema: JsonSchema, options?: StructuredOptions) {
    await this.check();
    if (!this.supportsVision || !this.inner.generateVisionStructured) throw new ModelUnavailableError("The configured model does not support image input.");
    try { return await this.inner.generateVisionStructured(prompt, images, schema, options); } catch (error) { this.failed(error); throw error; }
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
  const ownerDefaults = isConfiguredOwner(principal);
  const check = async () => {
    if (ownerDefaults && !isConfiguredOwner(principal)) throw new ExecutionBlocked("Owner designation changed. Reconnect this run with your personal API keys.");
    const current = await assertBindingCurrent(base.db, run);
    if (ownerDefaults && !isConfiguredOwner(current.principal)) throw new ExecutionBlocked("Owner designation changed. Reconnect this run with your personal API keys.");
  };
  const transport = providerTransport(base.transport ?? fetchTransport, check, settings);
  const usage = mongoUsageSink(base.db);
  const noProviderEnv = { NODE_ENV: process.env.NODE_ENV };
  const make = (selected: Settings, role: string): ModelRuntime => {
    let fallbackReason = "Personal model credentials are missing.";
    const models = executionModels(selected).map((provider) => {
      const personalKey = profile?.source === "personal" && profile.config?.modelProviders.some((saved) => saved.apiKey && saved.apiKey === provider.apiKey);
      return new CheckedModel(createRuntime({ ...selected, modelProviders: [provider] }, transport, undefined, { role, sink: record(personalKey ? "personal" : "environment") }), check, (error) => { fallbackReason = safeError(error); });
    });
    function record(funding: "personal" | "environment"): ModelCallSink {
      return async (call) => {
        await usage({ ...call, sponsor_id: binding.sponsorId, credential_version: binding.credentialVersion });
        await base.db.collection("journalist_funding_audit").insertOne({
          run_id: run._id, sponsor_id: binding.sponsorId, credential_version: binding.credentialVersion,
          funding, provider: call.provider, model: call.model, role, ok: call.ok, reason: null, at: Date.now() / 1000,
        });
      };
    }
    if (!models.length) throw new ExecutionBlocked(`No model credentials remain: ${fallbackReason} Configure your API keys in Environment & API settings, then reconnect the run.`);
    return models.length === 1 ? models[0] : new FallbackRuntime(models);
  };
  return {
    ...base, principal, settings, transport, runtimeForRun: undefined,
    model: make(settings, "writing"), rankingModel: make(rankingSettings(settings), "ranking"),
    lightModel: make(lightSettings(settings, noProviderEnv), "extraction"), discoveryModel: make(lightSettings(settings, noProviderEnv), "discovery"),
    agentModel: make(settings, "agent"), agentLightModel: make(lightSettings(settings, noProviderEnv), "agent"),
  };
}

/** One-off paid discovery always uses the keys of the person asking. */
export async function personalRequestDeps(base: OrchestratorDeps, principal: Principal, options?: Parameters<typeof capabilityReasons>[1], searchNeeded = false, modelNeeded = true) {
  const profile = await effectiveCredentialProfile(base.db, principal);
  const settings = personalSettings(base.settings, principal, profile);
  const choices = options ?? userDefaultOptions(settings);
  const reasons = capabilityReasons(settings, choices, searchNeeded, { ...credentialContext(principal, profile), model: modelNeeded, agent: false });
  if (reasons.length) throw new ExecutionBlocked(reasons.join(" "));
  const ownerDefaults = isConfiguredOwner(principal);
  const check = async () => {
    const latest = await effectiveCredentialProfile(base.db, principal);
    if (ownerDefaults && !isConfiguredOwner(principal)) throw new ExecutionBlocked("Owner designation changed. Retry with your personal API keys.");
    if (latest?.revoked || (latest?.version ?? 0) !== (profile?.version ?? 0) || latest?.source !== profile?.source) throw new ExecutionBlocked("API settings changed. Retry with your current configuration.");
  };
  const transport = providerTransport(base.transport ?? fetchTransport, check, settings);
  const usage = mongoUsageSink(base.db);
  const sink: ModelCallSink = (call) => usage({ ...call, sponsor_id: principal.id, credential_version: profile?.version ?? 0 });
  return {
    ...base, principal, settings, transport, requestOptions: choices, credentialVersion: profile?.version ?? 0,
    discoveryModel: executionModels(settings).length
      ? new CheckedModel(createRuntime(lightSettings(settings, { NODE_ENV: process.env.NODE_ENV }), transport, undefined, { role: "discovery", sink }), check)
      : NO_MODEL,
  };
}
