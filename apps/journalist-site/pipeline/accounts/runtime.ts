import { credentialProfile, effectiveCredentialProfile } from "./credentials";
import { assertBindingCurrent, assertGlobalAdmission, assertManagedNewsroomAssignment, capabilityReasons, credentialContext, executionModels, personalSettings, platformSettings, resolveExecutionProviderPolicy, userDefaultOptions } from "./execution";
import { lightSettings, rankingSettings, type Settings } from "../core/config";
import { ExecutionBlocked } from "../core/execution-errors";
import { executionTimeout } from "../core/execution-deadline";
import { assertJobExecutionCurrent, LostLeaseError } from "../orchestration/jobs";
import { fetchTransport, type HttpTransport } from "../core/http";
import { safeError } from "../core/redaction";
import { createRuntime, FallbackRuntime, ModelOutcomeUncertain, ModelUnavailableError, retryAfterSeconds, type ModelRuntime, type StructuredOptions, type JsonSchema, type ModelCallSink, type VisionInput } from "../model/runtime";
import { mongoUsageSink } from "../model/usage";
import { modelFunding, reserveModelAttempt } from "../model/budget";
import type { OrchestratorDeps } from "../orchestration/orchestrator";
import { RunConflict, type PipelineRun } from "../orchestration/runs";
import { isConfiguredOwner, principalById, type Principal } from "./identity";
import { COLLECTIONS } from "../storage/mongo";
import { EXECUTABLE_PUBLICATION_GENERATION_STATUSES } from "../publications/generation-status";

export const NO_MODEL: ModelRuntime = {
  provider: "unconfigured", model: null,
  health: async () => ({ status: "not_configured", detail: "No execution model is attached to shared reads. Managed configuration and recorded evidence are reported separately; reads never probe providers." }),
  generate: async () => { throw new ExecutionBlocked("No execution identity was resolved for this model call."); },
  generateStructured: async () => { throw new ExecutionBlocked("No execution identity was resolved for this model call."); },
};

function fundedSettings(settings: Settings, source: "platform" | "personal" | "environment", initiatorId: string, credentialVersion: number, personalKeys: string[] = []): Settings {
  return { ...settings, modelFunding: {
    source, initiatorId, credentialVersion,
    providers: Object.fromEntries(settings.modelProviders.map((provider) => [
      provider.name, source === "platform" ? "platform" : personalKeys.includes(provider.apiKey ?? "") ? "personal" : "environment",
    ])),
  } };
}

