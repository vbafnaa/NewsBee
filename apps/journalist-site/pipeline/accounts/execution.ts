import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { canUseEnvironmentKeys, credentialProfile, emptyPersonalConfig, safeProfile, type CredentialProfile } from "./credentials";
import { isConfiguredOwner, principalById, type Principal } from "./identity";
import { DEFAULT_LIGHT_MODEL, DEFAULT_MODEL_DAILY_CALLS, lightSettings, loadSettings, type ProviderConfig, type Settings } from "../core/config";
import { ExecutionBlocked, executionBlock } from "../core/execution-errors";
import { safeError } from "../core/redaction";
import { defaultRunOptions, isDeployed, LEGACY_MODEL_SERVICES, paidAllowance, resolveRunOptions, type RunOptions } from "../core/run-options";
import { ACTIVE_RUN_STATUSES, getRun, RunConflict, runs, type PipelineRun } from "../orchestration/runs";
import { COLLECTIONS } from "../storage/mongo";
import { assertSiteOpen } from "../../../../shared/restore-maintenance";
import { ACTIVE_PUBLICATION_GENERATION_STATUSES, EXECUTABLE_PUBLICATION_GENERATION_STATUSES, ensurePublicationGenerationAdmissionIndex } from "../publications/generation-status";
import { activePublicationSupport } from "../publications/support";
import { admissionLeaseActive } from "../orchestration/jobs";

/** A run keeps its initiating principal plus either managed or legacy credential policy. */
export type ExecutionBinding = {
  sponsorId: string;
  sponsorEmail?: string;
  initiatedBy: string;
  credentialVersion: number;
  source: "personal" | "environment" | "platform";
  planHash: string;
  /** Runs started before one kind of run kept these; they're read, never written. */
  purpose?: string;
  approvalId?: string | null;
  /** The newsroom whose managed allowance pays for a journalist's run. */
  publicationId?: string;
};
export type ExecutionPlan = { locationId: string; kind: "map" | "edition"; options: RunOptions & { purpose?: string }; credentialVersion: number; source: ExecutionBinding["source"] };
export type ExecutionProviderPolicy = {
  principal: Principal;
  profile: CredentialProfile | null;
  settings: Settings;
  source: ExecutionBinding["source"];
  credentialVersion: number;
};
type KnownLegacyCredential = { principal: Principal; profile?: CredentialProfile | null };
type ExecutionPolicyRequest =
  | { kind: "platform"; publicationId?: string; locationId?: string }
  | { kind: "legacy"; known?: KnownLegacyCredential }
  | { kind: "binding"; binding: ExecutionBinding; known?: KnownLegacyCredential };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function infrastructureSettings(): Settings {
  const env = process.env;
  // Only operational settings cross this boundary. No provider secret enters worker defaults.
  const infra = Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(NEWSBEE_(MODE|ROOT|PIPELINE_DRIVE_FOLDER_ID|RUN_TIMEOUT_MINUTES|COLLECT_CONCURRENCY|COLLECT_BUDGET_MINUTES|AI_LINK_DISCOVERY|WIDER_SOURCES|NEWS_SEARCH|LLM_DISCOVERY|MODEL_DAILY_CALLS)|CRON_SECRET)$/.test(key)));
  return loadSettings({ ...infra, NODE_ENV: process.env.NODE_ENV, NEWSBEE_MODEL_PROVIDERS: "gemini" });
}

export function platformSettings(base: Settings): Settings {
  const deployment = loadSettings();
  return {
    ...base,
    modelProviders: deployment.modelProviders,
    tavilySearchApiKey: deployment.tavilySearchApiKey,
    integrations: deployment.integrations,
    lightModel: deployment.lightModel,
    modelDailyCalls: deployment.modelDailyCalls,
  };
}

