import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Fetcher } from "../../connectors/fetcher";
import type { HttpTransport } from "../../core/http";
import { defaultRunOptions, resolveRunOptions, RunOptionsError, withRunContext, type RunContext } from "../../core/run-options";
import { apiCalls, ensureApiCallIndexes, HARD_LIMITS, limitWindow, paidCall, paidRefusal, RUN_MINUTES, stoppedBy, unavailableServices, type HardLimit } from "../../trace/gateway";
import { limit } from "../../playbook";

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("limits"); });
afterAll(async () => { await client.close(); await server.stop(); });
beforeEach(async () => { await db.dropDatabase(); await ensureApiCallIndexes(db); });

const saved = { ...HARD_LIMITS };
const setLimits = (limits: Record<string, HardLimit>) => { for (const key of Object.keys(HARD_LIMITS)) delete HARD_LIMITS[key]; Object.assign(HARD_LIMITS, limits); };
afterEach(() => setLimits(saved));

const run = <T>(runId: string, paid: Record<string, number>, work: () => Promise<T>, extra: Partial<RunContext> = {}) =>
  withRunContext({ db, runId, locationId: "loc", options: { ...defaultRunOptions(), paid }, runKind: "map", startedAt: Date.now() / 1000, ...extra }, work);
const allowed = (answers: Array<string | null>) => answers.filter((answer) => answer === null).length;

describe("hard limits, from the playbook", () => {
  it("holds every service's limits as the plan sets them", () => {
    expect(saved.gemini).toEqual({ per_minute: 8, per_run: 150, per_day: 450 });
    expect(saved.brightdata).toEqual({ per_minute: 10, per_run: 60, per_month: 4000 });
    expect(saved.brightdata_open).toEqual({ per_run: 50, per_month: 4000, pool: "brightdata" });
    expect(saved.serpapi).toEqual({ per_hour: 40, per_month: 200 });
    expect(saved.tavily).toEqual({ per_minute: 30, per_run: 60, per_month: 900 });
    expect(saved.tavily_explore).toMatchObject({ per_run: 2, pool: "tavily" });
    expect(saved.exa).toMatchObject({ per_second: 2, per_run: 60, spend_per_month: 8 });
    expect(saved.jina).toEqual({ per_minute: 60, per_minute_without_key: 15 });
    expect(saved.scrapingbee).toEqual({ per_run: 100, total: 180 });
    expect(saved.searchapi).toEqual({});
    expect(RUN_MINUTES).toBe(45);
    expect(limit("general.stop.fetch_seconds_per_host")).toBe(1);
  });

  it("counts the day from midnight Pacific", () => {
    // 07:30 UTC on 8 November is 23:30 on the 7th in Pacific standard time.
    const window = limitWindow(Date.parse("2026-11-08T07:30:00Z"));
    expect(window.day).toBe("2026-11-07");
    expect(new Date(window.dayStart * 1000).toISOString()).toBe("2026-11-07T08:00:00.000Z");
    expect(limitWindow(Date.parse("2026-11-08T08:30:00Z")).day).toBe("2026-11-08");
  });
});

