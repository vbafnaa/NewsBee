import { expect, it, vi } from "vitest";
import { GeminiRuntime, OllamaRuntime, OpenAICompatibleRuntime, FallbackRuntime, UsageRecordingRuntime, type ModelRuntime } from "../../model/runtime";
import type { HttpRequest } from "../../core/http";
import { loadSettings } from "../../core/config";

const images = [{ id: "candidate-1", mimeType: "image/jpeg" as const, data: Buffer.from("image fixture").toString("base64") }];
const schema = { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] };
const respond = (body: unknown) => ({ status: 200, url: "", headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });

it("sends image content parts and usage through an explicitly capable compatible provider", async () => {
  const config = loadSettings({ NEWSBEE_MODEL_PROVIDERS: "openai", NEWSBEE_LLM_OPENAI_MODEL: "fixture-vision", NEWSBEE_LLM_OPENAI_API_KEY: "fixture-key", NEWSBEE_LLM_OPENAI_VISION: "true" }).modelProviders[0];
  const transport = vi.fn(async (_request: HttpRequest) => respond({ choices: [{ message: { content: '{"approved":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 1234, completion_tokens: 20 } }));
  const sink = vi.fn(); const runtime = new UsageRecordingRuntime(new OpenAICompatibleRuntime(config, transport), { role: "agent", sink });
  // Outside a run the new agent service stays off, so exercise wire format on the adapter directly.
  const direct = new OpenAICompatibleRuntime(config, transport);
  expect(direct.supportsVision).toBe(true);
  const value = await direct.generateVisionStructured("Inspect this photo", images, schema);
  expect(value).toMatchObject({ done: true, prompt_eval_count: 1234 });
  const body = JSON.parse(transport.mock.calls[0][0]?.body ?? "{}");
  expect(body.messages[0].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${images[0].data}`, detail: "high" } })]));
  expect(transport.mock.calls[0][0]?.timeoutMs).toBe(25000);
  await expect(runtime.generateVisionStructured("Inspect", images, schema)).rejects.toThrow("not ticked");
  expect(transport).toHaveBeenCalledTimes(1); expect(sink).not.toHaveBeenCalled();
});

it("requires explicit capability for compatible and local providers", async () => {
  const config = loadSettings({ NEWSBEE_MODEL_PROVIDERS: "openai", NEWSBEE_LLM_OPENAI_MODEL: "text-model", NEWSBEE_LLM_OPENAI_API_KEY: "fixture" }).modelProviders[0];
  const transport = vi.fn();
  await expect(new OpenAICompatibleRuntime(config, transport).generateVisionStructured("Inspect", images, schema)).rejects.toThrow("capability");
  await expect(new OllamaRuntime("http://127.0.0.1:11434", "text-model", transport).generateVisionStructured("Inspect", images, schema)).rejects.toThrow("capability");
  expect(transport).not.toHaveBeenCalled();
});

it("uses Gemini inline image data and returns actual image-inclusive token counts", async () => {
  const transport = vi.fn(async (_request: HttpRequest) => respond({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"approved":true}' }] } }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 30 } }));
  const result = await new GeminiRuntime("fixture", "fixture-vision", transport).generateVisionStructured("Inspect", images, schema);
  const body = JSON.parse(transport.mock.calls[0][0]?.body ?? "{}");
  expect(body.contents[0].parts).toContainEqual({ inlineData: { mimeType: "image/jpeg", data: images[0].data } });
  expect(body.generationConfig.responseMimeType).toBe("application/json");
  expect(result.prompt_eval_count).toBe(1200);
});

it("uses local chat image inputs with structured output and never falls back to text-only inspection", async () => {
  const transport = vi.fn(async (_request: HttpRequest) => respond({ message: { content: '{"approved":true}' }, done: true, prompt_eval_count: 100, eval_count: 10 }));
  const vision = new OllamaRuntime("http://127.0.0.1:11434", "fixture-vision", transport, true);
  const text: ModelRuntime = { provider: "text", model: "text-model", generate: vi.fn(), generateStructured: vi.fn(), health: async () => ({ status: "ok", detail: "" }) };
  const fallback = new FallbackRuntime([text, vision]);
  expect(fallback.supportsVision).toBe(true);
  expect(await fallback.generateVisionStructured("Inspect", images, schema, { timeoutMs: 120000, keepAlive: "5m" })).toMatchObject({ response: '{"approved":true}' });
  expect(text.generateStructured).not.toHaveBeenCalled();
  const body = JSON.parse(transport.mock.calls[0][0]?.body ?? "{}");
  expect(body.messages[0].images).toEqual([images[0].data]); expect(body.format).toEqual(schema);
  expect(transport.mock.calls[0][0]?.url).toMatch(/\/api\/chat$/);
  expect(transport.mock.calls[0][0]?.timeoutMs).toBe(120000);
  expect(body.keep_alive).toBe("5m");
});

it("keeps a vision model's text planning on the chat adapter and preserves truncation", async () => {
  const transport = vi.fn(async (_request: HttpRequest) => respond({ message: { content: '{"approved":' }, done: true, done_reason: "length" }));
  const runtime = new OllamaRuntime("http://127.0.0.1:11434", "fixture-vision", transport, true);
  expect(await runtime.generateStructured("Plan a photo search", schema, { timeoutMs: 120000, keepAlive: "5m" })).toMatchObject({ done_reason: "length" });
  expect(transport.mock.calls[0][0]?.url).toMatch(/\/api\/chat$/);
  const body = JSON.parse(transport.mock.calls[0][0]?.body ?? "{}");
  expect(body.messages).toEqual([{ role: "user", content: "Plan a photo search" }]);
  expect(body.options.num_ctx).toBe(8192);
});
