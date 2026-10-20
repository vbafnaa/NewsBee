/** Port of shared/model_inference (ollama.py, gemini.py, runtime.py): one swappable model interface. */
import type { ProviderConfig, Settings } from "../core/config";
import { logger, type Logger } from "../core/log";
import { type HttpTransport, fetchTransport, text } from "../core/http";

export type ComponentStatus = "ok" | "degraded" | "unavailable" | "not_configured";
export type ProviderHealth = { name: string; model: string | null; status: ComponentStatus | "failed"; detail: string };
export type ComponentHealth = { status: ComponentStatus; detail: string; providers?: ProviderHealth[] };

export class ModelUnavailableError extends Error {}
export class ModelRateLimitError extends ModelUnavailableError {
  constructor(message: string, readonly retryAfterSeconds = 0) {
    super(message);
    this.name = "ModelRateLimitError";
  }
}

export function retryAfterSeconds(headers: Record<string, string>, body: string, now = Date.now()) {
  const header = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = header ? Date.parse(header) : NaN;
  if (Number.isFinite(date)) return Math.max(0, (date - now) / 1000);
  const hint = body.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i)
    ?? body.match(/try again in\s+([\d.]+)\s*s/i);
  return hint ? Number(hint[1]) : 0;
}

export type StructuredGeneration = {
  response: string;
  done: boolean;
  done_reason?: string | null;
  total_duration?: number | null;
  load_duration?: number | null;
  prompt_eval_count?: number | null;
  eval_count?: number | null;
  /** Billed reasoning tokens reported separately from eval_count (Gemini thoughts). */
  thinking_eval_count?: number | null;
  eval_duration?: number | null;
};

export type StructuredOptions = { numCtx?: number; numPredict?: number; keepAlive?: string | number };

export interface ModelRuntime {
  readonly provider: string;
  readonly model: string | null;
  health(): Promise<ComponentHealth>;
  generate(prompt: string): Promise<string>;
  generateStructured(prompt: string, schema: JsonSchema, options?: StructuredOptions): Promise<StructuredGeneration>;
}

export type JsonSchema = Record<string, unknown>;

function listedModelIds(body: Uint8Array): string[] | null {
  const payload: unknown = JSON.parse(new TextDecoder().decode(body));
  if (typeof payload !== "object" || payload === null || !("data" in payload) || !Array.isArray(payload.data)) {
    throw new Error("Model provider returned an invalid model list");
  }
  return payload.data.map((item: unknown) => {
    if (typeof item !== "object" || item === null || !("id" in item) || typeof item.id !== "string") {
      throw new Error("Model provider returned an invalid model identifier");
    }
    return item.id;
  });
}

async function post(transport: HttpTransport, url: string, headers: Record<string, string>, body: unknown) {
  const response = await transport({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    timeoutMs: 300_000,
  });
  if (response.status >= 400) {
    if (response.status === 429) {
      throw new ModelRateLimitError(`Model request rate limited (429): ${text(response).slice(0, 300)}`, retryAfterSeconds(response.headers, text(response)));
    }
    throw new Error(`Model request failed (${response.status}): ${text(response).slice(0, 300)}`);
  }
  return JSON.parse(text(response)) as Record<string, unknown>;
}

export class OllamaRuntime implements ModelRuntime {
  readonly provider = "ollama";

  constructor(readonly url: string, readonly model: string | null, private readonly transport: HttpTransport = fetchTransport) {}

  async health(): Promise<ComponentHealth> {
    const response = await this.transport({ url: `${this.url}/api/tags`, timeoutMs: 10_000 });
    if (response.status >= 400) throw new Error(`Ollama health failed (${response.status})`);
    const data = JSON.parse(text(response)) as { models?: Array<{ name: string }> };
    if (!Array.isArray(data.models)) throw new Error("Ollama returned an invalid model list");
    if (!this.model) {
      return { status: "not_configured", detail: "Ollama is reachable; no model selected. No automatic model downloads." };
    }
    if (!data.models.some((model) => model.name === this.model)) {
      return { status: "unavailable", detail: `Configured model is not installed: ${this.model}` };
    }
    return { status: "ok", detail: `Configured model installed: ${this.model}` };
  }