function providerTransport(transport: HttpTransport, check: () => Promise<void>, settings: Settings): HttpTransport {
  const secrets = [
    ...settings.modelProviders.map((provider) => provider.apiKey),
    settings.tavilySearchApiKey, ...Object.entries(settings.integrations).filter(([name]) => /Key$/.test(name)).map(([, value]) => value),
  ].filter((value): value is string => Boolean(value));
  const scrub = (value: string) => secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), value);
  return async (request) => {
    await check();
    try {
      const response = await transport({ ...request, timeoutMs: executionTimeout(request.timeoutMs) });
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
  constructor(private inner: ModelRuntime, private check: () => Promise<void>, private failed: (error: unknown) => void = () => undefined, private allowHealth = true, private completionFence?: () => Promise<void>) {}
  get provider() { return this.inner.provider; }
  get model() { return this.inner.model; }
  get servedModel() { return this.inner.servedModel ?? this.inner.model; }
  get supportsVision() { return this.inner.supportsVision === true; }
  private async settle() {
    if (!this.completionFence) return;
    try { await this.completionFence(); }
    catch (error) {
      if (error instanceof LostLeaseError) throw error;
      throw new ModelOutcomeUncertain(`Provider completed but the run completion fence rejected its result (${safeError(error)}); reconcile the recorded attempt before retrying.`);
    }
  }
  async health() {
    if (!this.allowHealth) return { status: "not_configured" as const, detail: "This provider is not checked." };
    await this.check(); return this.inner.health();
  }
  async generate(prompt: string) {
    await this.check();
    try { const result = await this.inner.generate(prompt); await this.settle(); return result; } catch (error) { this.failed(error); throw error; }
  }
  async generateStructured(prompt: string, schema: JsonSchema, options?: StructuredOptions) {
    await this.check();
    try { const result = await this.inner.generateStructured(prompt, schema, options); await this.settle(); return result; } catch (error) { this.failed(error); throw error; }
  }
  async generateVisionStructured(prompt: string, images: readonly VisionInput[], schema: JsonSchema, options?: StructuredOptions) {
    await this.check();
    if (!this.supportsVision || !this.inner.generateVisionStructured) throw new ModelUnavailableError("The configured model does not support image input.");
    try { const result = await this.inner.generateVisionStructured(prompt, images, schema, options); await this.settle(); return result; } catch (error) { this.failed(error); throw error; }
  }
}

/** Called only after a job has been claimed. No user secret is kept in shared worker deps. */
export async function runtimesForRun(base: OrchestratorDeps, run: PipelineRun): Promise<OrchestratorDeps> {
  try { await assertGlobalAdmission(base.db, run._id, run.publication_generation_id); }
  catch (error) {
    if (error instanceof RunConflict) throw new ExecutionBlocked(run.publication_generation_id
      ? error.message : "Multiple unfinished historical runs hold the newsroom. The owner must resolve the conflict before execution.");
    throw error;
  }
  const resolved = await assertBindingCurrent(base.db, run, false, undefined, base.settings);
  const { principal, profile } = resolved;
  const binding = run.execution!;
  const settings = fundedSettings(resolved.settings, binding.source, binding.sponsorId, binding.credentialVersion,
    profile?.source === "personal" ? profile.config?.modelProviders.flatMap((provider) => provider.apiKey ? [provider.apiKey] : []) : []);
  const ownerDefaults = binding.source !== "platform" && isConfiguredOwner(principal);
  const check = async () => {
    await assertJobExecutionCurrent();
    if (ownerDefaults && !isConfiguredOwner(principal)) throw new ExecutionBlocked("Owner designation changed. Reconnect this run with your personal API keys.");
    const current = await assertBindingCurrent(base.db, run, false, undefined, base.settings);
    if (ownerDefaults && !isConfiguredOwner(current.principal)) throw new ExecutionBlocked("Owner designation changed. Reconnect this run with your personal API keys.");
  };
  const transport = providerTransport(base.transport ?? fetchTransport, check, settings);
  const usage = mongoUsageSink(base.db);
  const completionFence = run.publication_generation_id ? async () => {
    await assertJobExecutionCurrent();
    const parent = await base.db.collection<{ _id: string; status: string }>(COLLECTIONS.publicationGenerations)
      .findOne({ _id: run.publication_generation_id! });
    if (!parent || !EXECUTABLE_PUBLICATION_GENERATION_STATUSES.includes(parent.status as never)) {
      throw new ExecutionBlocked("The combined publication generation is blocked, cancelling or finished.");
    }
  } : undefined;
  const noProviderEnv = { NODE_ENV: process.env.NODE_ENV };
  const make = (selected: Settings, role: string): ModelRuntime => {
    let fallbackReason = binding.source === "platform" ? "Deployment model configuration is missing." : "Personal model credentials are missing.";
    const models = executionModels(selected).map((provider) => {
      const funding = modelFunding(settings, provider.name);
      return new CheckedModel(createRuntime({ ...selected, modelProviders: [provider] }, transport, undefined, {
        role, sink: record(funding),
        beforeDispatch: async () => {
          await check();
          if (provider.kind !== "ollama") await reserveModelAttempt(base.db, settings, { funding, initiatorId: binding.sponsorId });
        },
      }), check, (error) => { fallbackReason = safeError(error); }, true, completionFence);
    });
    function record(funding: ReturnType<typeof modelFunding>): ModelCallSink {
      return async (call) => {
        await usage({ ...call, run_id: call.run_id ?? run._id, sponsor_id: binding.sponsorId, initiator_id: binding.initiatedBy ?? binding.sponsorId,
          funding, funding_identity: funding === "platform" ? "managed" : funding, credential_version: binding.credentialVersion });
        await base.db.collection("journalist_funding_audit").insertOne({
          run_id: run._id, sponsor_id: binding.sponsorId, credential_version: binding.credentialVersion,
          funding, funding_identity: funding === "platform" ? "managed" : funding, initiator_id: binding.initiatedBy ?? binding.sponsorId,
          provider: call.provider, model: call.model, role, ok: call.ok, reason: null, at: Date.now() / 1000,
        });
      };
    }
    if (!models.length) throw new ExecutionBlocked(binding.source === "platform"
      ? `No deployment model is available: ${fallbackReason} Configure the managed provider on the server.`
      : `No model credentials remain: ${fallbackReason} Configure your API keys in Environment & API settings, then reconnect the run.`);
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
export async function personalRequestDeps(base: OrchestratorDeps, principal: Principal, options?: Parameters<typeof capabilityReasons>[1], searchNeeded = false, modelNeeded = true, context?: { runId: string; role: string }) {
  const profile = await effectiveCredentialProfile(base.db, principal);
  const settings = fundedSettings(personalSettings(base.settings, principal, profile), profile?.source ?? "personal", principal.id, profile?.version ?? 0,
    profile?.source === "personal" ? profile.config?.modelProviders.flatMap((provider) => provider.apiKey ? [provider.apiKey] : []) : []);
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
  const sink = (funding: ReturnType<typeof modelFunding>): ModelCallSink => (call) => {
    return usage({ ...call, run_id: call.run_id ?? context?.runId, sponsor_id: principal.id, initiator_id: principal.id, funding,
      funding_identity: funding === "platform" ? "managed" : funding, credential_version: profile?.version ?? 0 });
  };
  const models = executionModels(lightSettings(settings, { NODE_ENV: process.env.NODE_ENV })).map((provider) => new CheckedModel(
    createRuntime({ ...settings, modelProviders: [provider] }, transport, undefined, { role: context?.role ?? "discovery", sink: sink(modelFunding(settings, provider.name)),
      beforeDispatch: async () => {
        await check();
        if (provider.kind !== "ollama") await reserveModelAttempt(base.db, settings, { funding: modelFunding(settings, provider.name), initiatorId: principal.id });
      },
    }), check));
  return {
    ...base, principal, settings, transport, requestOptions: choices, credentialVersion: profile?.version ?? 0,
    discoveryModel: models.length > 1 ? new FallbackRuntime(models) : models[0] ?? NO_MODEL,
  };
}

export async function managedRequestDeps(
  base: OrchestratorDeps,
  principal: Principal,
  context: { runId: string; role: string; publicationId?: string },
) {
  const current = await principalById(base.db, principal.id);
  if (!current) throw new ExecutionBlocked("The requesting account is disabled. Managed work is blocked.");
  if (current.role !== "editor") return personalRequestDeps(base, current, undefined, false, true, context);
  const policy = await resolveExecutionProviderPolicy(base.db, base.settings, current, { kind: "platform", publicationId: context.publicationId });
  const settings = lightSettings(fundedSettings(policy.settings, "platform", current.id, 0), { NODE_ENV: process.env.NODE_ENV });
  const check = async () => {
    const latest = await principalById(base.db, current.id);
    if (!latest) {
      throw new ExecutionBlocked("The requesting account is disabled. Managed work is blocked.");
    }
    await assertManagedNewsroomAssignment(base.db, latest, { publicationId: context.publicationId });
  };
  const transport = providerTransport(base.transport ?? fetchTransport, check, settings);
  const usage = mongoUsageSink(base.db);
  const sink: ModelCallSink = async (call) => {
    await usage({ ...call, run_id: call.run_id ?? context.runId, sponsor_id: current.id, initiator_id: current.id,
      funding: "platform", funding_identity: "managed", credential_version: 0 });
    await base.db.collection("journalist_funding_audit").insertOne({
      run_id: context.runId,
      sponsor_id: current.id,
      credential_version: 0,
      funding: "platform",
      funding_identity: "managed",
      initiator_id: current.id,
      provider: call.provider,
      model: call.model,
      role: context.role,
      ok: call.ok,
      reason: null,
      at: Date.now() / 1000,
    });
  };
  let fallbackReason = "Deployment model configuration is missing.";
  const models = executionModels(settings).map((provider) => new CheckedModel(
    createRuntime({ ...settings, modelProviders: [provider] }, transport, undefined, {
      role: context.role,
      sink,
      beforeDispatch: async () => {
        await check();
        if (provider.kind !== "ollama") await reserveModelAttempt(base.db, settings, { funding: "platform", initiatorId: current.id });
      },
    }),
    check,
    (error) => { fallbackReason = safeError(error); },
  ));
  if (!models.length) {
    throw new ExecutionBlocked(`No managed model is available: ${fallbackReason} Configure the managed provider on the server.`);
  }
  return {
    ...base,
    principal: current,
    settings,
    transport,
    credentialVersion: 0,
    discoveryModel: models.length === 1 ? models[0] : new FallbackRuntime(models),
  };
}

export type DesktopVideoCredential = {
  key: string;
  fundingIdentity: "managed" | "personal";
  credentialOwnerId?: string;
  credentialVersion: number;
};

type DesktopVideoJobCredential = {
  requested_by?: string;
  funding_identity?: "managed" | "personal";
  credential_owner_id?: string;
  credential_version?: number;
};

export async function desktopVideoCredentials(base: OrchestratorDeps, principal: Principal, publicationId?: string) {
  const current = await principalById(base.db, principal.id);
  if (!current) throw new ExecutionBlocked("The requesting account is disabled. Desktop Video is blocked.");
  if (current.role === "editor") await assertManagedNewsroomAssignment(base.db, current, { publicationId });
  const managedKey = current.role === "admin" ? null : platformSettings(base.settings).integrations.desktopVideoKey?.trim() || null;
  let personal: DesktopVideoCredential | null = null;
  let selectionUnavailable = false;
  if (current.role !== "editor") {
    try {
      const profile = await credentialProfile(base.db, current);
      const key = profile?.source === "personal" && !profile.revoked
        ? profile.config?.integrations.desktopVideoKey?.trim()
        : null;
      if (key) {
        personal = {
          key,
          fundingIdentity: "personal",
          credentialOwnerId: current.id,
          credentialVersion: profile!.version,
        };
      }
    } catch {
      selectionUnavailable = true;
    }
  }
  const managed: DesktopVideoCredential | null = managedKey
    ? { key: managedKey, fundingIdentity: "managed", credentialVersion: 0 }
    : null;
  return {
    principal: current,
    selected: selectionUnavailable ? null : personal ?? managed,
    selectionUnavailable,
    forJob(job: DesktopVideoJobCredential): DesktopVideoCredential | null {
      if (job.requested_by !== current.id) return null;
      if (job.funding_identity === "personal") {
        return personal
          && job.credential_owner_id === personal.credentialOwnerId
          && job.credential_version === personal.credentialVersion
          ? personal
          : null;
      }
      if (job.funding_identity === "managed") return managed;
      return null;
    },
  };
}
