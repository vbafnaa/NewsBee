import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  send: vi.fn(),
  deps: vi.fn(),
  runOne: vi.fn(),
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@vercel/queue", () => ({ send: mocks.send }));
vi.mock("../../../lib/pipeline", () => ({ pipelineDeps: mocks.deps }));
vi.mock("../../../lib/admin-session", () => ({ currentPrincipal: vi.fn(), operatorGuard: vi.fn(), signedInGuard: vi.fn() }));
vi.mock("../../../lib/internal-session", () => ({ internalGuard: vi.fn() }));
vi.mock("../../orchestration/orchestrator", () => ({ runOne: mocks.runOne }));

import { POST } from "../../../app/api/pipeline/advance/route";
import { kickPipeline } from "../../../lib/admin-api";
import { jobChainToken } from "../../../lib/pipeline-auth";
import { PIPELINE_TOPIC } from "../../../lib/pipeline-queue";
import { processNextJob } from "../../../lib/pipeline-queue-worker";
import { loadSettings } from "../../core/config";
import { claim, complete, enqueueMany, ensureJobIndexes, type Job } from "../../orchestration/jobs";
import type { OrchestratorDeps } from "../../orchestration/orchestrator";
import { ensureRunIndexes, newRun, runs } from "../../orchestration/runs";
import { schedulerState } from "../../orchestration/scheduler";
import { LocalArtifacts } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";
import { FakeModel } from "../support/fake-model";

