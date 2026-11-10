import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { effectiveCredentialProfile, emptyPersonalConfig, safeProfile, type CredentialProfile } from "./credentials";
import { isConfiguredOwner, principalById, type Principal } from "./identity";
import { DEFAULT_LIGHT_MODEL, DEFAULT_MODEL_DAILY_CALLS, loadSettings, type ProviderConfig, type Settings } from "../core/config";
import { ExecutionBlocked } from "../core/execution-errors";
import { safeError } from "../core/redaction";
import { defaultRunOptions, isDeployed, LEGACY_MODEL_SERVICES, paidAllowance, resolveRunOptions, type RunOptions } from "../core/run-options";
import { ACTIVE_RUN_STATUSES, getRun, RunConflict, runs, type PipelineRun } from "../orchestration/runs";

/**
 * Every run uses its starter's keys. Only the exact configured owner may use deployment
 * defaults; all other users must supply personal keys, with no environment fallback.
 */
export type ExecutionBinding = {
  sponsorId: string;
  sponsorEmail?: string;
  initiatedBy: string;
  credentialVersion: number;
  source: "personal" | "environment";
  planHash: string;
  /** Runs started before one kind of run kept these; they're read, never written. */
  purpose?: string;
  approvalId?: string | null;
};
export type ExecutionPlan = { locationId: string; kind: "map" | "edition"; options: RunOptions & { purpose?: string }; credentialVersion: number; source: "personal" | "environment" };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function infrastructureSettings(): Settings {
  const env = process.env;
  // Only operational settings cross this boundary. No provider secret enters worker defaults.
  const infra = Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(NEWSBEE_(MODE|ROOT|PIPELINE_DRIVE_FOLDER_ID|RUN_TIMEOUT_MINUTES|COLLECT_CONCURRENCY|COLLECT_BUDGET_MINUTES|AI_LINK_DISCOVERY|WIDER_SOURCES|NEWS_SEARCH|LLM_DISCOVERY)|CRON_SECRET)$/.test(key)));
  return loadSettings({ ...infra, NODE_ENV: process.env.NODE_ENV, NEWSBEE_MODEL_PROVIDERS: "gemini" });
}

export function personalSettings(base: Settings, principal: Principal, profile: CredentialProfile | null): Settings {
  if (profile?.revoked) throw new ExecutionBlocked("Your API credentials were revoked. Save and reconnect credentials before continuing.");
  if (profile?.source === "environment") {
    if (!isConfiguredOwner(principal)) throw new ExecutionBlocked("Deployment credentials are restricted to the exact NEWSBEE_OWNER_EMAIL account. Save personal API keys in Environment & API settings.");
    return loadSettings();
  }
  if (isConfiguredOwner(principal)) {
    const deployment = loadSettings();
    const config = profile?.config;
    const providers = config?.modelProviders ?? [];
    return {
      ...base,
      modelProviders: [
        ...providers.map((provider) => {
          const inherited = deployment.modelProviders.find((candidate) => candidate.name === provider.name && candidate.kind === provider.kind);
          return inherited ? { ...inherited, ...provider, apiKey: provider.apiKey ?? inherited.apiKey } : provider;
        }),
        ...deployment.modelProviders.filter((provider) => !providers.some((saved) => saved.name === provider.name)),
      ],
      tavilySearchApiKey: config?.tavilySearchApiKey ?? deployment.tavilySearchApiKey,
      integrations: Object.fromEntries(Object.entries({ ...deployment.integrations, ...config?.integrations }).map(([key, value]) => [
        key, value ?? deployment.integrations[key as keyof Settings["integrations"]],
      ])) as Settings["integrations"],
      lightModel: config?.lightModel ?? deployment.lightModel,
      modelDailyCalls: config?.modelDailyCalls ?? deployment.modelDailyCalls,
    };
  }
  const defaults = emptyPersonalConfig();
  const config = profile?.config ?? defaults;
  return {
    ...base,
    modelProviders: config.modelProviders,
    tavilySearchApiKey: config.tavilySearchApiKey,
    integrations: { ...defaults.integrations, ...config.integrations },
    lightModel: config.lightModel,
    modelDailyCalls: config.modelDailyCalls,
  };
}

export function deploymentCredentialDefaults() {
  try {
    const settings = loadSettings();
    return {
      modelProviders: settings.modelProviders.map((provider) => ({ ...provider, apiKey: provider.apiKey ? "configured" : null })),
      lightModel: settings.lightModel,
      modelDailyCalls: settings.modelDailyCalls,
      tavilySearchApiKey: settings.tavilySearchApiKey ? "configured" : null,
      integrations: Object.fromEntries(Object.entries(settings.integrations).map(([key, value]) => [
        key, /Key$/.test(key) ? value ? "configured" : null : value,
      ])),
      configurationError: null,
    };
  } catch (error) {
    return {
      modelProviders: [], lightModel: DEFAULT_LIGHT_MODEL, modelDailyCalls: DEFAULT_MODEL_DAILY_CALLS,
      tavilySearchApiKey: null, integrations: {},
      configurationError: `Deployment API defaults are invalid: ${safeError(error)}`,
    };
  }
}
export function profileMetadata(principal: Principal, profile: CredentialProfile | null) {
  let configurationError: string | null = null;
  let resolved: Settings | undefined;
  if (profile && !profile.revoked) {
    try { resolved = personalSettings(infrastructureSettings(), principal, profile); }
    catch (error) { configurationError = `Personal API settings are invalid: ${safeError(error)}`; }
  }
  return profile ? { ...safeProfile(profile, resolved)!, configurationError } : null;
}

