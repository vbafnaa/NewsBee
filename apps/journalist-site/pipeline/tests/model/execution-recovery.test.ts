import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ExecutionDeadline, executionTimeout, executionWait, withExecutionDeadline } from "../../core/execution-deadline";
import { ExecutionBlocked } from "../../core/execution-errors";
import { rank, type Candidate } from "../../model/newsworthiness";
import { MODEL_RECEIPTS, receiptRuntime } from "../../model/receipts";
import { FallbackRuntime, ModelOutcomeUncertain, ModelRateLimitError, OpenAICompatibleRuntime } from "../../model/runtime";
import { refineRanking } from "../../ranking/edition-ranker";
import { FakeModel } from "../support/fake-model";
import { HARD_LIMITS, paceService } from "../../trace/gateway";
import { defaultRunOptions, withRunContext } from "../../core/run-options";

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("execution-recovery");
});
beforeEach(async () => { await db.dropDatabase(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await client?.close(); await server?.stop(); });

it.each([30, 60])("resumes %i candidates and editor ordering without replaying recorded paid batches", async count => {
  let clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const values: Candidate[] = Array.from({ length: count }, (_, i) => ({
    id: `${i}`, title: `Town news ${i}`, occurrences: 1, venues: [], first_date: "2026-11-18",
  }));
  const model = new FakeModel(({ prompt, options }) => {
    expect(options!.timeoutMs).toBeGreaterThanOrEqual(90_000);
    clock += 90_000;
    const batch = JSON.parse(prompt.split("Candidates:\n")[1]) as Array<{ id: string }>;
    return prompt.includes("EditorOrder") ? { order: batch.map(item => item.id) }
      : { ratings: batch.map(item => ({ id: item.id, category: "other", civic: 2, appeal: 1, special: 0 })) };
  });
  const work = () => withExecutionDeadline(clock + 285_000, async () => {
    const runtime = receiptRuntime(db, model, `run-${count}:section:policy-v1`);
    const [rated] = await rank(runtime, values);
    return refineRanking(db, runtime, rated, {
      runId: "run:section", locationId: "loc", community: "Town",
      sourceTypes: new Map(), sourceIds: new Map(),
      evidence: { version: 1, captured_at: 1, local: [], network: [] },
    });
  });
  await expect(work()).rejects.toBeInstanceOf(ExecutionDeadline);
  expect(model.calls).toHaveLength(3);
  const [result] = await work();
  expect(result).toHaveLength(count);
  expect(model.calls).toHaveLength(Math.ceil(count / 12) + 1);
  expect(await db.collection(MODEL_RECEIPTS).countDocuments({ status: "started" })).toBe(0);
});

it("keeps origin/model/policy/run identities separate and records a completed operation before its consumer advances", async () => {
  const model = new FakeModel(() => ({ value: "recorded" }));
  const runtime = receiptRuntime(db, model, "run-a:policy1");
  await runtime.generateStructured("content", {});
  await receiptRuntime(db, model, "run-a:policy1").generateStructured("content", {}, { timeoutMs: 2000 });
  expect(model.calls).toHaveLength(1);
  await runtime.generateStructured("changed content", {});
  await receiptRuntime(db, model, "run-b:policy1").generateStructured("content", {});
  await receiptRuntime(db, model, "run-a:policy2").generateStructured("content", {});
  expect(model.calls).toHaveLength(4);
});

it("does not redispatch an interrupted or accounting-uncertain operation", async () => {
  const failure = new ModelOutcomeUncertain("Provider completed but recording failed");
  const model = new FakeModel(() => { throw failure; });
  const runtime = receiptRuntime(db, model, "run:section");
  await expect(runtime.generateStructured("content", {})).rejects.toBe(failure);
  await expect(runtime.generateStructured("content", {})).rejects.toBeInstanceOf(ModelOutcomeUncertain);
  expect(model.calls).toHaveLength(1);
  expect(await db.collection(MODEL_RECEIPTS).countDocuments({ status: "started" })).toBe(1);
});

it("does not start a provider, consume an ordinary retry, or sleep through settlement headroom", async () => {
  const model = new FakeModel(() => ({ ratings: [] }));
  await expect(withExecutionDeadline(Date.now() + 15_000, () =>
    receiptRuntime(db, model, "run:deadline").generateStructured("content", {}))).rejects.toBeInstanceOf(ExecutionDeadline);
  await expect(withExecutionDeadline(Date.now() + 20_000, () => executionWait(6000))).rejects.toBeInstanceOf(ExecutionDeadline);
  expect(model.calls).toHaveLength(0);
  expect(await db.collection(MODEL_RECEIPTS).countDocuments()).toBe(0);
});

it("yields quota waits without reserving ever-later slots on each retry", async () => {
  const now = Date.now(), future = now + 60_000;
  await db.collection("run_budgets").insertOne({ _id: "pace:fixture_deadline", next_at: future } as never);
  HARD_LIMITS.fixture_deadline = { per_second: 1 };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(withExecutionDeadline(now + 20_000, () => withRunContext({
        db, runId: "quota-run", locationId: "loc", options: defaultRunOptions(),
      }, () => paceService("fixture_deadline")))).rejects.toBeInstanceOf(ExecutionDeadline);
    }
    expect((await db.collection("run_budgets").findOne({ _id: "pace:fixture_deadline" as never }))?.next_at).toBe(future);
  } finally { delete HARD_LIMITS.fixture_deadline; }
});