describe("the budget race", () => {
  it("never lets calls running at the same time overshoot a run's budget", async () => {
    setLimits({});
    const answers = await run("race", { serpapi: 3 }, () => Promise.all(Array.from({ length: 25 }, () => paidRefusal("serpapi"))));
    expect(allowed(answers)).toBe(3);
  });

  it("gives every first call a fair chance: racing to create the count refuses nobody early", async () => {
    setLimits({});
    const answers = await run("first", { serpapi: 25 }, () => Promise.all(Array.from({ length: 25 }, () => paidRefusal("serpapi"))));
    expect(allowed(answers)).toBe(25);
  });

  it("holds a hard limit across runs at the same time, and per run", async () => {
    setLimits({ serpapi: { per_run: 5, per_day: 7 } });
    const [a, b] = await Promise.all(["a", "b"].map((id) => run(id, { serpapi: 100 }, () => Promise.all(Array.from({ length: 12 }, () => paidRefusal("serpapi"))))));
    expect(allowed(a)).toBeLessThanOrEqual(5);
    expect(allowed(b)).toBeLessThanOrEqual(5);
    expect(allowed(a) + allowed(b)).toBe(7);
    expect([...a, ...b].filter(Boolean).every((reason) => /Hard limit: SerpApi: (5 a run|7 a day)/.test(reason!))).toBe(true);
  });

  it("counts calls made with paidCall the same way, failed ones too", async () => {
    setLimits({ tavily: { per_run: 4 } });
    let made = 0;
    const call = () => paidCall("tavily", async () => { made += 1; if (made % 2) throw new Error("HTTP 500"); return "ok"; }).catch(() => ({ value: null, refused: null }));
    const outcomes = await run("calls", { tavily: 100 }, () => Promise.all(Array.from({ length: 10 }, call)));
    expect(made).toBe(4);
    expect(outcomes.filter((outcome) => outcome.refused).length).toBe(6);
  });

  it("counts Tavily in credits", async () => {
    setLimits({ tavily: { per_run: 5 } });
    const answers = await run("credits", { tavily: 100 }, async () => [await paidRefusal("tavily", { units: 2 }), await paidRefusal("tavily", { units: 2 }), await paidRefusal("tavily", { units: 2 }), await paidRefusal("tavily")]);
    expect(answers.map((answer) => answer === null)).toEqual([true, true, false, true]);
  });
});

describe("day, month and total limits", () => {
  it("starts a month's count from the usage records already there", async () => {
    setLimits({ serpapi: { per_month: 200 } });
    const now = Date.now() / 1000;
    await apiCalls(db).insertMany(Array.from({ length: 198 }, () => ({ run_id: "old", location_id: "loc", service: "serpapi", paid: true, units: 1, outcome: "ok" as const, detail: null, cost_estimate: null, created_at: now - 60 })));
    const answers = await run("month", { serpapi: 50 }, () => Promise.all(Array.from({ length: 6 }, () => paidRefusal("serpapi"))));
    expect(allowed(answers)).toBe(2);
    expect(answers.find(Boolean)).toBe("Hard limit: SerpApi: 200 a month was reached");
  });

  it("counts every Gemini call against Gemini's limits, under any budget", async () => {
    setLimits({ gemini: { per_day: 3 } });
    const answers = await run("gemini", { gemini: 100, agent_model: 100 }, () => Promise.all([
      paidRefusal("gemini"), paidRefusal("agent_model", { limits: "gemini" }), paidRefusal("agent_model", { limits: "gemini" }), paidRefusal("gemini"), paidRefusal("agent_model", { limits: "gemini" }),
    ]));
    expect(allowed(answers)).toBe(3);
  });

  it("applies per-run limits to source map runs only, and day limits to every run", async () => {
    setLimits({ gemini: { per_run: 2, per_day: 4 } });
    const edition = await run("edition", { gemini: 100 }, () => Promise.all(Array.from({ length: 3 }, () => paidRefusal("gemini"))), { runKind: "edition" });
    expect(allowed(edition)).toBe(3);
    const map = await run("map", { gemini: 100 }, () => Promise.all(Array.from({ length: 3 }, () => paidRefusal("gemini"))));
    expect(allowed(map)).toBe(1);
  });

  it("keeps the first limit that stopped a run, and records it once", async () => {
    setLimits({ gemini: { per_day: 1 } });
    await run("stopped", { gemini: 100 }, async () => { await paidRefusal("gemini"); await paidRefusal("gemini"); await paidRefusal("gemini"); });
    expect(await stoppedBy(db, "stopped")).toEqual({ limit: "gemini", reason: "Gemini: 1 a day (it resets at midnight Pacific)" });
    expect(await db.collection("run_decisions").countDocuments({ run_id: "stopped", decision: "limit_reached" })).toBe(1);
    expect(await stoppedBy(db, "other")).toBeNull();
  });

  it("stops a source map run after the whole-run time, and records why", async () => {
    setLimits({});
    const late = await run("late", { serpapi: 10 }, () => paidRefusal("serpapi"), { startedAt: Date.now() / 1000 - (RUN_MINUTES + 1) * 60 });
    expect(late).toBe(`Hard limit: the whole-run limit of ${RUN_MINUTES} minutes was reached`);
    expect((await stoppedBy(db, "late"))?.limit).toBe("run_minutes");
    expect(await run("edition-late", { serpapi: 10 }, () => paidRefusal("serpapi"), { runKind: "edition", startedAt: 0 })).toBeNull();
  });
});

