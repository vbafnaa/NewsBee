import path from "node:path";

export type ProviderKind = "ollama" | "gemini" | "openai";

/** Optional operator-supplied quota and pricing, used only to annotate recorded usage on Health. */
export type ProviderUsageConfig = {
  inputCostPerMTok: number | null;
  outputCostPerMTok: number | null;
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
};

/** One onboarded LLM provider. Secrets come only from environment variables. */
export type ProviderConfig = {
  /** Provider name from NEWSBEE_MODEL_PROVIDERS, e.g. "gemini", "openai", "groq". */
  name: string;
  kind: ProviderKind;
  model: string | null;
  baseUrl: string;
  apiKey: string | null;
  /** OpenAI-compatible only: header carrying the key ("api-key" for Azure); default Authorization: Bearer. */
  authHeader: string | null;
  maxTokensParam: "max_tokens" | "max_completion_tokens";
  /** OpenAI-compatible only: null omits temperature for models that only allow their default. */
  temperature: number | null;
  jsonMode: "json_schema" | "json_object";
  /** Explicit image-input capability; never send images to an unconfirmed text-only model. */
  vision?: boolean;
  usage: ProviderUsageConfig;
  /**
   * A cheaper model on the same provider for light work (extraction, discovery, the model check).
   * Unset: Gemini providers use Settings.lightModel; others use their own model.
   */
  lightModel?: string | null;
};
export type PipelineMode = "local" | "cloud";

export type Settings = {
  mode: PipelineMode;
  /** Repository root; local mode keeps MongoDB data and Drive stand-in files under .local/. */
  root: string;
  localDataDir: string;
  /** Ordered fallback list: each model call tries these in turn. */
  modelProviders: ProviderConfig[];
  /** Run the AI link finder alongside rule-based discovery in every connector. */
  aiLinkDiscovery: boolean;
  /** Optional Tavily API key for site-restricted council source discovery. */
  tavilySearchApiKey: string | null;
  /** Hazards, state news and trends near the town. */
  widerSources: boolean;
  pipelineDriveFolderId: string | null;
  cronSecret: string | null;
  /** Active runs older than this are failed with a diagnosis; null disables the deadline. */
  runTimeoutSeconds: number | null;
  /** NEWSBEE_COLLECT_CONCURRENCY: jobs running at once. Default 3 in the cloud, 6 locally. */
  collectConcurrency: number;
  /** NEWSBEE_COLLECT_BUDGET_MINUTES: when collection moves on with what it has; null for no limit. */
  collectBudgetSeconds: number | null;
  /** NEWSBEE_NEWS_SEARCH: news search backends, in order ("gdelt", "llm"); empty turns news search off. */
  newsSearch: Array<"gdelt" | "llm">;
  /** NEWSBEE_LLM_DISCOVERY: Gemini suggests sources at discovery time (every suggestion is checked). */
  llmDiscovery: boolean;
  /** NEWSBEE_PROPOSED_UNTIL_APPROVED: for the testing phase, every source a map run finds is saved as proposed, and editions read only what a person accepted. On by default. */
  proposedUntilApproved: boolean;
  /** NEWSBEE_MODEL_DAILY_CALLS: model calls per day for detail extraction and discovery. */
  modelDailyCalls: number;
  /** NEWSBEE_GEMINI_LIGHT_MODEL: the light model for Gemini providers that don't set their own (Flash-Lite). */
  lightModel: string;
  /** Keys for the paid integrations; a service with no key stays off whatever the run allows. */
  integrations: Integrations;
};

export type Integrations = {
  serpapiKey: string | null;
  searchapiKey: string | null;
  brightdataKey: string | null;
  brightdataZone: string | null;
  /** Bright Data's Web Unlocker zone, for opening pages: a different zone from search. */
  brightdataUnlockerZone: string | null;
  exaKey: string | null;
  scrapingbeeKey: string | null;
  typesafeKey: string | null;
  typesafeBase: string;
  openrouterKey: string | null;
  jevModel: string;
  attomKey: string | null;
  jinaKey: string | null;
  falKey: string | null;
};

