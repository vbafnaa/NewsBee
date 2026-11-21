import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { infrastructureSettings, safeManagedHealthSettings } from "../../accounts/execution";
import { loadSettings } from "../../core/config";
import type { ModelRuntime } from "../../model/runtime";
import { healthSummary } from "../../orchestration/health";
import type { PipelineRun } from "../../orchestration/runs";
import { COLLECTIONS } from "../../storage/mongo";

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;
const deployment = loadSettings({
  NEWSBEE_MODE: "cloud", NEWSBEE_MODEL_PROVIDERS: "example",
  NEWSBEE_LLM_EXAMPLE_API_KEY: "private-provider-key", NEWSBEE_LLM_EXAMPLE_BASE_URL: "https://private-endpoint.example/v1",
  NEWSBEE_LLM_EXAMPLE_MODEL: "writer", NEWSBEE_MODEL_DAILY_CALLS: "25",
  NEWSBEE_TAVILY_API_KEY: "private-search-key",
  NEWSBEE_MODEL_EXAMPLE_INPUT_COST_PER_MTOK: "2", NEWSBEE_MODEL_EXAMPLE_OUTPUT_COST_PER_MTOK: "8",
});
const settings = safeManagedHealthSettings({ runTimeoutSeconds: null }, deployment);
const noProbe = vi.fn(async () => { throw new Error("Health must not call a provider"); });
const runtime: ModelRuntime = { provider: "example", model: "writer", health: noProbe, generate: noProbe, generateStructured: noProbe };

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("health-evidence");
});
beforeEach(async () => { await db.dropDatabase(); noProbe.mockClear(); });
afterAll(async () => { await client?.close(); await server?.stop(); vi.unstubAllEnvs(); });

describe("managed configuration and recorded health", () => {
  it("projects deployment flags without keys, endpoints, funding bindings, probes or quota writes", async () => {
    const report = await healthSummary(db, runtime, settings);
    expect(report.model).toMatchObject({ scope: "managed_platform", status: "configured", live_tested: false });
    expect(report.model.providers[0]).toMatchObject({ name: "example", model: "writer", configured: true, pricing: { input_per_mtok: 2, output_per_mtok: 8 } });
    expect(report.model_budget).toMatchObject({ scope: "managed_platform", used: 0, cap: 25, remaining: 25 });
    expect(report.configuration.wiring).toMatchObject({ queue_consumer_route_wired: true, automatic_scheduling_enabled: false });
    expect(report.observations).toMatchObject({ live_probes_performed: false, last_consumer_delivery_at: null });
    expect(JSON.stringify({ settings, report })).not.toMatch(/private-provider-key|private-search-key|private-endpoint|baseUrl|apiKey|modelFunding/);
    expect(noProbe).not.toHaveBeenCalled();
    expect(await db.collection("run_budgets").countDocuments()).toBe(0);
    expect(await db.collection(COLLECTIONS.modelUsage).countDocuments()).toBe(0);
  });

  it("does not mistake an inert or healthy runtime for managed configuration", async () => {
    const empty = safeManagedHealthSettings({ runTimeoutSeconds: null }, loadSettings({ NEWSBEE_MODE: "cloud" }));
    const report = await healthSummary(db, runtime, empty);
    expect(report.model.status).toBe("not_configured");
    expect(report.status).toBe("failed");
    expect(noProbe).not.toHaveBeenCalled();
  });

  it("drops unsafe labels and server-only funding metadata from configuration", () => {
    const projected = safeManagedHealthSettings({ runTimeoutSeconds: null }, {
      ...deployment,
      modelFunding: { source: "platform", initiatorId: "private-initiator", credentialVersion: 3 },
      modelProviders: [{ ...deployment.modelProviders[0], model: "https://private-model-endpoint.example/infer" }],
    });
    expect(projected.modelProviders[0]).toMatchObject({ model: null, configured: false });
    expect(JSON.stringify(projected)).not.toMatch(/https:|private-|modelFunding|initiatorId|credentialVersion/);
  });

  it("keeps operational caps while stripping infrastructure credentials", () => {
    vi.stubEnv("NEWSBEE_MODEL_DAILY_CALLS", "37");
    vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "not-an-infrastructure-key");
    const infra = infrastructureSettings();
    expect(infra.modelDailyCalls).toBe(37);
    expect(infra.modelProviders.every((provider) => provider.apiKey === null)).toBe(true);
    vi.unstubAllEnvs();
  });

  it("separates declared queue wiring from recorded delivery and unresolved kick errors", async () => {
    const at = Date.now() / 1000;
    await db.collection<{ _id: string; [key: string]: unknown }>(COLLECTIONS.heartbeat).insertOne({
      _id: "scheduler", last_tick_at: at, last_queue_at: at - 5, kick_error_at: at, kick_error: "Queue refused the kick",
    });
    const report = await healthSummary(db, runtime, settings);
    expect(report.configuration.wiring?.queue_consumer_route_wired).toBe(true);
    expect(report.observations.last_consumer_delivery_at).toBe(at - 5);
    expect(report.observations.scheduler_issues).toEqual([expect.objectContaining({ channel: "kick" })]);
    expect(report.status).toBe("warning");
    expect(noProbe).not.toHaveBeenCalled();
  });

  it("reports each real successful stage rather than the newest failed attempt or a built draft's publish placeholder", async () => {
    await db.collection<{ _id: string; id: string; name: string; systems: never[] }>(COLLECTIONS.locations)
      .insertOne({ _id: "town", id: "town", name: "Town", systems: [] });
    await db.collection<Partial<PipelineRun> & { _id: string }>(COLLECTIONS.runs).insertMany([
      { _id: "mapped", location_id: "town", kind: "map", status: "mapped", created_at: 10, completed_at: 20, sources: [] },
      { _id: "isolated-map", location_id: "town", kind: "map", isolated: true, status: "mapped", created_at: 30, completed_at: 40, sources: [] },
      { _id: "new-failure", location_id: "town", status: "failed", created_at: 800, completed_at: 900, sources: [] },
    ]);
    await db.collection(COLLECTIONS.editions).insertMany([
      { id: "old", location_id: "town", status: "published", built_at: 100, published_at: 200, withdrawn: true },
      { id: "new", location_id: "town", status: "built", built_at: 700, published_at: 750 },
    ]);
    await db.collection(COLLECTIONS.publicationDrafts).insertMany([
      { publication_id: "paper", created_at: 300, release: { published_at: 400, manifest_revision: 1 } },
      { publication_id: "paper", created_at: 500, release: { published_at: 600 } },
      { publication_id: "paper", created_at: 800 },
    ]);
    await db.collection<{ _id: string; reader_publication: object }>(COLLECTIONS.outputChannels).insertOne({
      _id: "paper", reader_publication: { manifest_revision: 2, latest_release_id: null, latest_published_at: null },
    });
    const report = await healthSummary(db, runtime, settings);
    expect(report.locations[0]).toMatchObject({ run_id: "new-failure", stage: "failed" });
    expect(report.freshness).toEqual([{
      location_id: "town", mapped_at: 20, built_at: 700, published_at: 200, live_published_at: null, availability: "historical_only",
    }]);
    expect(report.publication_freshness).toEqual([{
      publication_id: "paper", built_at: 800, published_at: 400, live_published_at: null, availability: "withdrawn",
    }]);
    await db.collection(COLLECTIONS.editions).updateOne({ id: "new" }, { $set: { status: "published", published_at: 950 } });
    expect((await healthSummary(db, runtime, settings)).freshness[0]).toMatchObject({ published_at: 950, live_published_at: 950, availability: "live" });
  });
});
