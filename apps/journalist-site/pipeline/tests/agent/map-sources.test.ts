import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentJob, AGENT_STATE, gridOf, ROUND_PROPOSALS, roundCalls, TRIAGE_CATEGORIES, TRIAGE_RESULTS, triageChunks, type AgentState } from "../../agent/map-sources";
import { Fetcher } from "../../connectors/fetcher";
import type { LocationProfile } from "../../connectors/types";
import type { HttpRequest, HttpTransport } from "../../core/http";
import { resolveRunOptions, withRunContext, type RunOptions } from "../../core/run-options";
import { openPage } from "../../discovery/evaluate";
import { checkAndSave, PENDING_CHECKS } from "../../discovery/gemini-check";
import type { DiscoveryContext } from "../../discovery/methods";
import { UsageRecordingRuntime, type ModelRuntime } from "../../model/runtime";
import { normaliseUrl, pageDecisions, sourceMap, type SourceCandidate } from "../../sourcemap/store";
import { RUN_DECISIONS } from "../../trace/decisions";
import { ensureApiCallIndexes, HARD_LIMITS, limitWindow, type HardLimit } from "../../trace/gateway";
import { FakeModel, type FakeCall } from "../support/fake-model";

// The made-up sites have no DNS, and nothing here needs pacing.
vi.mock("../../connectors/public-http", async (original) => ({ ...await original<object>(), publicSourceTransport: (transport: HttpTransport) => transport }));
vi.mock("../../connectors/fetch-state", async (original) => ({ ...await original<object>(), reserveHost: async () => 0 }));

const TODAY = "2026-11-06";
const LOCATION = { id: "loc", name: "Lakeside, WA", state: "WA", latitude: 47.6, longitude: -122.3, systems: [], government: null } as unknown as LocationProfile;
const DIRECTORY_HABIT = "Before searching widely, look for the official directories that cover this place";
const listing = (title: string, links: Array<[string, string]> = [], dates = ["November 2, 2026", "October 19, 2026", "October 5, 2026"]) =>
  `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${"Lakeside residents' notices and news. ".repeat(30)}</p><ul>${dates.map((date) => `<li>${date}</li>`).join("")}</ul>${links.map(([href, text]) => `<a href="${href}">${text}</a>`).join("\n")}</main></body></html>`;

/** A made-up web, with the search services answering from `results`. Every request is kept. */
function web(pages: Record<string, string | number>, results: (service: string, query: string) => Array<{ url: string; title: string }> | null = () => []) {
  const requests: HttpRequest[] = [];
  const json = (request: HttpRequest, value: unknown) => ({ url: request.url, status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(value)) });
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    const url = new URL(request.url);
    const body = request.body ? JSON.parse(String(request.body)) as Record<string, unknown> : {};
    // A search service that answers null fails with HTTP 500.
    const service = url.host === "serpapi.com" ? ["serpapi", url.searchParams.get("q") ?? ""] : request.url === "https://api.exa.ai/search" ? ["exa", String(body.query)] : request.url === "https://api.tavily.com/search" ? ["tavily", String(body.query)] : null;
    const answered = service ? results(service[0], service[1]) : null;
    if (service && answered === null) return { url: request.url, status: 500, headers: {}, body: new Uint8Array() };
    if (url.host === "serpapi.com") return json(request, { organic_results: (answered ?? []).map((row) => ({ link: row.url, title: row.title, snippet: "From SerpApi" })) });
    if (request.url === "https://api.exa.ai/findSimilar") return json(request, { results: (results("exa-similar", String(body.url)) ?? []).map((row) => ({ url: row.url, title: row.title, highlights: ["Exa similar page"] })), costDollars: { total: 0.005 } });
    if (url.host === "api.exa.ai") return json(request, { results: (answered ?? []).map((row) => ({ url: row.url, title: row.title, highlights: ["Exa page text"] })), costDollars: { total: 0.005 } });
    if (request.url === "https://api.tavily.com/search") return json(request, { results: (answered ?? []).map((row) => ({ url: row.url, title: row.title, content: "Tavily page text" })) });
    if (request.url === "https://api.tavily.com/map") return json(request, { base_url: body.url, results: (results("explore", String(body.instructions)) ?? []).map((row) => row.url) });
    if (url.host === "r.jina.ai") {
      const target = request.url.slice("https://r.jina.ai/".length);
      return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(`Title: Read by Jina\n\nMarkdown Content:\n# ${target}\nLakeside calendar. ${"Lakeside events and programmes for families. ".repeat(20)}\nNovember 2, 2026\nOctober 19, 2026\nOctober 5, 2026`) };
    }
    if (url.pathname === "/robots.txt") return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode("User-agent: *\nDisallow:\n") };
    const page = pages[request.url];
    if (typeof page === "number") return { url: request.url, status: page, headers: {}, body: new Uint8Array() };
    if (page === undefined) return { url: request.url, status: 404, headers: {}, body: new Uint8Array() };
    return { url: request.url, status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode(page) };
  };
  return { transport, requests };
}

type PlanEntry = { category: string; angle?: string; angle_reason?: string; searches: Array<{ tool: string; query?: string; url?: string; instruction?: string }> };
type Turn = { category: string; tool: string; angle: string };
type Item = { id: string; url: string; category: string; carried: boolean };

