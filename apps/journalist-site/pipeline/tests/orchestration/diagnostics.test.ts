import { describe, expect, it } from "vitest";
import { loadSettings, runTimeoutSeconds, type ProviderConfig } from "../../core/config";
import { UsageRecordingRuntime, type ModelCall } from "../../model/runtime";
import { mongoUsageSink, modelUsageSummary } from "../../model/usage";
import { diagnoseRun, diagnoseRuns, expireOverdueRuns } from "../../orchestration/diagnostics";
import { healthSummary } from "../../orchestration/health";
import { claim, enqueue, ensureJobIndexes, runJobs } from "../../orchestration/jobs";
import { ensureRunIndexes, getRun, runs, type PipelineRun } from "../../orchestration/runs";
import { describeInternalFailure, markDispatch, recordScheduler, schedulerState } from "../../orchestration/scheduler";
import { COLLECTIONS } from "../../storage/mongo";
import { FakeModel } from "../support/fake-model";
import { withMongo } from "../support/mongo";

const env = (values: Record<string, string>) => ({ NEWSBEE_ROOT: "/tmp/newsbee", ...values }) as unknown as NodeJS.ProcessEnv;
const now = () => Date.now() / 1000;

function run(overrides: Partial<PipelineRun> = {}): PipelineRun {
  const created = now() - 600;
  return {
    _id: `run-${Math.random().toString(36).slice(2)}`,
    location_id: "kent",
    location_name: "Kent",
    trigger: { by: "admin", kind: "manual" },
    status: "collecting",
    today: "2026-01-01",
    window: ["2026-01-01", "2026-01-08"],
    sources: [{ source_id: "library", name: "Kent Library", type: "library", job_id: null, status: "pending", result_status: null, detail: null, event_count: 0, shortlisted: 0, link_discovery: null, error: null }],
    draft_id: null,
    edition_id: null,
    published: null,
    error: null,
    created_at: created,
    updated_at: created,
    authoring_started_at: null,
    completed_at: null,
    ...overrides,
  };
}

describe("run timeout and usage configuration", () => {
  it("defaults to a 60 minute run timeout, accepts overrides and 0 disables it", () => {
    expect(runTimeoutSeconds(env({}))).toBe(3600);
    expect(runTimeoutSeconds(env({ NEWSBEE_RUN_TIMEOUT_MINUTES: "15" }))).toBe(900);
    expect(runTimeoutSeconds(env({ NEWSBEE_RUN_TIMEOUT_MINUTES: "0" }))).toBeNull();
    expect(() => runTimeoutSeconds(env({ NEWSBEE_RUN_TIMEOUT_MINUTES: "-1" }))).toThrow();
  });

  it("reads per-provider pricing and request limits", () => {
    const settings = loadSettings(env({
      NEWSBEE_MODEL_PROVIDERS: "gemini",
      NEWSBEE_MODEL_GEMINI_INPUT_COST_PER_MTOK: "0.3",
      NEWSBEE_MODEL_GEMINI_OUTPUT_COST_PER_MTOK: "2.5",
      NEWSBEE_MODEL_GEMINI_RPM_LIMIT: "10",
      NEWSBEE_MODEL_GEMINI_RPD_LIMIT: "0",
    }));
    expect(settings.modelProviders[0].usage).toEqual({ inputCostPerMTok: 0.3, outputCostPerMTok: 2.5, requestsPerMinute: 10, requestsPerDay: null });
  });
});