  async generate(prompt: string) {
    if (!this.model) throw new ModelUnavailableError("Select NEWSBEE_OLLAMA_MODEL before requesting inference");
    const data = await post(this.transport, `${this.url}/api/generate`, {}, { model: this.model, prompt, stream: false });
    if (typeof data.response !== "string") throw new Error("Ollama returned an invalid generation response");
    return data.response;
  }

  async generateStructured(prompt: string, schema: JsonSchema, options: StructuredOptions = {}) {
    if (!this.model) throw new ModelUnavailableError("Select NEWSBEE_OLLAMA_MODEL before requesting inference");
    const data = await post(this.transport, `${this.url}/api/generate`, {}, {
      model: this.model,
      prompt,
      stream: false,
      think: false,
      format: schema,
      keep_alive: options.keepAlive ?? 0,
      options: { num_ctx: options.numCtx ?? 2048, num_predict: options.numPredict ?? 512, temperature: 0, seed: 42 },
    });
    if (typeof data.response !== "string" || typeof data.done !== "boolean") {
      throw new Error("Ollama returned an invalid structured generation");
    }
    return data as unknown as StructuredGeneration;
  }
}

const GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_KEYS = new Set([
  "type", "description", "enum", "format", "items", "properties", "required",
  "minimum", "maximum", "minLength", "maxLength",
]);

/** Inline $refs and drop keywords Gemini's structured output rejects (port of gemini._schema). */
export function geminiSchema(schema: JsonSchema, definitions: Record<string, JsonSchema> = {}): JsonSchema {
  const reference = schema.$ref;
  if (typeof reference === "string") {
    return geminiSchema(definitions[reference.split("/").pop() ?? ""], definitions);
  }
  const result: JsonSchema = Object.fromEntries(Object.entries(schema).filter(([key]) => GEMINI_KEYS.has(key)));
  if (Array.isArray(schema.anyOf)) {
    const variants = (schema.anyOf as JsonSchema[]).filter((item) => item.type !== "null");
    if (variants.length === 1) return geminiSchema(variants[0], definitions);
    throw new Error("Gemini structured output does not support this schema union");
  }
  if (result.items) result.items = geminiSchema(result.items as JsonSchema, definitions);
  if (result.properties) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties as Record<string, JsonSchema>).map(([key, value]) => [key, geminiSchema(value, definitions)]),
    );
  }
  return result;
}

type GeminiData = {
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
};

export class GeminiRuntime implements ModelRuntime {
  readonly provider = "gemini";

  constructor(private readonly apiKey: string | null, readonly model: string, private readonly transport: HttpTransport = fetchTransport) {}