const url = "https://newsbee.example/api/pipeline/advance";
const secret = "fixture-only-worker-secret";
const deliveries: number[] = [];
const callbacks: Array<() => Promise<void>> = [];
let server: MongoMemoryServer, client: MongoClient, db: Db, deps: OrchestratorDeps;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("independent-pipeline-delivery");
});
beforeEach(async () => {
  vi.clearAllMocks();
  deliveries.length = 0;
  callbacks.length = 0;
  await db.dropDatabase();
  await ensureRunIndexes(db);
  await ensureJobIndexes(db);
  vi.stubEnv("AUTH_SECRET", secret);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Cloud workers must not self-fetch"); }));
  deps = {
    db,
    settings: loadSettings({ NEWSBEE_MODE: "cloud", NEWSBEE_COLLECT_CONCURRENCY: "1" }),
    store: new LocalArtifacts("unused-worker-fixture"),
    model: new FakeModel(() => { throw new Error("No paid calls in dispatch fixtures"); }),
  };
  mocks.deps.mockResolvedValue(deps);
  mocks.after.mockImplementation((callback: () => Promise<void>) => { callbacks.push(callback); });
  mocks.send.mockImplementation(async (_topic, _payload, options?: { delaySeconds: number }) => {
    deliveries.push(options?.delaySeconds ?? 0);
  });
  // Keep the actual claim fence and settlement; replace only the job's provider work.
  mocks.runOne.mockImplementation(async () => {
    const job = await claim(db, ["discover", "agent_round"]);
    if (!job) return false;
    await complete(db, job, { checkpoint: job._id });
    return true;
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
afterAll(async () => { await client?.close(); await server?.stop(); });

async function seedJobs(count: number) {
  const run = {
    ...newRun({ id: "fixture-town", name: "Fixture Town" }, { kind: "manual", by: "fixture" }, "2099-01-01", ["2099-01-01", "2099-01-08"], []),
    status: "mapping" as const, kind: "map" as const,
  };
  await runs(db).insertOne(run);
  await enqueueMany(db, Array.from({ length: count }, (_, index) => ({
    _id: `step-${index}`, kind: index < 11 ? "discover" as const : "agent_round" as const,
    run_id: run._id, location_id: "fixture-town", payload: {}, dedupe_key: `fixture:${index}`,
  })));
  return db.collection<Job>(COLLECTIONS.jobs);
}

function recoveryRequest() {
  return new Request(url, { method: "POST", headers: { "x-newsbee-job-token": jobChainToken(secret) } });
}

async function flushCallbacks() {
  while (callbacks.length) await callbacks.shift()!();
}

it.each(["portal", "signed recovery"] as const)("continues 64 jobs from %s through independent deliveries, never nested HTTP", async (entry) => {
  const jobs = await seedJobs(64);
  if (entry === "portal") {
    // No consumer history: a cold/idle deployment must still bootstrap through the queue.
    kickPipeline(deps, url);
    await flushCallbacks();
    expect(await schedulerState(db)).toMatchObject({ last_queue_at: null, status: "stale" });
  } else {
    expect((await POST(recoveryRequest())).status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
  }
  let delivered = 0;
  while (deliveries.length) {
    expect(deliveries.shift()).toBe(0);
    expect(++delivered).toBeLessThanOrEqual(64);
    await processNextJob();
  }
  expect(delivered).toBe(entry === "portal" ? 64 : 63);
  expect(await jobs.countDocuments({ status: "completed", attempts: 1 })).toBe(64);
  expect(await jobs.countDocuments({ status: { $in: ["pending", "running"] } })).toBe(0);
  expect(mocks.send).toHaveBeenCalledTimes(delivered);
  expect(mocks.send.mock.calls.every(([topic, payload, options]) =>
    topic === PIPELINE_TOPIC && payload.action === "advance" && options === undefined)).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it("reports an unavailable cloud kickoff without falling back to HTTP or touching jobs", async () => {
  const jobs = await seedJobs(2);
  mocks.send.mockRejectedValueOnce(new Error("queue unavailable"));
  kickPipeline(deps, url);
  await flushCallbacks();
  expect((await schedulerState(db)).issues).toEqual([expect.objectContaining({ channel: "kick", message: expect.stringContaining("queue unavailable") })]);
  expect(await jobs.countDocuments({ status: "pending", attempts: 0 })).toBe(2);
  expect(mocks.runOne).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("returns 503 for failed recovery continuation while retaining the completed checkpoint", async () => {
  const jobs = await seedJobs(2);
  mocks.send.mockRejectedValueOnce(new Error("queue unavailable"));
  const response = await POST(recoveryRequest());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ executed: true, detail: expect.stringContaining("requires Vercel Queues delivery") });
  expect(await jobs.findOne({ _id: "step-0" })).toMatchObject({ status: "completed", attempts: 1, result: { checkpoint: "step-0" } });
  expect(await jobs.findOne({ _id: "step-1" })).toMatchObject({ status: "pending", attempts: 0 });
  expect((await schedulerState(db)).issues).toEqual([expect.objectContaining({ channel: "followup" })]);
  expect(fetch).not.toHaveBeenCalled();
});

it("retries a rejected worker handoff without replaying settled work, and clears its failure", async () => {
  const jobs = await seedJobs(2);
  mocks.send.mockRejectedValueOnce(new Error("queue unavailable"));
  await expect(processNextJob()).rejects.toThrow("queue unavailable");
  expect((await schedulerState(db)).issues).toEqual([expect.objectContaining({ channel: "followup" })]);
  await processNextJob();
  await processNextJob(); // A duplicate delivery must find no claimable job.
  expect(await jobs.countDocuments({ status: "completed", attempts: 1 })).toBe(2);
  expect((await schedulerState(db)).issues).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it("delivers backoff durably, suppresses duplicate wakes and executes only when due", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const jobs = await seedJobs(1);
  await jobs.updateOne({ _id: "step-0" }, { $set: { available_at: Date.now() / 1000 + 60 } });
  expect((await POST(recoveryRequest())).status).toBe(200);
  await processNextJob();
  expect(deliveries).toEqual([60]);
  expect(await jobs.findOne({ _id: "step-0" })).toMatchObject({ status: "pending", attempts: 0 });
  vi.setSystemTime(Date.now() + 60_000);
  await processNextJob();
  expect(await jobs.findOne({ _id: "step-0" })).toMatchObject({ status: "completed", attempts: 1 });
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith(PIPELINE_TOPIC, { action: "advance" }, { delaySeconds: 60 });
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves free-slot fanout alongside a delayed retry during cloud recovery", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  deps.settings.collectConcurrency = 3;
  const jobs = await seedJobs(5);
  await jobs.updateOne({ _id: "step-4" }, { $set: { available_at: Date.now() / 1000 + 60 } });
  expect((await POST(recoveryRequest())).status).toBe(200);
  expect(deliveries).toEqual([0, 0, 0, 60]);
  expect(await jobs.countDocuments({ status: "completed", attempts: 1 })).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});

it("releases a failed delayed wake reservation so queue redelivery can actually retry it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const jobs = await seedJobs(1);
  await jobs.updateOne({ _id: "step-0" }, { $set: { available_at: Date.now() / 1000 + 60 } });
  mocks.send.mockRejectedValueOnce(new Error("delayed send unavailable"));
  await expect(processNextJob()).rejects.toThrow("delayed send unavailable");
  await processNextJob();
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(deliveries).toEqual([60]);
  expect(await jobs.findOne({ _id: "step-0" })).toMatchObject({ status: "pending", attempts: 0 });
});

it("does not erase an earlier wake accepted while another delayed send fails", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const jobs = await seedJobs(1);
  await jobs.updateOne({ _id: "step-0" }, { $set: { available_at: Date.now() / 1000 + 60 } });
  mocks.send.mockImplementationOnce(async () => {
    await jobs.updateOne({ _id: "step-0" }, { $set: { available_at: Date.now() / 1000 + 5 } });
    await processNextJob();
    throw new Error("later wake rejected");
  });
  await expect(processNextJob()).rejects.toThrow("later wake rejected");
  await processNextJob();
  expect(deliveries).toEqual([5]);
  expect(mocks.send).toHaveBeenCalledTimes(2);
});

it("backs off a contended claim instead of spinning immediate deliveries", async () => {
  await seedJobs(1);
  mocks.runOne.mockResolvedValueOnce(false);
  await processNextJob();
  expect(deliveries).toEqual([5]);
  expect(fetch).not.toHaveBeenCalled();
});

it("retains local signed HTTP handoffs and leaves delayed work to the local poller", async () => {
  deps.settings.mode = "local";
  const jobs = await seedJobs(4);
  await jobs.updateOne({ _id: "step-3" }, { $set: { available_at: Date.now() / 1000 + 60 } });
  vi.stubGlobal("fetch", vi.fn(async (target: URL, init: RequestInit) => POST(new Request(target, init))));
  kickPipeline(deps, url);
  await flushCallbacks();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(await jobs.countDocuments({ status: "completed", attempts: 1 })).toBe(3);
  expect(await jobs.findOne({ _id: "step-3" })).toMatchObject({ status: "pending", attempts: 0 });
  expect(mocks.send).not.toHaveBeenCalled();
});

it("rejects unsigned recovery before loading dependencies or dispatching work", async () => {
  expect((await POST(new Request(url, { method: "POST" }))).status).toBe(401);
  expect(mocks.deps).not.toHaveBeenCalled();
  expect(mocks.runOne).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
