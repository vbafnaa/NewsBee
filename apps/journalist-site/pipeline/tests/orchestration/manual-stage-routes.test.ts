import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as ingest } from "@/app/api/admin/ingestion/route";
import { POST as author } from "@/app/api/admin/runs/[runId]/authoring/route";
import { POST as finish } from "@/app/api/admin/runs/[runId]/finish/route";
import { POST as resume } from "@/app/api/admin/runs/[runId]/resume/route";
import { POST as cancel } from "@/app/api/admin/runs/[runId]/cancel/route";
import { POST as restart } from "@/app/api/admin/runs/[runId]/restart/route";
import { POST as advance } from "@/app/api/pipeline/advance/route";
import { processNextJob } from "@/lib/pipeline-queue-worker";
import { send } from "@vercel/queue";
import { authorizedJobChain, jobChainToken } from "@/lib/pipeline-auth";
import { loadSettings } from "../../core/config";
import { sourceResult, type Connector, type SourceType } from "../../connectors/types";
import { acquireWorker, claim, ensureJobIndexes, runJobs } from "../../orchestration/jobs";
import type { OrchestratorDeps } from "../../orchestration/orchestrator";
import { ensureRunIndexes, getRun, newRun, runs, type RunStatus } from "../../orchestration/runs";
import { schedulerState } from "../../orchestration/scheduler";
import { LocalArtifacts } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";
import { FakeModel } from "../support/fake-model";
import { withMongo } from "../support/mongo";

const runtime = vi.hoisted(() => ({
  callbacks: [] as Array<() => Promise<void>>,
  deliveries: [] as Array<{ at: number }>,
  deps: null as OrchestratorDeps | null,
  email: "editor@example.org" as string | null,
}));
vi.mock("next/server", () => ({ after: (callback: () => Promise<void>) => runtime.callbacks.push(callback) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "portal.example.org" }) }));
vi.mock("@/auth", () => ({
  auth: async () => runtime.email ? { user: { email: runtime.email } } : null,
  isAdminEmail: async () => true,
}));
vi.mock("@/lib/pipeline", () => ({ pipelineDeps: async () => runtime.deps }));
vi.mock("@vercel/queue", () => ({
  send: vi.fn(async (_topic: string, _message: unknown, options?: { delaySeconds?: number }) => {
    runtime.deliveries.push({ at: Date.now() + (options?.delaySeconds ?? 0) * 1000 });
    return { messageId: `test-${runtime.deliveries.length}` };
  }),
}));

const origin = "https://portal.example.org";
const internalSecret = "test-worker-authorization";
const location = { id: "auburn-wa", name: "Auburn, WA", state: "WA", systems: [], government: null };
const context = (runId: string) => ({ params: Promise.resolve({ runId }) });
const request = (route: string, writeOrigin = origin) => new Request(`${origin}/api/admin/${route}`, {
  method: "POST", headers: { origin: writeOrigin },
});

