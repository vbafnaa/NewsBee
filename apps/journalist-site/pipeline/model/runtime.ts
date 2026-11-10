/** Port of shared/model_inference (ollama.py, gemini.py, runtime.py): one swappable model interface. */
import type { ProviderConfig, Settings } from "../core/config";
import { logger, type Logger } from "../core/log";
import { type HttpTransport, fetchTransport, text } from "../core/http";
import { logApiCall, modelLimit, modelService, paidRefusal } from "../trace/gateway";
import { AsyncLocalStorage } from "node:async_hooks";
import { ExecutionBlocked } from "../core/execution-errors";
import { safeError } from "../core/redaction";

export type ComponentStatus = "ok" | "degraded" | "unavailable" | "not_configured";
export type ProviderHealth = { name: string; model: string | null; status: ComponentStatus | "failed"; detail: string };
export type ComponentHealth = { status: ComponentStatus; detail: string; providers?: ProviderHealth[] };

export class ModelUnavailableError extends Error {}
export class ModelSafetyError extends Error {}
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

export type StructuredOptions = { numCtx?: number; numPredict?: number; keepAlive?: string | number; timeoutMs?: number };
export type VisionInput = { id: string; mimeType: "image/jpeg" | "image/png" | "image/webp"; data: string };

function checkVisionInputs(images: readonly VisionInput[]) {
  if (!images.length || images.length > 6 || images.some(image => !image.id || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
    || image.data.length > 3 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(image.mimeType)))
    throw new Error("Invalid or oversized vision inputs");
}

export interface ModelRuntime {
  readonly provider: string;
  readonly model: string | null;
  /** The model that served the latest call, when a fallback chain may have moved on from `model`. */
  readonly servedModel?: string | null;
  health(): Promise<ComponentHealth>;
  generate(prompt: string): Promise<string>;
  generateWithUsage?(prompt: string): Promise<StructuredGeneration>;
  generateStructured(prompt: string, schema: JsonSchema, options?: StructuredOptions): Promise<StructuredGeneration>;
  readonly supportsVision?: boolean;
  generateVisionStructured?(prompt: string, images: readonly VisionInput[], schema: JsonSchema, options?: StructuredOptions): Promise<StructuredGeneration>;
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

async function post(transport: HttpTransport, url: string, headers: Record<string, string>, body: unknown, timeoutMs = 300_000) {
  const response = await transport({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    timeoutMs,
  });
  if (response.status >= 400) {
    if (response.status === 429) {
      throw new ModelRateLimitError("Model request rate limited (429)", retryAfterSeconds(response.headers, text(response)));
    }
    const body = text(response);
    if (/provider_policy_refusal|content_policy_violation/.test(body)) throw new ModelSafetyError("The provider refused this request under its content policy. No fallback model was called.");
    const hint = response.status === 400
      ? /max_completion_tokens/.test(body) ? ": use max_completion_tokens"
        : /temperature/.test(body) && /unsupported/i.test(body) ? ": temperature unsupported" : ""
      : "";
    throw new Error(`Model request failed (${response.status})${hint}`);
  }
  return JSON.parse(text(response)) as Record<string, unknown>;
}

export class OllamaRuntime implements ModelRuntime {
  readonly provider = "ollama";

  constructor(readonly url: string, readonly model: string | null, private readonly transport: HttpTransport = fetchTransport, readonly supportsVision = false) {}

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
    return (await this.generateWithUsage(prompt)).response;
  }

  async generateWithUsage(prompt: string): Promise<StructuredGeneration> {
    if (!this.model) throw new ModelUnavailableError("Select NEWSBEE_OLLAMA_MODEL before requesting inference");
    const data = await post(this.transport, `${this.url}/api/generate`, {}, { model: this.model, prompt, stream: false });
    if (typeof data.response !== "string") throw new Error("Ollama returned an invalid generation response");
    return {
      response: data.response, done: data.done !== false,
      prompt_eval_count: typeof data.prompt_eval_count === "number" ? data.prompt_eval_count : null,
      eval_count: typeof data.eval_count === "number" ? data.eval_count : null,
    };
  }

  async generateStructured(prompt: string, schema: JsonSchema, options: StructuredOptions = {}) {
    if (!this.model) throw new ModelUnavailableError("Select NEWSBEE_OLLAMA_MODEL before requesting inference");
    if (this.supportsVision) return this.chatStructured(prompt, schema, options);
    const data = await post(this.transport, `${this.url}/api/generate`, {}, {
      model: this.model,
      prompt,
      stream: false,
      think: false,
      format: schema,
      keep_alive: options.keepAlive ?? 0,
      options: { num_ctx: options.numCtx ?? 2048, num_predict: options.numPredict ?? 512, temperature: 0, seed: 42 },
    }, options.timeoutMs);
    if (typeof data.response !== "string" || typeof data.done !== "boolean") {
      throw new Error("Ollama returned an invalid structured generation");
    }
    return data as unknown as StructuredGeneration;
  }