it("recomputes time remaining for fallback rather than restarting the original timeout", async () => {
  let clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const first = new FakeModel(() => { clock += 50_000; throw new Error("HTTP failure"); });
  const second = new FakeModel(() => ({ ok: true }));
  const runtime = new FallbackRuntime([first, second], { info() {}, warn() {}, error() {} });
  await withExecutionDeadline(clock + 60_000, () => expect(runtime.generateStructured("content", {})).rejects.toBeInstanceOf(ExecutionDeadline));
  expect(second.calls).toHaveLength(0);
});

it.each([new ExecutionBlocked("cancelled"), new ModelOutcomeUncertain("uncertain")])("does not fall back after cancellation or an uncertain dispatch", async error => {
  const first = new FakeModel(() => { throw error; }), second = new FakeModel(() => ({}));
  const runtime = new FallbackRuntime([first, second]);
  await expect(withExecutionDeadline(Date.now() + 100_000, () => runtime.generateStructured("content", {}))).rejects.toBe(error);
  expect(second.calls).toHaveLength(0);
});

it("allows a safely rejected quota request to resume, without caching an error as success", async () => {
  let refused = true;
  const model = new FakeModel(() => { if (refused) throw new ModelRateLimitError("quota"); return { ok: true }; });
  const runtime = receiptRuntime(db, model, "run:quota");
  await expect(runtime.generateStructured("content", {})).rejects.toBeInstanceOf(ModelRateLimitError);
  refused = false;
  await expect(runtime.generateStructured("content", {})).resolves.toMatchObject({ done: true });
  expect(model.calls).toHaveLength(2);
});

it("bounds plain text and compatibility retries at the actual transport boundary", async () => {
  let clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const timeouts: number[] = [];
  const runtime = new OpenAICompatibleRuntime({
    name: "fixture", kind: "openai", apiKey: "fixture", model: "fixture", baseUrl: "https://provider.test",
    authHeader: null, maxTokensParam: "max_tokens", temperature: 0, jsonMode: "json_schema",
  }, async request => {
    timeouts.push(request.timeoutMs!);
    clock += 10_000;
    return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })) };
  });
  await withExecutionDeadline(clock + 40_000, () => runtime.generate("plain text"));
  expect(timeouts).toEqual([25_000]);
  expect(withExecutionDeadline(clock + 40_000, () => executionTimeout(5000))).toBe(5000);
});