/** This round's turns, read back from the plan prompt. */
function turnsOf(prompt: string): Turn[] {
  const block = prompt.split("This round's turns")[1]?.split("\n\n")[0] ?? "";
  return block.split("\n").flatMap((line) => {
    const match = /^- (\w+): (.*)$/.exec(line);
    if (!match) return [];
    return match[2].split("; ").flatMap((part) => { const turn = /^(\w+) runs (\w+)/.exec(part); return turn ? [{ category: match[1], tool: turn[1], angle: turn[2] }] : []; });
  });
}
/** The results a triage prompt lists, with their ids and categories. */
function itemsOf(prompt: string): Item[] {
  const items: Item[] = [];
  let category = "";
  for (const line of prompt.split("Results by category")[1]?.split("\n") ?? []) {
    const heading = /^(\w+) \(/.exec(line);
    if (heading) category = heading[1];
    const item = /^\[(r\d+-\d+)\] (\S+)/.exec(line);
    if (item) items.push({ id: item[1], url: item[2], category, carried: line.includes("carried over") });
  }
  return items;
}
const FAMILIES = ["geography", "institutions", "publisher", "format", "item_type", "time", "language", "directories"];
const QUERY: Record<string, (category: string, family: string) => string> = {
  dork: (category, family) => `"Lakeside" ${category} ${family}`,
  exa: (category, family) => `Lakeside ${category} pages on ${family}`,
  tavily: (category, family) => `Where are Lakeside ${category} ${family}?`,
};
/** A plan for every turn: the anchor where it's due, else the category's next family from FAMILIES, with a query for each tool. */
function autoPlan(prompt: string, used: Map<string, number>, change: (entries: PlanEntry[], turns: Turn[]) => PlanEntry[] = (entries) => entries) {
  const turns = turnsOf(prompt);
  const entries = [...new Set(turns.map((turn) => turn.category))].map((category): PlanEntry => {
    const mine = turns.filter((turn) => turn.category === category);
    const fresh = mine.some((turn) => turn.angle === "new") ? FAMILIES[used.get(category) ?? 0] : undefined;
    if (fresh) used.set(category, (used.get(category) ?? 0) + 1);
    return { category, ...(fresh ? { angle: fresh, angle_reason: `try ${fresh} next` } : {}), searches: mine.map((turn) => turn.angle === "anchor" ? { tool: turn.tool } : { tool: turn.tool, query: QUERY[turn.tool](category, turn.angle === "new" ? fresh! : turn.angle) }) };
  });
  return { categories: change(entries, turns) };
}

/**
 * The agent's model, by call: the round's plan (`plan`, by default `autoPlan`), triage (`triage`,
 * by default propose what `propose` matches) and the model check (accept unless `reject` matches).
 * Every call is kept, by kind.
 */
function rounds(options: { plan?: (prompt: string, round: number, used: Map<string, number>) => unknown; triage?: (items: Item[], prompt: string) => unknown; propose?: RegExp; reject?: RegExp } = {}) {
  const calls = { plan: [] as string[], triage: [] as string[], check: [] as string[] };
  const used = new Map<string, number>();
  const fake = new FakeModel((request: FakeCall) => {
    if (/one verdict per source id/.test(request.prompt)) {
      calls.check.push(request.prompt);
      const blocks = request.prompt.split("\n\nSource id: ").slice(1);
      return { verdicts: blocks.map((block) => {
        const verdict = options.reject?.test(block) ? "reject" : "accept";
        return { id: block.split("\n")[0], verdict, reason_code: verdict === "accept" ? "A1" : "R3", evidence: "Latest dated item: 2026-11-02", reason: verdict === "accept" ? "Publishes local notices" : "Home page only" };
      }) };
    }
    if (/You are triaging search results/.test(request.prompt)) {
      calls.triage.push(request.prompt);
      const items = itemsOf(request.prompt);
      return options.triage ? options.triage(items, request.prompt) : { decisions: items.map((item) => options.propose?.test(item.url) ? { id: item.id, action: "propose", category: item.category } : { id: item.id, action: "skip", why: "not a local listing" }) };
    }
    calls.plan.push(request.prompt);
    return options.plan ? options.plan(request.prompt, calls.plan.length, used) : autoPlan(request.prompt, used);
  });
  return { fake, calls };
}
/** Fakes the gateway counts as Gemini, so its hard limits and the run's budgets apply. */
function asGemini(fake: FakeModel, role: string): ModelRuntime {
  const inner: ModelRuntime = { provider: "gemini", model: "flash-lite", health: () => fake.health(), generate: (prompt) => fake.generate(prompt), generateStructured: (prompt, schema, options) => fake.generateStructured(prompt, schema, options) };
  return new UsageRecordingRuntime(inner, { role, sink: () => undefined }, { info() {}, warn() {}, error() {} } as never);
}

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("agent"); });
afterAll(async () => { await client.close(); await server.stop(); });
const saved = { ...HARD_LIMITS };
const setLimits = (limits: Record<string, HardLimit>) => { for (const key of Object.keys(HARD_LIMITS)) delete HARD_LIMITS[key]; Object.assign(HARD_LIMITS, limits); };
// No pacing unless a test sets a limit.
beforeEach(async () => { await db.dropDatabase(); await ensureApiCallIndexes(db); setLimits({}); });
afterEach(() => { setLimits(saved); vi.restoreAllMocks(); });

const SETTINGS = { integrations: { serpapiKey: "k", exaKey: "k" }, tavilySearchApiKey: "k", modelProviders: [] };
const PAID = { serpapi: 100, exa: 100, tavily: 100, gemini: 1000, agent_model: 1000 };
const ONLY_DORK = { serpapi: 100, gemini: 1000, agent_model: 1000 };
function setup(transport: HttpTransport, fake: FakeModel, choices: Partial<RunOptions> = {}, settings: Record<string, unknown> = {}, isolated = false) {
  const options = resolveRunOptions({ flow: "agentic", map_flow: "agentic", search_provider: "serpapi", topics: ["events", "crime"], paid: PAID, ...choices });
  const context = { db, settings: { ...SETTINGS, ...settings }, transport, fetcher: new Fetcher(transport, undefined, false), location: LOCATION, today: TODAY, log: { info() {}, warn() {}, error() {} }, model: asGemini(fake, "agent"), judgeModel: asGemini(fake, "discovery") } as unknown as DiscoveryContext;
  const job = (n = 0, limits: { steps?: number } = {}, runId = "run") => withRunContext({ db, runId, locationId: "loc", options, runKind: "map", startedAt: Date.now() / 1000, ...(isolated ? { isolated: true } : {}) }, () => agentJob(context, n, limits));
  /** Jobs one after another, as the queue runs them, until the agent is done. */
  const run = async (most = 20) => { for (let n = 0; n < most; n += 1) if (!(await job(n)).next) return n + 1; throw new Error("the agent didn't finish"); };
  return { context, options, job, run };
}
const stateOf = async (runId = "run") => (await db.collection<AgentState>(AGENT_STATE).findOne({ _id: runId }))!;
const decisions = (filter: Record<string, unknown>) => db.collection(RUN_DECISIONS).find({ run_id: "run", ...filter }).sort({ at: 1 }).toArray();
const sentDork = (requests: HttpRequest[]) => requests.filter((request) => request.url.startsWith("https://serpapi.com/")).map((request) => new URL(request.url).searchParams.get("q")!).filter((query) => !query.startsWith('"City of'));
const sentExa = (requests: HttpRequest[]) => requests.filter((request) => request.url === "https://api.exa.ai/search").map((request) => JSON.parse(String(request.body)).query as string);
const sentTavily = (requests: HttpRequest[]) => requests.filter((request) => request.url === "https://api.tavily.com/search").map((request) => JSON.parse(String(request.body)).query as string);
/** A source the free readers found and the model check accepted. */
const freeSource = (section: string, url: string) => sourceMap(db).insertOne({ _id: `loc:web:${section}`, location_id: "loc", source_id: `web:${section}`, name: `${section} source`, url, reader: "web", params: {}, section, found_by: { method: "institutions", detail: "x" }, inside_area: false, status: "proposed", gemini: { verdict: "accept" } } as never);