export function credentialContext(principal: Principal, profile: CredentialProfile | null) {
  return { owner: isConfiguredOwner(principal), source: profile?.source ?? "personal", configured: Boolean(profile) };
}
/** Keyless inference is available only through a local development Ollama server. */
export function executionModels(settings: Settings, env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  const local = settings.mode === "local" && !env.VERCEL && env.NODE_ENV !== "production";
  return settings.modelProviders.filter((provider) => {
    if (!provider.model) return false;
    if (provider.kind !== "ollama") return Boolean(provider.apiKey);
    if (!local) return false;
    try {
      const url = new URL(provider.baseUrl);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
        && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    } catch { return false; }
  });
}

export function capabilityReasons(settings: Settings, options: RunOptions, searchNeeded = false, needs: { model?: boolean; agent?: boolean; owner?: boolean; source?: "personal" | "environment"; configured?: boolean } = {}): string[] {
  const reasons: string[] = [];
  const models = executionModels(settings);
  const localModel = models.some((provider) => provider.kind === "ollama");
  const deployment = needs.owner && needs.source === "environment";
  if (needs.model !== false && !models.length) reasons.push(deployment
    ? "Deployment defaults have no model with both a model name and API key. Configure the selected provider on the server or save personal keys in Environment & API settings."
    : "Add a personal model API key and model in Environment & API settings.");
  const modelAllowed = (paidAllowance(options.paid, "model") ?? 0) > 0;
  if (needs.model !== false && models.length && !modelAllowed && !localModel) reasons.push("Enable the Model calls paid-call budget for this run.");
  const keys = settings.integrations;
  const searchKeys = { serpapi: keys.serpapiKey, searchapi: keys.searchapiKey, brightdata: keys.brightdataKey && keys.brightdataZone, exa: keys.exaKey, tavily: settings.tavilySearchApiKey, fixture: null };
  if (searchNeeded) {
    // The fixture is the free local test: it needs no key or budget, and never runs deployed.
    if (options.search_provider === "fixture") { if (isDeployed()) reasons.push("Fixture search cannot be used for admitted newsroom runs."); }
    else {
      if (!searchKeys[options.search_provider]) reasons.push(`Add ${deployment ? "deployment or personal" : "your own"} ${options.search_provider} search credentials${options.search_provider === "brightdata" ? " and zone" : ""} in Environment & API settings.`);
      if (!(options.paid[options.search_provider] && options.paid[options.search_provider]! > 0)) reasons.push(`Enable ${options.search_provider}'s paid-call budget.`);
    }
    if (needs.agent !== false && !localModel && !(options.paid.agent_model && options.paid.agent_model > 0)) reasons.push("Enable the agent model budget for agentic work.");
  }
  if (options.classifier !== "off" && !(keys.typesafeKey || keys.openrouterKey)) reasons.push("Jev classification needs your own TypeSafe or OpenRouter key, or switch classification off.");
  for (const [service, present] of Object.entries({ scrapingbee: keys.scrapingbeeKey, brightdata_open: keys.brightdataKey && keys.brightdataUnlockerZone, attom: keys.attomKey, jev: keys.typesafeKey || keys.openrouterKey })) {
    if ((options.paid[service as keyof RunOptions["paid"]] ?? 0) > 0 && !present) reasons.push(`${service} is enabled but has no personal key. Disable it or add your own key.`);
  }
  return reasons;
}
export function userDefaultOptions(settings: Settings): RunOptions {
  const options = defaultRunOptions();
  if (settings.modelProviders.some((provider) => provider.apiKey)) options.paid.model ??= 200;
  return options;
}
export function normalizedPlan(locationId: string, kind: "map" | "edition", choices: unknown, profile: CredentialProfile | null): ExecutionPlan {
  const options: ExecutionPlan["options"] = resolveRunOptions(choices);
  if (kind === "map") options.flow = options.map_flow ?? options.flow;
  // A run started before one kind of run recorded a purpose; keeping it keeps that run's plan unchanged.
  const legacy = (choices as { purpose?: unknown } | null)?.purpose;
  if (typeof legacy === "string") options.purpose = legacy;
  // Likewise its separate Gemini and OpenAI-compatible budgets: hashed as they were saved, so it isn't paused as changed.
  const paid = (choices as { paid?: Record<string, unknown> } | null)?.paid;
  if (paid && typeof paid === "object" && LEGACY_MODEL_SERVICES.some((id) => id in paid)) (options as { paid: unknown }).paid = paid;
  return { locationId, kind, options, credentialVersion: profile?.version ?? 0, source: profile?.source ?? "personal" };
}
export async function prepareBinding(db: Db, base: Settings, principal: Principal, locationId: string, kind: "map" | "edition", choices: unknown, existingRunId?: string): Promise<ExecutionBinding> {
  const profile = await effectiveCredentialProfile(db, principal);
  const plan = normalizedPlan(locationId, kind, choices, profile);
  if (existingRunId) {
    const previous = await getRun(db, existingRunId);
    if (previous?.execution && previous.execution.sponsorId !== principal.id) throw new ExecutionBlocked("Only the person who started this run can reconnect it, because it uses their keys.");
  }
  const binding: ExecutionBinding = {
    sponsorId: principal.id, sponsorEmail: principal.email, initiatedBy: principal.id, credentialVersion: plan.credentialVersion, source: plan.source, planHash: hash(plan),
  };
  const settings = personalSettings(base, principal, profile);
  const reasons = capabilityReasons(settings, plan.options, (kind === "map" ? plan.options.map_flow ?? plan.options.flow : plan.options.flow) === "agentic", credentialContext(principal, profile));
  if (reasons.length) throw new ExecutionBlocked(reasons.join(" "));
  return binding;
}
export async function assertBindingCurrent(db: Db, run: PipelineRun, allowInactive = false) {
  const binding = run.execution;
  if (!binding) throw new ExecutionBlocked("Legacy run has no credential sponsor. The owner must explicitly claim it or cancel it.");
  const principal = await principalById(db, binding.sponsorId);
  if (!principal) throw new ExecutionBlocked("The sponsoring account is disabled. Further paid work is blocked.");
  if (binding.source === "environment" && !isConfiguredOwner(principal)) throw new ExecutionBlocked("Deployment credentials are owner-only. Save personal API keys and reconnect this run.");
  const profile = await effectiveCredentialProfile(db, principal);
  if (profile?.revoked || (profile?.version ?? 0) !== binding.credentialVersion || (profile?.source ?? "personal") !== binding.source) throw new ExecutionBlocked("API settings changed or were revoked. This run is paused until its sponsor explicitly reconnects it.");
  if (hash(normalizedPlan(run.location_id, run.kind ?? "edition", run.options, profile)) !== binding.planHash) throw new ExecutionBlocked("The run configuration changed. Reconnect the run to continue with your current keys.");
  const options = resolveRunOptions(run.options);
  const reasons = capabilityReasons(personalSettings(infrastructureSettings(), principal, profile), options,
    (run.kind === "map" ? options.map_flow ?? options.flow : options.flow) === "agentic", credentialContext(principal, profile));
  if (reasons.length) throw new ExecutionBlocked(reasons.join(" "));
  const latest = await getRun(db, run._id);
  if (!latest || (!allowInactive && !ACTIVE_RUN_STATUSES.includes(latest.status)) || latest.execution_blocked) throw new ExecutionBlocked(latest?.execution_blocked?.reason ?? "This run is paused or no longer active.");
  return { principal, profile };
}
export async function assertSponsor(db: Db, runId: string, principal: Principal) {
  const run = await getRun(db, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  if (run.execution?.sponsorId !== principal.id) throw new ExecutionBlocked("Only the person who started this run can trigger more paid work, because it uses their keys. Start your own run when the newsroom is free.");
  return run;
}
export async function blockExecution(db: Db, runId: string, reason: string) {
  await runs(db).updateOne({ _id: runId, status: { $in: ACTIVE_RUN_STATUSES } }, { $set: { execution_blocked: { reason, at: Date.now() / 1000 } } });
}
export async function globalBlocker(db: Db, exceptRunId?: string) {
  return runs(db).findOne({ status: { $in: ACTIVE_RUN_STATUSES }, ...(exceptRunId ? { _id: { $ne: exceptRunId } } : {}) }, { sort: { created_at: 1 } });
}
export async function assertGlobalAdmission(db: Db, exceptRunId?: string) {
  const blocker = await globalBlocker(db, exceptRunId);
  if (blocker) throw new RunConflict(`Newsroom busy: ${blocker.location_name} has unfinished run ${blocker._id}. Open /locations/${encodeURIComponent(blocker.location_id)}?tab=edition&run=${blocker._id}. Paused and editor-waiting runs also hold the slot.`);
}
export async function authorizePaidAction(db: Db, runId: string, principal: Principal) {
  const run = await assertSponsor(db, runId, principal);
  await assertGlobalAdmission(db, runId);
  try { await assertBindingCurrent(db, run, true); }
  catch (error) {
    if (error instanceof ExecutionBlocked) await blockExecution(db, runId, error.message);
    throw error;
  }
  return run;
}