describe("run diagnostics", () => {
  const mongo = withMongo();

  it("explains that the scheduler is not running when queued work is waiting", async () => {
    const active = run();
    await runs(mongo.db).insertOne(active);
    await enqueue(mongo.db, { kind: "collect_source", run_id: active._id, location_id: "kent", payload: { task: { source_id: "library" } } });
    await mongo.db.collection(COLLECTIONS.jobs).updateMany({}, { $set: { available_at: now() - 300 } });
    const diagnostics = (await diagnoseRuns(mongo.db, [active], 3600)).get(active._id)!;
    expect(diagnostics.issues[0]).toMatchObject({ code: "scheduler_not_running", severity: "failed" });
    expect(diagnostics.issues[0].message).toMatch(/has never run.*\/api\/pipeline\/tick/);
    expect(diagnostics.deadline_at).toBeCloseTo(active.created_at + 3600);
    expect(diagnostics.issues.some((issue) => issue.code === "deadline")).toBe(true);
  });

  it("reports a failed worker dispatch for the named source and clears it after a later success", async () => {
    const active = run();
    await runs(mongo.db).insertOne(active);
    const jobId = await enqueue(mongo.db, { kind: "collect_source", run_id: active._id, location_id: "kent", payload: { task: { source_id: "library" } } });
    await recordScheduler(mongo.db, "tick", null);
    await mongo.db.collection(COLLECTIONS.heartbeat).updateOne({ _id: "scheduler" as never }, { $set: { last_tick_at: now() } });
    const failure = describeInternalFailure("Source worker", 401, "<html>Authentication Required</html>");
    expect(failure).toMatch(/Deployment Protection/);
    await markDispatch(mongo.db, jobId, failure, now() - 1);
    let diagnostics = (await diagnoseRuns(mongo.db, [active], 3600)).get(active._id)!;
    expect(diagnostics.issues[0]).toMatchObject({ code: "dispatch_failed", severity: "failed" });
    expect(diagnostics.issues[0].message).toMatch(/source "Kent Library".*Deployment Protection/);

    await markDispatch(mongo.db, jobId, null);
    diagnostics = (await diagnoseRuns(mongo.db, [active], 3600)).get(active._id)!;
    expect(diagnostics.issues.some((issue) => issue.code === "dispatch_failed")).toBe(false);
  });

  it("surfaces scheduler channel errors until a later success", async () => {
    await recordScheduler(mongo.db, "kick", "Scheduler rejected the request (401): CRON_SECRET does not match", now() - 10);
    expect((await schedulerState(mongo.db)).issues.map((issue) => issue.channel)).toEqual(["kick"]);
    await recordScheduler(mongo.db, "kick", null);
    expect((await schedulerState(mongo.db)).issues).toEqual([]);
  });

  it("flags an authoring run with no remaining work", () => {
    const stuck = run({ status: "publishing", updated_at: now() - 600 });
    const result = diagnoseRun(stuck, [], { last_tick_at: now(), last_tick_finished_at: now(), seconds_since_tick: 0, status: "ok", issues: [] }, null);
    expect(result.issues[0]).toMatchObject({ code: "no_active_work", severity: "failed" });
    expect(result.deadline_at).toBeNull();
  });
});

describe("run timeout expiry", () => {
  const mongo = withMongo();

  it("fails an overdue run with the stall reason, cancels its queued jobs, and frees the location", async () => {
    await ensureRunIndexes(mongo.db);
    await ensureJobIndexes(mongo.db);
    const stale = run({ created_at: now() - 7200, updated_at: now() - 7200 });
    await runs(mongo.db).insertOne(stale);
    await enqueue(mongo.db, { kind: "collect_source", run_id: stale._id, location_id: "kent", payload: { task: { source_id: "library" } } });
    await mongo.db.collection(COLLECTIONS.jobs).updateMany({}, { $set: { available_at: now() - 7000 } });

    expect(await expireOverdueRuns(mongo.db, null)).toEqual([]);
    const expired = await expireOverdueRuns(mongo.db, 3600);
    expect(expired.map((item) => item._id)).toEqual([stale._id]);
    const failed = await getRun(mongo.db, stale._id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/^Timed out after 60 min while collecting\. Scheduler is not running/);
    expect((await runJobs(mongo.db, stale._id)).map((job) => job.status)).toEqual(["cancelled"]);
    await runs(mongo.db).insertOne(run({ _id: "fresh" }));
  });

  it("leaves an overdue publishing run alone while its worker holds a live lease", async () => {
    const publishing = run({ status: "publishing", created_at: now() - 7200 });
    await runs(mongo.db).insertOne(publishing);
    await enqueue(mongo.db, { kind: "author_finish", run_id: publishing._id, location_id: "kent" });
    await claim(mongo.db);
    expect(await expireOverdueRuns(mongo.db, 3600)).toEqual([]);
    expect((await getRun(mongo.db, publishing._id))?.status).toBe("publishing");

    await mongo.db.collection(COLLECTIONS.jobs).updateMany({}, { $set: { lease_until: now() - 1 } });
    expect((await expireOverdueRuns(mongo.db, 3600)).map((item) => item._id)).toEqual([publishing._id]);
  });

  it("marks a stalled location as failed in the health summary", async () => {
    await mongo.db.collection(COLLECTIONS.locations).insertOne({ id: "kent", name: "Kent" });
    const active = run();
    await runs(mongo.db).insertOne(active);
    await enqueue(mongo.db, { kind: "collect_source", run_id: active._id, location_id: "kent", payload: { task: { source_id: "library" } } });
    await mongo.db.collection(COLLECTIONS.jobs).updateMany({}, { $set: { available_at: now() - 300 } });
    const summary = await healthSummary(mongo.db, new FakeModel(() => "ok"), { runTimeoutSeconds: 3600, modelProviders: [] });
    expect(summary.status).toBe("failed");
    expect(summary.run_timeout_seconds).toBe(3600);
    const row = summary.locations.find((item) => item.location_id === "kent");
    expect(row?.level).toBe("failed");
    expect(row?.diagnostics?.issues[0].code).toBe("scheduler_not_running");
  });
});

