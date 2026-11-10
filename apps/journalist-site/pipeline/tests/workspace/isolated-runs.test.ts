import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), headers: vi.fn(), cookies: vi.fn(), deps: vi.fn(), database: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth, isAdminEmail: vi.fn(), getMongoDatabase: mocks.database }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies, headers: mocks.headers }));
vi.mock("@/lib/pipeline", () => ({ pipelineDeps: mocks.deps }));
vi.mock("@/pipeline/storage/mongo", async (original) => ({ ...await original<object>(), getDatabase: mocks.database }));
// The made-up sites have no DNS, and nothing here needs pacing.
vi.mock("../../connectors/public-http", async (original) => ({ ...await original<object>(), publicSourceTransport: (transport: HttpTransport) => transport }));
vi.mock("../../connectors/fetch-state", async (original) => ({ ...await original<object>(), reserveHost: async () => 0 }));

import { POST as decide } from "../../../app/api/admin/locations/[locationId]/source-runs/[runId]/decisions/route";
import { agentJob, AGENT_STATE, type AgentState } from "../../agent/map-sources";
import { Fetcher } from "../../connectors/fetcher";
import type { LocationProfile } from "../../connectors/types";
import { loadSettings } from "../../core/config";
import type { HttpRequest, HttpTransport } from "../../core/http";
import { resolveRunOptions, sourceRunsIsolated, withRunContext, type RunOptions } from "../../core/run-options";
import { cachedDiscovery } from "../../discovery/cache";
import { pastDecisions } from "../../discovery/gemini-check";
import type { DiscoveryContext } from "../../discovery/methods";
import { METHODS } from "../../discovery/methods";
import { discoveryState } from "../../discovery/run";
import { UsageRecordingRuntime, type ModelRuntime } from "../../model/runtime";
import { enqueue, ensureJobIndexes } from "../../orchestration/jobs";
import { executeJob, startMapRun, type OrchestratorDeps } from "../../orchestration/orchestrator";
import { ensureRunIndexes, getRun, runs, type PipelineRun } from "../../orchestration/runs";
import { search } from "../../search/provider";
import { pageDecisions, runSources, sourceMap, SOURCE_REVIEWS, upsertCandidates } from "../../sourcemap/store";
import { COLLECTIONS } from "../../storage/mongo";
import { RUN_DECISIONS } from "../../trace/decisions";
import { ensureApiCallIndexes, HARD_LIMITS, type HardLimit } from "../../trace/gateway";
import { sourceRunDetail, sourceRunList } from "../../trace/source-runs";
import { FakeModel, type FakeCall } from "../support/fake-model";