export const DEFAULT_MODEL_DAILY_CALLS = 800;
export const DEFAULT_LIGHT_MODEL = "gemini-flash-lite-latest";

function newsSearchValue(value: string | undefined): Array<"gdelt" | "llm"> {
  const raw = blank(value);
  if (raw === null) return ["gdelt"];
  if (raw.toLowerCase() === "off") return [];
  const names = [...new Set(raw.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean))];
  for (const name of names) if (name !== "gdelt" && name !== "llm") throw new Error("NEWSBEE_NEWS_SEARCH must be gdelt, llm, gdelt,llm or off");
  return names as Array<"gdelt" | "llm">;
}

export const DEFAULT_RUN_TIMEOUT_MINUTES = 60;
export const DEFAULT_COLLECT_BUDGET_MINUTES = 8;

function flag(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function blank(value: string | undefined) {
  return value?.trim() ? value.trim() : null;
}

function nonNegative(value: string | undefined, variable: string): number | null {
  const raw = blank(value);
  if (raw === null) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${variable} must be a non-negative number`);
  return parsed;
}

/** NEWSBEE_RUN_TIMEOUT_MINUTES: default 60; 0 disables the run deadline. */
export function runTimeoutSeconds(env: NodeJS.ProcessEnv): number | null {
  const minutes = nonNegative(env.NEWSBEE_RUN_TIMEOUT_MINUTES, "NEWSBEE_RUN_TIMEOUT_MINUTES") ?? DEFAULT_RUN_TIMEOUT_MINUTES;
  return minutes === 0 ? null : Math.round(minutes * 60);
}

/** NEWSBEE_MODEL_<NAME>_{INPUT,OUTPUT}_COST_PER_MTOK (USD per million tokens) and _{RPM,RPD}_LIMIT. */
function usageConfig(env: NodeJS.ProcessEnv, name: string): ProviderUsageConfig {
  const prefix = `NEWSBEE_MODEL_${name.toUpperCase()}_`;
  const limit = (suffix: string) => {
    const value = nonNegative(env[`${prefix}${suffix}`], `${prefix}${suffix}`);
    return value ? value : null;
  };
  return {
    inputCostPerMTok: nonNegative(env[`${prefix}INPUT_COST_PER_MTOK`], `${prefix}INPUT_COST_PER_MTOK`),
    outputCostPerMTok: nonNegative(env[`${prefix}OUTPUT_COST_PER_MTOK`], `${prefix}OUTPUT_COST_PER_MTOK`),
    requestsPerMinute: limit("RPM_LIMIT"),
    requestsPerDay: limit("RPD_LIMIT"),
  };
}

export function repositoryRoot() {
  return process.env.NEWSBEE_ROOT ?? path.resolve(process.cwd(), "..", "..");
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const mode = (env.NEWSBEE_MODE ?? "local").trim().toLowerCase();
  if (mode !== "local" && mode !== "cloud") throw new Error("NEWSBEE_MODE must be 'local' or 'cloud'");
  const root = env.NEWSBEE_ROOT ?? repositoryRoot();
  return {
    mode,
    root,
    localDataDir: path.join(root, ".local", "stage2"),
    modelProviders: modelProviders(env, mode),
    aiLinkDiscovery: flag(env.NEWSBEE_AI_LINK_DISCOVERY, false),
    tavilySearchApiKey: blank(env.NEWSBEE_TAVILY_API_KEY),
    widerSources: flag(env.NEWSBEE_WIDER_SOURCES, true),
    pipelineDriveFolderId: blank(env.NEWSBEE_PIPELINE_DRIVE_FOLDER_ID),
    cronSecret: blank(env.CRON_SECRET),
    runTimeoutSeconds: runTimeoutSeconds(env),
    collectConcurrency: Math.max(1, Math.floor(nonNegative(env.NEWSBEE_COLLECT_CONCURRENCY, "NEWSBEE_COLLECT_CONCURRENCY") ?? (mode === "cloud" ? 3 : 6))),
    collectBudgetSeconds: Math.round((nonNegative(env.NEWSBEE_COLLECT_BUDGET_MINUTES, "NEWSBEE_COLLECT_BUDGET_MINUTES") ?? DEFAULT_COLLECT_BUDGET_MINUTES) * 60) || null,
    newsSearch: newsSearchValue(env.NEWSBEE_NEWS_SEARCH),
    llmDiscovery: flag(env.NEWSBEE_LLM_DISCOVERY, true),
    proposedUntilApproved: flag(env.NEWSBEE_PROPOSED_UNTIL_APPROVED, true),
    modelDailyCalls: nonNegative(env.NEWSBEE_MODEL_DAILY_CALLS, "NEWSBEE_MODEL_DAILY_CALLS") ?? DEFAULT_MODEL_DAILY_CALLS,
    lightModel: blank(env.NEWSBEE_GEMINI_LIGHT_MODEL) ?? DEFAULT_LIGHT_MODEL,
    integrations: {
      serpapiKey: blank(env.NEWSBEE_SERPAPI_API_KEY),
      searchapiKey: blank(env.NEWSBEE_SEARCHAPI_API_KEY),
      brightdataKey: blank(env.NEWSBEE_BRIGHTDATA_API_KEY),
      brightdataZone: blank(env.NEWSBEE_BRIGHTDATA_ZONE),
      brightdataUnlockerZone: blank(env.NEWSBEE_BRIGHTDATA_UNLOCKER_ZONE),
      exaKey: blank(env.NEWSBEE_EXA_API_KEY),
      scrapingbeeKey: blank(env.NEWSBEE_SCRAPINGBEE_API_KEY),
      typesafeKey: blank(env.TYPESAFE_API_KEY),
      typesafeBase: (blank(env.TYPESAFE_API_BASE) ?? "https://api.typesafe.ai").replace(/\/$/, ""),
      openrouterKey: blank(env.OPENROUTER_API_KEY),
      jevModel: blank(env.NEWSBEE_JEV_MODEL) ?? "jev-1.13",
      attomKey: blank(env.NEWSBEE_ATTOM_API_KEY),
      jinaKey: blank(env.NEWSBEE_JINA_API_KEY),
      falKey: blank(env.FAL_KEY),
    },
  };
}

const PROVIDER_NAME = /^[a-z][a-z0-9_]{0,31}$/;

function enumValue<T extends string>(value: string | null, allowed: readonly T[], fallback: T, variable: string): T {
  if (value === null) return fallback;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${variable} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function temperatureValue(value: string | null, variable: string): number | null {
  if (value === null) return 0;
  if (value.toLowerCase() === "default") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) throw new Error(`${variable} must be 'default' or a number from 0 to 2`);
  return parsed;
}

/**
 * NEWSBEE_MODEL_PROVIDERS is an ordered, comma-separated list. "ollama" and "gemini" use their
 * own settings; any other name is an OpenAI-compatible API configured by NEWSBEE_LLM_<NAME>_*.
 */
export function modelProviders(env: NodeJS.ProcessEnv, mode: PipelineMode): ProviderConfig[] {
  const listed = blank(env.NEWSBEE_MODEL_PROVIDERS) ?? blank(env.NEWSBEE_MODEL_PROVIDER) ?? (mode === "cloud" ? "gemini" : "ollama");
  const names = [...new Set(listed.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean))];
  if (!names.length) throw new Error("NEWSBEE_MODEL_PROVIDERS must name at least one provider");
  return names.map((name): ProviderConfig => {
    if (!PROVIDER_NAME.test(name)) throw new Error(`Invalid model provider name: ${name}`);
    const base = { name, apiKey: null, authHeader: null, maxTokensParam: "max_tokens", temperature: 0, jsonMode: "json_schema", usage: usageConfig(env, name) } as const;
    if (name === "ollama") {
      if (mode === "cloud") throw new Error("Ollama is local-only; list hosted providers in NEWSBEE_MODEL_PROVIDERS for cloud mode");
      return {
        ...base,
        kind: "ollama",
        vision: env.NEWSBEE_OLLAMA_VISION === "true",
        baseUrl: (env.NEWSBEE_OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, ""),
        model: env.NEWSBEE_OLLAMA_MODEL === undefined ? "qwen3:4b" : blank(env.NEWSBEE_OLLAMA_MODEL),
      };
    }
    if (name === "gemini") {
      const model = blank(env.NEWSBEE_GEMINI_MODEL) ?? "gemini-flash-latest";
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(model)) throw new Error("NEWSBEE_GEMINI_MODEL is invalid");
      return {
        ...base,
        kind: "gemini",
        vision: env.NEWSBEE_GEMINI_VISION !== "false",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        model,
        apiKey: blank(env.NEWSBEE_GEMINI_API_KEY) ?? blank(env.GOOGLE_AI_STUDIO_API_KEY),
        lightModel: modelName(blank(env.NEWSBEE_GEMINI_LIGHT_MODEL) ?? DEFAULT_LIGHT_MODEL, "NEWSBEE_GEMINI_LIGHT_MODEL"),
      };
    }
    const prefix = `NEWSBEE_LLM_${name.toUpperCase()}_`;
    const baseUrl = blank(env[`${prefix}BASE_URL`]) ?? (name === "openai" ? "https://api.openai.com/v1" : null);
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) throw new Error(`Set ${prefix}BASE_URL to the provider's OpenAI-compatible API URL`);
    const model = blank(env[`${prefix}MODEL`]);
    if (!model) throw new Error(`Set ${prefix}MODEL for model provider ${name}`);
    return {
      name,
      kind: "openai",
      baseUrl: baseUrl.replace(/\/$/, ""),
      model,
      apiKey: blank(env[`${prefix}API_KEY`]),
      authHeader: blank(env[`${prefix}AUTH_HEADER`]),
      maxTokensParam: enumValue(blank(env[`${prefix}MAX_TOKENS_PARAM`]), ["max_tokens", "max_completion_tokens"] as const, "max_tokens", `${prefix}MAX_TOKENS_PARAM`),
      temperature: temperatureValue(blank(env[`${prefix}TEMPERATURE`]), `${prefix}TEMPERATURE`),
      jsonMode: enumValue(blank(env[`${prefix}JSON_MODE`]), ["json_schema", "json_object"] as const, "json_schema", `${prefix}JSON_MODE`),
      vision: env[`${prefix}VISION`] === "true",
      usage: base.usage,
      lightModel: blank(env[`${prefix}LIGHT_MODEL`]),
    };
  });
}