  async generateVisionStructured(prompt: string, images: readonly VisionInput[], schema: JsonSchema, options: StructuredOptions = {}): Promise<StructuredGeneration> {
    if (!this.supportsVision || !this.model) throw new ModelUnavailableError("Ollama vision capability is not configured");
    checkVisionInputs(images);
    return this.chatStructured(prompt, schema, options, images);
  }

  private async chatStructured(prompt: string, schema: JsonSchema, options: StructuredOptions, images?: readonly VisionInput[]): Promise<StructuredGeneration> {
    const data = await post(this.transport, `${this.url}/api/chat`, {}, {
      model: this.model, stream: false, think: false, format: schema, keep_alive: options.keepAlive ?? 0,
      messages: [{ role: "user", content: images ? `${prompt}\nImage order: ${images.map(image => image.id).join(", ")}` : prompt,
        ...(images ? { images: images.map(image => image.data) } : {}) }],
      options: { num_ctx: options.numCtx ?? 8192, num_predict: options.numPredict ?? 1800, temperature: 0 },
    }, options.timeoutMs ?? 25_000);
    const message = data.message as { content?: unknown } | undefined;
    if (typeof message?.content !== "string" || data.done !== true) throw new Error("Invalid or incomplete Ollama vision response");
    return { response: message.content, done: true, done_reason: typeof data.done_reason === "string" ? data.done_reason : null,
      prompt_eval_count: typeof data.prompt_eval_count === "number" ? data.prompt_eval_count : null,
      eval_count: typeof data.eval_count === "number" ? data.eval_count : null };
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
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
};

export class GeminiRuntime implements ModelRuntime {
  readonly provider = "gemini";

  constructor(private readonly apiKey: string | null, readonly model: string, private readonly transport: HttpTransport = fetchTransport, readonly supportsVision = true) {}

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

  private async call(prompt: string, schema?: JsonSchema, maxOutputTokens?: number, images?: readonly VisionInput[], timeoutMs = images ? 25_000 : 300_000): Promise<GeminiData> {
    if (!this.apiKey) throw new ModelUnavailableError("Set NEWSBEE_GEMINI_API_KEY before requesting inference");
    const generationConfig: Record<string, unknown> = { temperature: 0 };
    if (maxOutputTokens !== undefined) generationConfig.maxOutputTokens = maxOutputTokens;
    if (schema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseJsonSchema = geminiSchema(schema, (schema.$defs ?? {}) as Record<string, JsonSchema>);
    }
    return await post(this.transport, `${GEMINI_ROOT}/models/${this.model}:generateContent`, { "x-goog-api-key": this.apiKey }, {
      contents: [{ role: "user", parts: [{ text: prompt }, ...(images ?? []).flatMap(image => [
        { text: `Image ID: ${image.id}` }, { inlineData: { mimeType: image.mimeType, data: image.data } },
      ])] }],
      generationConfig,
    }, timeoutMs) as GeminiData;
  }

  private static textOf(data: GeminiData) {
    const candidate = data.candidates?.[0];
    if (data.promptFeedback?.blockReason || ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(candidate?.finishReason ?? "")) throw new ModelSafetyError("Gemini refused this request under its content policy. No fallback model was called.");
    if (!data.candidates?.length) throw new Error("Gemini returned no candidates");
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) throw new Error("Gemini returned an invalid generation response");
    return parts.map((part) => part.text ?? "").join("");
  }

  async generate(prompt: string) {
    return (await this.generateWithUsage(prompt)).response;
  }

  async generateWithUsage(prompt: string) {
    return this.generation(await this.call(prompt));
  }