const TODAY = "2026-11-06";
const LOCATION = { id: "loc", name: "Lakeside, WA", state: "WA", latitude: 47.6, longitude: -122.3, systems: [], government: null } as unknown as LocationProfile;
const EVENTS = "https://lib.example.org/events";
const POLICE = "https://police.example.gov/news";
const listing = (title: string) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${"Lakeside residents' notices and news. ".repeat(30)}</p><ul><li>November 2, 2026</li><li>October 19, 2026</li><li>October 5, 2026</li></ul></main></body></html>`;
const PAGES: Record<string, string> = { [EVENTS]: listing("Lakeside Library events"), [POLICE]: listing("Lakeside Police news") };

/** What SerpApi answers every query with: the pages the agent's run proposes (the events page by default). */
let answer: string[] = [EVENTS];
/** A made-up web; SerpApi answers every query with `answer`. Every request is kept. */
function web() {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    const url = new URL(request.url);
    const reply = (status: number, body: string, type = "text/html") => ({ url: request.url, status, headers: { "content-type": type }, body: new TextEncoder().encode(body) });
    if (url.host === "serpapi.com") return reply(200, JSON.stringify({ organic_results: answer.map((link) => ({ link, title: link === POLICE ? "Lakeside Police news" : "Lakeside Library events", snippet: "From SerpApi" })) }), "application/json");
    if (url.pathname === "/robots.txt") return reply(200, "User-agent: *\nDisallow:\n", "text/plain");
    const page = PAGES[request.url];
    return page ? reply(200, page) : reply(404, "");
  };
  return { transport, requests };
}

/** The agent's rounds: every turn's search (SerpApi answers with `urls`), and triage proposes `urls`, filed by page; the model check accepts everything. */
function agentModel(urls: string[]) {
  answer = urls;
  return new FakeModel((request: FakeCall) => {
    if (/one verdict per source id/.test(request.prompt)) {
      return { verdicts: request.prompt.split("\n\nSource id: ").slice(1).map((block) => ({ id: block.split("\n")[0], verdict: "accept", reason_code: "A1", evidence: "Latest dated item: 2026-11-02", reason: "Publishes local notices" })) };
    }
    if (/You are triaging search results/.test(request.prompt)) {
      const items = [...request.prompt.matchAll(/^\[(r\d+-\d+)\] (\S+)/gm)];
      return { decisions: items.map(([, id, url]) => urls.includes(url) ? { id, action: "propose", category: url === POLICE ? "crime" : "events" } : { id, action: "skip", why: "not local" }) };
    }
    const turns = [...(request.prompt.split("This round's turns")[1]?.split("\n\n")[0] ?? "").matchAll(/^- (\w+): dork runs (\w+)/gm)];
    return { categories: turns.map(([, category, angle]) => angle === "anchor" ? { category, searches: [{ tool: "dork" }] } : { category, angle: "geography", angle_reason: "the area's other names", searches: [{ tool: "dork", query: `"Lakeside" ${category} north end` }] }) };
  });
}
function asGemini(fake: FakeModel, role: string): ModelRuntime {
  const inner: ModelRuntime = { provider: "gemini", model: "flash-lite", health: () => fake.health(), generate: (prompt) => fake.generate(prompt), generateStructured: (prompt, schema, options) => fake.generateStructured(prompt, schema, options) };
  return new UsageRecordingRuntime(inner, { role, sink: () => undefined }, { info() {}, warn() {}, error() {} } as never);
}

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("isolated_runs"); }, 60_000);
afterAll(async () => { await client?.close(); await server?.stop(); });
const saved = { ...HARD_LIMITS };
const setLimits = (limits: Record<string, HardLimit>) => { for (const key of Object.keys(HARD_LIMITS)) delete HARD_LIMITS[key]; Object.assign(HARD_LIMITS, limits); };
beforeEach(async () => {
  await db.dropDatabase();
  await ensureApiCallIndexes(db); await ensureRunIndexes(db); await ensureJobIndexes(db);
  setLimits({});
  mocks.auth.mockResolvedValue({ user: { email: "labeller@example.test" } });
  mocks.headers.mockResolvedValue(new Headers({ host: "workspace.example.test" }));
  mocks.cookies.mockResolvedValue({ get: () => undefined });
  mocks.database.mockResolvedValue(db);
  mocks.deps.mockResolvedValue({ db });
  await db.collection("journalist_admins").insertOne({ email: "labeller@example.test", enabled: true });
  await db.collection<{ _id: string }>(COLLECTIONS.locations).insertOne({ ...LOCATION, _id: LOCATION.id } as never);
});
afterEach(() => { setLimits(saved); vi.unstubAllEnvs(); vi.resetAllMocks(); });

const SETTINGS = { integrations: { serpapiKey: "k" }, tavilySearchApiKey: null, modelProviders: [] };
const OPTIONS = resolveRunOptions({ flow: "agentic", map_flow: "agentic", search_provider: "serpapi", topics: ["events", "crime"], paid: { serpapi: 100, gemini: 1000, agent_model: 1000 } });
const T = Date.now() / 1000;

/** A map run as startMapRun records it, then its agent, as an agent_round job runs it. */
async function agentRun(runId: string, urls: string[], isolated = true, transport = web().transport) {
  await runs(db).insertOne({ _id: runId, kind: "map", location_id: LOCATION.id, location_name: LOCATION.name, status: "mapped", created_at: T + (await runs(db).countDocuments()), completed_at: T + 600, options: OPTIONS, ...(isolated ? { isolated: true } : {}) } as unknown as PipelineRun);
  const fake = agentModel(urls);
  const context = { db, settings: SETTINGS, transport, fetcher: new Fetcher(transport, undefined, false), location: LOCATION, today: TODAY, log: { info() {}, warn() {}, error() {} }, model: asGemini(fake, "agent"), judgeModel: asGemini(fake, "discovery") } as unknown as DiscoveryContext;
  await withRunContext({ db, runId, locationId: LOCATION.id, options: OPTIONS, runKind: "map", startedAt: T, isolated }, () => agentJob(context, 0));
}
const inRun = <T,>(runId: string, isolated: boolean, operation: () => Promise<T>, options: RunOptions = OPTIONS) => withRunContext({ db, runId, locationId: LOCATION.id, options, runKind: "map", startedAt: T, isolated }, operation);
const stripVolatile = <T extends { last_seen?: string }>(rows: T[]) => rows.map(({ last_seen, ...row }) => row);
const post = (runId: string, body: unknown) => decide(new Request(`https://workspace.example.test/api/admin/locations/${LOCATION.id}/source-runs/${runId}/decisions`, { method: "POST", headers: { origin: "https://workspace.example.test", "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ locationId: LOCATION.id, runId }) });

