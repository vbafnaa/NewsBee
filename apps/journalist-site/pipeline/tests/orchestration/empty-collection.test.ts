import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { POST as author } from "@/app/api/admin/runs/[runId]/authoring/route";
import { POST as cancel } from "@/app/api/admin/runs/[runId]/cancel/route";
import { POST as restart } from "@/app/api/admin/runs/[runId]/restart/route";
import { loadSettings } from "../../core/config";
import { CONNECTORS } from "../../connectors/registry";
import { sourceResult, type CollectedEvent, type LocationProfile, type SourceTask } from "../../connectors/types";
import { collectedItems, type CollectedItem } from "../../editions/assemble";
import { locationHealth } from "../../orchestration/health";
import { ensureJobIndexes, runJobs } from "../../orchestration/jobs";
import { resumeRun, runOne, startMapRun, startRun, tick, triggerStage, type OrchestratorDeps } from "../../orchestration/orchestrator";
import { collectionCandidateCount, ensureRunIndexes, getRun, newRun, runs, type RunStatus } from "../../orchestration/runs";
import { LocalArtifacts } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";
import { FakeModel } from "../support/fake-model";

const runtime = vi.hoisted(() => ({
  deps: null as OrchestratorDeps | null,
  email: "editor@example.org" as string | null,
  callbacks: [] as Array<() => Promise<void>>,
}));
vi.mock("next/server", () => ({ after: (callback: () => Promise<void>) => runtime.callbacks.push(callback) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "portal.example.org" }) }));
vi.mock("@/auth", () => ({
  auth: async () => runtime.email ? { user: { email: runtime.email } } : null,
  isAdminEmail: async () => true,
}));
vi.mock("@/lib/pipeline", () => ({ pipelineDeps: async () => runtime.deps }));