  async health(): Promise<ComponentHealth> {
    if (!this.apiKey) {
      return { status: "unavailable", detail: "Gemini selected but NEWSBEE_GEMINI_API_KEY is not set; no stories can be written." };
    }
    // countTokens is free and, unlike model metadata, rejects models retired for this key.
    const response = await this.transport({
      url: `${GEMINI_ROOT}/models/${this.model}:countTokens`,
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: "health" }] }] }),
      timeoutMs: 10_000,
    });
    if (response.status === 401 || response.status === 403) return { status: "unavailable", detail: `Gemini API key rejected (${response.status})` };
    if (response.status === 404) return { status: "unavailable", detail: `Gemini model not available to this key: ${this.model}` };
    if (response.status >= 400) throw new Error(`Gemini health failed (${response.status})`);
    return { status: "ok", detail: `Gemini model available: ${this.model}` };
  }

  private async call(prompt: string, schema?: JsonSchema, maxOutputTokens?: number): Promise<GeminiData> {
    if (!this.apiKey) throw new ModelUnavailableError("Set NEWSBEE_GEMINI_API_KEY before requesting inference");
    const generationConfig: Record<string, unknown> = { temperature: 0 };
    if (maxOutputTokens !== undefined) generationConfig.maxOutputTokens = maxOutputTokens;
    if (schema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseJsonSchema = geminiSchema(schema, (schema.$defs ?? {}) as Record<string, JsonSchema>);
    }
    return await post(this.transport, `${GEMINI_ROOT}/models/${this.model}:generateContent`, { "x-goog-api-key": this.apiKey }, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig,
    }) as GeminiData;
  }

  private static textOf(data: GeminiData) {
    const candidate = data.candidates?.[0];
    if (!data.candidates?.length) throw new Error("Gemini returned no candidates");
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) throw new Error("Gemini returned an invalid generation response");
    return parts.map((part) => part.text ?? "").join("");
  }

  async generate(prompt: string) {
    return GeminiRuntime.textOf(await this.call(prompt));
  }

  async generateStructured(prompt: string, schema: JsonSchema, options: StructuredOptions = {}) {
    const data = await this.call(prompt, schema, Math.max(options.numPredict ?? 512, 4096));
    const reason = data.candidates?.[0]?.finishReason ?? null;
    return {
      response: GeminiRuntime.textOf(data),
      done: reason !== "MAX_TOKENS",
      done_reason: reason === "MAX_TOKENS" ? "length" : reason,
      prompt_eval_count: data.usageMetadata?.promptTokenCount ?? null,
      eval_count: data.usageMetadata?.candidatesTokenCount ?? null,
      thinking_eval_count: data.usageMetadata?.thoughtsTokenCount ?? null,
    };
  }
}