/** A source on the map from before testing, accepted by a person: test runs must leave it, and everything else on the map, alone. */
async function seedMap() {
  await upsertCandidates(db, LOCATION.id, [{ source_id: "web:old-events", name: "Old events page", url: "https://old.example.org/events", reader: "web", params: {}, section: "events", inside_area: true, found_by: { method: "government", detail: "City site" }, status: "active", topics: ["events"] }]);
  await sourceMap(db).updateOne({ _id: `${LOCATION.id}:web:old-events` }, { $set: { review: { decision: "accept", reason_code: "A1", reason: null, initial_status: "active", by: "owner", at: "2026-10-01T00:00:00Z" } } });
  return sourceMap(db).find({}).toArray();
}

describe("test mode (NEWSBEE_SOURCE_RUNS_ISOLATED)", () => {
  it("is on by default, and off restores runs that write the source map", () => {
    expect(sourceRunsIsolated({})).toBe(true);
    expect(sourceRunsIsolated({ NEWSBEE_SOURCE_RUNS_ISOLATED: "on" })).toBe(true);
    for (const off of ["off", "0", "false", "no"]) expect(sourceRunsIsolated({ NEWSBEE_SOURCE_RUNS_ISOLATED: off })).toBe(false);
  });

  it("an isolated run writes its own store, not the source map, and its agent starts from an empty checklist", async () => {
    const before = await seedMap();
    await agentRun("run-1", [EVENTS]);
    expect(stripVolatile(await sourceMap(db).find({}).toArray())).toEqual(stripVolatile(before));
    const own = await runSources(db, "run-1").find({}).toArray();
    expect(own.map((row) => row.url)).toEqual([EVENTS]);
    expect(own[0]).toMatchObject({ status: "proposed", gemini: { verdict: "accept", reason_code: "A1" } });
    // The map's accepted events page didn't count: the checklist came from this run alone.
    const state = (await db.collection<AgentState>(AGENT_STATE).findOne({ _id: "run-1" }))!;
    expect(state.checklist.events.accepted.map((item) => item.url)).not.toContain("https://old.example.org/events");
    expect(state.checklist.events.accepted.map((item) => item.url)).toContain(EVENTS);
  });

  it("two runs on the same place each keep their own complete results, unchanged by the later run", async () => {
    await agentRun("run-1", [EVENTS]);
    const first = await sourceRunDetail(db, LOCATION.id, "run-1");
    await agentRun("run-2", [EVENTS, POLICE]);
    const second = await sourceRunDetail(db, LOCATION.id, "run-2");
    expect(await sourceRunDetail(db, LOCATION.id, "run-1")).toEqual(first);
    expect(first!.run.isolated).toBe(true);
    expect(first!.pages.filter((row) => row.source_id).map((row) => row.url)).toEqual([EVENTS]);
    expect(second!.pages.filter((row) => row.source_id).map((row) => row.url).sort()).toEqual([EVENTS, POLICE].sort());
    // The second run judged the events page itself rather than keeping the first run's verdict.
    expect(await db.collection(RUN_DECISIONS).countDocuments({ run_id: "run-2", subject: { $regex: "lib.example.org/events" }, decision: "gemini_accepted" })).toBe(1);
    expect(await db.collection(RUN_DECISIONS).countDocuments({ run_id: "run-2", decision: "judgement_kept" })).toBe(0);
    expect(second!.log.length).toBeGreaterThan(0);
    expect(await sourceMap(db).countDocuments({})).toBe(0);
    const list = await sourceRunList(db, LOCATION.id);
    expect(list.runs.map((run) => [run.run_id, run.isolated])).toEqual([["run-2", true], ["run-1", true]]);
    expect(list.completed).toBe(2);
  });

  it("reuses no search results across runs, while runs that write the source map still share the cache", async () => {
    const { transport, requests } = web();
    const query = { db, settings: SETTINGS as never, transport, query: '"Lakeside" library events', topic: "events", family: "agent:dork", stage: "stage1" as const, origin: "agent" as const, provider: "serpapi" as const };
    for (const runId of ["run-1", "run-2"]) await inRun(runId, true, () => search(query));
    expect(requests.filter((request) => request.url.startsWith("https://serpapi.com/"))).toHaveLength(2);
    // Within one run, a repeat is still the same search.
    await inRun("run-2", true, () => search(query));
    expect(requests.filter((request) => request.url.startsWith("https://serpapi.com/"))).toHaveLength(2);
    // Runs that write the source map share the cache, as today.
    const other = { ...query, query: '"Lakeside" police news' };
    for (const runId of ["old-1", "old-2"]) await inRun(runId, false, () => search(other));
    expect(requests.filter((request) => request.url.startsWith("https://serpapi.com/"))).toHaveLength(3);
  });

  it("finds lists of sources again, while facts about the place itself may be reused", async () => {
    let built = 0;
    const build = async () => { built += 1; return { items: [{ name: `built ${built}` }] }; };
    await cachedDiscovery(db, LOCATION.id, "newsrooms", 30, build);
    await cachedDiscovery(db, LOCATION.id, "area", 30, build);
    expect(built).toBe(2);
    await inRun("run-1", true, async () => {
      expect((await cachedDiscovery(db, LOCATION.id, "newsrooms", 30, build)).items).toEqual([{ name: "built 3" }]);
      expect((await cachedDiscovery(db, LOCATION.id, "area", 30, build)).items).toEqual([{ name: "built 2" }]);
    });
    // A run that writes the map reuses the saved newsroom list, which the test run left as it was.
    expect((await cachedDiscovery(db, LOCATION.id, "newsrooms", 30, build)).items).toEqual([{ name: "built 1" }]);
  });

  it("carries a decision across runs by page, past and future, with bulk decisions too, and gives it to the model check", async () => {
    await agentRun("run-1", [EVENTS, POLICE]);
    const events = (await runSources(db, "run-1").findOne({ url: EVENTS }))!;
    const police = (await runSources(db, "run-1").findOne({ url: POLICE }))!;
    const response = await post("run-1", { source_ids: [events.source_id], decision: "reject", reason_code: "R2" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ saved: [{ source_id: events.source_id, status: "rejected", review: { decision: "reject", reason_code: "R2" } }], failed: [] });
    expect(await pageDecisions(db).findOne({ location_id: LOCATION.id, key: "lib.example.org/events" })).toMatchObject({ decision: "reject", reason_code: "R2", run_id: "run-1" });
    // Bulk: one decision for several pages, each saved on its own; one that can't be saved is reported.
    const bulk = await post("run-1", { source_ids: [police.source_id, "web:missing"], decision: "accept", reason_code: "A1" });
    expect(await bulk.json()).toMatchObject({ saved: [{ source_id: police.source_id, status: "active" }], failed: [{ source_id: "web:missing", detail: "Unknown source: web:missing" }] });
    expect((await post("run-1", { source_ids: [police.source_id, events.source_id], decision: "accept" })).status).toBe(400);
    // The run's own records and the source map stay as the run left them.
    expect((await runSources(db, "run-1").find({}).toArray()).map((row) => row.status)).toEqual(["proposed", "proposed"]);
    expect(await sourceMap(db).countDocuments({})).toBe(0);

    // A later run finds the accepted page again and shows the decision on its row; it doesn't propose the rejected page again.
    await agentRun("run-2", [POLICE, EVENTS]);
    expect((await sourceRunDetail(db, LOCATION.id, "run-2"))!.pages.find((row) => row.url === POLICE)).toMatchObject({ decision: { decision: "accept", reason_code: "A1" }, status: "active" });
    const refused = (await db.collection<AgentState>(AGENT_STATE).findOne({ _id: "run-2" }))!.steps.find((step) => step.action === "propose" && step.url === EVENTS);
    expect(refused).toMatchObject({ outcome: "refused" });
    expect(refused!.result).toMatch(/rejected this page in an earlier run/);

    // A decision changed in the later run shows in the earlier one too: it belongs to the page.
    const again = (await runSources(db, "run-2").findOne({ url: POLICE }))!;
    expect((await post("run-2", { source_ids: [again.source_id], decision: "reject", reason_code: "R4" })).status).toBe(200);
    const first = (await sourceRunDetail(db, LOCATION.id, "run-1"))!;
    expect(first.pages.find((row) => row.url === POLICE)).toMatchObject({ decision: { decision: "reject", reason_code: "R4" }, status: "rejected", disagrees: true });
    expect(first.pages.find((row) => row.url === EVENTS)).toMatchObject({ decision: { decision: "reject", reason_code: "R2" }, status: "rejected", disagrees: true });

    // Every decision is in the review history, which the model check takes its examples from.
    expect(await db.collection(SOURCE_REVIEWS).countDocuments({ location_id: LOCATION.id })).toBe(3);
    const examples = (await pastDecisions(db, LOCATION.id, ["events", "safety"])).join("\n");
    expect(examples).toMatch(/Rejected \(R2[^\n]*lib\.example\.org\/events/);
    expect(examples).toMatch(/Rejected \(R4[^\n]*police\.example\.gov\/news/);
  });

  it("with the setting off, a run writes the source map as today, its rows read the map, and decisions go through All sources", async () => {
    await agentRun("old-run", [EVENTS], false);
    expect((await sourceMap(db).find({}).toArray()).map((row) => row.url)).toEqual([EVENTS]);
    expect(await db.listCollections({ name: "source_run_old-run" }).toArray()).toHaveLength(0);
    const detail = (await sourceRunDetail(db, LOCATION.id, "old-run"))!;
    expect(detail.run.isolated).toBe(false);
    expect(detail.pages.find((row) => row.url === EVENTS)).toMatchObject({ status: "proposed", decision: { decision: null } });
    const source = (await sourceMap(db).findOne({ url: EVENTS }))!;
    const refused = await post("old-run", { source_ids: [source.source_id], decision: "accept", reason_code: "A1" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).detail).toMatch(/decide its sources in All sources/);
  });

  it("starts a test-mode run with every fixed reader, and with the setting off only the due ones, as today", async () => {
    const deps = { db, settings: loadSettings({}) } as unknown as OrchestratorDeps;
    const due = METHODS.map((definition) => definition.method);
    await discoveryState(db).insertOne({ _id: `${LOCATION.id}:${due[0]}`, location_id: LOCATION.id, method: due[0], label: "", last_run_at: T, ok: true, found: 0, added: 0, detail: "", next_due_at: T + 86400 });
    const isolated = (await startMapRun(deps, LOCATION.id, { by: "owner", kind: "manual" }, {}, false)).run;
    expect(isolated).toMatchObject({ kind: "map", isolated: true, discovery: due });
    await runs(db).deleteMany({});
    vi.stubEnv("NEWSBEE_SOURCE_RUNS_ISOLATED", "off");
    const writing = (await startMapRun(deps, LOCATION.id, { by: "owner", kind: "manual" }, {}, false)).run;
    expect(writing.isolated).toBeUndefined();
    expect(writing.discovery).toEqual(due.slice(1));
  });

  it("ends a test-mode run without saving addresses or moving the location's map version; off ends it as today", async () => {
    const deps = { db, settings: loadSettings({}) } as unknown as OrchestratorDeps;
    await db.collection(COLLECTIONS.locations).updateOne({ _id: LOCATION.id as never }, { $set: { source_map_version: 4 } });
    for (const [runId, isolated] of [["run-1", true], ["old-run", false]] as const) {
      await runs(db).insertOne({ _id: runId, kind: "map", location_id: LOCATION.id, location_name: LOCATION.name, status: "mapping", created_at: T, today: TODAY, window: [TODAY, TODAY], options: OPTIONS, sources: [], draft_id: null, edition_id: null, ...(isolated ? { isolated: true } : {}) } as unknown as PipelineRun);
      await inRun(runId, isolated, () => upsertCandidates(db, LOCATION.id, [{ source_id: "web:events", name: "Events", url: EVENTS, reader: "web", params: {}, section: "events", inside_area: true, found_by: { method: "agent", detail: "Agent" }, status: "proposed", topics: ["events"] }]));
      const id = await enqueue(db, { kind: "finish_map", run_id: runId, location_id: LOCATION.id, payload: { step: 0 }, dedupe_key: `finish_map:${runId}:0` });
      await executeJob(deps, (await db.collection(COLLECTIONS.jobs).findOne({ _id: id as never }))! as never);
      const run = (await getRun(db, runId))!;
      expect(run.status).toBe("mapped");
      expect(run.category_coverage?.find((row) => row.category === "events")?.found).toBe(1);
      expect((await db.collection(COLLECTIONS.locations).findOne({ _id: LOCATION.id as never }))!.source_map_version).toBe(isolated ? 4 : 5);
      expect(await sourceMap(db).countDocuments({})).toBe(isolated ? 0 : 1);
    }
  });
});