/** The primary provider's model (first in the fallback list). */
export function configuredModel(settings: Settings) {
  return settings.modelProviders[0]?.model ?? null;
}

export function rankingSettings(settings: Settings): Settings {
  const hosted = settings.modelProviders.filter((provider) => provider.kind !== "ollama");
  return hosted.length ? { ...settings, modelProviders: hosted } : settings;
}

const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,100}$/;
function modelName(value: string, variable: string) {
  if (!MODEL_NAME.test(value)) throw new Error(`${variable} is invalid`);
  return value;
}

/** A provider's light model, or null when its light work runs on its own model. */
export function lightModelOf(provider: ProviderConfig, settings: Pick<Settings, "lightModel">): string | null {
  const light = provider.lightModel !== undefined && provider.lightModel !== null ? provider.lightModel
    : provider.kind === "gemini" ? settings.lightModel : null;
  return light && light !== provider.model ? light : null;
}

/**
 * Light-model settings: the configured providers in their order, each preceded by its light model
 * when it has one (`<name>_light`). Any provider kind works; nothing assumes Gemini.
 */
export function lightSettings(settings: Settings, env: NodeJS.ProcessEnv = process.env): Settings {
  const modelProviders = settings.modelProviders.flatMap((provider): ProviderConfig[] => {
    const light = lightModelOf(provider, settings);
    if (!light) return [provider];
    const lightUsage = usageConfig(env, `${provider.name}_light`);
    return [{ ...provider, name: `${provider.name}_light`, model: light, lightModel: null, usage: {
      ...lightUsage,
      requestsPerMinute: lightUsage.requestsPerMinute ?? provider.usage.requestsPerMinute,
      requestsPerDay: lightUsage.requestsPerDay ?? provider.usage.requestsPerDay,
    } }, provider];
  });
  return modelProviders.length === settings.modelProviders.length ? settings : { ...settings, modelProviders };
}
