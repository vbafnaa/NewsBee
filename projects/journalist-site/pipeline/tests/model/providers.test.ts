/** Provider onboarding from env vars, the OpenAI-compatible adapter and ordered fallback. */
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings, modelProviders } from "../../core/config";
import type { HttpRequest, HttpTransport } from "../../core/http";
import { logger, setLogSink, type LogRecord } from "../../core/log";
import { createRuntime, FallbackRuntime, GeminiRuntime, ModelUnavailableError, OpenAICompatibleRuntime, type ModelRuntime } from "../../model/runtime";

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;

function respond(status: number, body: unknown) {
  return { url: "", status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}

function stub(name: string, behaviour: () => string): ModelRuntime & { calls: number } {
  return {
    provider: name,
    model: `${name}-model`,
    calls: 0,
    async health() { return { status: "ok", detail: "" }; },
    async generate() { this.calls += 1; return behaviour(); },
    async generateStructured() { this.calls += 1; return { response: behaviour(), done: true }; },
  };
}

function captureLog() {
  const records: LogRecord[] = [];
  process.env.NEWSBEE_LOG_LEVEL = "debug";
  setLogSink((record) => records.push(record));
  return { records, log: logger("model") };
}

afterEach(() => {
  setLogSink(null);
  process.env.NEWSBEE_LOG_LEVEL = "error";
});

describe("model provider config", () => {
  it("defaults to Ollama locally and Gemini in cloud mode", () => {
    expect(modelProviders(env({}), "local").map((item) => item.name)).toEqual(["ollama"]);
    expect(modelProviders(env({}), "cloud").map((item) => item.name)).toEqual(["gemini"]);
  });

  it("reads an ordered list of providers, including any OpenAI-compatible API", () => {
    const providers = modelProviders(env({
      NEWSBEE_MODEL_PROVIDERS: "gemini, groq, openai",
      NEWSBEE_GEMINI_API_KEY: "g-key",
      NEWSBEE_LLM_GROQ_BASE_URL: "https://api.groq.com/openai/v1/",
      NEWSBEE_LLM_GROQ_MODEL: "openai/gpt-oss-120b",
      NEWSBEE_LLM_GROQ_API_KEY: "groq-key",
      NEWSBEE_LLM_OPENAI_MODEL: "gpt-4.1-mini",
    }), "cloud");
    expect(providers.map((item) => [item.name, item.kind, item.model])).toEqual([
      ["gemini", "gemini", "gemini-flash-latest"],
      ["groq", "openai", "openai/gpt-oss-120b"],
      ["openai", "openai", "gpt-4.1-mini"],
    ]);
    expect(providers[1].baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(providers[2].baseUrl).toBe("https://api.openai.com/v1");
    expect(providers[2].apiKey).toBeNull();
  });

  it("rejects Ollama in cloud mode and incomplete OpenAI-compatible providers", () => {
    expect(() => loadSettings(env({ NEWSBEE_MODE: "cloud", NEWSBEE_MODEL_PROVIDERS: "gemini,ollama" }))).toThrow(/local-only/);
    expect(() => modelProviders(env({ NEWSBEE_MODEL_PROVIDERS: "groq" }), "local")).toThrow(/NEWSBEE_LLM_GROQ_BASE_URL/);
    expect(() => modelProviders(env({ NEWSBEE_MODEL_PROVIDERS: "openai" }), "local")).toThrow(/NEWSBEE_LLM_OPENAI_MODEL/);
  });
});

describe("OpenAI-compatible runtime", () => {
  const [config] = modelProviders(env({
    NEWSBEE_MODEL_PROVIDERS: "azure",
    NEWSBEE_LLM_AZURE_BASE_URL: "https://example.openai.azure.com/openai/v1",
    NEWSBEE_LLM_AZURE_MODEL: "gpt-4.1-mini",
    NEWSBEE_LLM_AZURE_API_KEY: "secret",
    NEWSBEE_LLM_AZURE_AUTH_HEADER: "api-key",
  }), "cloud");

  it("sends structured requests and reads the reply", async () => {
    const requests: HttpRequest[] = [];
    const transport: HttpTransport = async (request) => {
      requests.push(request);
      return respond(200, { choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
    };
    const runtime = new OpenAICompatibleRuntime(config, transport);
    const result = await runtime.generateStructured("Rate this", { type: "object" }, { numPredict: 100 });
    expect(result).toMatchObject({ response: "{\"ok\":true}", done: true, prompt_eval_count: 5, eval_count: 3 });
    expect(requests[0].url).toBe("https://example.openai.azure.com/openai/v1/chat/completions");
    expect(requests[0].headers).toMatchObject({ "api-key": "secret" });
    const body = JSON.parse(requests[0].body ?? "{}");
    expect(body).toMatchObject({ model: "gpt-4.1-mini", max_tokens: 4096, temperature: 0, response_format: { type: "json_schema" } });
  });

  it("reserves hosted reasoning headroom without lowering a larger requested budget", async () => {
    const requests: HttpRequest[] = [];
    const transport: HttpTransport = async (request) => {
      requests.push(request);
      return respond(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }] });
    };
    const runtime = new GeminiRuntime("key", "gemini-flash-latest", transport);
    await runtime.generateStructured("story", {}, { numPredict: 600 });
    await runtime.generateStructured("story", {}, { numPredict: 8192 });
    expect(requests.map((request) => JSON.parse(request.body ?? "{}").generationConfig.maxOutputTokens)).toEqual([4096, 8192]);
  });

  it("marks a truncated reply as not done and reports a missing key as unavailable", async () => {
    const runtime = new OpenAICompatibleRuntime(config, async () => respond(200, { choices: [{ finish_reason: "length", message: { content: "{" } }] }));
    expect((await runtime.generateStructured("x", {})).done).toBe(false);
    const keyless = new OpenAICompatibleRuntime({ ...config, apiKey: null });
    expect((await keyless.health()).status).toBe("unavailable");
    await expect(keyless.generate("x")).rejects.toBeInstanceOf(ModelUnavailableError);
  });
  it("probes Gemini with countTokens so a retired model is unavailable", async () => {
    const requests: HttpRequest[] = [];
    const retired = new GeminiRuntime("key", "gemini-old", async (request) => { requests.push(request); return respond(404, {}); });
    expect(await retired.health()).toMatchObject({ status: "unavailable" });
    expect(requests[0].url).toMatch(/models\/gemini-old:countTokens$/);
  });

  it("reports a model the provider no longer offers as unavailable", async () => {
    const listed = new OpenAICompatibleRuntime(config, async () => respond(200, { data: [{ id: "other-model" }] }));
    expect(await listed.health()).toMatchObject({ status: "unavailable" });
    const offered = new OpenAICompatibleRuntime(config, async () => respond(200, { data: [{ id: "gpt-4.1-mini" }] }));
    expect((await offered.health()).status).toBe("ok");
  });
});

describe("fallback runtime", () => {
  it("retries the same call on the next provider and cools down the failed one", async () => {
    let clock = 0;
    const primary = stub("gemini", () => { throw new Error("503 overloaded"); });
    const backup = stub("openai", () => "written");
    const { records, log } = captureLog();
    const runtime = new FallbackRuntime([primary, backup], log, 60_000, () => clock);

    expect(await runtime.generate("story")).toBe("written");
    expect(await runtime.generate("story")).toBe("written");
    expect(primary.calls).toBe(1);
    expect(backup.calls).toBe(2);
    expect(records.map((record) => record.event)).toContain("model_fallback_served");

    clock = 61_000;
    await runtime.generate("story");
    expect(primary.calls).toBe(2);
  });

  it("fails clearly when every provider fails", async () => {
    const runtime = new FallbackRuntime([stub("a", () => { throw new Error("down"); }), stub("b", () => { throw new Error("401"); })], captureLog().log);
    await expect(runtime.generate("x")).rejects.toThrow(/All model providers failed: a: Error: down; b: Error: 401/);
  });

  it("reports degraded health when only a fallback is ready", async () => {
    const down = { ...stub("gemini", () => ""), health: async () => ({ status: "unavailable" as const, detail: "no key" }) };
    const health = await new FallbackRuntime([down, stub("openai", () => "")], captureLog().log).health();
    expect(health.status).toBe("degraded");
    expect(health.providers?.map((item) => item.status)).toEqual(["unavailable", "ok"]);
  });

  it("uses a single provider directly and a chain for several", () => {
    expect(createRuntime(loadSettings(env({}))).provider).toBe("ollama");
    const chain = createRuntime(loadSettings(env({ NEWSBEE_MODEL_PROVIDERS: "gemini,ollama" })));
    expect(chain.provider).toBe("gemini>ollama");
    expect(chain.model).toBe("gemini-flash-latest");
  });
});