export type ManagedHealthSettings = {
  runTimeoutSeconds: number | null;
  modelDailyCalls?: number;
  modelProviders: Array<Pick<ProviderConfig, "name" | "kind" | "model" | "usage"> & { configured: boolean }>;
  integrationFlags?: Record<string, boolean>;
  wiring?: { automatic_scheduling_enabled: false; scheduler_auth_configured: boolean; queue_consumer_route_wired: true };
};

/** Project only operational facts; never pass deployment settings or provider endpoints to Health. */
export function safeManagedHealthSettings(base: Pick<Settings, "runTimeoutSeconds">, deployment = loadSettings()): ManagedHealthSettings {
  const allowed = new Set(executionModels(deployment).map((provider) => provider.name));
  const label = (value: string | null) => value && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(value) && !value.includes("://") ? value : null;
  const finite = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0 ? value : null;
  const providers = [...deployment.modelProviders, ...lightSettings(deployment).modelProviders];
  return {
    runTimeoutSeconds: base.runTimeoutSeconds,
    modelDailyCalls: deployment.modelDailyCalls,
    modelProviders: providers.map((provider) => ({
      name: label(provider.name) ?? "provider",
      kind: provider.kind,
      model: label(provider.model),
      configured: allowed.has(provider.name.replace(/_light$/, "")) && Boolean(label(provider.model)),
      usage: {
        inputCostPerMTok: finite(provider.usage.inputCostPerMTok),
        outputCostPerMTok: finite(provider.usage.outputCostPerMTok),
        requestsPerMinute: finite(provider.usage.requestsPerMinute),
        requestsPerDay: finite(provider.usage.requestsPerDay),
      },
    })).filter((provider, index, all) => all.findIndex((other) => other.name === provider.name && other.model === provider.model) === index),
    integrationFlags: {
      tavily: Boolean(deployment.tavilySearchApiKey),
      ...Object.fromEntries((["serpapiKey", "searchapiKey", "brightdataKey", "exaKey", "scrapingbeeKey", "typesafeKey", "openrouterKey", "attomKey", "jinaKey", "falKey", "desktopVideoKey"] as const)
        .map((name) => [name.replace(/Key$/, ""), Boolean(deployment.integrations[name])])),
    },
    wiring: { automatic_scheduling_enabled: false, scheduler_auth_configured: Boolean(deployment.cronSecret), queue_consumer_route_wired: true },
  };
}