const location = { id: "fixture-wa", name: "Fixture, WA", state: "WA", systems: [], government: null };
const task: SourceTask = { type: "library", source_id: "library:fixture", name: "Fixture library" };
const facts: CollectedEvent = {
  source_event_id: "workshop", title: "Community workshop", event_date: "2099-11-02",
  schedule_text: "November 2, 2099", venue: "Town Hall", source_url: "https://example.org/workshop",
  description: "Neighbors discuss practical local resources.", kind: "event", tier: "local",
};
const origin = "https://portal.example.org";
const request = (runId: string, action: string, writeOrigin = origin) => new Request(`${origin}/api/admin/runs/${runId}/${action}`, {
  method: "POST", headers: { origin: writeOrigin },
});
const context = (runId: string) => ({ params: Promise.resolve({ runId }) });
let server: MongoMemoryServer, client: MongoClient, db: Db, root: string, deps: OrchestratorDeps, model: FakeModel;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("isolated-empty-collection");
});
beforeEach(async () => {
  await db.dropDatabase();
  root = await mkdtemp(path.join(os.tmpdir(), "newsbee-empty-collection-"));
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  runtime.email = "editor@example.org";
  runtime.callbacks = [];
  model = new FakeModel(() => { throw new Error("Empty collection must not call a model"); });
  deps = { db, store: new LocalArtifacts(root), settings: loadSettings({ NEWSBEE_ROOT: root }), model };
  runtime.deps = deps;
  await db.collection<LocationProfile & { _id: string }>(COLLECTIONS.locations).insertOne({ ...location, _id: location.id });
  await ensureRunIndexes(db);
  await ensureJobIndexes(db);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => { await client?.close(); await server?.stop(); });

async function seed(status: RunStatus = "awaiting_authoring", tasks: SourceTask[] = []) {
  const run = newRun(location, { kind: "manual", by: "editor@example.org" }, "2099-11-01", ["2099-11-01", "2099-11-08"], tasks);
  run.status = status;
  await runs(db).insertOne(run);
  return run;
}

function item(runId: string, id = "workshop"): CollectedItem {
  return {
    _id: `${runId}:${id}`, run_id: runId, location_id: location.id, source_id: task.source_id,
    source_name: task.name, title: facts.title, url: facts.source_url, event_date: facts.event_date,
    status: "collected", reason: null, step: "reader", facts, created_at: Date.now() / 1000,
  };
}

it.each(["missing", "legacy", "stale-counters", "dropped"] as const)("returns HTTP 409 with %s inputs, without starting jobs or authoring", async (inputs) => {
  const run = await seed();
  if (inputs === "legacy") await db.collection(COLLECTIONS.shortlists).insertOne({ run_id: run._id, events: [{ facts }] });
  if (inputs === "stale-counters") await runs(db).updateOne({ _id: run._id }, { $set: { sources: [{ ...task, job_id: null, status: "completed", result_status: "ok", detail: null, event_count: 3, shortlisted: 3, link_discovery: null, error: null }] } });
  if (inputs === "dropped") await collectedItems(db).insertMany([
    { ...item(run._id, "dropped"), status: "dropped", reason: "outside window", facts: null },
    { ...item(run._id, "missing-facts"), facts: null },
  ]);
  const response = await author(request(run._id, "authoring"), context(run._id));
  expect(response.status).toBe(409);
  expect((await response.json()).detail).toMatch(/no usable items/i);
  expect(await getRun(db, run._id)).toMatchObject({ status: "awaiting_authoring", authoring_started_at: null, stage_transitions: run.stage_transitions });
  expect(await runJobs(db, run._id)).toHaveLength(0);
  expect(await db.collection(COLLECTIONS.editions).countDocuments()).toBe(0);
  expect(runtime.callbacks).toHaveLength(0);
  expect(model.calls).toHaveLength(0);
  expect((await locationHealth(db, (await getRun(db, run._id))!, location)).candidate_count).toBe(0);
});

it("uses the current collection store to allow nonempty authoring and repeated clicks without duplicate jobs", async () => {
  const run = await seed();
  await collectedItems(db).insertOne(item(run._id));
  expect(await db.collection(COLLECTIONS.shortlists).countDocuments()).toBe(0);
  for (let click = 0; click < 2; click++) {
    expect((await author(request(run._id, "authoring"), context(run._id))).status).toBe(200);
  }
  const current = (await getRun(db, run._id))!;
  expect(current.status).toBe("authoring");
  expect(current.authoring_started_at).not.toBeNull();
  expect(current.stage_transitions?.filter((transition) => transition.status === "authoring")).toHaveLength(1);
  expect((await runJobs(db, run._id)).map((job) => job.kind)).toEqual(["author_start"]);
  expect((await locationHealth(db, current, location)).candidate_count).toBe(1);
});

it("scopes retained input counts to this run and ignores dropped or factless traces", async () => {
  const run = await seed();
  await collectedItems(db).insertMany([
    item(run._id), item("another-run"), { ...item(run._id, "dropped"), status: "dropped" },
    { ...item(run._id, "factless"), facts: null },
  ]);
  expect(await collectionCandidateCount(db, run._id)).toBe(1);
});

function collect(events: CollectedEvent[]) {
  deps.connectors = { ...CONNECTORS, library: { ...CONNECTORS.library, collect: async () => ({
    result: sourceResult(task.source_id, task.name, "ingested", "Fixture collection"), events,
    dropped: [{ source_event_id: "old", title: "Old event", url: null, reason: "outside_window" }],
  }) } };
}

it.each([false, true])("stops actual empty collection at the editor gate (no sources: %s)", async (noSources) => {
  const run = await seed("collecting", noSources ? [] : [task]);
  collect([]);
  await resumeRun(deps, run._id, "editor");
  await tick(deps, { budgetMs: 10_000 });
  expect((await getRun(db, run._id))?.status).toBe("awaiting_authoring");
  await expect(triggerStage(deps, run._id, "authoring", "editor")).rejects.toThrow(/no usable items/i);
  expect((await locationHealth(db, (await getRun(db, run._id))!, location)).candidate_count).toBe(0);
  expect((await runJobs(db, run._id)).every((job) => job.kind === "collect_source" && job.status === "completed")).toBe(true);
  expect(model.calls).toHaveLength(0);
});

it("allows freshly collected items through the gate into main's section-ranking flow", async () => {
  const run = await seed("collecting", [task]);
  collect([facts]);
  await resumeRun(deps, run._id, "editor");
  await tick(deps, { budgetMs: 10_000 });
  expect((await locationHealth(db, (await getRun(db, run._id))!, location)).candidate_count).toBe(1);
  expect(await db.collection(COLLECTIONS.shortlists).countDocuments()).toBe(0);
  await triggerStage(deps, run._id, "authoring", "editor");
  expect(await runOne(deps, { kinds: ["author_start"] })).toBe(true);
  const current = (await getRun(db, run._id))!;
  expect(current.draft_id).toBeTruthy();
  expect(await db.collection(COLLECTIONS.editions).findOne({ id: current.draft_id })).toMatchObject({ status: "ranking" });
  expect((await runJobs(db, run._id)).some((job) => job.kind === "author_rank" && job.status === "pending")).toBe(true);
});

it("cancels the empty attempt and starts a distinct edition run without losing its logs or history", async () => {
  const run = await seed("collecting", [task]);
  collect([]);
  await resumeRun(deps, run._id, "editor");
  await tick(deps, { budgetMs: 10_000 });
  expect((await getRun(db, run._id))?.status).toBe("awaiting_authoring");
  const oldJobs = await runJobs(db, run._id);
  const oldItems = await collectedItems(db).find({ run_id: run._id }).toArray();
  expect((await restart(request(run._id, "restart"), context(run._id))).status).toBe(409);
  expect((await cancel(request(run._id, "cancel"), context(run._id))).status).toBe(200);
  const cancelled = await getRun(db, run._id);
  await db.collection("source_map").insertOne({ _id: `${location.id}:${task.source_id}` as never, location_id: location.id, source_id: task.source_id, status: "active" });
  const response = await restart(request(run._id, "restart"), context(run._id));
  expect(response.status).toBe(200);
  const result = await response.json() as { run_id: string; restarted_from: string };
  expect(result.restarted_from).toBe(run._id);
  expect(result.run_id).not.toBe(run._id);
  expect(await getRun(db, run._id)).toEqual(cancelled);
  expect(await runJobs(db, run._id)).toEqual(oldJobs);
  expect(await collectedItems(db).find({ run_id: run._id }).toArray()).toEqual(oldItems);
  expect(await getRun(db, result.run_id)).toMatchObject({ status: "collecting", planned: false });
  expect((await runJobs(db, result.run_id)).every((job) => job.kind === "plan_sources")).toBe(true);
});

it("won't start an edition with no source map, and a map run only maps", async () => {
  await expect(startRun(deps, location.id, { by: "editor", kind: "manual" })).rejects.toThrow(/source map first/i);
  const { run } = await startMapRun(deps, location.id, { by: "editor", kind: "manual" }, {}, true);
  expect(run).toMatchObject({ kind: "map", status: "mapping" });
  const kinds = (await runJobs(db, run._id)).map((job) => job.kind);
  expect(kinds.length).toBeGreaterThan(0);
  expect(kinds.every((kind) => kind === "discover")).toBe(true);
});

it("preserves main's location-removal precondition even with retained items", async () => {
  const run = await seed();
  await collectedItems(db).insertOne(item(run._id));
  await db.collection(COLLECTIONS.locations).updateOne({ id: location.id }, { $set: { removal: { status: "pending" } } });
  expect((await author(request(run._id, "authoring"), context(run._id))).status).toBe(409);
  expect((await getRun(db, run._id))?.status).toBe("awaiting_authoring");
  expect(await runJobs(db, run._id)).toHaveLength(0);
});

it("preserves unknown-run, authentication and same-origin responses", async () => {
  expect((await author(request("missing", "authoring"), context("missing"))).status).toBe(404);
  const run = await seed();
  runtime.email = null;
  expect((await author(request(run._id, "authoring"), context(run._id))).status).toBe(401);
  runtime.email = "editor@example.org";
  expect((await author(request(run._id, "authoring", "https://untrusted.example.org"), context(run._id))).status).toBe(403);
  expect(runtime.callbacks).toHaveLength(0);
});