describe("model usage", () => {
  const mongo = withMongo();

  it("records tokens including Gemini thinking tokens, and rate-limited failures", async () => {
    const calls: ModelCall[] = [];
    let attempt = 0;
    const inner = new FakeModel(() => "{}", "gemini-flash");
    inner.generateStructured = async () => {
      attempt += 1;
      if (attempt === 2) throw new Error("Model request failed (429): RESOURCE_EXHAUSTED");
      return { response: "{}", done: true, done_reason: "stop", prompt_eval_count: 1000, eval_count: 200, thinking_eval_count: 50 };
    };
    const runtime = new UsageRecordingRuntime(inner, { role: "writing", sink: (call) => { calls.push(call); } });
    await runtime.generateStructured("p", {});
    await expect(runtime.generateStructured("p", {})).rejects.toThrow(/429/);
    expect(calls[0]).toMatchObject({ provider: "fake", model: "gemini-flash", role: "writing", ok: true, input_tokens: 1000, output_tokens: 250 });
    expect(calls[1]).toMatchObject({ ok: false, status_code: 429, rate_limited: true, input_tokens: null });
  });

  it("never lets a usage-store failure break generation", async () => {
    const runtime = new UsageRecordingRuntime(new FakeModel(() => "{}"), { role: "ranking", sink: () => { throw new Error("db down"); } });
    await expect(runtime.generateStructured("p", {})).resolves.toMatchObject({ response: "{}" });
  });

  it("summarises cost, peak rate and limit warnings per provider", async () => {
    const sink = mongoUsageSink(mongo.db);
    const base = { provider: "gemini", model: "gemini-flash", operation: "generate_structured" as const, status_code: null, rate_limited: false, duration_ms: 1000, error: null };
    for (let index = 0; index < 9; index += 1) {
      await sink({ ...base, role: index % 3 ? "writing" : "ranking", ok: true, input_tokens: 100_000, output_tokens: 10_000 });
    }
    await sink({ ...base, role: "writing", ok: false, status_code: 429, rate_limited: true, input_tokens: null, output_tokens: null, error: "Model request failed (429)" });
    const providers: ProviderConfig[] = [{
      name: "gemini", kind: "gemini", apiKey: "k", model: "gemini-flash", baseUrl: "",
      usage: { inputCostPerMTok: 0.3, outputCostPerMTok: 2.5, requestsPerMinute: 10, requestsPerDay: 1000 },
    } as ProviderConfig];
    const summary = await modelUsageSummary(mongo.db, providers);
    const row = summary.providers[0];
    expect(row.last_24h).toMatchObject({ calls: 10, failures: 1, rate_limited: 1, input_tokens: 900_000, output_tokens: 90_000 });
    expect(row.last_24h.estimated_cost_usd).toBeCloseTo(0.9 * 0.3 + 0.09 * 2.5);
    expect(row.roles.map((role) => [role.role, role.calls])).toEqual([["ranking", 3], ["writing", 7]]);
    expect(row.peak_requests_per_minute).toBeGreaterThanOrEqual(1);
    expect(row.last_error).toMatchObject({ status_code: 429 });
    expect(row.warnings.join(" ")).toMatch(/rate-limited/);
    expect(summary.totals.last_7d.estimated_cost_usd).toBeCloseTo(row.last_7d.estimated_cost_usd!);
    expect(summary.pricing_configured).toBe(true);
  });
});