export function personalSettings(base: Settings, principal: Principal, profile: CredentialProfile | null): Settings {
  if (profile?.revoked) throw new ExecutionBlocked("Your API credentials were revoked. Save and reconnect credentials before continuing.");
  if (profile?.source === "environment") {
    if (!canUseEnvironmentKeys(principal)) throw new ExecutionBlocked("Deployment credentials are restricted to the exact NEWSBEE_OWNER_EMAIL account. Save personal API keys in Environment & API settings.");
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

export async function assertManagedNewsroomAssignment(
  db: Db, principal: Principal, scope: { publicationId?: string; locationId?: string } = {},
) {
  if (principal.role !== "editor") throw new ExecutionBlocked("Managed services are available only to assigned Journalist accounts. Administrators must use personal API keys.");
  const publication = await db.collection<{
    _id: string; selected_location_ids?: string[]; allowed_location_ids?: string[];
  }>(COLLECTIONS.outputChannels).findOne({
    ...(scope.publicationId ? { _id: scope.publicationId } : {}),
    $or: [{ owner_id: principal.id }, { members: { $elemMatch: { principal_id: principal.id, role: "editor" } } }],
    enabled: true, archived_at: { $not: { $type: "number" } },
    ...(scope.locationId ? { selected_location_ids: scope.locationId } : {}),
  });
  if (!publication) {
    throw new ExecutionBlocked("An active assigned newsroom is required for managed work.");
  }
  if (scope.locationId && !(publication.allowed_location_ids ?? publication.selected_location_ids ?? []).includes(scope.locationId)) {
    throw new ExecutionBlocked("This community is outside the assigned newsroom's allowed coverage.");
  }
}

/** New work follows the persisted account role; managed work never decrypts journalist keys. */
export async function resolveExecutionProviderPolicy(
  db: Db,
  base: Settings,
  principal: Principal,
  request: ExecutionPolicyRequest,
): Promise<ExecutionProviderPolicy> {
  const known = request.kind === "platform" ? undefined : request.known;
  const current = known?.principal.id === principal.id ? known.principal : await principalById(db, principal.id);
  if (!current) throw new ExecutionBlocked("The sponsoring account is disabled. Further paid work is blocked.");
  const platform = request.kind === "binding" && request.binding.source === "platform"
    || request.kind === "platform" && current.role === "editor";
  if (platform) {
    await assertManagedNewsroomAssignment(db, current, request.kind === "platform" ? request : {});
    return { principal: current, profile: null, settings: platformSettings(base), source: "platform", credentialVersion: 0 };
  }
  let profile = known?.principal.id === current.id && "profile" in known ? known.profile ?? null : await credentialProfile(db, current);
  if (!profile && canUseEnvironmentKeys(current)) {
    profile = { userId: current.id, version: 0, source: "environment", config: null, revoked: false, automatic: true };
  }
  return {
    principal: current,
    profile,
    settings: personalSettings(base, current, profile),
    source: profile?.source ?? "personal",
    credentialVersion: profile?.version ?? 0,
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
        key, /(?:Key|Zone)$/.test(key) ? value ? "configured" : null : value,
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

export function capabilityReasons(settings: Settings, options: RunOptions, searchNeeded = false, needs: { model?: boolean; agent?: boolean; owner?: boolean; source?: ExecutionBinding["source"]; configured?: boolean } = {}): string[] {
  const reasons: string[] = [];
  const models = executionModels(settings);
  const localModel = models.some((provider) => provider.kind === "ollama");
  const deployment = needs.source === "environment" || needs.source === "platform";
  const platform = needs.source === "platform";
  if (needs.model !== false && !models.length) reasons.push(deployment
    ? `Deployment defaults have no model with both a model name and API key. Configure the selected provider on the server${platform ? "." : " or save personal keys in Environment & API settings."}`
    : "Add a personal model API key and model in Environment & API settings.");
  const modelAllowed = (paidAllowance(options.paid, "model") ?? 0) > 0;
  if (needs.model !== false && models.length && !modelAllowed && !localModel) reasons.push("Enable the Model calls paid-call budget for this run.");
  const keys = settings.integrations;
  const searchKeys = { serpapi: keys.serpapiKey, searchapi: keys.searchapiKey, brightdata: keys.brightdataKey && keys.brightdataZone, exa: keys.exaKey, tavily: settings.tavilySearchApiKey, fixture: null };
  if (searchNeeded) {
    // The fixture is the free local test: it needs no key or budget, and never runs deployed.
    if (options.search_provider === "fixture") { if (isDeployed()) reasons.push("Fixture search cannot be used for admitted newsroom runs."); }
    else {
      if (!searchKeys[options.search_provider]) reasons.push(platform
        ? `Configure deployment ${options.search_provider} search credentials${options.search_provider === "brightdata" ? " and zone" : ""}.`
        : `Add ${deployment ? "deployment or personal" : "your own"} ${options.search_provider} search credentials${options.search_provider === "brightdata" ? " and zone" : ""} in Environment & API settings.`);
      if (!(options.paid[options.search_provider] && options.paid[options.search_provider]! > 0)) reasons.push(`Enable ${options.search_provider}'s paid-call budget.`);
    }
    if (needs.agent !== false && !localModel && !(options.paid.agent_model && options.paid.agent_model > 0)) reasons.push("Enable the agent model budget for agentic work.");
  }
  if (options.classifier !== "off" && !(keys.typesafeKey || keys.openrouterKey)) reasons.push(`Jev classification needs ${platform ? "a deployment" : deployment ? "a deployment or personal" : "your own"} TypeSafe or OpenRouter key, or switch classification off.`);
  for (const [service, present] of Object.entries({ scrapingbee: keys.scrapingbeeKey, brightdata_open: keys.brightdataKey && keys.brightdataUnlockerZone, attom: keys.attomKey, jev: keys.typesafeKey || keys.openrouterKey })) {
    if ((options.paid[service as keyof RunOptions["paid"]] ?? 0) > 0 && !present) reasons.push(`${service} is enabled but has no ${deployment ? "deployment" : "personal"} key. Disable it${platform ? " or configure it on the server." : " or add your own key."}`);
  }
  return reasons;
}
export function userDefaultOptions(settings: Settings): RunOptions {
  const options = defaultRunOptions();
  if (settings.modelProviders.some((provider) => provider.apiKey)) options.paid.model ??= 200;
  return options;
}
function planForPolicy(locationId: string, kind: "map" | "edition", choices: unknown, policy: Pick<ExecutionProviderPolicy, "credentialVersion" | "source">): ExecutionPlan {
  const options: ExecutionPlan["options"] = resolveRunOptions(choices);
  if (kind === "map") options.flow = options.map_flow ?? options.flow;
  // A run started before one kind of run recorded a purpose; keeping it keeps that run's plan unchanged.
  const legacy = (choices as { purpose?: unknown } | null)?.purpose;
  if (typeof legacy === "string") options.purpose = legacy;
  // Likewise its separate Gemini and OpenAI-compatible budgets: hashed as they were saved, so it isn't paused as changed.
  const paid = (choices as { paid?: Record<string, unknown> } | null)?.paid;
  if (paid && typeof paid === "object" && LEGACY_MODEL_SERVICES.some((id) => id in paid)) (options as { paid: unknown }).paid = paid;
  return { locationId, kind, options, credentialVersion: policy.credentialVersion, source: policy.source };
}
export function normalizedPlan(locationId: string, kind: "map" | "edition", choices: unknown, profile: CredentialProfile | null): ExecutionPlan {
  return planForPolicy(locationId, kind, choices, { credentialVersion: profile?.version ?? 0, source: profile?.source ?? "personal" });
}

export async function preparePolicyBinding(
  policy: ExecutionProviderPolicy,
  locationId: string,
  kind: "map" | "edition",
  choices: unknown,
): Promise<ExecutionBinding> {
  const plan = planForPolicy(locationId, kind, choices, policy);
  const reasons = capabilityReasons(policy.settings, plan.options, (kind === "map" ? plan.options.map_flow ?? plan.options.flow : plan.options.flow) === "agentic", {
    source: policy.source,
    configured: policy.source === "platform" || Boolean(policy.profile),
    owner: isConfiguredOwner(policy.principal),
  });
  if (reasons.length) throw new ExecutionBlocked(reasons.join(" "));
  return {
    sponsorId: policy.principal.id,
    sponsorEmail: policy.principal.email,
    initiatedBy: policy.principal.id,
    credentialVersion: policy.credentialVersion,
    source: policy.source,
    planHash: hash(plan),
  };
}

export async function prepareManagedBinding(db: Db, base: Settings, principal: Principal, locationId: string, kind: "map" | "edition", choices: unknown, publicationId?: string): Promise<ExecutionBinding> {
  // Journalists work only from an assigned newsroom: editions, and source runs (Collect sources) for communities
  // that newsroom covers. The policy check above refuses any other newsroom or community.
  if (principal.role === "editor" && !publicationId) {
    throw new ExecutionBlocked("Journalists start editions and source runs only from an assigned newsroom that covers this community.");
  }
  const policy = await resolveExecutionProviderPolicy(db, base, principal, { kind: "platform", publicationId, locationId });
  const binding = await preparePolicyBinding(policy, locationId, kind, choices);
  return policy.source === "platform" && publicationId ? { ...binding, publicationId } : binding;
}

export async function prepareBinding(db: Db, base: Settings, principal: Principal, locationId: string, kind: "map" | "edition", choices: unknown, existingRunId?: string): Promise<ExecutionBinding> {
  let previous: PipelineRun | null = null;
  if (existingRunId) {
    previous = await getRun(db, existingRunId);
    if (previous?.execution && previous.execution.sponsorId !== principal.id) throw new ExecutionBlocked("Only the person who started this run can reconnect its execution policy.");
  }
  const request: ExecutionPolicyRequest = previous?.execution?.source === "platform"
    ? { kind: "binding", binding: previous.execution }
    : { kind: "legacy" };
  return preparePolicyBinding(await resolveExecutionProviderPolicy(db, base, principal, request), locationId, kind, choices);
}
export async function assertBindingCurrent(db: Db, run: PipelineRun, allowInactive = false, known?: KnownLegacyCredential, base: Settings = infrastructureSettings()) {
  if (run.publication_generation_id) {
    const parent = await db.collection<{ _id: string; status: string }>(COLLECTIONS.publicationGenerations)
      .findOne({ _id: run.publication_generation_id });
    if (!parent || !EXECUTABLE_PUBLICATION_GENERATION_STATUSES.includes(parent.status as never)) {
      throw new ExecutionBlocked("The combined publication generation is blocked, cancelling or finished. Use its publication recovery controls.");
    }
  }
  const binding = run.execution;
  if (!binding) throw new ExecutionBlocked("Legacy run has no credential sponsor. The owner must explicitly claim it or cancel it.");
  const principal = known?.principal.id === binding.sponsorId ? known.principal : await principalById(db, binding.sponsorId);
  if (!principal) throw new ExecutionBlocked("The sponsoring account is disabled. Further paid work is blocked.");
  if (binding.source === "environment" && !canUseEnvironmentKeys(principal)) throw new ExecutionBlocked("Deployment credentials are owner-only. Save personal API keys and reconnect this run.");
  if (binding.source === "platform") {
    // Managed work is an edition inside a newsroom generation, or a source run a journalist started from a
    // newsroom covering the community (recorded on the binding). Either way the assignment is rechecked now.
    const managedPublication = run.kind === "map" ? binding.publicationId
      : run.publication_generation_id ? run.publication_id : undefined;
    if (!managedPublication) throw new ExecutionBlocked("Managed execution requires an assigned publication generation. Reconnect through the newsroom.");
    await assertManagedNewsroomAssignment(db, principal, { publicationId: managedPublication, locationId: run.location_id });
  } else if (run.publication_id) {
    const publication = await db.collection<{ _id: string; owner_id: string; members?: Array<{ principal_id: string; role: string }> }>(COLLECTIONS.outputChannels)
      .findOne({ _id: run.publication_id, enabled: true, archived_at: { $not: { $type: "number" } } });
    const direct = publication && (publication.owner_id === principal.id
      || publication.members?.some((member) => member.principal_id === principal.id && member.role === "editor"));
    if (!publication || !direct && (principal.role === "editor" || !await activePublicationSupport(db, principal, run.publication_id))) {
      throw new ExecutionBlocked("Newsroom assignment or audited support access expired. Explicitly recover this generation with current authority.");
    }
  }
  const resolved = known?.principal.id === principal.id ? known : { principal };
  const policy = await resolveExecutionProviderPolicy(db, base, principal, { kind: "binding", binding, known: resolved });
  if (binding.source !== "platform" && (policy.profile?.revoked || policy.credentialVersion !== binding.credentialVersion || policy.source !== binding.source)) {
    throw new ExecutionBlocked("API settings changed or were revoked. This run is paused until its sponsor explicitly reconnects it.");
  }
  if (hash(planForPolicy(run.location_id, run.kind ?? "edition", run.options, policy)) !== binding.planHash) throw new ExecutionBlocked("The run configuration changed. Reconnect the run to continue with its current execution policy.");
  const options = resolveRunOptions(run.options);
  const reasons = capabilityReasons(policy.settings, options,
    (run.kind === "map" ? options.map_flow ?? options.flow : options.flow) === "agentic", {
      source: policy.source,
      configured: policy.source === "platform" || Boolean(policy.profile),
      owner: isConfiguredOwner(policy.principal),
    });
  if (reasons.length) throw new ExecutionBlocked(reasons.join(" "));
  const latest = await getRun(db, run._id);
  if (!latest || (!allowInactive && !ACTIVE_RUN_STATUSES.includes(latest.status)) || latest.execution_blocked) throw new ExecutionBlocked(latest?.execution_blocked?.reason ?? "This run is paused or no longer active.");
  return policy;
}
export async function assertSponsor(db: Db, runId: string, principal: Principal) {
  const run = await getRun(db, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  if (run.execution?.sponsorId !== principal.id) throw new ExecutionBlocked("Only the person who started this run can trigger more provider-backed work. Start your own run when the newsroom is free.");
  return run;
}
export async function blockExecution(db: Db, runId: string, reason: string | Error) {
  const blocked = executionBlock(reason);
  const run = await runs(db).findOneAndUpdate({ _id: runId, status: { $in: ACTIVE_RUN_STATUSES } },
    { $set: { execution_blocked: blocked, updated_at: Date.now() / 1000 } }, { returnDocument: "after" });
  if (run?.publication_generation_id) {
    await ensurePublicationGenerationAdmissionIndex(db);
    await db.collection<{ _id: string; status: string; error?: string; execution_blocked?: ReturnType<typeof executionBlock>; updated_at?: number }>(COLLECTIONS.publicationGenerations).updateOne({
      _id: run.publication_generation_id, status: { $in: [...EXECUTABLE_PUBLICATION_GENERATION_STATUSES] },
    }, { $set: { status: "blocked", error: blocked.reason, execution_blocked: blocked, updated_at: Date.now() / 1000 } });
  }
}
type GlobalBlocker = Pick<PipelineRun, "_id" | "kind" | "location_id" | "location_name" | "status" | "execution_blocked" | "publication_generation_id"> & {
  blocker_kind?: "publication_generation" | "inactive_publication_generation";
};

export async function globalBlocker(db: Db, exceptRunId?: string, publicationGenerationId?: string, recovery = false): Promise<GlobalBlocker | null> {
  if (publicationGenerationId) {
    const parent = await db.collection<{
      _id: string;
      publication_id: string;
      publication_name: string;
      status: string;
      execution_blocked?: ReturnType<typeof executionBlock>;
    }>(COLLECTIONS.publicationGenerations).findOne({ _id: publicationGenerationId });
    if (!parent || !(recovery ? [...ACTIVE_PUBLICATION_GENERATION_STATUSES, "failed"] : EXECUTABLE_PUBLICATION_GENERATION_STATUSES).includes(parent.status as never)) {
      return {
        _id: publicationGenerationId,
        location_id: parent?.publication_id ?? publicationGenerationId,
        location_name: parent?.publication_name ?? "Combined draft",
        status: (parent?.status ?? "failed") as PipelineRun["status"],
        execution_blocked: parent?.execution_blocked,
        blocker_kind: "inactive_publication_generation",
      };
    }
  }
  const run = await runs(db).findOne({
    status: { $in: ACTIVE_RUN_STATUSES },
    ...(exceptRunId ? { _id: { $ne: exceptRunId } } : {}),
    ...(publicationGenerationId ? {
      $nor: [{ admission: "publication", publication_generation_id: publicationGenerationId }],
    } : {}),
  }, {
    sort: { created_at: 1 },
    projection: { _id: 1, kind: 1, location_id: 1, location_name: 1, status: 1, execution_blocked: 1, publication_generation_id: 1 },
  });
  if (run) return run;
  const generation = await db.collection<{
    _id: string;
    publication_id: string;
    publication_name: string;
    status: string;
    created_at: number;
    execution_blocked?: ReturnType<typeof executionBlock>;
  }>(COLLECTIONS.publicationGenerations).findOne({
    status: { $in: [...ACTIVE_PUBLICATION_GENERATION_STATUSES] },
    ...(publicationGenerationId ? { _id: { $ne: publicationGenerationId } } : {}),
  }, { sort: { created_at: 1 } });
  return generation ? {
    _id: generation._id,
    location_id: generation.publication_id,
    location_name: generation.publication_name,
    status: generation.status as PipelineRun["status"],
    execution_blocked: generation.execution_blocked,
    blocker_kind: "publication_generation",
  } : null;
}
export async function globalBlockerDestination(db: Db, blocker: GlobalBlocker): Promise<string | null> {
  const generationId = blocker.blocker_kind ? blocker._id : blocker.publication_generation_id;
  if (generationId) {
    const parent = await db.collection<{ _id: string; publication_id: string }>(COLLECTIONS.publicationGenerations)
      .findOne({ _id: generationId }, { projection: { publication_id: 1 } });
    return parent?.publication_id ? `/newsroom/${encodeURIComponent(parent.publication_id)}?generation=${encodeURIComponent(generationId)}` : null;
  }
  return `/locations/${encodeURIComponent(blocker.location_id)}?tab=${blocker.kind === "map" ? "collect-sources" : "edition"}&run=${encodeURIComponent(blocker._id)}`;
}
export const SHARED_GENERATION_BUSY_DETAIL = "Shared generation capacity is busy. Unfinished work, including paused or cancelling work, keeps its place until it is resolved or safely settled. Recheck availability shortly, or start writing without generation.";
export class GlobalAdmissionConflict extends RunConflict {}

/** Use the authoritative blocker rules without changing admission or revealing other newsrooms. */
export async function sharedGenerationAvailability(db: Db) {
  await assertSiteOpen(db);
  const busy = Boolean(await globalBlocker(db)) || await admissionLeaseActive(db);
  return { available: !busy, detail: busy ? SHARED_GENERATION_BUSY_DETAIL : null };
}

export async function assertGlobalAdmission(db: Db, exceptRunId?: string, publicationGenerationId?: string, recovery = false) {
  await assertSiteOpen(db);
  const blocker = await globalBlocker(db, exceptRunId, publicationGenerationId, recovery);
  if (!blocker) return;
  if (blocker.blocker_kind === "inactive_publication_generation") {
    throw new RunConflict(`This combined draft is not executable (${blocker.status}). ${blocker.execution_blocked?.reason ?? "Use its explicit publication recovery controls."}`);
  }
  if (blocker.blocker_kind === "publication_generation") {
    const destination = await globalBlockerDestination(db, blocker);
    throw new GlobalAdmissionConflict(`Newsroom busy: ${blocker.location_name} has an unfinished combined draft (${blocker.status}). ${blocker.execution_blocked?.reason ?? ""} Open ${destination} for publication recovery. Paused and cancelling generations retain the slot.`);
  }
  const destination = await globalBlockerDestination(db, blocker);
  throw new GlobalAdmissionConflict(`Newsroom busy: ${blocker.location_name} has unfinished run ${blocker._id}. ${destination ? `Open ${destination}.` : "Combined draft context is unavailable. Ask the workspace operator to inspect its parent generation."} Paused and editor-waiting runs also hold the slot.`);
}
export async function authorizePaidAction(db: Db, runId: string, principal: Principal) {
  const run = await assertSponsor(db, runId, principal);
  await assertGlobalAdmission(db, runId, run.publication_generation_id);
  try { await assertBindingCurrent(db, run, true); }
  catch (error) {
    if (error instanceof ExecutionBlocked) await blockExecution(db, runId, error);
    throw error;
  }
  return run;
}