  private generation(data: GeminiData) {
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

  async generateStructured(prompt: string, schema: JsonSchema, options: StructuredOptions = {}) {
    const data = await this.call(prompt, schema, Math.max(options.numPredict ?? 512, 4096), undefined, options.timeoutMs);
    return this.generation(data);
  }

  async generateVisionStructured(prompt: string, images: readonly VisionInput[], schema: JsonSchema, options: StructuredOptions = {}) {
    if (!this.supportsVision) throw new ModelUnavailableError("Gemini vision is disabled");
    checkVisionInputs(images);
    return this.generation(await this.call(prompt, schema, options.numPredict ?? 2400, images));
  }
}

type ChatData = {
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** Any OpenAI-compatible chat completions API (OpenAI, Azure OpenAI v1, Groq, Together, OpenRouter, Mistral, vLLM...). */
export class OpenAICompatibleRuntime implements ModelRuntime {
  constructor(private readonly config: ProviderConfig, private readonly transport: HttpTransport = fetchTransport) {}

  get provider() { return this.config.name; }
  get model() { return this.config.model; }
  get supportsVision() { return this.config.vision === true; }

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

  private maxTokensParam = this.config.maxTokensParam;
  private temperature = this.config.temperature;

  private async call(prompt: string, schema?: JsonSchema, maxTokens?: number, images?: readonly VisionInput[], timeoutMs = images ? 25_000 : 300_000): Promise<ChatData> {
        for (let attempt = 0; ; attempt += 1) {
          const content = images ? [{ type: "text", text: prompt }, ...images.flatMap(image => [
            { type: "text", text: `Image ID: ${image.id}` },
            { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}`, detail: "high" } },
          ])] : prompt;
          const body: Record<string, unknown> = { model: this.config.model, messages: [{ role: "user", content }] };
          if (this.temperature !== null) body.temperature = this.temperature;
          if (maxTokens !== undefined) body[this.maxTokensParam] = maxTokens;
          if (schema) {
            body.response_format = this.config.jsonMode === "json_object"
              ? { type: "json_object" }
              : { type: "json_schema", json_schema: { name: "response", schema, strict: false } };
          }
          try {
            return await post(this.transport, `${this.config.baseUrl}/chat/completions`, this.headers(), body, timeoutMs) as ChatData;
          } catch (error) {
            // Newer models reject legacy request parameters; adapt once per parameter instead of requiring config.
            const message = error instanceof Error ? error.message : "";
            if (attempt >= 2 || !message.startsWith("Model request failed (400)")) throw error;
            if (this.maxTokensParam === "max_tokens" && maxTokens !== undefined && /max_completion_tokens/.test(message)) {
              this.maxTokensParam = "max_completion_tokens";
            } else if (this.temperature !== null && /temperature/.test(message) && /unsupported/i.test(message)) {
              this.temperature = null;
            } else {
              throw error;
            }
          }
        }
  }

  private static textOf(data: ChatData) {
    if (data.choices?.[0]?.finish_reason === "content_filter" || data.choices?.[0]?.message?.refusal) throw new ModelSafetyError("The provider refused this request under its content policy. No fallback model was called.");
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("Model returned no message content");
    return content;
  }

  async generate(prompt: string) {
    return (await this.generateWithUsage(prompt)).response;
  }

  async generateWithUsage(prompt: string) {
    return this.generation(await this.call(prompt));
  }

  async generateStructured(prompt: string, schema: JsonSchema, options: StructuredOptions = {}) {
    return this.generation(await this.call(prompt, schema, Math.max(options.numPredict ?? 512, 4096), undefined, options.timeoutMs));
  }

  private generation(data: ChatData) {
    const reason = data.choices?.[0]?.finish_reason ?? null;
    return {
      response: OpenAICompatibleRuntime.textOf(data),
      done: reason !== "length",
      done_reason: reason,
      prompt_eval_count: data.usage?.prompt_tokens ?? null,
      eval_count: data.usage?.completion_tokens ?? null,
    };
  }

  async generateVisionStructured(prompt: string, images: readonly VisionInput[], schema: JsonSchema, options: StructuredOptions = {}) {
    if (!this.supportsVision) throw new ModelUnavailableError("Image-input capability is not configured for this provider");
    checkVisionInputs(images);
    return this.generation(await this.call(prompt, schema, options.numPredict ?? 2400, images));
  }
}

/**
 * Ordered fallback across onboarded providers: each call goes to the first provider not in
 * cooldown; a provider or network error retries the same call on the next provider. Output
 * validation happens above this layer, so a bad story is never re-sent elsewhere.
 */
export class FallbackRuntime implements ModelRuntime {
  private readonly cooldownUntil = new Map<number, number>();
  servedModel: string | null = null;

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
  get supportsVision() { return this.runtimes.some(runtime => runtime.supportsVision && runtime.generateVisionStructured); }

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

  private async attempt<T>(operation: string, call: (runtime: ModelRuntime) => Promise<T>, accepts: (runtime: ModelRuntime) => boolean = () => true): Promise<T> {
    const time = this.now();
    const order = this.runtimes.map((runtime, index) => ({ runtime, index })).filter(({ runtime }) => accepts(runtime));
    const available = order.filter(({ index }) => (this.cooldownUntil.get(index) ?? 0) <= time);
    const cooling = order.filter(({ index }) => (this.cooldownUntil.get(index) ?? 0) > time);
    const failures: string[] = [];
    const limits: ModelRateLimitError[] = [];
    // Cooling providers are a last resort rather than skipped outright.
    for (const { runtime, index } of [...available, ...cooling]) {
      try {
        const result = await call(runtime);
        this.servedModel = runtime.model;
        this.cooldownUntil.delete(index);
        if (failures.length) this.log.warn("model_fallback_served", { operation, provider: runtime.provider, failed: failures });
        return result;
      } catch (error) {
        if (error instanceof ExecutionBlocked || error instanceof ModelSafetyError) throw error;
        if (error instanceof ModelRateLimitError) limits.push(error);
        const message = `${error instanceof Error ? `${error.name}: ` : ""}${safeError(error)}`;
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

  generateVisionStructured(prompt: string, images: readonly VisionInput[], schema: JsonSchema, options?: StructuredOptions) {
    return this.attempt("generate_vision_structured", runtime => runtime.generateVisionStructured!(prompt, images, schema, options),
      runtime => Boolean(runtime.supportsVision && runtime.generateVisionStructured));
  }
}

export function providerRuntime(config: ProviderConfig, transport: HttpTransport = fetchTransport): ModelRuntime {
  if (config.kind === "gemini") return new GeminiRuntime(config.apiKey, config.model ?? "", transport, config.vision !== false);
  if (config.kind === "ollama") return new OllamaRuntime(config.baseUrl, config.model, transport, config.vision === true);
  return new OpenAICompatibleRuntime(config, transport);
}

export type ModelUsageContext = { location_id: string; run_id?: string; sponsor_id?: string; credential_version?: number };
const usageContext = new AsyncLocalStorage<ModelUsageContext>();

export function withModelUsageContext<T>(context: ModelUsageContext, operation: () => T): T {
  return usageContext.run(context, operation);
}

/** One provider call as recorded for usage reporting; never includes prompts or responses. */
export type ModelCall = Partial<ModelUsageContext> & {
  provider: string;
  model: string | null;
  role: string;
  operation: "generate" | "generate_structured" | "generate_vision_structured";
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
  get supportsVision() { return this.inner.supportsVision === true; }

  private async record(call: Omit<ModelCall, "provider" | "model" | "role">) {
    try {
      await this.usage.sink({ ...usageContext.getStore(), provider: this.provider, model: this.model, role: this.usage.role, ...call });
    } catch (error) {
      this.log.warn("model_usage_record_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async measure<T>(operation: ModelCall["operation"], run: () => Promise<T>, tokens: (result: T) => [number | null, number | null]) {
    // A hosted provider the run hasn't ticked is skipped, so the fallback chain moves on.
    const service = modelService(this.provider, this.usage.role);
    const source = service ? { limit: modelLimit(this.provider, service), provider: this.provider, model: this.model } : {};
    if (service) {
      // Gemini's hard limits count every Gemini call, whichever role or budget it is under.
      const refused = await paidRefusal(service, { limits: source.limit, provider: this.provider });
      if (refused) throw new ModelUnavailableError(refused);
    }
    const started = this.clock();
    try {
      const result = await run();
      if (service) await logApiCall(service, true, "ok", this.usage.role, null, 1, source);
      const [input, output] = tokens(result);
      await this.record({ operation, ok: true, status_code: null, rate_limited: false, input_tokens: input, output_tokens: output, duration_ms: this.clock() - started, error: null });
      return result;
    } catch (error) {
      const message = safeError(error);
      const code = statusCode(message);
      if (service) await logApiCall(service, true, "failed", `${code ? `HTTP ${code}: ` : ""}${message}`.slice(0, 300));
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

  private tokenCounts(result: StructuredGeneration): [number | null, number | null] {
    const valid = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    const output = valid(result.eval_count), thinking = valid(result.thinking_eval_count);
    return [valid(result.prompt_eval_count), output === null && thinking === null ? null : (output ?? 0) + (thinking ?? 0)];
  }

  async generate(prompt: string) {
    const result = await this.measure("generate", () => this.inner.generateWithUsage
      ? this.inner.generateWithUsage(prompt)
      : this.inner.generate(prompt).then((response) => ({ response, done: true })), (value) => this.tokenCounts(value));
    return result.response;
  }

  generateStructured(prompt: string, schema: JsonSchema, options?: StructuredOptions) {
    return this.measure("generate_structured", () => this.inner.generateStructured(prompt, schema, options), (result) => this.tokenCounts(result));
  }

  generateVisionStructured(prompt: string, images: readonly VisionInput[], schema: JsonSchema, options?: StructuredOptions) {
    if (!this.inner.supportsVision || !this.inner.generateVisionStructured) return Promise.reject(new ModelUnavailableError("Provider does not support image input"));
    return this.measure("generate_vision_structured", () => this.inner.generateVisionStructured!(prompt, images, schema, options), result => this.tokenCounts(result));
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
