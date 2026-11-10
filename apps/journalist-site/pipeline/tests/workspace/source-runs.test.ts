import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), headers: vi.fn(), cookies: vi.fn(), deps: vi.fn(), database: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth, isAdminEmail: vi.fn(), getMongoDatabase: mocks.database }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies, headers: mocks.headers }));
vi.mock("@/lib/pipeline", () => ({ pipelineDeps: mocks.deps }));
vi.mock("@/pipeline/storage/mongo", async (original) => ({ ...await original<object>(), getDatabase: mocks.database }));
vi.mock("@/lib/pipeline-queue", () => ({ queueNextJob: vi.fn() }));
vi.mock("@/lib/job-chain", () => ({ callNextJob: vi.fn() }));
vi.mock("../../connectors/web", async (original) => ({ ...await original<object>(), webConnector: { collect: async () => ({ result: { status: "ingested", detail: "ok" }, events: [] }) } }));

import { GET as runList } from "../../../app/api/maps/locations/[locationId]/source-runs/route";
import { GET as runDetail } from "../../../app/api/maps/locations/[locationId]/source-runs/[runId]/route";
import { POST as bulkReview } from "../../../app/api/admin/locations/[locationId]/source-map/reviews/route";
import SourceMapPage from "../../../app/source-map/page";
import { editionRedirect, internalReturnPath, internalToken } from "../../../lib/internal-access";
import { COLLECTIONS } from "../../storage/mongo";
import { AGENT_STATE, type AgentState } from "../../agent/map-sources";
import { addSourceLink } from "../../connectors/manual-links";
import { loadSettings } from "../../core/config";
import { defaultRunOptions, resolveRunOptions, RunOptionsError, type RunOptions } from "../../core/run-options";
import { normalizedPlan } from "../../accounts/execution";
import { runDecisions, type Decision } from "../../trace/decisions";
import { apiCalls } from "../../trace/gateway";
import { agentLog, pageRows, runEnding, searchGrid, toolCounts } from "../../trace/source-runs";
import { choicesFor, codeState, DEFAULT_SETTINGS, filterPages, groupPages, inStage, settingsOf, toolsSummary, type PageRow } from "../../trace/source-run-settings";
import { sourceMap, SOURCE_REVIEWS, upsertCandidates, type SourceCandidate, type SourceRecord } from "../../sourcemap/store";

