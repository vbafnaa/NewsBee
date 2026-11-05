import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { loadSettings, lightSettings } from "../../core/config";
import type { HttpTransport } from "../../core/http";
import { createRuntime, UsageRecordingRuntime, withModelUsageContext, type ModelCall, type ModelRuntime } from "../../model/runtime";
import { detailedModelUsage, modelPriceOverrides, mongoUsageSink, UNASSIGNED_USAGE } from "../../model/usage";

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;
const now = Date.parse("2026-10-27T12:00:00Z");
const DAY = 86400000;
const config = loadSettings({ NEWSBEE_MODE: "cloud", NEWSBEE_MODEL_PROVIDERS: "example", NEWSBEE_LLM_EXAMPLE_BASE_URL: "https://example.test/v1", NEWSBEE_LLM_EXAMPLE_MODEL: "writer", NEWSBEE_MODEL_EXAMPLE_INPUT_COST_PER_MTOK: "2", NEWSBEE_MODEL_EXAMPLE_OUTPUT_COST_PER_MTOK: "8" });
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("model-usage-tests"); });
beforeEach(async () => { await db.dropDatabase(); });
afterAll(async () => { await client?.close(); await server?.stop(); });

const call = (overrides: Partial<ModelCall> = {}): ModelCall => ({
  provider: "example", model: "writer", role: "writing", operation: "generate_structured", ok: true, status_code: null, rate_limited: false,
  input_tokens: 1000, output_tokens: 200, duration_ms: 1000, error: null, location_id: "town-wa", ...overrides,
});

describe("model usage aggregation", () => {
  it("reconciles model/location/role/day totals, counts fallbacks and leaves unknown costs unpriced", async () => {
    await db.collection<{ _id: string; name: string }>("locations").insertOne({ _id: "town-wa", name: "Town, WA" });
    const sink = mongoUsageSink(db, () => now - 1000);
    await sink(call());
    await sink(call({ ok: false, status_code: 429, rate_limited: true, input_tokens: null, output_tokens: null, error: "quota" }));
    await sink(call({ model: "other-model", location_id: "other-wa", role: "ranking", input_tokens: 500, output_tokens: 100 }));
    await sink(call({ location_id: undefined, input_tokens: 50, output_tokens: null }));
    await mongoUsageSink(db, () => now - 2 * DAY)(call({ input_tokens: 500, output_tokens: 50 }));
    await mongoUsageSink(db, () => now - 36 * DAY)(call());
    await mongoUsageSink(db, () => now + DAY)(call());
    const report = await detailedModelUsage(db, config.modelProviders, { days: 7 }, now);
    expect(report.totals).toMatchObject({ calls: 5, failures: 1, rate_limited: 1, input_tokens: 2050, output_tokens: 350, priced_calls: 2, unpriced_calls: 3, calls_with_tokens: 3, calls_without_tokens: 2 });
    expect(report.totals.estimated_cost_usd).toBeCloseTo(.005);
    expect(report.models.find((row) => row.model === "other-model")).toMatchObject({ pricing: null, estimated_cost_usd: null });
    expect(report.locations.find((row) => row.id === UNASSIGNED_USAGE)).toMatchObject({ name: "Unassigned / historical", calls: 1, attributed: false });
    for (const rows of [report.models, report.locations, report.roles, report.daily]) {
      expect(rows.reduce((sum, row) => sum + row.calls, 0)).toBe(5);
      expect(rows.reduce((sum, row) => sum + (row.estimated_cost_usd ?? 0), 0)).toBeCloseTo(.005);
    }
    expect(report.recent_failures[0]).toMatchObject({ location: "Town, WA", message: "quota", status_code: 429 });
    expect(JSON.stringify(report)).not.toMatch(/prompt|response/);
    const day = await detailedModelUsage(db, config.modelProviders, { days: 1, location: "town-wa" }, now);
    expect(day.totals).toMatchObject({ calls: 2, priced_calls: 1, failures: 1 });
    expect(day.location_options).toEqual(expect.arrayContaining([{ id: "other-wa", name: "other-wa" }]));
    const unassigned = await detailedModelUsage(db, config.modelProviders, { days: 7, location: UNASSIGNED_USAGE }, now);
    expect(unassigned.totals.calls).toBe(1);
    const empty = await detailedModelUsage(db, config.modelProviders, { days: 30, location: "no-activity" }, now);
    expect(empty.totals).toMatchObject({ calls: 0, estimated_cost_usd: null, average_duration_ms: null });
    expect(empty.daily).toHaveLength(31);
  });

  it("uses explicit per-model overrides, supports free models, and never assumes a missing price is zero", async () => {
    await mongoUsageSink(db, () => now)(call({ model: "historic-model" }));
    const prices = modelPriceOverrides('[{"provider":"example","model":"historic-model","input_per_mtok":0.1,"output_per_mtok":0.4}]');
    const report = await detailedModelUsage(db, config.modelProviders, { days: 1, prices }, now);
    expect(report.totals.estimated_cost_usd).toBeCloseTo(.00018);
    expect(report.totals.priced_calls).toBe(1);
    const free = await detailedModelUsage(db, config.modelProviders, { days: 1, prices: [{ ...prices[0], input_per_mtok: 0, output_per_mtok: 0 }] }, now);
    expect(free.totals.estimated_cost_usd).toBe(0);
    const partial = { ...config.modelProviders[0], model: "historic-model", usage: { ...config.modelProviders[0].usage, outputCostPerMTok: null } };
    expect((await detailedModelUsage(db, [partial], { days: 1 }, now)).totals.estimated_cost_usd).toBeNull();
    for (const value of ["not json", "{}", '[{"provider":"a","model":"b","input_per_mtok":-1,"output_per_mtok":0}]']) expect(() => modelPriceOverrides(value)).toThrow("Invalid NEWSBEE_MODEL_PRICING");
    expect(() => modelPriceOverrides(JSON.stringify([prices[0], prices[0]]))).toThrow("duplicate");
  });

  it("keeps light-model prices independent and matches Gemini's recorded provider identity", async () => {
    const settings = loadSettings({ NEWSBEE_MODE: "cloud", NEWSBEE_MODEL_GEMINI_INPUT_COST_PER_MTOK: "2", NEWSBEE_MODEL_GEMINI_OUTPUT_COST_PER_MTOK: "8" });
    expect(lightSettings(settings, {}).modelProviders[0].usage.inputCostPerMTok).toBeNull();
    const light = lightSettings(settings, { NEWSBEE_MODEL_GEMINI_LIGHT_INPUT_COST_PER_MTOK: ".1", NEWSBEE_MODEL_GEMINI_LIGHT_OUTPUT_COST_PER_MTOK: ".4" });
    expect(light.modelProviders[0].usage).toMatchObject({ inputCostPerMTok: .1, outputCostPerMTok: .4 });
    await mongoUsageSink(db, () => now)(call({ provider: "gemini", model: settings.lightModel, role: "extraction" }));
    expect((await detailedModelUsage(db, light.modelProviders, { days: 1 }, now)).totals.estimated_cost_usd).toBeCloseTo(.00018);
  });
});