describe("manual stage HTTP flow", () => {
  const mongo = withMongo();
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "newsbee-manual-routes-"));
    vi.stubEnv("NEWSBEE_MODE", "cloud");
    vi.stubEnv("AUTH_SECRET", internalSecret);
    vi.stubEnv("CRON_SECRET", "");
    runtime.callbacks = [];
    runtime.deliveries = [];
    vi.mocked(send).mockClear();
    runtime.email = "editor@example.org";
    await mongo.db.collection(COLLECTIONS.locations).insertOne({ ...location, _id: location.id as never });
    await ensureRunIndexes(mongo.db);
    await ensureJobIndexes(mongo.db);
    const connectors = Object.fromEntries((["library", "meetings", "hazards", "statenews", "trending"] as SourceType[]).map((type) => [type, {
      type,
      sources: () => [{ type, source_id: `${type}:main`, name: type }],
      collect: async (task) => ({ result: sourceResult(task.source_id, task.name, "ingested", "ok"), events: [] }),
    } satisfies Connector])) as Record<SourceType, Connector>;
    runtime.deps = {
      db: mongo.db,
      settings: { ...loadSettings({ NEWSBEE_ROOT: dir } as NodeJS.ProcessEnv), cronSecret: internalSecret },
      store: new LocalArtifacts(dir),
      connectors,
      model: new FakeModel(({ prompt }) => {
        if (prompt.startsWith("You edit a friendly")) return { headline: "Community updates", intro: "The latest community updates." };
        if (prompt.startsWith("You write the email")) return { blurb: "Read the latest community updates." };
        throw new Error(`Unexpected model call: ${prompt.slice(0, 40)}`);
      }),
    };
    // Route real internal requests in-process: no server, external APIs, poller or cron.
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const internal = new Request(input, init);
      expect(authorizedJobChain(internal)).toBe(true);
      const route = new URL(internal.url).pathname;
      if (route === "/api/pipeline/advance") return advance(internal);
      throw new Error(`Unexpected internal request: ${route}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  async function drainCallbacks() {
    let calls = 0;
    while (runtime.callbacks.length || runtime.deliveries.length) {
      if (++calls > 50) throw new Error("Worker chain failed to reach an editor gate");
      if (runtime.callbacks.length) {
        await runtime.callbacks.shift()!();
      } else {
        runtime.deliveries.sort((a, b) => a.at - b.at);
        const delivery = runtime.deliveries.shift()!;
        if (delivery.at > Date.now()) await new Promise((resolve) => setTimeout(resolve, delivery.at - Date.now()));
        await processNextJob();
      }
    }
  }

  async function seed(status: RunStatus, draftId: string | null = null) {
    const run = newRun(location, { kind: "manual", by: "editor@example.org" }, "2026-01-01", ["2026-01-01", "2026-01-08"], []);
    run.status = status;
    run.draft_id = draftId;
    await runs(mongo.db).insertOne(run);
    return run;
  }

  it.each(["local", "cloud"] as const)("one click completes each stage without cron or a poller in %s mode", async (mode) => {
    runtime.deps!.settings.mode = mode;
    const response = await ingest(request("ingestion"));
    expect(response.status).toBe(200);
    const { jobs } = await response.json() as { jobs: { job_id: string }[] };
    const runId = jobs[0].job_id;
    expect(runtime.callbacks).toHaveLength(1);
    await drainCallbacks();
    expect((await getRun(mongo.db, runId))?.status).toBe("awaiting_authoring");
    expect((await runJobs(mongo.db, runId)).every((job) => job.kind === "collect_source" && job.status === "completed")).toBe(true);
    if (mode === "local") {
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5);
      const count = fetchMock.mock.calls.length;
      expect((await advance(new Request(`${origin}/api/pipeline/advance`, {
        method: "POST", headers: { "x-newsbee-job-token": jobChainToken(internalSecret) },
      }))).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(count);
    } else {
      expect(send).toHaveBeenCalledTimes(6); // Five sources and one final gate check.
      expect(fetchMock).not.toHaveBeenCalled();
      await processNextJob(); // A stray delivery cannot cross the editor gate.
      expect(runtime.deliveries).toHaveLength(0);
    }
    expect(runtime.callbacks).toHaveLength(0);

    expect((await author(request(`runs/${runId}/authoring`), context(runId))).status).toBe(200);
    await drainCallbacks();
    expect((await getRun(mongo.db, runId))?.status).toBe("awaiting_finish");
    expect((await runJobs(mongo.db, runId)).some((job) => job.kind === "author_finish")).toBe(false);
    expect((await finish(request(`runs/${runId}/finish`), context(runId))).status).toBe(200);
    await drainCallbacks();
    expect((await getRun(mongo.db, runId))?.status).toBe("published");
    expect((await getRun(mongo.db, runId))?.published?.artifacts.email_html).toBeTruthy();
  });

  it.each([author, finish, resume])("requires admin authentication and same-origin writes", async (handler) => {
    const run = await seed("awaiting_authoring");
    runtime.email = null;
    expect((await handler(request(`runs/${run._id}/stage`), context(run._id))).status).toBe(401);
    runtime.email = "editor@example.org";
    expect((await handler(request(`runs/${run._id}/stage`, "https://untrusted.example.org"), context(run._id))).status).toBe(403);
    expect(runtime.callbacks).toHaveLength(0);
    expect((await getRun(mongo.db, run._id))?.status).toBe("awaiting_authoring");
  });

  it.each([author, finish, resume])("returns 404 for an unknown run without dispatching work", async (handler) => {
    const response = await handler(request("runs/missing/stage"), context("missing"));
    expect(response.status).toBe(404);
    expect(runtime.callbacks).toHaveLength(0);
  });

  it.each([
    ["collecting", author], ["collecting", finish], ["awaiting_authoring", finish],
    ["authoring", finish], ["awaiting_finish", author], ["finishing", author],
    ["published", author], ["published", finish], ["failed", author], ["cancelled", finish],
    ["awaiting_authoring", resume], ["awaiting_finish", resume], ["published", resume],
  ] as const)("returns a clear 409 for an invalid trigger from %s", async (status, handler) => {
    const run = await seed(status);
    const response = await handler(request(`runs/${run._id}/stage`), context(run._id));
    expect(response.status).toBe(409);
    expect((await response.json()).detail).toMatch(/Cannot (start|resume)/);
    expect(runtime.callbacks).toHaveLength(0);
    expect(await runJobs(mongo.db, run._id)).toHaveLength(0);
  });

  it.each(["local", "cloud"] as const)("resumes durable backoff and chains the next worker in %s mode", async (mode) => {
    runtime.deps!.settings.mode = mode;
    const response = await ingest(request("ingestion"));
    const { jobs } = await response.json() as { jobs: { job_id: string }[] };
    const runId = jobs[0].job_id;
    await mongo.db.collection(COLLECTIONS.jobs).updateMany({ run_id: runId }, { $set: { available_at: Date.now() / 1000 + 0.15 } });
    expect((await resume(request(`runs/${runId}/resume`), context(runId))).status).toBe(200);
    expect(await mongo.db.collection(COLLECTIONS.jobs).countDocuments({ run_id: runId })).toBe(5);
    await drainCallbacks();
    expect((await getRun(mongo.db, runId))?.status).toBe("awaiting_authoring");
    expect((await runJobs(mongo.db, runId)).every((job) => job.attempts === 1)).toBe(true);
    if (mode === "local") expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    else expect(vi.mocked(send).mock.calls.length).toBeGreaterThan(1);
  });

  it.each(["awaiting_authoring", "awaiting_finish"] as const)("cancels and restarts a waiting run through protected endpoints: %s", async (status) => {
    const run = await seed(status);
    expect((await restart(request(`runs/${run._id}/restart`), context(run._id))).status).toBe(409);
    expect((await cancel(request(`runs/${run._id}/cancel`), context(run._id))).status).toBe(200);
    const response = await restart(request(`runs/${run._id}/restart`), context(run._id));
    expect(response.status).toBe(200);
    const result = await response.json() as { run_id: string };
    expect(result.run_id).not.toBe(run._id);
    await drainCallbacks();
    expect((await getRun(mongo.db, run._id))?.status).toBe("cancelled");
    expect((await getRun(mongo.db, result.run_id))?.status).toBe("awaiting_authoring");
  });

  it.each(["local", "cloud"] as const)("a single resume waits for an interrupted worker lease and recovers it without a poller in %s mode", async (mode) => {
    runtime.deps!.settings.mode = mode;
    const response = await ingest(request("ingestion"));
    const { jobs } = await response.json() as { jobs: { job_id: string }[] };
    runtime.callbacks = []; // The original request died before dispatching its kick.
    const runId = jobs[0].job_id;
    await acquireWorker(mongo.db);
    const interrupted = await claim(mongo.db, undefined, undefined, runId);
    const expires = Date.now() / 1000 + 0.2;
    await mongo.db.collection(COLLECTIONS.jobs).updateOne({ _id: interrupted!._id as never }, { $set: { lease_until: expires } });
    await mongo.db.collection(COLLECTIONS.heartbeat).updateOne({ _id: "pipeline-worker" as never }, { $set: { lease_until: expires } });
    expect((await resume(request(`runs/${runId}/resume`), context(runId))).status).toBe(200);
    await drainCallbacks();
    expect((await getRun(mongo.db, runId))?.status).toBe("awaiting_authoring");
    const recovered = await runJobs(mongo.db, runId);
    expect(recovered).toHaveLength(5);
    expect(recovered.find((job) => job._id === interrupted!._id)?.attempts).toBe(2);
  });

  it("surfaces a rejected worker kick instead of silently claiming stage completion", async () => {
    runtime.deps!.settings.mode = "local";
    const run = await seed("awaiting_authoring");
    fetchMock.mockResolvedValue(new Response('{"detail":"Unauthorized"}', { status: 401 }));
    expect((await author(request(`runs/${run._id}/authoring`), context(run._id))).status).toBe(200);
    await drainCallbacks();
    expect((await schedulerState(mongo.db)).issues[0].message).toMatch(/401/);
    expect((await getRun(mongo.db, run._id))?.status).toBe("authoring");
    expect((await runJobs(mongo.db, run._id))[0].attempts).toBe(0);
  });
});