const locationId = "fixture-town-wa";
const host = "workspace.example.test";
const context = { params: Promise.resolve({ locationId }) };
const password = "test-only-password-not-a-deployment-secret";

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("source_runs_test");
}, 60_000);
beforeEach(async () => {
  await db.dropDatabase();
  mocks.auth.mockResolvedValue({ user: { email: "labeller@example.test" } });
  mocks.headers.mockResolvedValue(new Headers({ host }));
  mocks.cookies.mockResolvedValue({ get: () => undefined });
  mocks.database.mockResolvedValue(db);
  mocks.deps.mockResolvedValue({ db });
  await db.collection("journalist_admins").insertOne({ email: "labeller@example.test", enabled: true });
  await db.collection<{ _id: string }>(COLLECTIONS.locations).insertOne({ _id: locationId, id: locationId, name: "Fixture Town", state: "WA", systems: [] } as never);
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
afterAll(async () => { await client?.close(); await server?.stop(); });

const RUN = "map-run-2";
const T = 1_800_000_000;
function decision(stage: Decision["stage"], subject: string, value: string, extra: Partial<Decision> = {}): Decision {
  return { run_id: RUN, location_id: locationId, at: T + 10, stage, actor: "rule", subject, decision: value, reason: null, ...extra };
}
function candidate(sourceId: string, url: string, overrides: Partial<SourceCandidate> = {}): SourceCandidate {
  return { source_id: sourceId, name: `Source ${sourceId}`, url, reader: "web", params: {}, section: "civic", inside_area: true, found_by: { method: "government", detail: "City site" }, status: "proposed", ...overrides };
}

/** One run's record, as steps 1 to 4 write it: the fixed readers' checks, the model check, and the agent's leads and steps. */
function fixture() {
  const decisions: Decision[] = [
    // A fixed reader's page, opened through Jina after the fetcher got too little text, then accepted by the model check.
    decision("fetch", "https://www.fixturetown.gov/agendas", "fetch", { reason: "kept: Names Fixture Town; calendar", topic: "government",
      evidence: { family: "official_site", method: "government", outcome: "kept", reader: "jina", fallbacks: [{ reader: "fetcher", why: "40 characters of text, under 300: probably built by script" }], source_id: "web:agendas", source_url: "https://fixturetown.gov/agendas", section: "civic", checks: { locality: { outcome: "pass" } } } }),
    decision("source", "https://fixturetown.gov/agendas", "gemini_accepted", { actor: "model", reason: "A1 Primary local record (official): The council's own agendas", model: "gemini-flash-lite", evidence: { reason_code: "A1", quote: "City Council, Nov 4" } }),
    decision("source", "https://fixturetown.gov/agendas", "proposed", { evidence: { method: "government", name: "Agendas" } }),
    // A fixed reader's page clearly about another place.
    decision("fetch", "https://www.othertown.gov/news", "fetch", { reason: "Clearly about Other Town", topic: "government", evidence: { family: "official_site", method: "government", outcome: "other_place", reader: "fetcher", fallbacks: [] } }),
    // The agent's dork search found a page; Gemini rejected it, and the editor accepted it.
    decision("fetch", "https://sheriff.example.test/news", "fetch", { reason: "kept: Covers Fixture County", topic: "crime",
      evidence: { family: "agent:dork", method: "agent", query: "\"Fixture Town\" sheriff", outcome: "kept", reader: "fetcher", fallbacks: [], source_id: "web:sheriff", source_url: "https://sheriff.example.test/news", section: "safety", checks: { locality: { outcome: "unclear" } } } }),
    decision("source", "https://sheriff.example.test/news", "gemini_rejected", { actor: "model", reason: "R1 Not about this place: County-wide only", evidence: { reason_code: "R1", quote: "Fixture County" } }),
    // A structured source, read through its own API.
    decision("source", "opendata:data.example.test:abcd-1234", "proposed", { evidence: { method: "opendata", name: "Police incidents" } }),
    decision("source", "opendata:data.example.test:abcd-1234", "not_judged", { reason: "Not judged: the model call failed (timeout)" }),
    // Blocked before opening.
    decision("fetch", "https://blocked.example.test/", "fetch", { reason: "blocked: robots.txt disallows this page", rule: "access", topic: "news", evidence: { family: "agent:exa", method: "agent", query: "fixture town news", outcome: "blocked" } }),
  ];
  const agent = {
    _id: RUN, run_id: RUN, jobs: 1, seen: [], known_hosts: [], rejected: [], dry_steps: 10, model_failures: 0, unavailable: {}, tool_failures: {},
    checklist: { government: { status: "covered", accepted: [], searches: 0, tools: [], note: null }, crime: { status: "not_found", accepted: [], searches: 8, tools: ["dork", "exa"], note: "dried up after 8 searches" } },
    leads: [
      { url: "https://sheriff.example.test/news", tool: "dork", query: "\"Fixture Town\" sheriff", step: 2, title: "Sheriff news", snippet: "" },
      { url: "https://blocked.example.test/", tool: "exa", query: "fixture town news", step: 3, title: "", snippet: "" },
      { url: "https://www.yelp.example.test/fixture", tool: "tavily", query: "Where to shop in Fixture Town?", step: 4, title: "Listings", snippet: "" },
      { url: "https://parks.example.test/events", tool: "open", query: "https://fixturetown.gov/agendas", step: 5, title: "Parks events", snippet: "" },
    ],
    sources: [{ url: "https://sheriff.example.test/news", source_id: "web:sheriff", name: "Sheriff", category: "crime", tool: "dork", query: "\"Fixture Town\" sheriff", step: 6, found_at_step: 2, opened_with: "fetcher", verdict: "reject", reason: "County-wide only" }],
    steps: [
      { step: 2, job: 1, at: T + 2, action: "search", tool: "dork", query: "\"Fixture Town\" sheriff", url: null, category: "crime", reason: "Crime is open", outcome: "ok", result: "2 results.\n1. https://sheriff.example.test/news", accepted: [], ms: 10 },
      { step: 5, job: 1, at: T + 5, action: "open", tool: null, query: null, url: "https://fixturetown.gov/agendas", category: "events", reason: "The city may link to parks", outcome: "ok", result: "Opened https://fixturetown.gov/agendas with fetcher.", accepted: [], ms: 10, opened_with: "fetcher", fallbacks: [] },
      { step: 7, job: 1, at: T + 7, action: "open", tool: null, query: null, url: "https://parks.example.test/events", category: "events", reason: "Parks post events", outcome: "ok", result: "Opened with jina.", accepted: [], ms: 10, opened_with: "jina", fallbacks: [{ reader: "fetcher", why: "12 characters of text, under 300: probably built by script" }] },
    ],
    finished: { reason: "every category is covered or marked not found, and the last 10 steps found nothing new", at: T + 100 },
  } as unknown as AgentState;
  const sources = [
    { source_id: "web:agendas", url: "https://fixturetown.gov/agendas", name: "Agendas", section: "civic", status: "proposed", found_by: { method: "government", detail: "" }, review: undefined, gemini: undefined },
    { source_id: "web:sheriff", url: "https://sheriff.example.test/news", name: "Sheriff", section: "safety", status: "active", found_by: { method: "agent", detail: "" }, review: { decision: "accept", reason_code: "A1", reason: null, initial_status: "rejected", by: "x", at: "" }, gemini: undefined },
    { source_id: "opendata:data.example.test:abcd-1234", url: "https://data.example.test/d/abcd-1234", name: "Police incidents", section: "safety", status: "proposed", found_by: { method: "opendata", detail: "" }, review: undefined, gemini: undefined },
  ] as Array<Pick<SourceRecord, "source_id" | "url" | "name" | "section" | "status" | "review" | "gemini" | "found_by">>;
  return { decisions, agent, sources };
}

describe("settings recorded per run", () => {
  it("reads the settings a run used back from its run options, and turns new settings into options", () => {
    const defaults: RunOptions = { ...defaultRunOptions({}), paid: { gemini: 200, agent_model: 20, serpapi: 5 } };
    const choices = choicesFor({ ...DEFAULT_SETTINGS, dork_service: "serpapi", exa: false, scrapingbee: true }, defaults);
    expect(choices.map_flow).toBe("agentic");
    expect(choices.search_provider).toBe("serpapi");
    // Model budgets stay as the defaults set them; the switches tick only their own services.
    expect(choices.paid).toEqual({ gemini: 200, agent_model: 20, serpapi: 5, tavily: 60, scrapingbee: 20 });
    expect(settingsOf(choices)).toEqual({ ...DEFAULT_SETTINGS, depth: null, dork_service: "serpapi", exa: false, scrapingbee: true });
    const fixedOnly = choicesFor({ ...DEFAULT_SETTINGS, agent: false, respect: false, gemini_check: false }, defaults);
    expect(fixedOnly).toMatchObject({ map_flow: "current", access: "relaxed", gemini_check: false });
    expect(fixedOnly.paid).toEqual({ gemini: 200, agent_model: 20 });
    expect(settingsOf(fixedOnly)).toMatchObject({ agent: false, dork: false, exa: false, tavily: false, respect: false, gemini_check: false });
    expect(toolsSummary(settingsOf(fixedOnly))).toBe("Fixed readers only · Relaxed · Model check off");
    expect(toolsSummary(settingsOf(choicesFor(DEFAULT_SETTINGS, defaults)))).toBe("All search tools");
    expect(toolsSummary(settingsOf(choicesFor({ ...DEFAULT_SETTINGS, exa: false, tavily: false }, defaults)))).toBe("Dorking only");
    // A run from before run options shows as the fixed readers alone.
    expect(settingsOf(undefined)).toMatchObject({ agent: false, respect: true });
  });

  it("allows Relaxed and the model check off when deployed, through the existing start path, keeping Respect and the check on by default", () => {
    const defaults = defaultRunOptions({});
    expect(resolveRunOptions(choicesFor({ ...DEFAULT_SETTINGS, respect: false }, defaults), { NEWSBEE_MODE: "local" }).access).toBe("relaxed");
    for (const env of [{ NEWSBEE_MODE: "cloud" }, { VERCEL: "1" }]) {
      const relaxed = resolveRunOptions(choicesFor({ ...DEFAULT_SETTINGS, respect: false, gemini_check: false }, defaults), env);
      expect(relaxed).toMatchObject({ access: "relaxed", gemini_check: false });
      expect(settingsOf(relaxed)).toMatchObject({ respect: false, gemini_check: false });
      expect(resolveRunOptions(choicesFor(DEFAULT_SETTINGS, defaults), env)).toMatchObject({ access: "respect", gemini_check: true });
      expect(() => resolveRunOptions({ ...choicesFor(DEFAULT_SETTINGS, defaults), search_provider: "fixture" }, env)).toThrow(RunOptionsError);
    }
    expect(DEFAULT_SETTINGS).toMatchObject({ respect: true, gemini_check: true });
  });
});

describe("page rows from traces", () => {
  it("builds one row per page: found by, opened by with fallbacks, code check, Model check and your decision", () => {
    const rows = pageRows({ ...fixture(), runId: RUN });
    const byUrl = (part: string) => rows.find((row) => row.url.includes(part))!;
    const agendas = byUrl("fixturetown.gov/agendas");
    expect(agendas).toMatchObject({ tool: "fixed", category: "civic", source_id: "web:agendas", stage: "passed", code: { result: "pass" }, found: { how: "City or county website", query: null } });
    expect(agendas.opened).toMatchObject({ reader: "jina", fallbacks: [{ reader: "fetcher" }] });
    expect(agendas.gemini).toMatchObject({ verdict: "accept", reason_code: "A1", reason: "The council's own agendas", evidence: "City Council, Nov 4" });
    expect(agendas.decision).toEqual({ decision: null, reason_code: null, reason: null });
    expect(byUrl("othertown")).toMatchObject({ stage: "code_fail", code: { result: "fail", reason: "Clearly about Other Town" }, opened: { reader: "fetcher" }, decision: null });
    const sheriff = byUrl("sheriff");
    expect(sheriff).toMatchObject({ tool: "dork", stage: "gemini_reject", code: { result: "unclear" }, found: { query: "\"Fixture Town\" sheriff", step: 2 }, disagrees: true, status: "active" });
    expect(byUrl("data.example.test")).toMatchObject({ tool: "fixed", stage: "opened", code: { result: "pass" }, opened: { reader: null }, gemini: { verdict: null, note: "Not judged: the model call failed (timeout)" } });
    // Blocked from reading, so kept as a link-only lead: not a code rejection.
    expect(byUrl("blocked")).toMatchObject({ tool: "exa", stage: "found", opened: { reader: null }, code: { result: "link_only", reason: "robots.txt disallows this page" } });
    // Found by a tool and never opened, and opened by the agent to read without proposing it.
    expect(byUrl("yelp")).toMatchObject({ tool: "tavily", stage: "found", code: { result: "not_opened" }, found: { query: "Where to shop in Fixture Town?", step: 4 } });
    expect(byUrl("parks")).toMatchObject({ tool: "link", stage: "opened", found: { how: "Link on https://fixturetown.gov/agendas", step: 5 }, opened: { reader: "jina" }, code: { result: "not_checked" } });
    // The agendas page the agent opened at step 5 is the fixed reader's row, not a second one.
    expect(rows.filter((row) => row.url.includes("agendas"))).toHaveLength(1);
  });

  it("says why a found page wasn't opened: code's facts first, then the agent's own words, else the old line", () => {
    const { decisions, agent, sources } = fixture();
    const lead = (url: string, step: number, extra: Record<string, unknown> = {}) => ({ url, tool: "exa", query: "fixture town", step, title: "", snippet: "", ...extra });
    agent.checklist.events = { status: "covered", accepted: [{ name: "Library calendar", url: "https://library.example.test/calendar", by: "map" }], searches: 0, tools: [], note: null };
    agent.leads.push(
      lead("https://www.facebook.com/fixturetown", 4),
      lead("https://fixturetown.gov/agendas?ref=nav", 4),
      lead("https://library.example.test/calendar", 4),
      lead("https://www.othertown.gov/events", 4),
      lead("https://sheriff.example.test/blotter", 4),
      lead("https://parks.example.test/programs", 4),
      lead("https://blocked.example.test/other", 4),
      lead("https://library.example.test/branches", 4),
      lead("https://national.example.test/fixture-story", 4, { skipped: { why: "national outlet, not local", step: 5 } }),
      lead("https://events.example.test/fixture", 5),
      lead("https://late.example.test/page", 6),
    );
    sources.push({ source_id: "web:library", url: "https://library.example.test/calendar", name: "Library calendar", section: "events", status: "proposed", found_by: { method: "institutions", detail: "" }, review: undefined, gemini: undefined });
    const rows = pageRows({ decisions, agent, sources, runId: RUN });
    const why = (url: string) => rows.find((row) => row.url === url)?.code;
    expect(why("https://www.facebook.com/fixturetown")).toEqual({ result: "not_opened", reason: "Not opened: on the never-read list (facebook.com)", skipped_by: "code" });
    expect(why("https://fixturetown.gov/agendas?ref=nav")?.reason).toBe("Not opened: another address for https://www.fixturetown.gov/agendas, already in this run");
    expect(why("https://library.example.test/calendar")?.reason).toBe("Not opened: already on the source map");
    expect(why("https://www.othertown.gov/events")?.reason).toBe("Not opened: same site as othertown.gov, rejected earlier this run (Clearly about Other Town)");
    expect(why("https://sheriff.example.test/blotter")?.reason).toBe("Not opened: same site as sheriff.example.test, rejected earlier this run (the model check: County-wide only)");
    expect(why("https://parks.example.test/programs")?.reason).toBe("Not opened: same site as parks.example.test, already opened this run");
    expect(why("https://blocked.example.test/other")?.reason).toBe("Not opened: same site as blocked.example.test, which couldn't be read this run (robots.txt disallows this page)");
    expect(why("https://library.example.test/branches")?.reason).toBe("Not opened: same site as library.example.test, already on the source map");
    expect(why("https://national.example.test/fixture-story")).toEqual({ result: "not_opened", reason: "Not opened (agent): national outlet, not local", skipped_by: "agent" });
    expect(why("https://events.example.test/fixture")?.reason).toBe("Not opened: its category (Events and things to do) was already covered when it was found");
    expect(why("https://late.example.test/page")?.reason).toBe("Not opened: the run ended before the agent got to it (every category is covered or marked not found, and the last 10 steps found nothing new)");
    // Nothing recorded says why: the old line, as for runs from before reasons were kept.
    expect(why("https://www.yelp.example.test/fixture")).toEqual({ result: "not_opened", reason: "Found, not opened: the agent didn't choose it" });
  });

  it("shows the code check in three states: passed, link only (still judged) and rejected (dropped)", () => {
    const fetch = (url: string, reason: string, evidence: Record<string, unknown>, value = "fetch") => decision(value === "fetch" ? "fetch" : "result", url, value, { reason, evidence: { family: "official_site", method: "government", ...evidence } });
    const decisions: Decision[] = [
      fetch("https://slow.example.test/news", "blocked: crawl-delay of 12s is longer than 10s: https://slow.example.test/news", { outcome: "blocked" }),
      fetch("https://facebook.com/fixturetown", "platform or aggregator we never read: kept as a link-only lead", { outcome: "link_only" }, "link_only_lead"),
      fetch("https://facebook.com/elsewhere", "a platform we never read, and nothing shown names the place", { outcome: "dropped" }, "link_only_lead"),
      // A run from before the log said whether a link-only lead was kept.
      fetch("https://nextdoor.com/fixturetown", "platform or aggregator we never read: kept as a link-only lead", {}, "link_only_lead"),
      fetch("https://paper.example.test/fixture", "kept: Names Fixture Town; listing", { outcome: "kept", link_only: true, rights: "link-only", source_id: "web:paper", reader: "fetcher" }),
      fetch("https://oldpaper.example.test/fixture", "kept: Names Fixture Town; listing", { outcome: "kept", rights: "link-only", reader: "fetcher" }),
      fetch("https://unclear.example.test/news", "kept: Locality unclear (no evidence it concerns Fixture Town): for the model check to decide; listing", { outcome: "kept", reader: "fetcher", checks: { locality: { outcome: "unclear" } } }),
      fetch("https://gone.example.test/news", "failed: HTTP 500", { outcome: "failed" }),
      fetch("https://stale.example.test/news", "nothing newer than 120 days", { outcome: "stale", reader: "fetcher" }),
      decision("source", "https://slow.example.test/news", "gemini_accepted", { actor: "model", reason: "A1 Primary local record: The county's notices", evidence: { reason_code: "A1" } }),
    ];
    const rows = pageRows({ decisions, agent: null, sources: [], runId: RUN });
    const of = (url: string) => rows.find((row) => row.url === url)!;
    const states = Object.fromEntries(rows.map((row) => [row.url, [codeState(row.code.result), row.code.reason]]));
    expect(states).toEqual({
      "https://slow.example.test/news": ["link_only", "crawl-delay of 12s is longer than 10s"],
      "https://facebook.com/fixturetown": ["link_only", "platform or aggregator we never read: kept as a link-only lead"],
      "https://facebook.com/elsewhere": ["rejected", "a platform we never read, and nothing shown names the place"],
      "https://nextdoor.com/fixturetown": ["link_only", "platform or aggregator we never read: kept as a link-only lead"],
      "https://paper.example.test/fixture": ["link_only", "Names Fixture Town; listing"],
      "https://oldpaper.example.test/fixture": ["link_only", "Names Fixture Town; listing"],
      "https://unclear.example.test/news": ["passed", "Locality unclear (no evidence it concerns Fixture Town): for the model check to decide; listing"],
      "https://gone.example.test/news": ["rejected", "failed: HTTP 500"],
      "https://stale.example.test/news": ["rejected", "nothing newer than 120 days"],
    });
    expect(codeState("not_opened")).toBeNull();
    expect(codeState("not_checked")).toBeNull();
    // A link-only page the model check accepted passed both, and is still in Kept as a link only.
    expect(of("https://slow.example.test/news")).toMatchObject({ stage: "passed", opened: { reader: null } });
    const urls = (stage: string) => rows.filter((row) => inStage(row, stage)).map((row) => row.url).sort();
    expect(urls("link_only")).toEqual(["https://facebook.com/fixturetown", "https://nextdoor.com/fixturetown", "https://oldpaper.example.test/fixture", "https://paper.example.test/fixture", "https://slow.example.test/news"]);
    // Rejected by code check: only what was dropped.
    expect(urls("code_fail")).toEqual(["https://facebook.com/elsewhere", "https://gone.example.test/news", "https://stale.example.test/news"]);
    expect(filterPages(rows, { stage: "link_only" })).toHaveLength(5);
  });

  it("groups Every page by category in the usual order, sorted by outcome, with counts of what the filters show", () => {
    const row = (url: string, category: string | null, stage: PageRow["stage"], result: PageRow["code"]["result"], tool: PageRow["tool"] = "fixed", at = 0) =>
      ({ key: url, url, name: null, source_id: null, category, tool, found: { how: "", query: null, step: null }, opened: { reader: null, why: null, fallbacks: [] }, code: { result, reason: null }, gemini: null, decision: null, status: null, stage, disagrees: false, at }) as PageRow;
    const rows = [
      row("https://a/not-opened", "safety", "found", "not_opened", "exa", 1),
      row("https://a/code", "safety", "code_fail", "fail", "fixed", 2),
      row("https://a/model", "safety", "gemini_reject", "pass", "fixed", 3),
      row("https://a/link", "safety", "found", "link_only", "dork", 4),
      row("https://a/passed-2", "safety", "passed", "pass", "dork", 5),
      row("https://a/passed-1", "safety", "passed", "pass", "fixed", 0),
      row("https://a/opened", "safety", "opened", "not_checked", "fixed", 6),
      row("https://b/none", null, "found", "not_opened", "exa", 7),
      row("https://b/unknown", "weather-ish", "passed", "pass", "fixed", 8),
      row("https://c/events", "events", "passed", "pass", "fixed", 9),
      row("https://c/civic", "civic", "found", "link_only", "fixed", 10),
    ];
    const groups = groupPages(rows);
    // The site's usual category order, Uncategorised (no or an unknown category) last.
    expect(groups.map((group) => group.label)).toEqual(["Events and things to do", "Council and government", "Police, fire and safety", "Uncategorised"]);
    const safety = groups[2];
    expect(safety.heading).toBe("Police, fire and safety (7) · 2 passed both · 1 link only · 2 rejected");
    // Passed both, link only, rejected by the model check, rejected by code, then not opened; keeping order within each.
    expect(safety.rows.map((item) => item.url)).toEqual(["https://a/passed-2", "https://a/passed-1", "https://a/link", "https://a/model", "https://a/code", "https://a/not-opened", "https://a/opened"]);
    expect(groups[3]).toMatchObject({ category: null, heading: "Uncategorised (2) · 1 passed both", counts: { total: 2, passed: 1, link_only: 0, rejected: 0 } });
    expect(groups[1].heading).toBe("Council and government (1) · 1 link only");

    // The counts follow the filters: a tool, or a clicked stage.
    const dork = groupPages(filterPages(rows, { tool: "dork" }));
    expect(dork.map((group) => group.heading)).toEqual(["Police, fire and safety (2) · 1 passed both · 1 link only"]);
    const rejected = groupPages(filterPages(rows, { stage: "code_fail" }));
    expect(rejected.map((group) => group.heading)).toEqual(["Police, fire and safety (1) · 1 rejected"]);
    expect(groupPages(filterPages(rows, { stage: "link_only" })).map((group) => group.counts.total)).toEqual([1, 1]);
    expect(groupPages([])).toEqual([]);
  });

  it("filters by address, tool, category, stage and disagreement", () => {
    const rows = pageRows({ ...fixture(), runId: RUN });
    const urls = (list: PageRow[]) => list.map((row) => row.url).sort();
    expect(urls(filterPages(rows, { q: "SHERIFF" }))).toEqual(["https://sheriff.example.test/news"]);
    expect(urls(filterPages(rows, { tool: "fixed" }))).toEqual(["https://data.example.test/d/abcd-1234", "https://www.fixturetown.gov/agendas", "https://www.othertown.gov/news"]);
    expect(filterPages(rows, { category: "safety" })).toHaveLength(2);
    expect(filterPages(rows, { stage: "found" })).toHaveLength(rows.length);
    expect(urls(filterPages(rows, { stage: "opened" }))).toEqual(["https://parks.example.test/events", "https://sheriff.example.test/news", "https://www.fixturetown.gov/agendas", "https://www.othertown.gov/news"]);
    expect(filterPages(rows, { stage: "passed" }).map((row) => row.source_id)).toEqual(["web:agendas"]);
    expect(filterPages(rows, { disagrees: true }).map((row) => row.source_id)).toEqual(["web:sheriff"]);
    expect(filterPages(rows, { tool: "dork", category: "civic" })).toHaveLength(0);
  });

  it("counts each tool's searches, pages and acceptances, and pages only that tool found", () => {
    const rows = pageRows({ ...fixture(), runId: RUN });
    const foundBy = new Map(rows.map((row) => [row.key, new Set([row.tool])]));
    const tools = toolCounts(rows, { dork: 3, exa: 2, tavily: 1 }, foundBy, [{ id: "brightdata", label: "", used: 3, ceiling: 60, unit: "searches", note: null, tool: "dork" }]);
    const none = { returned: 0, found_only: 0, found_elsewhere: 0 };
    expect(tools.find((row) => row.tool === "fixed")).toEqual({ tool: "fixed", searches: null, found: 3, opened: 2, passed_code: 2, accepted_by_gemini: 1, only_this_tool: 1, accepted_by_you: 0, limit_use: "Free", ...none });
    expect(tools.find((row) => row.tool === "dork")).toEqual({ tool: "dork", searches: 3, found: 1, opened: 1, passed_code: 1, accepted_by_gemini: 0, only_this_tool: 0, accepted_by_you: 1, limit_use: "3 of 60 searches", ...none });
    // An accepted page another tool also turned up isn't only this tool's.
    foundBy.get(rows.find((row) => row.source_id === "web:agendas")!.key)!.add("exa");
    expect(toolCounts(rows, {}, foundBy, []).find((row) => row.tool === "fixed")!.only_this_tool).toBe(0);
  });

  it("credits every tool that found a page, and counts every result each tool returned, with those only it found", () => {
    const rows = pageRows({ ...fixture(), runId: RUN });
    const shared = rows.find((row) => row.tool === "dork")!;
    shared.tools = ["dork", "exa"];
    const foundBy = new Map(rows.map((row) => [row.key, new Set(row.tools ?? [row.tool])]));
    foundBy.set("only.example.org/page", new Set(["exa"]));
    const returned = { dork: new Set([shared.key]), exa: new Set([shared.key, "only.example.org/page"]) };
    const tools = toolCounts(rows, { dork: 1, exa: 1 }, foundBy, [], returned, { exa: 1 });
    // The page both found counts for each, so the totals add up to more than the run's pages.
    expect(tools.filter((row) => row.tool === "dork" || row.tool === "exa").map((row) => [row.tool, row.found, row.returned, row.found_only, row.found_elsewhere])).toEqual([["dork", 1, 1, 0, 0], ["exa", 2, 2, 1, 1]]);
    // The exa page of its own, and the one it shares with dork.
    expect(filterPages(rows, { tool: "exa" }).map((row) => row.key)).toContain(shared.key);
  });

  it("keeps a fixed reader's page credited to the fixed readers when search tools return it later, with those tools as extra tags", () => {
    const input = fixture();
    input.agent!.leads.push({ url: "https://fixturetown.gov/agendas", tool: "dork", tools: ["dork", "exa"], query: "Fixture Town city council", step: 8, title: "Agendas", snippet: "", skipped: { why: "a site the free readers already found", step: 8, by: "code" } });
    const rows = pageRows({ ...input, runId: RUN });
    const agendas = rows.find((row) => row.url.includes("fixturetown.gov/agendas"))!;
    expect(agendas).toMatchObject({ tool: "fixed", tools: ["fixed", "dork", "exa"], found: { query: null, step: null } });
    expect(agendas.found.how).not.toBe("Search");
    expect(filterPages(rows, { tool: "fixed" }).map((row) => row.key)).toContain(agendas.key);
    expect(filterPages(rows, { tool: "dork" }).map((row) => row.key)).toContain(agendas.key);
  });

  it("gives search tools no credit in By tool for a page a fixed reader found first, beyond the results they returned", () => {
    const input = fixture();
    input.agent!.leads.push({ url: "https://fixturetown.gov/agendas", tool: "dork", tools: ["dork", "exa"], query: "Fixture Town city council", step: 8, title: "Agendas", snippet: "", skipped: { why: "a site the free readers already found", step: 8, by: "code" } });
    const rows = pageRows({ ...input, runId: RUN });
    const agendas = rows.find((row) => row.url.includes("fixturetown.gov/agendas"))!;
    const foundBy = new Map(rows.map((row) => [row.key, new Set(row.tools ?? [row.tool])]));
    const counts = (all: typeof rows, returned: Partial<Record<"dork" | "exa", Set<string>>>) => toolCounts(all, {}, foundBy, [], returned);
    const without = counts(rows.filter((row) => row.key !== agendas.key), {});
    const withIt = counts(rows, { dork: new Set([agendas.key]), exa: new Set([agendas.key]) });
    for (const tool of ["dork", "exa"] as const) {
      const before = without.find((row) => row.tool === tool), after = withIt.find((row) => row.tool === tool)!;
      expect(after).toMatchObject({ found: before?.found ?? 0, opened: before?.opened ?? 0, passed_code: before?.passed_code ?? 0, accepted_by_gemini: before?.accepted_by_gemini ?? 0, only_this_tool: before?.only_this_tool ?? 0, found_only: 0, returned: 1 });
    }
    // The fixed readers keep it.
    expect(withIt.find((row) => row.tool === "fixed")!.found).toBe(without.find((row) => row.tool === "fixed")!.found + 1);
  });

  it("orders a page's tool tags as the grid does: Dorking, Exa, Tavily", () => {
    const input = fixture();
    input.agent!.leads.push({ url: "https://new.example.org/listing", tool: "tavily", tools: ["tavily", "exa", "dork"], query: "q", step: 9, title: "Listing", snippet: "" });
    input.agent!.leads.push({ url: "https://fixturetown.gov/agendas", tool: "tavily", tools: ["tavily", "dork"], query: "q", step: 9, title: "Agendas", snippet: "" });
    const rows = pageRows({ ...input, runId: RUN });
    expect(rows.find((row) => row.url === "https://new.example.org/listing")?.tools).toEqual(["dork", "exa", "tavily"]);
    expect(rows.find((row) => row.url.includes("fixturetown.gov/agendas"))?.tools).toEqual(["fixed", "dork", "tavily"]);
  });

  it("says how the run ended and lists the agent's steps, ending with why it stopped", () => {
    const { agent } = fixture();
    const settings = settingsOf(choicesFor(DEFAULT_SETTINGS, defaultRunOptions({})));
    expect(runEnding({ status: "mapped", error: null }, settings, agent).text).toBe("Dried up: nothing new in 10 steps; not found: Police, fire and safety");
    expect(runEnding({ status: "mapped", error: null }, settings, { ...agent, stopped_by: { limit: "gemini", reason: "gemini: 150 a run" } }).text).toBe("Stopped at a limit: gemini: 150 a run");
    expect(runEnding({ status: "mapped", error: null }, { ...settings, agent: false }, null).text).toBe("Finished: fixed readers only");
    expect(runEnding({ status: "mapped", error: null }, settings, { ...agent, checklist: { government: agent.checklist.government } }).text).toBe("Goal met: every category has an accepted source");
    const log = agentLog(agent);
    expect(log.map((row) => row.step)).toEqual(["2", "5", "7", "Stop"]);
    expect(log[0]).toMatchObject({ action: "search", tool: "dork", target: "\"Fixture Town\" sheriff", reason: "Crime is open", result: "2 results." });
    expect(log.at(-1)).toMatchObject({ reason: expect.stringContaining("found nothing new"), result: "Not found: Police, fire and safety: dried up after 8 searches" });
  });
});

describe("search depth", () => {
  it("has no search depth to choose: new runs record none, and a past run shows the depth it recorded", () => {
    expect(defaultRunOptions({})).not.toHaveProperty("search_depth");
    expect(defaultRunOptions({ NEWSBEE_SOURCE_RUNS_ISOLATED: "off" })).not.toHaveProperty("search_depth");
    const defaults = defaultRunOptions({});
    expect(choicesFor(DEFAULT_SETTINGS, defaults)).not.toHaveProperty("search_depth");
    expect(DEFAULT_SETTINGS).not.toHaveProperty("depth");
    // A run from #134 keeps what it recorded, so its saved plan and its display stay as they were.
    expect(settingsOf(resolveRunOptions({ search_depth: "enough" }))).toMatchObject({ depth: "enough" });
    expect(toolsSummary(settingsOf(resolveRunOptions({ map_flow: "agentic", search_depth: "enough", paid: { serpapi: 20 } })))).toBe("Dorking only · Enough (an older run)");
    expect(() => resolveRunOptions({ search_depth: "forever" })).toThrow(RunOptionsError);
    const legacy = { ...resolveRunOptions({}) };
    expect(normalizedPlan("loc", "map", legacy, null).options).not.toHaveProperty("search_depth");
  });

  it("shows an exhaustive run's grid and says in plain words why it stopped", () => {
    const { agent } = fixture();
    const settings = { ...settingsOf(choicesFor({ ...DEFAULT_SETTINGS, exa: false, tavily: false, depth: "exhaustive" }, defaultRunOptions({}))) };
    const searches = [1, 2, 3].map((step) => ({ step, at: T + step, category: "crime" as const, tool: "dork" as const, results: 3, new_sites: 2, overlap: 0 }));
    const exhaustive: AgentState = { ...agent, depth: "exhaustive", cell_dry: 3, checklist: { crime: agent.checklist.crime }, searches, sources: [], start_hosts: [], stopped_by: null };
    expect(runEnding({ status: "mapped", error: null }, settings, exhaustive).text).toBe("All cells dry or unavailable: 1 dry, 2 unavailable");
    expect(runEnding({ status: "mapped", error: null }, settings, { ...exhaustive, unavailable: {}, finished: null, stopped_by: { limit: "gemini", reason: "Gemini: 450 a day" }, open_cells: 7 }).text).toBe("Stopped at a limit: Gemini: 450 a day, with 7 cells still open");
    const grid = searchGrid(exhaustive, settings)!;
    expect(grid.categories).toEqual([{ category: "crime", label: "Police, fire and safety", dry: true }]);
    expect(grid.cells.map((cell) => [cell.tool, cell.status, cell.searches, cell.hits])).toEqual([["dork", "dry", 3, 0], ["exa", "unavailable", 0, 0], ["tavily", "unavailable", 0, 0]]);
    expect(grid.curves.dork).toHaveLength(3);
    // A run that searched until covered has no grid.
    expect(searchGrid(agent, settings)).toBeNull();
  });

  it("shows each cell's round and share, which wait for their turn, Dorking's dry after 2, and hits found while searching another category", () => {
    const { agent } = fixture();
    const settings = { ...settingsOf(choicesFor({ ...DEFAULT_SETTINGS, tavily: false }, defaultRunOptions({}))) };
    const search = (step: number, category: "crime" | "schools" | "sports", tool: "dork" | "exa") => ({ step, at: T + step, category, tool, results: 3, new_sites: 1, overlap: 0, round: 1 });
    const checklist = { crime: agent.checklist.crime, schools: { status: "open" as const, accepted: [], searches: 0, tools: [], note: null }, sports: { status: "open" as const, accepted: [], searches: 0, tools: [], note: null } };
    const sources = [{ url: "https://hale.example.edu/news", source_id: "web:hale", name: "Hale news", category: "schools" as const, tool: "exa", query: null, step: 9, found_at_step: 4, opened_with: null, verdict: "accept", reason: null, host: "hale.example.edu", credits: [{ step: 4, tool: "exa" as const, category: "schools" as const, searched: "sports" as const }], good: true, pending: false }];
    const state: AgentState = { ...agent, depth: "exhaustive", cell_dry: 3, cell_dry_dork: 2, checklist, caps: { dork: 20, exa: 60 }, searches: [search(1, "crime", "dork"), search(2, "crime", "dork"), search(3, "schools", "exa"), search(4, "sports", "exa"), search(5, "sports", "exa")], sources, start_hosts: [], stopped_by: null, finished: null, rounds: 2 };
    const grid = searchGrid(state, settings)!;
    const cell = (category: string, tool: string) => grid.cells.find((item) => item.category === category && item.tool === tool)!;
    expect(grid).toMatchObject({ cell_dry: 3, cell_dry_dork: 2, rounds: 2 });
    expect(cell("crime", "dork")).toMatchObject({ status: "dry", dry_after: 2, share: 6 });
    expect(cell("sports", "dork")).toMatchObject({ status: "open", round: 1, share: 6, waiting: false });
    expect(cell("sports", "exa")).toMatchObject({ round: 3, share: 20, waiting: true });
    // Crime × Exa hasn't had its first turn, so both other Exa cells wait for it.
    expect(cell("crime", "exa")).toMatchObject({ round: 1, waiting: false });
    expect(cell("schools", "exa")).toMatchObject({ round: 2, waiting: true, hits: 1, found_elsewhere: { sports: 1 } });
  });

  it("shows each category's angle sequence with the agent's reasons and which tools hit, and the angles each cell tried", () => {
    const { agent } = fixture();
    const settings = { ...settingsOf(choicesFor({ ...DEFAULT_SETTINGS, tavily: false, depth: "exhaustive" }, defaultRunOptions({}))) };
    const search = (step: number, tool: "dork" | "exa", angle: string, query: string) => ({ step, at: T + step, category: "crime" as const, tool, results: 3, new_sites: 2, overlap: 0, angle, query });
    const searches = [search(1, "dork", "anchor", "Lakeside crime"), search(2, "exa", "anchor", "Lakeside crime"), search(3, "dork", "institutions", '"North Precinct" Lakeside blotter'), search(4, "exa", "institutions", "Pages where the North Precinct posts incident reports")];
    const sources = [{ url: "https://spd.example.gov/north", source_id: "web:spd", name: "North Precinct", category: "crime" as const, tool: "exa", query: null, step: 5, found_at_step: 4, opened_with: null, verdict: "accept", reason: null, host: "spd.example.gov", credit: { step: 4, tool: "exa" as const, category: "crime" as const }, good: true, pending: false }];
    const angles = { crime: [{ family: "anchor" as const, reason: "", step: 1, at: T + 1, tool: "dork" as const }, { family: "institutions" as const, reason: "the North Precinct covers it", step: 3, at: T + 3, tool: "dork" as const }] };
    const exhaustive: AgentState = { ...agent, depth: "exhaustive", cell_dry: 3, checklist: { crime: agent.checklist.crime }, searches, sources, start_hosts: [], stopped_by: null, angles, explore: false };
    const grid = searchGrid(exhaustive, settings)!;
    expect(grid.angles).toEqual([{ category: "crime", label: "Police, fire and safety", angles: [
      expect.objectContaining({ family: "anchor", label: "Anchor", step: 1, results: { dork: "miss", exa: "miss", tavily: "not yet" } }),
      expect.objectContaining({ family: "institutions", label: "Institutions", reason: "the North Precinct covers it", tool: "dork", results: { dork: "miss", exa: "hit", tavily: "not yet" }, queries: { dork: '"North Precinct" Lakeside blotter', exa: "Pages where the North Precinct posts incident reports" } }),
    ] }]);
    expect(grid.cells.filter((cell) => cell.tool !== "tavily").map((cell) => [cell.tool, cell.angles, cell.hits])).toEqual([["dork", ["anchor", "institutions"], 0], ["exa", ["anchor", "institutions"], 1]]);
    // A run from before angles shows none.
    expect(searchGrid({ ...exhaustive, angles: undefined }, settings)!.angles).toEqual([]);
  });
});

describe("Source runs routes", () => {
  async function seedRuns() {
    const options = choicesFor({ ...DEFAULT_SETTINGS, tavily: false }, { ...defaultRunOptions({}), paid: { gemini: 200 } });
    await db.collection(COLLECTIONS.runs).insertMany([
      { _id: "map-run-1", kind: "map", location_id: locationId, location_name: "Fixture Town", status: "mapped", created_at: T - 1000, completed_at: T - 500, options: choicesFor({ ...DEFAULT_SETTINGS, agent: false }, defaultRunOptions({})), trigger: { by: "x", kind: "manual" } },
      { _id: "edition-run", kind: "edition", location_id: locationId, location_name: "Fixture Town", status: "published", created_at: T - 100, completed_at: T, trigger: { by: "x", kind: "manual" } },
      { _id: RUN, kind: "map", location_id: locationId, location_name: "Fixture Town", status: "mapped", created_at: T, completed_at: T + 32 * 60, options, trigger: { by: "owner@example.test", kind: "manual" } },
      { _id: "other-place-run", kind: "map", location_id: "elsewhere", location_name: "Elsewhere", status: "mapped", created_at: T, completed_at: T + 60, options, trigger: { by: "x", kind: "manual" } },
    ] as never[]);
    const { decisions, agent } = fixture();
    await runDecisions(db).insertMany(decisions);
    await db.collection<AgentState>(AGENT_STATE).insertOne(agent);
    await apiCalls(db).insertMany([
      { run_id: RUN, location_id: locationId, service: "gemini", paid: true, units: 1, outcome: "ok", detail: null, cost_estimate: null, created_at: T + 5 },
      { run_id: RUN, location_id: locationId, service: "brightdata", paid: true, units: 1, outcome: "ok", detail: null, cost_estimate: null, created_at: T + 6 },
      { run_id: RUN, location_id: locationId, service: "brightdata", paid: true, units: 0, outcome: "skipped", detail: "not ticked", cost_estimate: null, created_at: T + 7 },
    ]);
    await db.collection("search_queries").insertOne({ run_id: RUN, location_id: locationId, provider: "brightdata", query: "q", topic: "crime", family: "agent:dork", stage: "stage1", origin: "agent", results: [{ url: "https://sheriff.example.test/news" }], skipped: null, error: null, created_at: T + 2 });
    await upsertCandidates(db, locationId, [
      candidate("web:agendas", "https://fixturetown.gov/agendas"),
      candidate("web:sheriff", "https://sheriff.example.test/news", { section: "safety", found_by: { method: "agent", detail: "", tool: "dork" } }),
    ]);
  }
  const get = (path: string) => new Request(`https://${host}/api/maps/locations/${locationId}/${path}`);

  it("lists only a location's map runs, newest first and numbered, with how many finished", async () => {
    await seedRuns();
    const response = await runList(get("source-runs"), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.completed).toBe(2);
    expect(body.runs.map((run: { run_id: string; number: number; summary: string }) => [run.run_id, run.number, run.summary])).toEqual([[RUN, 2, "Dorking and Exa"], ["map-run-1", 1, "Fixed readers only"]]);
  });

  it("returns one run's settings, ending, limits, stages, categories, pages, tools and log, and nothing for an edition or another place's run", async () => {
    await seedRuns();
    const detail = async (runId: string) => runDetail(get(`source-runs/${runId}`), { params: Promise.resolve({ locationId, runId }) });
    const response = await detail(RUN);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.settings).toMatchObject({ agent: true, dork: true, exa: true, tavily: false, respect: true, gemini_check: true });
    expect(body.run).toMatchObject({ number: 2, location_name: "Fixture Town", by: "owner@example.test" });
    expect(body.ending.text).toMatch(/^Dried up/);
    expect(body.limits.map((meter: { id: string; used: number; ceiling: number | null }) => [meter.id, meter.used, meter.ceiling])).toEqual([["model", 1, 150], ["brightdata", 1, 20], ["exa", 0, 60], ["time", 32, 45]]);
    expect(body.stages.map((stage: { id: string; count: number }) => [stage.id, stage.count])).toEqual([["found", 7], ["opened", 4], ["link_only", 1], ["code_fail", 1], ["gemini_reject", 1], ["passed", 1]]);
    expect(body.categories.find((row: { category: string }) => row.category === "civic")).toMatchObject({ status: "covered", accepted_by_gemini: 1 });
    expect(body.categories.find((row: { category: string }) => row.category === "safety")).toMatchObject({ status: "not_found", note: "dried up after 8 searches" });
    expect(body.tools.find((row: { tool: string }) => row.tool === "dork")).toMatchObject({ searches: 1, found: 1, limit_use: "1 of 20 searches" });
    expect(body.log.at(-1).step).toBe("Stop");
    expect((await detail("edition-run")).status).toBe(404);
    expect((await detail("other-place-run")).status).toBe(404);
  });

  it("leaves the search tools' meters out of a local fixture run, says its tools were free, and gives its grid no shares", async () => {
    await seedRuns();
    await db.collection("pipeline_runs").updateOne({ _id: RUN as never }, { $set: { "options.search_provider": "fixture" } });
    await db.collection(AGENT_STATE).updateOne({ _id: RUN as never }, { $set: { depth: "exhaustive", caps: { dork: null, exa: null } } });
    const body = await (await runDetail(get(`source-runs/${RUN}`), { params: Promise.resolve({ locationId, runId: RUN }) })).json();
    expect(body.limits.map((meter: { id: string }) => meter.id)).toEqual(["model", "time"]);
    expect(body.tools.find((row: { tool: string }) => row.tool === "dork")).toMatchObject({ limit_use: "Local fixture, free" });
    expect(body.grid).toMatchObject({ fixture: true });
    expect(body.grid.cells.every((cell: { share: number | null }) => cell.share === null)).toBe(true);
  });

  it("shows each limit as the gateway enforces it: the lower of the run's budget and the hard limit a run", async () => {
    await seedRuns();
    await db.collection("pipeline_runs").updateOne({ _id: RUN as never }, { $set: { "options.paid.brightdata": 100, "options.paid.exa": 5 } });
    const response = await runDetail(get(`source-runs/${RUN}`), { params: Promise.resolve({ locationId, runId: RUN }) });
    const body = await response.json();
    expect(body.limits.map((meter: { id: string; ceiling: number | null }) => [meter.id, meter.ceiling])).toEqual([["model", 150], ["brightdata", 60], ["exa", 5], ["time", 45]]);
  });

  it("is a protected map read: password-only viewers can read it, strangers can't", async () => {
    await seedRuns();
    mocks.auth.mockResolvedValue(null);
    vi.stubEnv("NEWSBEE_INTERNAL_PASSWORD", password);
    expect((await runList(get("source-runs"), context)).status).toBe(403);
    mocks.cookies.mockResolvedValue({ get: () => ({ value: internalToken(password) }) });
    expect((await runList(get("source-runs"), context)).status).toBe(200);
  });
});

describe("bulk decisions", () => {
  const post = (body: unknown, headers: Record<string, string> = { origin: `https://${host}` }) =>
    bulkReview(new Request(`https://${host}/api/admin/locations/${locationId}/source-map/reviews`, { method: "POST", headers, body: JSON.stringify(body) }), context);
  beforeEach(async () => {
    await upsertCandidates(db, locationId, ["a", "b", "c"].map((id) => candidate(`web:${id}`, `https://${id}.example.test/`)));
  });

  it("saves one decision and reason on every selected source, each with its own history row, as in All sources", async () => {
    const response = await post({ source_ids: ["web:a", "web:b"], decision: "accept", reason_code: "A1" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.saved.map((row: { source_id: string; status: string }) => [row.source_id, row.status])).toEqual([["web:a", "active"], ["web:b", "active"]]);
    expect(body.failed).toEqual([]);
    for (const id of ["web:a", "web:b"]) expect((await sourceMap(db).findOne({ _id: `${locationId}:${id}` }))?.review).toMatchObject({ decision: "accept", reason_code: "A1", initial_status: "proposed", by: "labeller@example.test" });
    expect((await sourceMap(db).findOne({ _id: `${locationId}:web:c` }))?.review).toBeUndefined();
    expect(await db.collection(SOURCE_REVIEWS).countDocuments({ decision: "accept" })).toBe(2);
    const rejected = await (await post({ source_ids: ["web:a", "web:missing"], decision: "reject", reason_code: "R9", reason: "Only a staff list" })).json();
    expect(rejected.saved.map((row: { source_id: string; status: string }) => [row.source_id, row.status])).toEqual([["web:a", "rejected"]]);
    expect(rejected.failed).toEqual([{ source_id: "web:missing", detail: "Unknown source: web:missing" }]);
    expect((await sourceMap(db).findOne({ _id: `${locationId}:web:a` }))?.review).toMatchObject({ decision: "reject", reason_code: "R9", reason: "Only a staff list" });
  });

  it("refuses a reason that doesn't fit the decision, a missing reason, text without Other, an empty list, a stranger and another site", async () => {
    expect((await post({ source_ids: ["web:a"], decision: "accept", reason_code: "R1" })).status).toBe(400);
    expect((await post({ source_ids: ["web:a"], decision: "accept" })).status).toBe(400);
    expect((await post({ source_ids: ["web:a"], decision: "accept", reason_code: "A1", reason: "text" })).status).toBe(400);
    expect((await post({ source_ids: [], decision: "accept", reason_code: "A1" })).status).toBe(400);
    expect((await post({ source_ids: ["web:a", 4], decision: "accept", reason_code: "A1" })).status).toBe(400);
    expect((await post({ source_ids: ["web:a"], decision: "accept", reason_code: "A1" }, { origin: "https://elsewhere.example.test" })).status).toBe(403);
    mocks.auth.mockResolvedValue(null);
    expect((await post({ source_ids: ["web:a"], decision: "accept", reason_code: "A1" })).status).toBe(401);
    expect(await db.collection(SOURCE_REVIEWS).countDocuments()).toBe(0);
  });
});

describe("navigation", () => {
  it("sends the old Run funnel and Compare runs addresses to the Edition map", async () => {
    expect(editionRedirect({ location: "fixture", mode: "edition", run: "run-1" })).toBe("/edition-map?location=fixture&run=run-1");
    expect(editionRedirect({ location: "fixture", mode: "edition", view: "compare" })).toBe("/edition-map?location=fixture&view=compare");
    expect(editionRedirect({ mode: "edition" })).toBe("/edition-map");
    expect(editionRedirect({ location: "fixture", mode: "inventory" })).toBeNull();
    expect(editionRedirect({ location: "fixture", tab: "runs" })).toBeNull();
    await expect(SourceMapPage({ searchParams: Promise.resolve({ location: "fixture", mode: "edition", run: "run-1" }) })).rejects.toMatchObject({ digest: expect.stringContaining("/edition-map?location=fixture&run=run-1") });
    expect(internalReturnPath("/edition-map?location=fixture&view=compare")).toBe("/edition-map?location=fixture&view=compare");
  });
});

describe("How I found it", () => {
  it("keeps the note with how a hand-added source was found, in the source and its review history", async () => {
    const saved = await addSourceLink(db, loadSettings(), locationId, { type: "web", name: "Library branches", url: "https://library.example.test/branches", section: "events", how_found: "  The library's   branch list  " });
    const record = await sourceMap(db).findOne({ _id: `${locationId}:${saved.source_id}` });
    expect(record?.found_by).toMatchObject({ method: "editor", how_found: "The library's branch list" });
    const plain = await addSourceLink(db, loadSettings(), locationId, { type: "web", name: "Parks", url: "https://parks.example.test/", section: "events" });
    expect((await sourceMap(db).findOne({ _id: `${locationId}:${plain.source_id}` }))?.found_by.how_found).toBeUndefined();
    await (await import("../../sourcemap/store")).saveSourceReview(db, locationId, saved.source_id, { decision: "accept" }, "labeller@example.test");
    expect((await db.collection(SOURCE_REVIEWS).findOne({ source_id: saved.source_id }))?.found_by).toMatchObject({ how_found: "The library's branch list" });
  });
});