describe("location-aware token recording", () => {
  it("captures tokens for plain generations from each provider, including Gemini reasoning", async () => {
    const events: ModelCall[] = [];
    for (const name of ["ollama", "gemini", "example"]) {
      const settings = loadSettings({
        NEWSBEE_MODE: "local", NEWSBEE_MODEL_PROVIDERS: name, NEWSBEE_OLLAMA_MODEL: "local-model",
        NEWSBEE_GEMINI_API_KEY: "test-key", NEWSBEE_LLM_EXAMPLE_MODEL: "writer", NEWSBEE_LLM_EXAMPLE_API_KEY: "test-key",
        NEWSBEE_LLM_EXAMPLE_BASE_URL: "https://example.test/v1",
      });
      const payload = name === "ollama" ? { response: "ok", done: true, prompt_eval_count: 10, eval_count: 3 }
        : name === "gemini" ? { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 2 } }
        : { choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 3 } };
      const transport: HttpTransport = async () => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(payload)), url: "http://fixture" });
      const runtime = createRuntime(settings, transport, undefined, { role: "discovery", sink: (event) => { events.push(event); } });
      expect(await withModelUsageContext({ location_id: "town-wa", run_id: "run-1" }, () => runtime.generate("not stored"))).toBe("ok");
    }
    expect(events).toHaveLength(3);
    for (const event of events) expect(event).toMatchObject({ input_tokens: 10, output_tokens: event.provider === "gemini" ? 5 : 3, location_id: "town-wa", run_id: "run-1", operation: "generate" });
    expect(JSON.stringify(events)).not.toContain("not stored");
  });

  it("isolates concurrent communities on a shared runtime and leaves unattributed calls unassigned", async () => {
    const events: ModelCall[] = [];
    const inner: ModelRuntime = {
      provider: "example", model: "writer", health: async () => ({ status: "ok", detail: "fixture" }),
      generate: async () => "ok",
      generateStructured: async (prompt) => { await new Promise((resolve) => setTimeout(resolve, prompt === "first" ? 10 : 1)); return { response: "ok", done: true, prompt_eval_count: 5, eval_count: 2 }; },
    };
    const runtime = new UsageRecordingRuntime(inner, { role: "writing", sink: (event) => { events.push(event); } });
    await Promise.all([
      withModelUsageContext({ location_id: "first-wa", run_id: "first" }, () => runtime.generateStructured("first", {})),
      withModelUsageContext({ location_id: "second-wa", run_id: "second" }, () => runtime.generateStructured("second", {})),
    ]);
    await runtime.generate("no context");
    expect(events[0]).toMatchObject({ location_id: "second-wa", run_id: "second" });
    expect(events[1]).toMatchObject({ location_id: "first-wa", run_id: "first" });
    expect(events[2].location_id).toBeUndefined();
  });

  it("keeps location context and token metadata on each failed and successful fallback attempt", async () => {
    const events: ModelCall[] = [];
    const settings = loadSettings({
      NEWSBEE_MODE: "cloud", NEWSBEE_MODEL_PROVIDERS: "gemini,example", NEWSBEE_GEMINI_API_KEY: "test-key",
      NEWSBEE_LLM_EXAMPLE_BASE_URL: "https://example.test/v1", NEWSBEE_LLM_EXAMPLE_MODEL: "writer", NEWSBEE_LLM_EXAMPLE_API_KEY: "test-key",
    });
    const transport: HttpTransport = async (request) => ({
      status: request.url.includes("googleapis") ? 429 : 200, headers: {},
      body: new TextEncoder().encode(JSON.stringify(request.url.includes("googleapis") ? { error: "quota" } : { choices: [{ message: { content: "fallback" } }], usage: { prompt_tokens: 7, completion_tokens: 4 } })),
      url: request.url,
    });
    const runtime = createRuntime(settings, transport, undefined, { role: "writing", sink: (event) => { events.push(event); } });
    expect(await withModelUsageContext({ location_id: "town-wa", run_id: "run-1" }, () => runtime.generate("not stored"))).toBe("fallback");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ provider: "gemini", location_id: "town-wa", run_id: "run-1", ok: false, rate_limited: true });
    expect(events[1]).toMatchObject({ provider: "example", location_id: "town-wa", run_id: "run-1", ok: true, input_tokens: 7, output_tokens: 4 });
  });
});