type ChatData = {
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** Any OpenAI-compatible chat completions API (OpenAI, Azure OpenAI v1, Groq, Together, OpenRouter, Mistral, vLLM...). */
export class OpenAICompatibleRuntime implements ModelRuntime {
  constructor(private readonly config: ProviderConfig, private readonly transport: HttpTransport = fetchTransport) {}

  get provider() { return this.config.name; }
  get model() { return this.config.model; }

  private keyVariable() { return `NEWSBEE_LLM_${this.config.name.toUpperCase()}_API_KEY`; }

  private headers(): Record<string, string> {
    const key = this.config.apiKey;
    if (!key) throw new ModelUnavailableError(`Set ${this.keyVariable()} before requesting inference`);
    return this.config.authHeader ? { [this.config.authHeader]: key } : { Authorization: `Bearer ${key}` };
  }

  async health(): Promise<ComponentHealth> {
    if (!this.config.apiKey) return { status: "unavailable", detail: `${this.keyVariable()} is not set` };
    const response = await this.transport({ url: `${this.config.baseUrl}/models`, headers: this.headers(), timeoutMs: 10_000 });
    if (response.status === 401 || response.status === 403) return { status: "unavailable", detail: `API key rejected (${response.status})` };
    // Some compatible APIs (e.g. Azure deployments) have no model list; a non-auth error still proves reachability.
    if (response.status >= 500) throw new Error(`${this.config.name} health failed (${response.status})`);
    const listed = response.status < 300 ? listedModelIds(response.body) : null;
    const model = this.config.model ?? "";
    if (listed && !listed.includes(model)) {
      return { status: "unavailable", detail: `${this.config.name} does not offer model ${model}` };
    }
    return { status: "ok", detail: `${this.config.name} reachable; model ${this.config.model}` };
  }

  private async call(prompt: string, schema?: JsonSchema, maxTokens?: number): Promise<ChatData> {
    const body: Record<string, unknown> = { model: this.config.model, messages: [{ role: "user", content: prompt }], temperature: 0 };
    if (maxTokens !== undefined) body[this.config.maxTokensParam] = maxTokens;
    if (schema) {
      body.response_format = this.config.jsonMode === "json_object"
        ? { type: "json_object" }
        : { type: "json_schema", json_schema: { name: "response", schema, strict: false } };
    }
    return await post(this.transport, `${this.config.baseUrl}/chat/completions`, this.headers(), body) as ChatData;
  }

  private static textOf(data: ChatData) {
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("Model returned no message content");
    return content;
  }

  async generate(prompt: string) {
    return OpenAICompatibleRuntime.textOf(await this.call(prompt));
  }

  async generateStructured(prompt: string, schema: JsonSchema, options: StructuredOptions = {}) {
    const data = await this.call(prompt, schema, Math.max(options.numPredict ?? 512, 4096));
    const reason = data.choices?.[0]?.finish_reason ?? null;
    return {
      response: OpenAICompatibleRuntime.textOf(data),
      done: reason !== "length",
      done_reason: reason,
      prompt_eval_count: data.usage?.prompt_tokens ?? null,
      eval_count: data.usage?.completion_tokens ?? null,
    };
  }
}

/**
 * Ordered fallback across onboarded providers: each call goes to the first provider not in
 * cooldown; a provider or network error retries the same call on the next provider. Output
 * validation happens above this layer, so a bad story is never re-sent elsewhere.
 */
export class FallbackRuntime implements ModelRuntime {
  private readonly cooldownUntil = new Map<number, number>();

  constructor(
    private readonly runtimes: ModelRuntime[],
    private readonly log: Logger = logger("model"),
    private readonly cooldownMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!runtimes.length) throw new Error("At least one model provider is required");
  }

  get provider() { return this.runtimes.map((runtime) => runtime.provider).join(">"); }
  get model() { return this.runtimes[0].model; }

  async health(): Promise<ComponentHealth> {
    const providers = await Promise.all(this.runtimes.map(async (runtime): Promise<ProviderHealth> => {
      const health = await runtime.health().catch((error: unknown) => ({ status: "failed" as const, detail: error instanceof Error ? error.message : String(error) }));
      return { name: runtime.provider, model: runtime.model, status: health.status, detail: health.detail };
    }));
    const ready = providers.filter((item) => item.status === "ok" || item.status === "degraded");
    const status: ComponentStatus = !ready.length ? "unavailable" : ready[0] === providers[0] && providers[0].status === "ok" ? "ok" : "degraded";
    const detail = !ready.length
      ? "No model provider can serve requests"
      : ready[0] === providers[0] ? `Primary ${ready[0].name} ready` : `Primary ${providers[0].name} down; falling back to ${ready[0].name}`;
    return { status, detail, providers };
  }

  private async attempt<T>(operation: string, call: (runtime: ModelRuntime) => Promise<T>): Promise<T> {
    const time = this.now();
    const order = this.runtimes.map((runtime, index) => ({ runtime, index }));
    const available = order.filter(({ index }) => (this.cooldownUntil.get(index) ?? 0) <= time);
    const cooling = order.filter(({ index }) => (this.cooldownUntil.get(index) ?? 0) > time);
    const failures: string[] = [];
    const limits: ModelRateLimitError[] = [];
    // Cooling providers are a last resort rather than skipped outright.
    for (const { runtime, index } of [...available, ...cooling]) {
      try {
        const result = await call(runtime);
        this.cooldownUntil.delete(index);
        if (failures.length) this.log.warn("model_fallback_served", { operation, provider: runtime.provider, failed: failures });
        return result;
      } catch (error) {
        if (error instanceof ModelRateLimitError) limits.push(error);
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        failures.push(`${runtime.provider}: ${message}`);
        this.cooldownUntil.set(index, this.now() + this.cooldownMs);
        this.log.warn("model_provider_failed", { operation, provider: runtime.provider, error: message });
      }
    }
    this.log.error("model_all_providers_failed", { operation, failed: failures });
    if (limits.length) throw new ModelRateLimitError(`All model providers failed: ${failures.join("; ")}`, Math.min(...limits.map((error) => error.retryAfterSeconds)));
    throw new ModelUnavailableError(`All model providers failed: ${failures.join("; ")}`);
  }

  generate(prompt: string) {
    return this.attempt("generate", (runtime) => runtime.generate(prompt));
  }

  generateStructured(prompt: string, schema: JsonSchema, options?: StructuredOptions) {
    return this.attempt("generate_structured", (runtime) => runtime.generateStructured(prompt, schema, options));
  }
}

