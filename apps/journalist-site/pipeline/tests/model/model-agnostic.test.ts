import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { lightSettings, loadSettings } from "../../core/config";
import { defaultRunOptions, paidAllowance, resolveRunOptions } from "../../core/run-options";
import { groundedModel } from "../../model/budget";
import { detailedModelUsage, modelUsageSummary, mongoUsageSink } from "../../model/usage";
import type { ModelCall } from "../../model/runtime";
import { modelLimit, modelService } from "../../trace/gateway";

const env = (values: Record<string, string>) => ({ NEWSBEE_MODE: "cloud", ...values }) as unknown as NodeJS.ProcessEnv;
const openai = { NEWSBEE_LLM_OPENAI_MODEL: "gpt-main" };

describe("light models follow the configured order, on any provider", () => {
  it("gives a non-Gemini provider its own light model, and never a Gemini one", () => {
    const settings = loadSettings(env({ NEWSBEE_MODEL_PROVIDERS: "openai,gemini", ...openai, NEWSBEE_LLM_OPENAI_LIGHT_MODEL: "gpt-mini" }));
    expect(lightSettings(settings).modelProviders.map(({ name, model }) => `${name}:${model}`))
      .toEqual(["openai_light:gpt-mini", "openai:gpt-main", "gemini_light:gemini-flash-lite-latest", "gemini:gemini-flash-latest"]);
    const plain = loadSettings(env({ NEWSBEE_MODEL_PROVIDERS: "openai", ...openai }));
    expect(lightSettings(plain)).toBe(plain);
    // A personal profile's Gemini light-model default only ever applies to Gemini providers.
    expect(lightSettings({ ...plain, lightModel: "gemini-flash-lite-latest" }).modelProviders.map(({ model }) => model)).toEqual(["gpt-main"]);
  });
});

describe("one model budget, whichever provider serves the call", () => {
  it("bills every hosted model to the model budget, and only Gemini calls to Gemini's own limits", () => {
    expect(modelService("gemini", "writing")).toBe("model");
    expect(modelService("openai", "extraction")).toBe("model");
    expect(modelService("ollama", "writing")).toBeNull();
    expect(modelService("openai", "agent")).toBe("agent_model");
    expect(modelLimit("gemini", "model")).toBe("gemini");
    expect(modelLimit("groq", "model")).toBe("model");
  });
  it("reads the old Gemini and OpenAI-compatible budgets as the model budget", () => {
    expect(resolveRunOptions({ paid: { gemini: 10, openai_compatible: 30 } }).paid).toEqual({ model: 30 });
    expect(defaultRunOptions({ NEWSBEE_PAID_ALLOW: "gemini,tavily", NEWSBEE_PAID_BUDGETS: "gemini:50" } as unknown as NodeJS.ProcessEnv).paid).toMatchObject({ model: 50, tavily: 60 });
    expect(paidAllowance({ gemini: 10, openai_compatible: 40 }, "model")).toBe(40);
    expect(paidAllowance({ model: 5, gemini: 10 }, "model")).toBe(5);
    expect(paidAllowance({}, "model")).toBeUndefined();
  });
});

describe("web-grounded search uses the first configured model that can search the web", () => {
  it("passes over models without grounded search, and is off when none can", () => {
    const both = loadSettings(env({ NEWSBEE_MODEL_PROVIDERS: "openai,gemini", ...openai, NEWSBEE_GEMINI_API_KEY: "fixture-key", NEWSBEE_LLM_OPENAI_API_KEY: "fixture-key" }));
    expect(groundedModel(both)).toMatchObject({ provider: { name: "gemini" }, model: "gemini-flash-lite-latest" });
    expect(groundedModel(loadSettings(env({ NEWSBEE_MODEL_PROVIDERS: "openai", ...openai, NEWSBEE_LLM_OPENAI_API_KEY: "fixture-key" })))).toBeNull();
  });
});

describe("usage by person and run", () => {
  let server: MongoMemoryServer, client: MongoClient, db: Db;
  const now = Date.parse("2026-11-08T12:00:00Z");
  beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("model-agnostic-usage"); });
  beforeEach(async () => { await db.dropDatabase(); });
  afterAll(async () => { await client?.close(); await server?.stop(); });
  const call = (overrides: Partial<ModelCall>): ModelCall => ({
    provider: "gemini", model: "gemini-flash-lite-latest", role: "discovery", operation: "generate_structured", ok: true, status_code: null, rate_limited: false,
    input_tokens: 100, output_tokens: 10, duration_ms: 500, error: null, location_id: "town-wa", ...overrides,
  });

  it("shows which models each run used and whose keys they were on, even when people use different providers", async () => {
    await db.collection<{ _id: string }>("pipeline_runs").insertMany([
      { _id: "run-a", kind: "map", location_id: "town-wa", location_name: "Town, WA", status: "mapped", created_at: now / 1000 - 600, execution: { sponsorId: "owner", sponsorEmail: "owner@example.test", source: "environment" } },
      { _id: "run-b", kind: "edition", location_id: "town-wa", location_name: "Town, WA", status: "published", created_at: now / 1000 - 300, execution: { sponsorId: "editor", sponsorEmail: "editor@example.test", source: "personal" } },
    ] as never);
    const sink = mongoUsageSink(db, () => now - 1000);
    await sink(call({ run_id: "run-a", sponsor_id: "owner" }));
    await sink(call({ run_id: "run-a", sponsor_id: "owner", model: "gemini-flash-latest", role: "writing" }));
    await sink(call({ run_id: "run-b", sponsor_id: "editor", provider: "openai", model: "gpt-main", role: "writing" }));
    await sink(call({ run_id: "run-b", sponsor_id: "editor", provider: "openai", model: "gpt-main", ok: false, error: "quota", input_tokens: null, output_tokens: null }));
    await sink(call({ provider: "openai", model: "gpt-main", role: "discovery" }));
    const report = await detailedModelUsage(db, [], { days: 1 }, now);
    expect(report.people.map((row) => [row.email, row.runs, row.calls, row.models.map((model) => model.model).sort()])).toEqual([
      ["editor@example.test", 1, 2, ["gpt-main"]],
      ["owner@example.test", 1, 2, ["gemini-flash-latest", "gemini-flash-lite-latest"]],
    ]);
    expect(report.runs.map((row) => [row.run_id, row.started_by, row.credential_source, row.kind, row.calls, row.failures])).toEqual([
      ["run-b", "editor@example.test", "personal", "edition", 2, 1],
      ["run-a", "owner@example.test", "environment", "map", 2, 0],
    ]);
    expect(report.runs[0].models).toEqual([{ provider: "openai", model: "gpt-main", calls: 2, failures: 1 }]);
    // A call outside any run counts in the totals, not against a person.
    expect(report.totals.calls).toBe(5);
    const health = await modelUsageSummary(db, [], now);
    expect(health.runs.map((row) => row.run_id)).toEqual(["run-b", "run-a"]);
  });
});
