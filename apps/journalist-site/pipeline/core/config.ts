import path from "node:path";

export type ProviderKind = "ollama" | "gemini" | "openai";

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
  jsonMode: "json_schema" | "json_object";
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
  /** Hazards, state news and trends near the town. */
  widerSources: boolean;
  pipelineDriveFolderId: string | null;
  cronSecret: string | null;
};

function flag(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function blank(value: string | undefined) {
  return value?.trim() ? value.trim() : null;
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
    widerSources: flag(env.NEWSBEE_WIDER_SOURCES, true),
    pipelineDriveFolderId: blank(env.NEWSBEE_PIPELINE_DRIVE_FOLDER_ID),
    cronSecret: blank(env.CRON_SECRET),
  };
}

const PROVIDER_NAME = /^[a-z][a-z0-9_]{0,31}$/;

function enumValue<T extends string>(value: string | null, allowed: readonly T[], fallback: T, variable: string): T {
  if (value === null) return fallback;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${variable} must be one of: ${allowed.join(", ")}`);
  return value as T;
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
    const base = { name, apiKey: null, authHeader: null, maxTokensParam: "max_tokens", jsonMode: "json_schema" } as const;
    if (name === "ollama") {
      if (mode === "cloud") throw new Error("Ollama is local-only; list hosted providers in NEWSBEE_MODEL_PROVIDERS for cloud mode");
      return {
        ...base,
        kind: "ollama",
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
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        model,
        apiKey: blank(env.NEWSBEE_GEMINI_API_KEY) ?? blank(env.GOOGLE_AI_STUDIO_API_KEY),
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
      jsonMode: enumValue(blank(env[`${prefix}JSON_MODE`]), ["json_schema", "json_object"] as const, "json_schema", `${prefix}JSON_MODE`),
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

/** More recall before hosted scoring, without making the local-model path more expensive. */
export function rankingCandidateLimit(settings: Settings) {
  return settings.modelProviders.some((provider) => provider.kind !== "ollama") ? 15 : 5;
}