export function providerRuntime(config: ProviderConfig, transport: HttpTransport = fetchTransport): ModelRuntime {
  if (config.kind === "gemini") return new GeminiRuntime(config.apiKey, config.model ?? "", transport);
  if (config.kind === "ollama") return new OllamaRuntime(config.baseUrl, config.model, transport);
  return new OpenAICompatibleRuntime(config, transport);
}

/** One provider call as recorded for usage reporting; never includes prompts or responses. */
export type ModelCall = {
  provider: string;
  model: string | null;
  role: string;
  operation: "generate" | "generate_structured";
  ok: boolean;
  status_code: number | null;
  rate_limited: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number;
  error: string | null;
};
export type ModelCallSink = (call: ModelCall) => Promise<void> | void;
export type UsageRecording = { role: string; sink: ModelCallSink };

function statusCode(message: string) {
  const match = /\((\d{3})\)/.exec(message);
  return match ? Number(match[1]) : null;
}

/** Records every provider attempt, including fallback attempts, without changing results or errors. */
export class UsageRecordingRuntime implements ModelRuntime {
  constructor(
    private readonly inner: ModelRuntime,
    private readonly usage: UsageRecording,
    private readonly log: Logger = logger("model.usage"),
    private readonly clock: () => number = Date.now,
  ) {}

  get provider() { return this.inner.provider; }
  get model() { return this.inner.model; }

  health() { return this.inner.health(); }

  private async record(call: Omit<ModelCall, "provider" | "model" | "role">) {
    try {
      await this.usage.sink({ provider: this.provider, model: this.model, role: this.usage.role, ...call });
    } catch (error) {
      this.log.warn("model_usage_record_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async measure<T>(operation: ModelCall["operation"], run: () => Promise<T>, tokens: (result: T) => [number | null, number | null]) {
    const started = this.clock();
    try {
      const result = await run();
      const [input, output] = tokens(result);
      await this.record({ operation, ok: true, status_code: null, rate_limited: false, input_tokens: input, output_tokens: output, duration_ms: this.clock() - started, error: null });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = statusCode(message);
      await this.record({
        operation,
        ok: false,
        status_code: code,
        rate_limited: code === 429 || /RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(message),
        input_tokens: null,
        output_tokens: null,
        duration_ms: this.clock() - started,
        error: message.slice(0, 300),
      });
      throw error;
    }
  }

  generate(prompt: string) {
    return this.measure("generate", () => this.inner.generate(prompt), () => [null, null]);
  }

  generateStructured(prompt: string, schema: JsonSchema, options?: StructuredOptions) {
    return this.measure("generate_structured", () => this.inner.generateStructured(prompt, schema, options), (result) => {
      const output = result.eval_count ?? null;
      const thinking = result.thinking_eval_count ?? null;
      return [result.prompt_eval_count ?? null, output === null && thinking === null ? null : (output ?? 0) + (thinking ?? 0)];
    });
  }
}

/** The pipeline's model: one provider directly, or an ordered fallback chain. */
export function createRuntime(settings: Settings, transport: HttpTransport = fetchTransport, log?: Logger, usage?: UsageRecording): ModelRuntime {
  const runtimes = settings.modelProviders.map((config) => {
    const runtime = providerRuntime(config, transport);
    return usage ? new UsageRecordingRuntime(runtime, usage) : runtime;
  });
  return runtimes.length === 1 ? runtimes[0] : new FallbackRuntime(runtimes, log);
}