const EVENTS = "https://lib.example.org/events";
const POLICE = "https://police.example.gov/news";
const PAGES: Record<string, string> = { [EVENTS]: listing("Lakeside Library events", [["/events/kids", "Kids events"]]), [POLICE]: listing("Lakeside Police news"), "https://lib.example.org/": listing("Lakeside Library", [["/events", "Events"], ["/branches", "Branch locations"]]) };

describe("rounds", () => {
  it("runs a round as one plan call, the searches, clean-up, triage chunks and model check batches", async () => {
    // 45 listings for events: the round opens 40 and carries 5 to the next round's triage.
    const pages = Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`https://site${index + 1}.example.org/calendar`, listing(`Lakeside calendar ${index + 1}`)]));
    const { transport } = web(pages, (service, query) => service === "serpapi" && /^Lakeside events( |$)/.test(query) ? Object.keys(pages).map((url, index) => ({ url, title: `Calendar ${index + 1}` })) : []);
    const { fake, calls } = rounds({ propose: /calendar/ });
    const { job } = setup(transport, fake, { topics: ["events"], paid: ONLY_DORK });
    // One job, stopped once the first round is scored: plan, search, clean, 2 triage chunks of at most 30, open, judge, score.
    await job(0, { steps: 8 });
    const state = await stateOf();
    expect(state.rounds).toBe(1);
    expect(calls.plan).toHaveLength(1);
    expect(calls.triage).toHaveLength(2);
    expect(calls.check).toHaveLength(2);
    // 40 judged: 25, then 15.
    expect(calls.check.map((prompt) => prompt.split("\n\nSource id: ").length - 1)).toEqual([25, 15]);
    expect(state.sources).toHaveLength(40);
    expect(state.carry?.map((item) => item.url)).toEqual(Object.keys(pages).slice(40));
    expect(state.steps.filter((step) => step.round === 1).map((step) => step.action)).toEqual(["plan", "search", "triage", "triage", "propose", "check", "score"]);
    expect(state.steps.at(-1)?.result).toMatch(/Calls: 1 plan, 2 triage, 2 model check/);
    // The next round's triage sees the 5 carried over first.
    await job(1, { steps: 4 });
    const next = itemsOf(calls.triage[2]);
    expect(next.slice(0, 5)).toEqual(Object.keys(pages).slice(40).map((url) => expect.objectContaining({ url, carried: true })));
  });

  it("gives every result a triage decision: the agent's, or code's skip when it gave none", async () => {
    const { transport } = web(PAGES, (service, query) => service === "serpapi" && /^Lakeside events/.test(query) ? [{ url: EVENTS, title: "Library events" }, { url: "https://news.example.com/lakeside", title: "A story" }, { url: "https://blog.example.net/", title: "A blog" }] : []);
    const { fake } = rounds({ triage: (items) => ({ decisions: items.filter((item) => !item.url.includes("blog")).map((item) => item.url === EVENTS ? { id: item.id, action: "propose", category: "events" } : { id: item.id, action: "skip", why: "one story, not a listing, just a single news item" }) }) });
    const { job } = setup(transport, fake, { topics: ["events"], paid: ONLY_DORK });
    await job(0, { steps: 4 });
    const round = (await stateOf()).round!;
    expect(Object.values(round.decisions).map((row) => [row.action, row.why, row.by])).toEqual([["propose", "", "agent"], ["skip", "one story, not a listing, just a single", "agent"], ["skip", "no decision from the agent", "code"]]);
    // The skip reasons are kept on the leads, for the Every page tab.
    const state = await stateOf();
    expect(state.leads.find((lead) => lead.url === "https://blog.example.net/")?.skipped).toMatchObject({ why: "no decision from the agent", by: "code" });
  });

  it("resumes at the saved step after a job ends between steps, repeating no call", async () => {
    const { transport, requests } = web(PAGES, (service, query) => service === "serpapi" && /^Lakeside events/.test(query) ? [{ url: EVENTS, title: "Library events" }] : []);
    const { fake, calls } = rounds({ propose: /lib\.example\.org/ });
    const { job } = setup(transport, fake, { topics: ["events"], paid: ONLY_DORK });
    // A job per step: each ends between two steps, and the next carries on.
    const stages: string[] = [];
    for (let n = 0; n < 7; n += 1) { await job(n, { steps: 1 }); stages.push((await stateOf()).round?.stage ?? "none"); }
    // After the score, round 2 starts at its plan.
    expect(stages).toEqual(["search", "clean", "triage", "open", "judge", "score", "plan"]);
    expect((await stateOf()).rounds).toBe(1);
    expect([calls.plan.length, calls.triage.length, calls.check.length]).toEqual([1, 1, 1]);
    expect(sentDork(requests)).toEqual([expect.stringMatching(/^Lakeside events /)]);
    expect(requests.filter((request) => request.url === EVENTS)).toHaveLength(1);
  });

  it("doesn't start a model step with less than the playbook's reserve left in the job", async () => {
    const { transport } = web(PAGES);
    const { fake, calls } = rounds();
    let offset = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    // The plan call takes 160 of the job's 200 seconds: the search still fits, but the next plan waits for the next job.
    const wrapped = fake.generateStructured.bind(fake);
    fake.generateStructured = async (prompt, schema, options) => { offset += 160_000; return wrapped(prompt, schema, options); };
    const { job } = setup(transport, fake, { topics: ["events"], paid: ONLY_DORK });
    expect(await job(0)).toMatchObject({ next: true, rounds: 1, stage: "plan" });
    expect(calls.plan).toHaveLength(1);
  });

  it("stops before a round the model budget left can't cover, and says why", async () => {
    // Round 1 takes a plan, a triage and a check call; another round needs about 4 of the 6.
    setLimits({ gemini: { per_run: 6 } });
    const { transport } = web(PAGES, (service, query) => service === "serpapi" && /^Lakeside events/.test(query) ? [{ url: EVENTS, title: "Library events" }] : []);
    const { fake, calls } = rounds({ propose: /lib\.example\.org/ });
    const { run } = setup(transport, fake, { topics: ["events"], paid: ONLY_DORK });
    await run();
    const state = await stateOf();
    expect(state.rounds).toBe(1);
    expect(calls.plan).toHaveLength(1);
    expect(state.stopped_by).toMatchObject({ limit: "model_budget", reason: expect.stringMatching(/the model budget left can't cover another full round \(about 4 calls\): Gemini has 3 calls left/) });
    expect(state.finished?.reason).toMatch(/with 1 cell still open/);
  });
});

describe("cells and turns", () => {
  it("dries a dork cell after 2 misses and an Exa or Tavily cell after 3, then stops", async () => {
    const { transport } = web(PAGES);
    const { fake, calls } = rounds();
    const { run } = setup(transport, fake, { topics: ["events"] });
    await run();
    const state = await stateOf();
    expect(gridOf(state, ["events"], ["dork", "exa", "tavily"]).cells.map((cell) => [cell.tool, cell.status, cell.searches, cell.why])).toEqual([
      ["dork", "dry", 2, "2 searches in a row found no new accepted site"], ["exa", "dry", 3, "3 searches in a row found no new accepted site"], ["tavily", "dry", 3, "3 searches in a row found no new accepted site"],
    ]);
    expect(state).toMatchObject({ rounds: 3, cell_dry: 3, cell_dry_dork: 2, depth: "exhaustive", finished: { reason: "every cell is dry or unavailable" } });
    expect(calls.plan).toHaveLength(3);
    // Round 3 has only Exa's and Tavily's turns: dork is dry.
    expect(turnsOf(calls.plan[2]).map((turn) => turn.tool)).toEqual(["exa", "tavily"]);
  });

  it("gives every open cell its turn before any takes another, and refuses a search out of turn", async () => {
    // Crime's round-2 Exa search fails, so crime × exa falls a turn behind.
    let failed = false;
    const { transport } = web(PAGES, (service, query) => { if (service === "exa" && /crime/.test(query) && /geography/.test(query) && !failed) { failed = true; return null; } return []; });
    const { fake, calls } = rounds({
      // Round 3: events × exa asks for a turn it doesn't have yet.
      plan: (prompt, round, used) => autoPlan(prompt, used, (entries) => round === 3 ? [...entries, { category: "events", angle: "publisher", angle_reason: "again", searches: [{ tool: "exa", query: "Lakeside events pages on publisher" }] }] : entries),
    });
    const { job } = setup(transport, fake, { topics: ["events", "crime"], paid: { exa: 100, gemini: 1000, agent_model: 1000 } });
    for (let n = 0; n < 3; n += 1) await job(n, { steps: n === 0 ? 4 : 3 });
    const state = await stateOf();
    expect(state.steps.find((step) => step.round === 2 && step.category === "crime" && step.tool === "exa")).toMatchObject({ outcome: "failed" });
    expect(turnsOf(calls.plan[2])).toEqual([{ category: "crime", tool: "exa", angle: "geography" }]);
    expect(calls.plan[2]).toContain("Waiting for their turn (don't plan these): events × exa");
    expect(state.steps.find((step) => step.round === 3 && step.outcome === "refused")?.result).toBe("Search refused: exa must give crime their turn first.");
    expect(gridOf(state, ["events", "crime"], ["exa"]).cells.filter((cell) => cell.tool === "exa").map((cell) => [cell.category, cell.searches, cell.waiting])).toEqual([["events", 2, false], ["crime", 2, false]]);
  });

  it("counts a refused turn as a miss, so a cell whose queries keep breaking a rule goes dry instead of holding its tool back", async () => {
    // QA's case: Council × Dorking's query is refused every round, as not local.
    const { transport } = web(PAGES);
    const { fake } = rounds({ plan: (prompt, round, used) => autoPlan(prompt, used, (entries) => entries.map((entry) => entry.category === "government" ? { ...entry, searches: entry.searches.map((search) => search.query ? { ...search, query: "Washington council agendas" } : search) } : entry)) });
    const { run } = setup(transport, fake, { topics: ["events", "government"], paid: ONLY_DORK });
    await run();
    const state = await stateOf();
    const cells = gridOf(state, ["events", "government"], ["dork"]).cells.filter((cell) => cell.tool === "dork");
    expect(cells.map((cell) => [cell.category, cell.status, cell.searches, cell.refused])).toEqual([["events", "dry", 2, 0], ["government", "dry", 2, 1]]);
    expect(cells[1].last_refused).toMatch(/it must name Lakeside/);
    expect(state.finished?.reason).toBe("every cell is dry or unavailable");
    expect(state.searches?.find((row) => row.category === "government" && row.round === 2)).toMatchObject({ results: 0, refused: expect.stringMatching(/must name Lakeside/) });
  });

  it("splits each tool's cap evenly: with Dorking's 20 and 10 categories, each gets 2", async () => {
    const { transport } = web(PAGES);
    const { fake } = rounds();
    const all = ["crime", "deaths", "events", "home_sales", "sports", "government", "schools", "business", "community", "news"] as const;
    const { job } = setup(transport, fake, { topics: [...all], paid: { serpapi: 20, exa: 60, tavily: 60, gemini: 1000, agent_model: 1000 } });
    await job(0, { steps: 0 });
    const state = await stateOf();
    expect(state.caps).toEqual({ dork: 20, exa: 60, tavily: 60 });
    const grid = gridOf(state, [...all], ["dork", "exa", "tavily"]);
    expect([...new Set(grid.cells.map((cell) => `${cell.tool}:${cell.share}`))]).toEqual(["dork:2", "exa:6", "tavily:6"]);
  });
});

describe("what the tools find", () => {
  it("leaves out every site the free readers found: no triage, no check, no hit", async () => {
    await freeSource("events", "https://cc.example.org/calendar");
    const { transport } = web({ ...PAGES, "https://cc.example.org/other": listing("Another") }, (service, query) => service === "serpapi" && /^Lakeside events/.test(query) ? [{ url: "https://cc.example.org/other", title: "Another cc page" }, { url: EVENTS, title: "Library events" }] : []);
    const { fake, calls } = rounds({ propose: /./ });
    const { job } = setup(transport, fake, { topics: ["events"], paid: ONLY_DORK });
    await job(0, { steps: 7 });
    const state = await stateOf();
    expect(state.free_hosts).toEqual(["cc.example.org"]);
    expect(itemsOf(calls.triage[0]).map((item) => item.url)).toEqual([EVENTS]);
    expect(state.leads.find((lead) => lead.url === "https://cc.example.org/other")?.skipped).toMatchObject({ why: "a site the free readers already found", by: "code" });
    expect(state.sources.map((source) => source.host)).toEqual(["lib.example.org"]);
  });

  it("finishes the free readers' model checks before round 1", async () => {
    const { transport } = web(PAGES);
    const { fake, calls } = rounds();
    const order: string[] = [];
    const wrapped = fake.generateStructured.bind(fake);
    fake.generateStructured = async (prompt, schema, options) => { order.push(/one verdict per source id/.test(prompt) ? "check" : /triaging/.test(prompt) ? "triage" : "plan"); return wrapped(prompt, schema, options); };
    const { context, options, job } = setup(transport, fake, { topics: ["events"], paid: ONLY_DORK });
    const calendar: SourceCandidate = { source_id: "web:calendar00001", name: "Lakeside community calendar", url: "https://cc.example.org/calendar", feed_url: null, reader: "web", params: { url: "https://cc.example.org/calendar" }, section: "events",
      found_by: { method: "institutions", detail: "Local institution site" }, inside_area: false, status: "active", source_kind: "calendar", latest_day: "2026-11-02", judge_input: { text: "Lakeside events this week: storytime, farmers market.", titles: [], recent: 3 } };
    // A free reader whose time ran out before the check reached it.
    await withRunContext({ db, runId: "run", locationId: "loc", options, runKind: "map", startedAt: Date.now() / 1000 }, () => checkAndSave(context, [calendar], { route: "institutions", deadline: Date.now() - 1 }));
    expect(await db.collection(PENDING_CHECKS).countDocuments()).toBe(1);
    await job(0, { steps: 1 });
    expect(order).toEqual(["check", "plan"]);
    expect(calls.check).toHaveLength(1);
    const state = await stateOf();
    expect(state.checklist.events.accepted.map((item) => item.name)).toContain("Lakeside community calendar");
    expect(state.start_hosts).toEqual(["cc.example.org"]);
  });

  it("lists a page several tools found once, credits each tool, and counts one new source as a hit for each", async () => {
    const { transport } = web(PAGES, (service, query) => (service === "serpapi" || service === "exa") && /^Lakeside events/.test(query) ? [{ url: EVENTS, title: "Library events" }] : []);
    const { fake, calls } = rounds({ propose: /lib\.example\.org/ });
    const { job } = setup(transport, fake, { topics: ["events"], paid: { serpapi: 100, exa: 100, gemini: 1000, agent_model: 1000 } });
    await job(0, { steps: 7 });
    const state = await stateOf();
    expect(itemsOf(calls.triage[0])).toHaveLength(1);
    expect(calls.triage[0]).toContain("(found by dork, exa)");
    expect(state.sources).toEqual([expect.objectContaining({ host: "lib.example.org", tools: ["dork", "exa"], good: true, credits: [expect.objectContaining({ tool: "dork", category: "events" }), expect.objectContaining({ tool: "exa", category: "events" })] })]);
    expect(state.leads.find((lead) => lead.url === EVENTS)?.tools).toEqual(["dork", "exa"]);
    const grid = gridOf(state, ["events"], ["dork", "exa"]);
    expect(grid.hits).toBe(1);
    expect(grid.cells.filter((cell) => cell.tool !== "tavily").map((cell) => [cell.tool, cell.hits, cell.dry_streak])).toEqual([["dork", 1, 0], ["exa", 1, 0]]);
  });

  it("gives a hit to the category the source is filed under, not the one that searched", async () => {
    const SCHOOL = "https://hale.example.edu/news";
    const { transport } = web({ ...PAGES, [SCHOOL]: listing("Nathan Hale news") }, (service, query) => service === "exa" && /sports/.test(query) ? [{ url: SCHOOL, title: "Nathan Hale news" }] : []);
    const { fake } = rounds({ triage: (items) => ({ decisions: items.map((item) => ({ id: item.id, action: "propose", category: "schools" })) }) });
    const { job } = setup(transport, fake, { topics: ["sports", "schools"], paid: { exa: 100, gemini: 1000, agent_model: 1000 } });
    await job(0, { steps: 7 });
    const state = await stateOf();
    expect(state.sources[0]).toMatchObject({ category: "schools", searched: "sports", credits: [expect.objectContaining({ tool: "exa", category: "schools", searched: "sports" })] });
    const cells = gridOf(state, ["sports", "schools"], ["exa"]).cells.filter((cell) => cell.tool === "exa");
    expect(cells.map((cell) => [cell.category, cell.searches, cell.hits, cell.dry_streak, cell.found_elsewhere])).toEqual([["sports", 1, 0, 1, {}], ["schools", 1, 1, 0, { sports: 1 }]]);
    expect((await sourceMap(db).findOne({ url: SCHOOL }))?.section).toBe("schools");
  });

  it("finds more like an accepted source with Exa's find-similar, as Exa's search in that cell for the round", async () => {
    await freeSource("events", "https://cc.example.org/calendar");
    const { transport, requests } = web(PAGES, (service, query) => service === "exa-similar" && query === "https://cc.example.org/calendar" ? [{ url: "https://arts.example.org/calendar", title: "Arts calendar" }] : []);
    const { fake } = rounds({ plan: (prompt, round, used) => autoPlan(prompt, used, (entries) => round === 2 ? entries.map((entry) => ({ ...entry, angle: "more_like_this", angle_reason: "the community centre calendar was accepted", searches: entry.searches.map((search) => search.tool === "exa" ? { tool: "exa" } : { ...search, query: '"cc.example.org" Lakeside events links' }) })) : entries) });
    const { job } = setup(transport, fake, { topics: ["events"], paid: { serpapi: 100, exa: 100, gemini: 1000, agent_model: 1000 } });
    await job(0, { steps: 4 });
    await job(1, { steps: 2 });
    const state = await stateOf();
    expect(JSON.parse(String(requests.find((request) => request.url === "https://api.exa.ai/findSimilar")!.body))).toMatchObject({ url: "https://cc.example.org/calendar", excludeSourceDomain: true, excludeDomains: expect.arrayContaining(["facebook.com"]) });
    expect(state.searches?.filter((row) => row.tool === "exa").map((row) => [row.round, row.angle, row.query])).toEqual([[1, "anchor", "Lakeside events"], [2, "more_like_this", "similar to https://cc.example.org/calendar"]]);
    expect(state.steps.find((step) => step.action === "similar")).toMatchObject({ outcome: "ok", tool: "exa", round: 2 });
  });

  it("explores a confirmed hub site as Tavily's tool-native search for the round, and refuses one nobody confirmed", async () => {
    await freeSource("events", "https://lib.example.org/");
    const { transport, requests } = web(PAGES, (service) => service === "explore" ? [{ url: "https://lib.example.org/branches", title: "" }] : []);
    const native = (url: string) => (entries: PlanEntry[]) => entries.map((entry) => ({ ...entry, angle: "tool_native", angle_reason: "the library is the hub", searches: [{ tool: "tavily", url, instruction: "find the branch events calendars" }] }));
    const { fake } = rounds({ plan: (prompt, round, used) => autoPlan(prompt, used, round === 2 ? native("https://unknown.example.net/") : round === 3 ? native("https://lib.example.org/") : (entries) => entries) });
    const { job } = setup(transport, fake, { topics: ["events"], paid: { tavily: 100, gemini: 1000, agent_model: 1000 } });
    for (let n = 0; n < 3; n += 1) await job(n, { steps: n === 0 ? 4 : 3 });
    const state = await stateOf();
    expect(state.steps.find((step) => step.round === 2 && step.outcome === "refused" && step.action === "search")?.result).toMatch(/unknown\.example\.net isn't a confirmed site/);
    expect(JSON.parse(String(requests.find((request) => request.url === "https://api.tavily.com/map")!.body))).toMatchObject({ url: "https://lib.example.org/", instructions: "find the branch events calendars" });
    // Round 2's refused turn is a miss; round 3 explores.
    expect(state.searches?.filter((row) => row.tool === "tavily").map((row) => [row.round, row.angle ?? row.refused])).toEqual([[1, "anchor"], [2, expect.stringMatching(/isn't a confirmed site/)], [3, "tool_native"]]);
  });
});

describe("triage chunks", () => {
  const item = (category: string, n: number, carried = false) => ({ id: `${category}-${n}`, url: `https://${category}${n}.example.org/`, key: `${category}${n}.example.org`, host: `${category}${n}.example.org`, category: category as never, title: "", snippet: "", tools: ["dork" as const], credits: [], query: null, carried });

  it("takes at most 3 categories and 30 results a call, splits a bigger category, and puts carried results first", () => {
    expect([TRIAGE_CATEGORIES, TRIAGE_RESULTS, ROUND_PROPOSALS]).toEqual([3, 30, 40]);
    const topics = ["crime", "deaths", "events", "home_sales", "sports", "government", "schools"] as const;
    const small = triageChunks(topics.flatMap((topic) => [item(topic, 1), item(topic, 2)]), [...topics]);
    expect(small.map((chunk) => chunk.length)).toEqual([6, 6, 2]);
    const big = triageChunks(Array.from({ length: 70 }, (_, n) => item("events", n)), ["events"]);
    expect(big.map((chunk) => chunk.length)).toEqual([30, 30, 10]);
    expect(triageChunks([item("events", 1), item("crime", 1, true)], ["events", "crime"])[0][0]).toBe("crime-1");
  });

  it("budgets a round at one plan call, a triage call per 3 categories, and model check calls of 25", () => {
    expect(roundCalls(10)).toEqual({ agent: 5, judge: 2, total: 7 });
    expect(roundCalls(1)).toEqual({ agent: 2, judge: 2, total: 4 });
  });

  it("reopens a dry cell when another category's search finds a source filed under it, and it rejoins at the current round", async () => {
    const SCHOOL = "https://hale.example.edu/news";
    const leagues = Object.fromEntries([1, 2, 3, 4].map((n) => [`https://league${n}.example.org/`, listing(`Lakeside league ${n}`)]));
    let sportsSearches = 0;
    const { transport } = web({ ...PAGES, ...leagues, [SCHOOL]: listing("Nathan Hale news") }, (service, query) => {
      if (service !== "exa" || !/sports/.test(query)) return [];
      sportsSearches += 1;
      return [{ url: `https://league${sportsSearches}.example.org/`, title: "League" }, ...(sportsSearches === 4 ? [{ url: SCHOOL, title: "Nathan Hale news" }] : [])];
    });
    const { fake, calls } = rounds({ triage: (items) => ({ decisions: items.map((row) => ({ id: row.id, action: "propose", category: row.url === SCHOOL ? "schools" : "sports" })) }) });
    const { job } = setup(transport, fake, { topics: ["sports", "schools"], paid: { exa: 100, gemini: 1000, agent_model: 1000 } });
    // Rounds 1 to 3, then round 4 (sports alone: schools is dry), then round 5's plan.
    for (let n = 0; n < 10 && calls.plan.length < 5; n += 1) await job(n);
    const state = await stateOf();
    expect(state.steps.find((step) => step.action === "score" && step.round === 4)?.result).toMatch(/reopened by a hit: schools × exa/);
    expect(state.rejoin).toEqual({ "schools|exa": 4 });
    expect(turnsOf(calls.plan[3]).map((turn) => turn.category)).toEqual(["sports"]);
    expect(turnsOf(calls.plan[4]).map((turn) => turn.category)).toEqual(["sports", "schools"]);
  });
});

describe("angles in rounds", () => {
  it("runs the same anchor with every tool first, then the next angle the agent picks with every tool", async () => {
    const { transport, requests } = web(PAGES);
    const { fake, calls } = rounds();
    const { job } = setup(transport, fake, { topics: ["events"] });
    await job(0, { steps: 4 });
    await job(1, { steps: 2 });
    const state = await stateOf();
    expect(turnsOf(calls.plan[0])).toEqual(["dork", "exa", "tavily"].map((tool) => ({ category: "events", tool, angle: "anchor" })));
    expect(calls.plan[0]).toContain('- events: no angle yet: it starts with the Anchor, "Lakeside events"');
    expect([sentDork(requests)[0], sentExa(requests)[0], sentTavily(requests)[0]]).toEqual([expect.stringMatching(/^Lakeside events -site:facebook\.com .*-site:legacy\.com( -site:\S+)*$/), "Lakeside events", "Lakeside events"]);
    expect(turnsOf(calls.plan[1]).map((turn) => turn.angle)).toEqual(["new", "new", "new"]);
    expect(state.angles?.events?.map((row) => [row.family, row.reason])).toEqual([["anchor", ""], ["geography", "try geography next"]]);
    expect(gridOf(state, ["events"], ["dork", "exa", "tavily"]).cells.map((cell) => cell.angles)).toEqual([["anchor", "geography"], ["anchor", "geography"], ["anchor", "geography"]]);
    expect(calls.plan[1]).toContain("This is round 2.");
  });

  const round2 = [
    { name: "a repeated angle", entry: { category: "events", angle: "anchor", searches: [{ tool: "dork", query: '"Lakeside" events again' }, { tool: "exa", query: "Lakeside events pages" }, { tool: "tavily", query: "Lakeside events?" }] },
      refused: ["dork", "exa", "tavily"].map((tool) => [tool, "Search refused: already tried anchor here; pick another."]) },
    { name: "a person's name or no title in Roles", entry: { category: "events", angle: "roles", angle_reason: "the parks events coordinator", searches: [{ tool: "dork", query: '"Jane Doe" Lakeside events coordinator' }, { tool: "exa", query: "Lakeside events notices" }, { tool: "tavily", query: "Who is the Lakeside parks events coordinator?" }] },
      refused: [["dork", expect.stringMatching(/names a person \(Jane Doe\): use the title, never the name/)], ["exa", expect.stringMatching(/a Roles angle uses a title, like events coordinator/)]] },
    { name: "a near-duplicate query", entry: { category: "events", angle: "geography", angle_reason: "the North End", searches: [{ tool: "dork", query: '"Lakeside" north end' }, { tool: "exa", query: '"Lakeside" events' }, { tool: "tavily", query: "Where is the Lakeside North End?" }] },
      refused: [["exa", expect.stringMatching(/too close to "Lakeside events", already run in events × exa/)]] },
    { name: "a tool-native search without the tool's own means", entry: { category: "events", angle: "tool_native", angle_reason: "titles", searches: [{ tool: "dork", query: '"Lakeside" events calendar' }, { tool: "exa", query: "Lakeside calendars" }, { tool: "tavily", query: "Lakeside events calendar pages" }] },
      refused: [["dork", expect.stringMatching(/dork's tool-native angle uses site:/)], ["exa", expect.stringMatching(/Exa's tool-native angle is a plain-sentence description/)], ["tavily", expect.stringMatching(/tavily's tool-native angle explores a confirmed hub site/)]] },
  ];
  for (const { name, entry, refused } of round2) it(`refuses ${name}, and counts that turn as a miss`, async () => {
    const { transport } = web(PAGES);
    const { fake } = rounds({ plan: (prompt, round, used) => autoPlan(prompt, used, (entries) => round === 2 ? [entry] : entries) });
    const { job } = setup(transport, fake, { topics: ["events"] });
    await job(0, { steps: 4 });
    await job(1, { steps: 2 });
    const state = await stateOf();
    expect(state.steps.filter((step) => step.round === 2 && step.action === "search" && step.outcome === "refused").map((step) => [step.tool, step.result])).toEqual(refused);
    expect(state.searches?.filter((row) => row.round === 2 && row.refused).map((row) => row.tool)).toEqual(refused.map(([tool]) => tool));
  });

  it("keeps every safety rule: guessed sites removed, wide, admin and exposed-file searches refused", async () => {
    const { transport, requests } = web(PAGES);
    const { fake } = rounds({
      plan: (prompt, round, used) => autoPlan(prompt, used, (entries) => round === 2 ? [
        { category: "events", angle: "geography", angle_reason: "the North End", searches: [{ tool: "dork", query: 'site:guess.example.com "Lakeside" north end' }] },
        { category: "crime", angle: "institutions", angle_reason: "x", searches: [{ tool: "dork", query: '"Washington" police news' }] },
        { category: "deaths", angle: "tool_native", angle_reason: "x", searches: [{ tool: "dork", query: 'inurl:admin "Lakeside" obituaries' }] },
        { category: "news", angle: "format", angle_reason: "x", searches: [{ tool: "dork", query: '"Lakeside" news filetype:xlsx' }] },
      ] : entries),
    });
    const { job } = setup(transport, fake, { topics: ["events", "crime", "deaths", "news"], paid: ONLY_DORK });
    await job(0, { steps: 4 });
    await job(1, { steps: 2 });
    const state = await stateOf();
    const round2 = state.steps.filter((step) => step.round === 2 && step.action === "search");
    expect(round2.find((step) => step.category === "events")).toMatchObject({ outcome: "ok", query: '"Lakeside" north end' });
    expect(round2.find((step) => step.category === "crime")?.result).toMatch(/must name Lakeside/);
    expect(round2.find((step) => step.category === "deaths")?.result).toMatch(/login or admin/);
    expect(round2.find((step) => step.category === "news")?.result).toMatch(/login or admin pages or exposed files/);
    const sent = sentDork(requests);
    expect(sent.every((query) => query.includes("-site:facebook.com"))).toBe(true);
    expect(sent.some((query) => /guess\.example\.com|Washington|inurl:admin|filetype/.test(query))).toBe(false);
    expect(await decisions({ decision: "guessed_site_removed" })).toHaveLength(1);
  });
});

describe("proposing", () => {
  it("sends every proposal through the code checks and the model check, and traces where it came from", async () => {
    const { transport } = web(PAGES, (service, query) => service === "serpapi" && /^Lakeside events/.test(query) ? [{ url: EVENTS, title: "Lakeside Library events" }] : []);
    const { fake } = rounds({ propose: /lib\.example\.org/ });
    const { job } = setup(transport, fake, { topics: ["events"], paid: ONLY_DORK });
    await job(0, { steps: 7 });
    const state = await stateOf();
    const saved = await sourceMap(db).findOne({ url: EVENTS });
    expect(saved).toMatchObject({ status: "proposed", section: "events", gemini: { verdict: "accept", route: "agent" }, found_by: { method: "agent", tool: "dork", tools: ["dork"], query: "Lakeside events" } });
    expect(state.sources[0]).toMatchObject({ url: EVENTS, verdict: "accept", good: true, pending: false, tool: "dork", found_at_step: state.searches![0].step });
    expect(state.checklist.events.accepted.map((item) => item.url)).toContain(EVENTS);
  });

  it("never opens again what the editor rejected in an earlier run", async () => {
    await pageDecisions(db).insertOne({ _id: "loc:police", location_id: "loc", key: normaliseUrl(POLICE), decision: "reject", name: "Police news" } as never);
    const { transport, requests } = web(PAGES, (service, query) => service === "serpapi" && /crime/.test(query) ? [{ url: POLICE, title: "Police news" }] : []);
    const { fake } = rounds({ propose: /police/ });
    const { job } = setup(transport, fake, { topics: ["crime"], paid: ONLY_DORK }, {}, true);
    await job(0, { steps: 5 });
    const state = await stateOf();
    expect(state.steps.find((step) => step.action === "propose" && step.url === POLICE)).toMatchObject({ outcome: "refused", result: expect.stringMatching(/editor rejected this page in an earlier run/) });
    expect(requests.some((request) => request.url === POLICE)).toBe(false);
  });

  it("leaves out sites already on the source map, which the free readers found", async () => {
    await sourceMap(db).insertOne({ _id: "loc:web:x", location_id: "loc", source_id: "web:x", name: "Police news", url: POLICE, reader: "web", params: {}, section: "safety", found_by: { method: "agent", detail: "x" }, inside_area: false, status: "rejected", review: { decision: "reject" } } as never);
    const { transport, requests } = web(PAGES, (service, query) => service === "serpapi" && /crime/.test(query) ? [{ url: POLICE, title: "Police news" }] : []);
    const { fake, calls } = rounds({ propose: /police/ });
    const { job } = setup(transport, fake, { topics: ["crime"], paid: ONLY_DORK });
    await job(0, { steps: 4 });
    expect(calls.triage).toHaveLength(0);
    expect(requests.some((request) => request.url === POLICE)).toBe(false);
  });
});

describe("tools and ceilings", () => {
  it("takes a tool out when it reaches its cap, and carries on with the others", async () => {
    setLimits({ exa: { per_run: 1 } });
    const { transport } = web(PAGES);
    const { fake } = rounds();
    const { run } = setup(transport, fake, { topics: ["events"], paid: { serpapi: 100, exa: 100, gemini: 1000, agent_model: 1000 } });
    await run();
    const state = await stateOf();
    expect(state.unavailable.exa).toMatch(/Hard limit: Exa: 1 a run/);
    const cells = gridOf(state, ["events"], ["dork", "exa"]).cells;
    expect(cells.map((cell) => [cell.tool, cell.status, cell.searches])).toEqual([["dork", "dry", 2], ["exa", "unavailable", 1], ["tavily", "unavailable", 0]]);
    expect(state.finished?.reason).toBe("every cell is dry or unavailable");
  });

  it("stops cleanly at Gemini's limit mid-round, saves its progress and says why", async () => {
    setLimits({ gemini: { per_day: 50 } });
    const { transport } = web(PAGES, (service, query) => service === "serpapi" && /^Lakeside events/.test(query) ? [{ url: EVENTS, title: "Library events" }] : []);
    const { fake } = rounds({ propose: /lib\.example\.org/ });
    const { job } = setup(transport, fake, { topics: ["events"], paid: ONLY_DORK });
    await job(0, { steps: 3 });
    // Other runs use the rest of today's Gemini calls before this run's triage.
    await db.collection("run_budgets").updateOne({ _id: `day:gemini:${limitWindow().day}` as never }, { $set: { used: 50 } }, { upsert: true });
    const result = await job(1);
    const state = await stateOf();
    expect(result).toMatchObject({ next: false, stopped_by: "gemini" });
    expect(state.stopped_by).toMatchObject({ limit: "gemini", reason: "Gemini: 50 a day (it resets at midnight Pacific)" });
    expect(state.round?.stage).toBe("triage");
    expect((await decisions({ decision: "stopped" }))[0].reason).toMatch(/Stopped at a limit: Gemini: 50 a day .*carry on after the daily reset at midnight Pacific/);
    expect(await job(2)).toMatchObject({ next: false, steps: 0 });
  });

  it("stops at the whole-run time", async () => {
    const { transport } = web(PAGES);
    const { fake } = rounds();
    const { context, options } = setup(transport, fake, { topics: ["events"] });
    const result = await withRunContext({ db, runId: "run", locationId: "loc", options, runKind: "map", startedAt: Date.now() / 1000 - 46 * 60 }, () => agentJob(context, 0));
    expect(result).toMatchObject({ next: false, stopped_by: "run_minutes", total_steps: 0 });
  });

  it("sends the directory habit, the tool practices and worked examples to the model", async () => {
    const { transport } = web(PAGES);
    const { fake, calls } = rounds();
    const { job } = setup(transport, fake, { topics: ["events"], paid: ONLY_DORK });
    await job(0, { steps: 1 });
    expect(calls.plan[0]).toContain(DIRECTORY_HABIT);
    expect(calls.plan[0]).toContain("dork: exact Google searches");
    expect(calls.plan[0]).toContain("A directory entry is a lead, not a source");
    expect(calls.plan[0]).toMatch(/share 100/);
  });
});

describe("the free local fixture", () => {
  it("runs every round with all three tools answered from the fixture, with no paid search call and no share", async () => {
    await freeSource("events", "https://cc.example.org/calendar");
    const { transport, requests } = web(PAGES);
    const { fake } = rounds();
    const { run } = setup(transport, fake, { topics: ["events"], search_provider: "fixture", paid: { gemini: 1000, agent_model: 1000 } });
    await run();
    const state = await stateOf();
    expect(state.caps).toEqual({ dork: null, exa: null, tavily: null });
    expect(new Set(state.searches?.map((row) => row.tool))).toEqual(new Set(["dork", "exa", "tavily"]));
    expect(gridOf(state, ["events"], ["dork", "exa", "tavily"]).cells.map((cell) => cell.share)).toEqual([null, null, null]);
    expect(requests.some((request) => /serpapi\.com|api\.exa\.ai|api\.tavily\.com/.test(request.url))).toBe(false);
    expect(state.finished?.reason).toBe("every cell is dry or unavailable");
  });
});

describe("Exhaustive only", () => {
  it("runs rounds whatever depth a run recorded, and new runs record none", async () => {
    expect(resolveRunOptions({})).not.toHaveProperty("search_depth");
    const { transport } = web(PAGES);
    const { fake } = rounds();
    const { run } = setup(transport, fake, { topics: ["events"], paid: ONLY_DORK, search_depth: "enough" });
    await run();
    expect(await stateOf()).toMatchObject({ depth: "exhaustive", rounds: 2, finished: { reason: "every cell is dry or unavailable" } });
  });
});

describe("opening pages", () => {
  const blocked = "https://shy.example.org/events";
  const inRun = <T>(choices: Partial<RunOptions>, work: () => Promise<T>) => withRunContext({ db, runId: "open", locationId: "loc", options: resolveRunOptions({ paid: { brightdata_open: 10 }, ...choices }), runKind: "map", startedAt: Date.now() / 1000 }, work);
  const settings = { integrations: { brightdataKey: "k", brightdataUnlockerZone: "unlocker" } };
  const unlocked = (request: HttpRequest) => request.url === "https://api.brightdata.com/request";
  const site = () => web({ [blocked]: 403 }, () => []);
  const contextFor = (transport: HttpTransport) => ({ db, settings, transport, location: LOCATION, today: TODAY }) as unknown as DiscoveryContext;

  it("never gets past a block under Respect", async () => {
    const { transport, requests } = site();
    await expect(inRun({}, () => openPage(contextFor(transport), new Fetcher(transport, undefined, false), blocked, "agent"))).rejects.toThrow(/login or permission required/);
    expect(requests.some(unlocked)).toBe(false);
  });

  it("opens a blocked page through Bright Data's Web Unlocker only under Relaxed", async () => {
    const { transport: base, requests } = site();
    const transport: HttpTransport = async (request) => unlocked(request) ? (requests.push(request), { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(listing("Shy events")) }) : base(request);
    const page = await inRun({ access: "relaxed" }, () => openPage(contextFor(transport), new Fetcher(transport, undefined, false), blocked, "agent"));
    expect(page).toMatchObject({ reader: "brightdata", unblocked: true });
    expect(JSON.parse(String(requests.find(unlocked)!.body))).toEqual({ zone: "unlocker", url: blocked, format: "raw", country: "us" });
  });
});