describe("pacing", () => {
  it("waits for a per-second limit rather than refusing", async () => {
    setLimits({ exa: { per_second: 4 } });
    const started = Date.now();
    const answers = await run("pace", { exa: 100 }, () => Promise.all(Array.from({ length: 6 }, () => paidRefusal("exa"))));
    expect(allowed(answers)).toBe(6);
    // Six calls at four a second are spread over at least five quarter-seconds.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1100);
  });
});

describe("run options", () => {
  it("allows Relaxed access when deployed, a test option the run records, and still refuses the fixture search provider", () => {
    expect(resolveRunOptions({ access: "relaxed" }, { NEWSBEE_MODE: "cloud" }).access).toBe("relaxed");
    expect(resolveRunOptions({ access: "relaxed" }, { VERCEL: "1" }).access).toBe("relaxed");
    expect(resolveRunOptions({}, { VERCEL: "1" }).access).toBe("respect");
    expect(() => resolveRunOptions({ search_provider: "fixture" }, { VERCEL: "1" })).toThrow(RunOptionsError);
    expect(resolveRunOptions({ access: "relaxed", access_ignore: ["never_read"] }, { NEWSBEE_MODE: "local" })).toMatchObject({ access: "relaxed", access_ignore: ["never_read"] });
  });
});

describe("our fetcher", () => {
  it("reads one page at a time per site", async () => {
    let open = 0, most = 0;
    const transport: HttpTransport = async (request) => {
      open += 1; most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 30));
      open -= 1;
      return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(request.url.endsWith("robots.txt") ? "User-agent: *\nDisallow:\n" : "<p>page</p>") };
    };
    const fetcher = new Fetcher(transport);
    const started = Date.now();
    await Promise.all(["/a", "/b"].map((path) => fetcher.get(`https://one-site.example.org${path}`, 1024 * 1024, "text/html")));
    expect(most).toBe(1);
    // robots.txt, then two pages, at least a second apart.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  });
});

describe("a service's own limit", () => {
  it("makes that service unavailable for the run, without stopping it; only Gemini's limits stop a run", async () => {
    setLimits({ exa: { per_run: 1 }, gemini: { per_run: 1 } });
    const answers = await run("tools", { exa: 10, gemini: 10 }, async () => [await paidRefusal("exa"), await paidRefusal("exa"), await paidRefusal("exa")]);
    expect(answers.map((answer) => answer === null)).toEqual([true, false, false]);
    expect(await stoppedBy(db, "tools")).toBeNull();
    expect(await unavailableServices(db, "tools")).toEqual({ exa: "Exa: 1 a run" });
    expect(await db.collection("run_decisions").countDocuments({ run_id: "tools", decision: "service_unavailable", subject: "exa" })).toBe(1);
    await run("tools", { exa: 10, gemini: 10 }, async () => { await paidRefusal("gemini"); await paidRefusal("gemini"); });
    expect(await stoppedBy(db, "tools")).toEqual({ limit: "gemini", reason: "Gemini: 1 a run" });
  });
});
