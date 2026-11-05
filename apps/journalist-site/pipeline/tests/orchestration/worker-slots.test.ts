import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { acquireRunLease, acquireSlot, acquireWorker, claim, enqueue, enqueueMany, releaseLease, releaseWorker, type JobKind } from "../../orchestration/jobs";
import { dispatchPlan } from "../../orchestration/dispatch";
import { ensureRunIndexes, newRun, runs, stageKinds, workableRuns } from "../../orchestration/runs";
import { defaultRunOptions, withRunContext } from "../../core/run-options";
import { ensureApiCallIndexes, paidRefusal } from "../../trace/gateway";
import { parseJina } from "../../connectors/web/jina";
import { readablePage } from "../../connectors/web/page";
import { tavilyRequest } from "../../search/provider";

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("isolated-worker-slots");
});
beforeEach(async () => { await db.dropDatabase(); await ensureRunIndexes(db); await ensureApiCallIndexes(db); });
afterAll(async () => { await client?.close(); await server?.stop(); });

const location = (id: string) => ({ id, name: `${id}, WA` });
async function seedRun(id: string, status: "collecting" | "mapping" = "collecting", kind: "map" | "edition" = "edition") {
  const run = { ...newRun(location(id), { kind: "manual", by: "test" }, "2099-01-01", ["2099-01-01", "2099-01-08"], []), status, kind };
  await runs(db).insertOne(run);
  return run;
}
const jobsFor = (runId: string, kind: JobKind, count: number) => Array.from({ length: count }, (_, index) => ({ _id: `${runId}-${kind}-${index}`, kind, run_id: runId, location_id: "a", payload: {}, dedupe_key: `${runId}:${kind}:${index}` }));

it("gives out only as many worker slots as allowed, and removal waits for them", async () => {
  const first = await acquireSlot(db, 2), second = await acquireSlot(db, 2);
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  expect(await acquireSlot(db, 2)).toBeNull();
  expect(await acquireWorker(db)).toBeNull();
  await releaseLease(db, first!);
  await releaseLease(db, second!);
  const token = await acquireWorker(db);
  expect(token).toBeTruthy();
  expect(await acquireSlot(db, 2)).toBeNull();
  await releaseWorker(db, token!);
  expect(await acquireSlot(db, 2)).toBeTruthy();
});

it("runs a run's serial jobs one at a time", async () => {
  const lease = await acquireRunLease(db, "run");
  expect(lease).toBeTruthy();
  expect(await acquireRunLease(db, "run")).toBeNull();
  expect(await acquireRunLease(db, "other")).toBeTruthy();
});

it("claims jobs in the order they were planned, and never one twice", async () => {
  const run = await seedRun("a");
  await enqueueMany(db, jobsFor(run._id, "collect_source", 5));
  const claimed = await Promise.all(Array.from({ length: 5 }, () => claim(db, ["collect_source"], undefined, run._id)));
  expect(new Set(claimed.map((job) => job!._id)).size).toBe(5);
  expect(await claim(db, ["collect_source"], undefined, run._id)).toBeNull();
});

it("serves editions before map runs, then oldest first", async () => {
  const map = await seedRun("map", "mapping", "map");
  const older = await seedRun("older");
  await runs(db).updateOne({ _id: map._id }, { $set: { created_at: 1 } });
  await runs(db).updateOne({ _id: older._id }, { $set: { created_at: 2 } });
  await enqueue(db, { kind: "discover", run_id: map._id, location_id: "map" });
  await enqueue(db, { kind: "plan_sources", run_id: older._id, location_id: "older" });
  expect((await workableRuns(db)).map((run) => run._id)).toEqual([older._id, map._id]);
  expect(stageKinds({ status: "mapping" })).toContain("finish_map");
});

it("starts a worker for each free slot with work ready", async () => {
  const run = await seedRun("a");
  await enqueueMany(db, jobsFor(run._id, "collect_source", 10));
  expect((await dispatchPlan(db, 3)).send).toBe(3);
  await claim(db, ["collect_source"], undefined, run._id);
  await claim(db, ["collect_source"], undefined, run._id);
  const plan = await dispatchPlan(db, 3);
  expect(plan.send).toBe(1);
  expect(plan.wakeIn).toBeGreaterThan(0);
});

it("counts a run's serial work as one worker", async () => {
  const run = await seedRun("a");
  await enqueueMany(db, jobsFor(run._id, "plan_sources", 2));
  expect((await dispatchPlan(db, 3)).send).toBe(1);
});

it("keeps parallel jobs inside a run's paid budget", async () => {
  const options = { ...defaultRunOptions(), paid: { serpapi: 3 } };
  const answers = await withRunContext({ db, runId: "budget", locationId: "a", options }, () => Promise.all(Array.from({ length: 10 }, () => paidRefusal("serpapi"))));
  expect(answers.filter((answer) => answer === null)).toHaveLength(3);
});

it("refuses a paid service with a budget of nothing", async () => {
  const options = { ...defaultRunOptions(), paid: { serpapi: 0 } };
  expect(await withRunContext({ db, runId: "none", locationId: "a", options }, () => paidRefusal("serpapi"))).toMatch(/budget/);
});

it("reads a date and text from a page without a model", () => {
  const body = "<p>The neighbourhood council met on Tuesday to talk about the new crossing at the park, and agreed to ask the city for a study before the end of the year.</p>".repeat(4);
  const page = readablePage(`<html><head><title>Council meets</title></head><body><article><h1>Council meets</h1><time datetime="2026-10-20T08:00:00Z">Oct 20</time>${body}</article></body></html>`);
  expect(page?.date).toBe("2026-10-20");
  expect(page?.text).toContain("neighbourhood council");
});

it("doesn't take a date from a list of dated items", () => {
  const rows = Array.from({ length: 6 }, (_, index) => `<article><time datetime="2026-10-${10 + index}">x</time><p>Item ${index}</p></article>`).join("");
  expect(readablePage(`<html><body><main>${rows}</main></body></html>`)?.date ?? null).toBeNull();
});

it("parses Jina Reader's answer", () => {
  const page = parseJina("Title: A page\nURL Source: https://example.org\nPublished Time: 2026-10-20T08:00:00Z\nMarkdown Content:\nHello [there](https://example.org/a)");
  expect(page).toMatchObject({ title: "A page", date: "2026-10-20" });
  expect(page?.markdown).toContain("Hello");
});

it("turns Google operators into Tavily parameters", () => {
  const request = tavilyRequest('site:city.example.gov "Northgate" (agenda OR minutes) -site:facebook.com after:2026-10-01 filetype:pdf');
  expect(request).toMatchObject({ include_domains: ["city.example.gov"], exclude_domains: ["facebook.com"], start_date: "2026-10-01" });
  expect(request.query).toBe('"Northgate" (agenda OR minutes)');
});
