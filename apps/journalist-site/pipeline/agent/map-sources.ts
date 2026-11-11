/**
 * The source-mapping agent: Stage 1 of the agentic flow, after the free readers (the fixed
 * pipeline). It finds every lasting local source the free readers missed, until each search tool
 * stops turning up new ones, category by category (./search-grid.ts). It works in rounds, and each
 * round has the same steps:
 *
 *   plan     one model call: for every category × tool cell whose turn it is, the angle it runs
 *            (./search-angles.ts; the agent picks a category's next angle, with a reason) and one
 *            query in that tool's own phrasing. Code checks each query and refuses what breaks a
 *            rule: local only, no guessed `site:` addresses, no admin, login or exposed-file
 *            queries, the angle rules, and the round's turns.
 *   search   code runs the round's searches, the tools side by side, each within the gateway's
 *            limits. Tool-native actions (Tavily explore, Exa find-similar, opening a hub page for
 *            its links) are that cell's search for the round, against the same share and cap.
 *   clean    code drops sites the free readers found, sites already accepted or proposed in this
 *            run, the platforms we never read and results triaged before, and merges what several
 *            tools found into one result that credits each of them.
 *   triage   a few model calls, a few categories at a time: propose or skip every result, with a
 *            reason for each skip, and the category each proposal belongs to.
 *   open     code opens and code-checks the proposals (`agent_round_proposals` a round; the rest
 *            go to the next round's triage, first).
 *   judge    the shared model check (../discovery/gemini-check.ts), 25 sources a call.
 *   score    code updates hits, streaks and dry cells, and the next round starts.
 *
 * The round is saved after every step, so the 200-second jobs carry one run on: a job starts steps
 * until the next won't fit (a step that calls the model needs `agent_gemini_reserve_seconds`), and
 * the next job resumes at the saved step, repeating nothing. Only the dry rules set how many rounds
 * there are; the run stops when every cell is dry or unavailable, or at a ceiling: Gemini's hard
 * limits, the run's model budget (checked before each round) or the whole-run time.
 *
 * Its instructions are the skill (skills/map-sources/SKILL.md) and the playbook's prompts, tool
 * practices and research habits. Page text and search results are data, not instructions; the
 * agent has no database access or secrets, never sets `inside_area`, and robots, rights and
 * private addresses stay with code.
 */
import type { Db } from "mongodb";
import { Fetcher } from "../connectors/fetcher";
import { pageLinks } from "../connectors/ai-discovery";
import { httpsLink } from "../connectors/common";
import { publicSourceTransport } from "../connectors/public-http";
import { accessIgnored, currentOptions, isDeployed, isolatedRunId, PRIORITY_TOPICS, runContext, type PriorityTopic, type RunOptions, type SearchProvider } from "../core/run-options";
import { paidAllowance, type PaidService } from "../core/run-values";
import type { Settings } from "../core/config";
import { DO_NOT_SCRAPE } from "../connectors/fetcher";
import type { JsonSchema, ModelRuntime } from "../model/runtime";
import { addDays } from "../connectors/common";
import { normaliseUrl, pageDecisions, sourceMap, hostOf, type SourceCandidate, type SourceRecord } from "../sourcemap/store";
import { recordDecision } from "../trace/decisions";
import { HARD_LIMITS, modelCallsLeft, paidCall, pastRunTime, RUN_MINUTES, stoppedBy, unavailableServices } from "../trace/gateway";
import type { DiscoveryContext } from "../discovery/methods";
import { evaluateLeads, JOB_DEADLINE_MS, openPage, sourceUrl, type Rejection } from "../discovery/evaluate";
import { CHECK_BATCH, checkAndSave, geminiCheckOn, judgePending, OUT_OF_TIME, pastDecisions } from "../discovery/gemini-check";
import { buildSearchKit, isLocalQuery, TOPIC_SECTIONS, type SearchKit } from "../discovery/topics";
import { exploreSite, findSimilar, missingKey, search, type SearchResult } from "../search/provider";
import { fill, limit, ruleSet, table, template } from "../playbook";
import { mappingSkill } from "./skill";
import { buildGrid, cellKey, cellOf, eligibleCells, SEARCH_TOOLS, weakQueries, type CellSearch, type Credit, type Grid, type SearchDepth, type SearchTool } from "./search-grid";
import {
  anchorQuery, ANGLE_FAMILIES, ANGLE_LABELS, angleRows, applicableCells, applicableFamilies, cellQueries, checkAngle, familyLines, nativeQueryProblem, nearDuplicate,
  pendingAngle, QUERY_OVERLAP, roleQueryProblem, triedAngles, vocabularyLines, type AngleContext, type AngleFamily, type AngleSequences,
} from "./search-angles";

export const AGENT_STATE = "agent_state";
/** Searches in a row with no hit before an Exa or Tavily cell goes dry, and before a dork cell does. */
export const CELL_DRY = limit("general.stop.agent_cell_dry");
export const CELL_DRY_DORK = limit("general.stop.agent_cell_dry_dork");
const MODEL_FAILURES = limit("general.stop.agent_model_failures");
const LINKS_SHOWN = limit("general.stop.agent_links_shown");
const QUERY_MIN_CHARS = limit("general.stop.agent_query_min_chars");
const QUERY_MAX_CHARS = limit("general.stop.agent_query_max_chars");
/** Words in each of the agent's reasons for skipping a result. */
export const SKIP_WORDS = limit("general.stop.agent_skip_words");
/** Categories, and results after clean-up, in one triage call. */
export const TRIAGE_CATEGORIES = limit("general.stop.agent_triage_categories");
export const TRIAGE_RESULTS = limit("general.stop.agent_triage_results");
/** Proposals one round opens and checks; the rest go to the next round's triage, first. */
export const ROUND_PROPOSALS = limit("general.stop.agent_round_proposals");
/** No step that calls the model starts with less than this left in the job. */
export const GEMINI_RESERVE_MS = limit("general.stop.agent_gemini_reserve_seconds") * 1000;
/** No search or page opening starts this close to the end of a job, so it finishes inside it. */
const WORK_RESERVE_MS = 30_000;
/** Categories whose searches ask only for recent pages, by section. */
const DATE_RANGE_DAYS = table<number>("general.search.agent_date_range_days");
const TOOL_RULES = Object.fromEntries(ruleSet("agent_tools").map((rule) => [rule.id.replace(/^general\.search\.tool_/, ""), rule.text!]));
const HABITS = ruleSet("research_habits").map((rule) => rule.text!);
const HABIT_EXAMPLES = ruleSet("habit_examples").map((rule) => rule.text!);
/** Failures in a row before a search tool is treated as unavailable. */
const TOOL_FAILURES = 3;
const BAD_QUERY = /\binurl:(admin|login|wp-admin)|password|filetype:(sql|env|xlsx?)/i;

export { SEARCH_TOOLS, type SearchTool } from "./search-grid";
export const ROUND_STAGES = ["plan", "search", "clean", "triage", "open", "judge", "score"] as const;
export type RoundStage = typeof ROUND_STAGES[number];

/** One category's accepted sources: from the free readers, earlier runs and the agent. */
export type CategoryCheck = {
  /** Covered once anything is accepted. Not found is from runs before every run was exhaustive. */
  status: "covered" | "open" | "not_found";
  accepted: Array<{ name: string; url: string | null; by: "map" | "agent" }>;
  searches: number; tools: SearchTool[]; note: string | null;
};
/** One step of a round, as traced: a plan or triage call, a search, the proposals opened, the model check or the score. */
export type AgentStep = {
  step: number; job: number; at: number; action: string; tool: string | null; query: string | null; url: string | null; category: PriorityTopic | null;
  reason: string; outcome: "ok" | "refused" | "failed" | "invalid"; result: string; accepted: string[]; ms: number;
  /** For a search: the angle family it took, and its round. */
  angle?: string | null; round?: number;
  /** For an opened page: the reader that opened it, and the readers tried first with why. */
  opened_with?: string | null; fallbacks?: Array<{ reader: string; why: string }>;
};
/**
 * Where a page came up: the first tool, query and step that found it, every tool that returned it,
 * and why it was passed over (the agent's words from triage, or code's from clean-up).
 */
export type Lead = { url: string; tool: string; query: string | null; step: number; title: string; snippet: string; skipped?: { why: string; step: number; by?: "agent" | "code" } | null; tools?: string[]; round?: number };
/** One source the agent proposed, as traced. */
export type SourceTrace = {
  url: string; source_id: string; name: string; category: PriorityTopic; tool: string; query: string | null; step: number; found_at_step: number; opened_with: string | null; verdict: string; reason: string | null;
  /** Its site, the searches it is credited to (one per tool that returned it, in the category it is filed under), whether it is accepted, and whether its verdict still waits. */
  host?: string | null; credit?: Credit | null; credits?: Credit[]; tools?: string[]; good?: boolean; pending?: boolean;
  /** The category whose search found it, when it is filed under another. */
  searched?: PriorityTopic;
};

/** One search the round's plan settled on, with the step it is traced under. */
export type PlannedSearch = {
  step: number; category: PriorityTopic; tool: SearchTool; family: AngleFamily; reason: string;
  kind: "search" | "similar" | "explore" | "hub"; query: string; url?: string; instruction?: string;
  done?: boolean; results?: Array<{ url: string; title: string; snippet: string }>;
};
/** One result after clean-up: a page, every tool that returned it, and the category whose search found it first. */
export type RoundItem = { id: string; url: string; key: string; host: string; category: PriorityTopic; title: string; snippet: string; tools: SearchTool[]; credits: Credit[]; query: string | null; carried?: boolean };
export type TriageDecision = { action: "propose" | "skip"; why: string; category: PriorityTopic; by: "agent" | "code" };
export type Round = {
  n: number; stage: RoundStage; started_at: number; plan_step: number | null;
  planned: PlannedSearch[]; items: RoundItem[]; chunks: string[][]; triaged: number;
  decisions: Record<string, TriageDecision>; proposals: string[]; opened: string[];
  /** The model calls it made: one plan, its triage chunks, and the model check's batches. */
  calls: { plan: number; triage: number; check: number };
};

export type AgentState = {
  _id: string; run_id: string; jobs: number; steps: AgentStep[]; checklist: Record<string, CategoryCheck>;
  seen: string[]; leads: Lead[]; known_hosts: string[]; rejected: Rejection[]; model_failures: number;
  /** Search tools that became unavailable this run, with why and when. */
  unavailable: Record<string, string>; unavailable_at?: Record<string, number>; tool_failures: Record<string, number>; sources: SourceTrace[];
  /** The ceiling that ended the run's mapping, if one did, and how it ended. */
  stopped_by?: { limit: string; reason: string } | null;
  finished?: { reason: string; at: number } | null;
  /** Always exhaustive now; runs from before recorded Enough or Exhaustive. The misses a cell needed, as this run used them. */
  depth?: SearchDepth; cell_dry?: number; cell_dry_dork?: number;
  /** Every search, by category and tool; the hosts seen in results; those accepted before the tools' finds; and every site the free readers found. */
  searches?: CellSearch[]; seen_hosts?: string[]; start_hosts?: string[]; free_hosts?: string[];
  /** Cells still open when a ceiling stopped the run. */
  open_cells?: number | null;
  /** Each category's sequence of angles, shared by every tool. */
  angles?: AngleSequences;
  /** Whether this run can explore sites with Tavily, which is Tavily's tool-native angle. */
  explore?: boolean;
  /** Each tool's per-run cap, for its share per category; and searches a reopened cell counts as having had, so it rejoins at the current round. */
  caps?: Partial<Record<SearchTool, number | null>>; rejoin?: Record<string, number>; dry_cells?: string[];
  /** The round under way, rounds finished, results triaged in earlier rounds, and proposals over a round's cap waiting for the next. */
  round?: Round | null; rounds?: number; triaged?: string[]; carry?: RoundItem[];
  /** The free readers' model checks were finished, so rounds could start. */
  free_done?: boolean;
  /** The last step number given out. */
  last_step?: number;
  /** From the step-by-step loop runs before rounds used. */
  dry_steps?: number;
};

function states(db: Db) { return db.collection<AgentState>(AGENT_STATE); }
const LABELS = Object.fromEntries(PRIORITY_TOPICS.map((topic) => [topic.id, topic.label])) as Record<PriorityTopic, string>;
const clip = (text: string, length: number) => text.length > length ? `${text.slice(0, length - 1)}…` : text;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const words = (text: string, count: number) => clip(oneLine(text).split(" ").filter(Boolean).slice(0, count).join(" "), 80);

/** The ceiling that has stopped this run, if any: Gemini's hard limits or the whole-run time. Other services' limits only take out their tool. */
async function ceilingReached(db: Db, runId: string) {
  if (pastRunTime()) return { limit: "run_minutes", reason: `the whole-run limit of ${RUN_MINUTES} minutes` };
  return stoppedBy(db, runId);
}

/** A model failure that every later call would hit too: Gemini's hard limits, the run's model budget or a rejected key. */
const stopsAgent = (message: string) => /Hard limit|budget|not ticked|rejected the key/i.test(message);

/** `site:` is allowed only for confirmed sites and whole domains like .gov; a guessed one is removed. */
export function withoutGuessedSites(query: string, known: Set<string>) {
  const guessed: string[] = [];
  const clean = query.replace(/(^|\s)(-?)site:(\S+)/gi, (whole, space: string, minus: string, target: string) => {
    if (minus) return whole;
    const host = target.toLowerCase().replace(/^www\./, "").split("/")[0];
    if (host.startsWith(".") || !host.includes(".") || [...known].some((item) => host === item || host.endsWith(`.${item}`) || item.endsWith(`.${host}`))) return whole;
    guessed.push(target);
    return space;
  }).replace(/\s+/g, " ").trim();
  return { query: clean, guessed };
}

/** The Google-operator service the dork tool runs on: the run's search provider when it is one, else Bright Data, then SerpApi. SearchApi isn't used. */
export function dorkProvider(options: RunOptions, settings: Settings): SearchProvider | null {
  if (options.search_provider === "fixture") return isDeployed() ? null : "fixture";
  const google: SearchProvider[] = ["brightdata", "serpapi"];
  const order = google.includes(options.search_provider) ? [options.search_provider, ...google] : google;
  return order.find((provider) => options.paid[provider as keyof RunOptions["paid"]] !== undefined && !missingKey(provider, settings)) ?? null;
}

/** The search tools this run enables, with the service each runs on. A local fixture run answers every tool from the fixture. */
export function enabledTools(options: RunOptions, settings: Settings): Partial<Record<SearchTool | "explore", SearchProvider>> {
  const fixture = options.search_provider === "fixture" && !isDeployed();
  const paid = (provider: "exa" | "tavily") => options.paid[provider] !== undefined && !missingKey(provider, settings);
  const dork = dorkProvider(options, settings);
  return {
    ...(dork ? { dork } : {}),
    ...(fixture ? { exa: "fixture" as const, tavily: "fixture" as const } : {}),
    ...(paid("exa") ? { exa: "exa" as const } : {}),
    ...(paid("tavily") ? { tavily: "tavily" as const, explore: "tavily" as const } : {}),
  };
}
type Tools = ReturnType<typeof enabledTools>;
/** The limit key in the gateway behind each tool, for unavailability. */
const LIMIT_KEYS: Record<string, string[]> = { dork: ["brightdata", "serpapi"], exa: ["exa"], tavily: ["tavily"], explore: ["tavily_explore", "tavily"] };

/** Each tool's per-run cap, as the gateway holds it: the lower of the run's budget for its service and that service's hard limit a run. None for the fixture. */
export function toolCaps(options: RunOptions, tools: Tools): Partial<Record<SearchTool, number | null>> {
  return Object.fromEntries(SEARCH_TOOLS.filter((tool) => tools[tool]).map((tool) => {
    const service = tools[tool]!;
    if (service === "fixture") return [tool, null];
    const caps = [paidAllowance(options.paid, service), HARD_LIMITS[service]?.per_run].filter((value): value is number => typeof value === "number");
    return [tool, caps.length ? Math.min(...caps) : null];
  }));
}

/** The checklist the run starts from: what is already on the map and accepted by the model check (or by a person). */
async function startingChecklist(db: Db, locationId: string, topics: PriorityTopic[]) {
  const rows = await sourceMap(db).find({ location_id: locationId, status: { $nin: ["rejected"] } }, { projection: { name: 1, url: 1, section: 1, topics: 1, gemini: 1, review: 1 } }).toArray() as Array<Pick<SourceRecord, "name" | "url" | "section" | "topics" | "gemini" | "review">>;
  // With the check off (a local baseline test), anything code kept counts.
  const counts = (row: typeof rows[number]) => row.review?.decision === "accept" || row.gemini?.verdict === "accept" || (!geminiCheckOn() && row.review?.decision !== "reject");
  return Object.fromEntries(topics.map((topic) => {
    const accepted = rows.filter((row) => counts(row) && (row.section === TOPIC_SECTIONS[topic] || row.topics?.includes(topic))).map((row) => ({ name: row.name, url: row.url, by: "map" as const }));
    return [topic, { status: accepted.length ? "covered" : "open", accepted, searches: 0, tools: [], note: null } satisfies CategoryCheck];
  }));
}

function emptyState(runId: string): AgentState {
  return { _id: runId, run_id: runId, jobs: 0, steps: [], checklist: {}, seen: [], leads: [], known_hosts: [], rejected: [], model_failures: 0, unavailable: {}, tool_failures: {}, sources: [] };
}

const runToolsOf = (tools: Tools) => SEARCH_TOOLS.filter((tool) => tools[tool]);
/** The grid of category × search tool, from what the agent has done so far. */
export function gridOf(state: AgentState, topics: PriorityTopic[], tools: SearchTool[]): Grid {
  // A run with angles also goes dry in a cell that has tried every angle that applies to it.
  const applicable = state.angles ? applicableCells(topics, tools, (category) => angleContext(state, category)) : undefined;
  return buildGrid({
    topics, searches: state.searches ?? [], sources: state.sources, startHosts: state.start_hosts ?? [], enabled: tools, unavailable: state.unavailable, unavailableAt: state.unavailable_at,
    cellDry: cellDryOf(state), applicable, caps: state.caps, rejoin: state.rejoin,
  });
}
/** The misses that make each tool's cells dry, as this run used them. */
export const cellDryOf = (state: Pick<AgentState, "cell_dry" | "cell_dry_dork">) => ({ dork: state.cell_dry_dork ?? state.cell_dry ?? CELL_DRY_DORK, exa: state.cell_dry ?? CELL_DRY, tavily: state.cell_dry ?? CELL_DRY });
/** What decides which angles apply in a category: an accepted source to find more like, and whether Tavily can still explore. */
export function angleContext(state: Pick<AgentState, "checklist" | "unavailable" | "explore">, category: PriorityTopic): AngleContext {
  return { accepted: acceptedIn(state, category).length > 0, explore: Boolean(state.explore) && !state.unavailable.explore && !state.unavailable.tavily };
}
/** The category's accepted sources with an address, newest last: what "more like this" builds on. */
const acceptedIn = (state: Pick<AgentState, "checklist">, category: PriorityTopic) => (state.checklist[category]?.accepted ?? []).filter((item) => item.url);
/** Hosts accepted so far in this run: the free readers', and the tools' good finds. */
const acceptedHosts = (state: AgentState) => new Set([...state.start_hosts ?? [], ...state.sources.filter((source) => source.good && source.host).map((source) => source.host!)]);

function noteLeads(state: AgentState, leads: Lead[]) {
  const known = new Map(state.leads.map((lead) => [normaliseUrl(lead.url), lead]));
  for (const lead of leads) {
    const existing = known.get(normaliseUrl(lead.url));
    // A page another tool returned too: every tool that returned it is credited.
    if (existing) { existing.tools = [...new Set([...existing.tools ?? [existing.tool], ...lead.tools ?? [lead.tool]])]; continue; }
    state.leads.push({ ...lead, tools: lead.tools ?? [lead.tool] }); known.set(normaliseUrl(lead.url), state.leads.at(-1)!);
  }
  state.leads = state.leads.slice(-600);
}
const leadOf = (state: AgentState, url: string) => state.leads.find((lead) => normaliseUrl(lead.url) === normaliseUrl(url)) ?? null;

/** A service refusal or repeated failure takes the tool out for the rest of the run. */
function toolTrouble(state: AgentState, tool: string, skipped: string | null, error: string | null) {
  if (skipped && !/whole-run limit/.test(skipped)) markUnavailable(state, tool, skipped);
  if (error) {
    state.tool_failures[tool] = (state.tool_failures[tool] ?? 0) + 1;
    if (state.tool_failures[tool] >= TOOL_FAILURES) markUnavailable(state, tool, `failed ${TOOL_FAILURES} times in a row (${clip(error, 120)})`);
  } else if (!skipped) state.tool_failures[tool] = 0;
}
function markUnavailable(state: AgentState, tool: string, why: string) {
  state.unavailable[tool] = why;
  (state.unavailable_at ??= {})[tool] ??= Date.now() / 1000;
}

/** Record a search in its cell: how many results, how many from sites new to the run, how many from sites already accepted, its angle and its round. */
function noteSearch(state: AgentState, planned: PlannedSearch, urls: string[], round: number) {
  const seen = new Set(state.seen_hosts ?? []), accepted = acceptedHosts(state);
  const hosts = [...new Set(urls.map(hostOf).filter(Boolean))];
  (state.searches ??= []).push({ step: planned.step, at: Date.now() / 1000, category: planned.category, tool: planned.tool, results: urls.length, new_sites: hosts.filter((host) => !seen.has(host)).length, overlap: hosts.filter((host) => accepted.has(host)).length, angle: planned.family, query: planned.query, round });
  // The tools search side by side; the record keeps step order, whichever finished first.
  state.searches.sort((a, b) => a.step - b.step);
  state.seen_hosts = [...seen, ...hosts.filter((host) => !seen.has(host))];
  const check = state.checklist[planned.category];
  if (check) { check.searches += 1; if (!check.tools.includes(planned.tool)) check.tools.push(planned.tool); }
}

function resultLines(results: SearchResult[]) {
  return results.map((result) => `${result.position}. ${result.url}${result.title ? ` | ${clip(oneLine(result.title), 100)}` : ""}`).join("\n");
}

/** The grid as the agent sees it: one line per category, each tool's cell, whose turn it is, and a warning where queries look weak. */
export function gridLines(grid: Grid, topics: PriorityTopic[]) {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : /(s|ch)$/.test(word) ? "es" : "s"}`;
  return topics.map((topic) => {
    const cells = grid.cells.filter((cell) => cell.category === topic);
    const parts = cells.map((cell) => {
      if (cell.status === "unavailable") return `${cell.tool} UNAVAILABLE`;
      if (cell.status === "dry") return `${cell.tool} DRY (${plural(cell.searches, "search")}, ${plural(cell.hits, "hit")})`;
      const share = cell.share !== null ? `, share ${cell.share}` : "";
      if (!cell.searches) return `${cell.tool} open, untried${share}`;
      return `${cell.tool} open (${plural(cell.searches, "search")}, ${plural(cell.hits, "hit")}, ${cell.dry_streak} of ${cell.dry_after} misses in a row${cell.pending ? `, ${cell.pending} waiting for a verdict` : ""}${share}${cell.waiting ? ", waiting for its turn" : ""}${cell.last_refused ? `; last refused: ${cell.last_refused}` : ""})`;
    });
    const weak = cells.filter((cell) => cell.status === "open" && weakQueries(cell)).map((cell) => `${cell.tool} found ${cell.new_sites} new sites but ${cell.rejected} were rejected and none accepted: rephrase`);
    return `- ${topic}${grid.dry_categories.includes(topic) ? " (dry)" : ""}: ${parts.join(" · ")}${weak.length ? `. Weak queries: ${weak.join("; ")}` : ""}`;
  }).join("\n");
}

/** The place kit, as names the agent fills its angles with. */
export function kitLine(kit: SearchKit) {
  const parts = [
    `place ${kit.place}`, kit.parent ? `part of ${kit.parent}` : null, kit.county ? `${kit.county} County` : null, kit.state, kit.zips.length ? `ZIP ${kit.zips.join(", ")}` : null,
    kit.cityDomain ? `city site ${kit.cityDomain}` : null, kit.schools.length ? `schools: ${kit.schools.slice(0, 12).map((school) => school.name).join(", ")}` : null,
    kit.institutions.length ? `institutions: ${kit.institutions.slice(0, 20).map((item) => `${item.name} (${item.kind.replace(/_/g, " ")})`).join(", ")}` : null,
    kit.venues.length ? `landmarks and venues: ${kit.venues.slice(0, 12).join(", ")}` : null,
  ];
  return parts.filter(Boolean).join("; ");
}

/** Each category's angles so far, and what each tool's search on them came to. */
export function angleLines(kit: SearchKit, state: AgentState, topics: PriorityTopic[], tools: Tools) {
  const rows = angleRows(state.angles ?? {}, state.searches ?? [], state.sources, state.start_hosts ?? [], topics);
  return rows.map(({ category, angles }) => {
    const done = angles.map((angle, index) => `${index + 1}. ${angle.label}${angle.family === "anchor" ? ` "${anchorQuery(kit, category)}"` : ` (${angle.tool}, step ${angle.step}: ${angle.reason})`}: ${runToolsOf(tools).map((tool) => `${tool} ${angle.results[tool]}`).join(", ")}`);
    return `- ${category}: ${done.length ? done.join(" · ") : `no angle yet: it starts with the Anchor, "${anchorQuery(kit, category)}"`}`;
  }).join("\n");
}

/** The angle a cell runs this round: the one it has to catch up on, the anchor, or null when the agent picks the category's next one. */
function turnAngle(state: AgentState, category: PriorityTopic, tool: SearchTool): AngleFamily | null {
  const sequence = state.angles?.[category] ?? [];
  if (!sequence.length) return "anchor";
  return pendingAngle(sequence, triedAngles(state.searches ?? [], category, tool), applicableFamilies(tool, angleContext(state, category)))?.family ?? null;
}

/** This round's turns, by category, as the agent reads them, with the cells that wait for theirs. */
function turnLines(state: AgentState, grid: Grid, topics: PriorityTopic[]) {
  const turns = eligibleCells(grid);
  const lines = topics.flatMap((category) => {
    const mine = turns.filter((cell) => cell.category === category);
    if (!mine.length) return [];
    return [`- ${category}: ${mine.map((cell) => { const angle = turnAngle(state, category, cell.tool); return `${cell.tool} runs ${angle ?? "new"}${angle === "anchor" ? " (code writes it)" : ""}`; }).join("; ")}`];
  });
  const waiting = grid.cells.filter((cell) => cell.waiting).map((cell) => `${cell.category} × ${cell.tool}`);
  return `${lines.join("\n") || "none"}${waiting.length ? `\nWaiting for their turn (don't plan these): ${waiting.join(", ")}` : ""}`;
}

export async function planPrompt(context: DiscoveryContext, kit: SearchKit, state: AgentState, topics: PriorityTopic[], tools: Tools) {
  const grid = gridOf(state, topics, runToolsOf(tools));
  const toolLines = [
    ...runToolsOf(tools).map((tool) => state.unavailable[tool] ? `- ${tool}: UNAVAILABLE this run (${state.unavailable[tool]})` : `- ${TOOL_RULES[tool]}`),
    ...(tools.explore ? [state.unavailable.explore ? `- explore: UNAVAILABLE this run (${state.unavailable.explore})` : `- ${fill(TOOL_RULES.explore, { explorations: HARD_LIMITS.tavily_explore?.per_run ?? "a few" })}`] : []),
  ];
  const tried = (state.searches ?? []).map((row) => `${row.tool} [${row.category}]: ${row.query ?? ""}`);
  const decisions = await pastDecisions(context.db, context.location.id, topics.map((topic) => TOPIC_SECTIONS[topic]));
  const plan = fill(template("general.search.agent_round_plan"), {
    where: `${kit.place}${kit.parent ? `, ${kit.parent}` : ""}, ${kit.state}${kit.county ? ` (${kit.county} County)` : ""}`, names: kit.parent ? `${kit.place} or ${kit.parent}` : kit.place,
    round: state.round?.n ?? 1, cell_dry: state.cell_dry ?? CELL_DRY, cell_dry_dork: state.cell_dry_dork ?? CELL_DRY_DORK,
    tools: toolLines.join("\n"), habits: HABITS.map((text) => `- ${text}`).join("\n"), examples: HABIT_EXAMPLES.map((text) => `- ${text}`).join("\n"),
    confirmed: state.known_hosts.slice(0, 40).join(", ") || "none yet", rejected: state.rejected.slice(-12).map((row) => `${row.url}: ${row.reason}`).join("\n") || "none",
    tried: tried.slice(-40).join("\n") || "none", grid: gridLines(grid, topics), turns: turnLines(state, grid, topics),
  });
  const angles = fill(template("general.search.agent_angles"), {
    overlap: `${Math.round(QUERY_OVERLAP * 100)}%`, families: familyLines(), vocabulary: vocabularyLines(topics), kit: kitLine(kit), angles: angleLines(kit, state, topics, tools),
  });
  return `${mappingSkill().text}\n\n${plan}\n\n${angles}${decisions.length ? `\n\nPast decisions by the editor, as examples:\n${decisions.join("\n")}` : ""}`;
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    categories: {
      type: "array", description: "One entry per category in this round's turns",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: PRIORITY_TOPICS.map((topic) => topic.id) },
          angle: { type: "string", enum: [...ANGLE_FAMILIES], description: "When a tool's angle is \"new\": the category's next angle family" },
          angle_reason: { type: "string", description: "Why this angle next, in a few words naming what in this place makes it worth trying" },
          searches: {
            type: "array", description: "One per tool whose turn it is in this category",
            items: { type: "object", properties: { tool: { type: "string", enum: [...SEARCH_TOOLS] }, query: { type: "string" }, url: { type: "string" }, instruction: { type: "string" } }, required: ["tool"] },
          },
        },
        required: ["category", "searches"],
      },
    },
  },
  required: ["categories"],
};
type PlanReply = { categories?: Array<{ category?: string; angle?: string; angle_reason?: string; searches?: Array<{ tool?: string; query?: string; url?: string; instruction?: string }> }> };

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array", description: "One per result id",
      items: { type: "object", properties: { id: { type: "string" }, action: { type: "string", enum: ["propose", "skip"] }, category: { type: "string", enum: PRIORITY_TOPICS.map((topic) => topic.id), description: "For propose: the category the page belongs to" }, why: { type: "string", description: `For skip: why, in at most ${SKIP_WORDS} words` } }, required: ["id", "action"] },
    },
  },
  required: ["decisions"],
};
type TriageReply = { decisions?: Array<{ id?: string; action?: string; category?: string; why?: string }> };

type StageInput = { context: DiscoveryContext; kit: SearchKit; state: AgentState; tools: Tools; topics: PriorityTopic[]; deadline: number; job: number; runId: string };
/** ok: carry on; more: the job's time is up mid-step; failed: an unusable model reply; or stop, with the limit a model call hit. */
type StageResult = "ok" | "more" | "failed" | { stop: string };

/** The next step number: every plan, search, triage, proposal, check and score has its own. */
function nextStep(state: AgentState) {
  state.last_step = Math.max(state.last_step ?? 0, state.steps.at(-1)?.step ?? 0) + 1;
  return state.last_step;
}
function logStep(input: StageInput, step: Omit<AgentStep, "job" | "at" | "ms" | "accepted"> & { accepted?: string[]; ms?: number }) {
  const record: AgentStep = { accepted: [], ms: 0, ...step, job: input.job, at: Date.now() / 1000, round: input.state.round?.n, result: clip(step.result, 3000), reason: clip(oneLine(step.reason), 400) };
  input.state.steps.push(record);
  input.state.steps.sort((a, b) => a.step - b.step);
  return record;
}

/** Ask the model; returns the parsed reply, or the error. */
async function ask<T>(model: ModelRuntime, prompt: string, schema: JsonSchema, numPredict: number): Promise<{ reply: T | null; error: string | null }> {
  try {
    const response = await model.generateStructured(prompt, schema, { numPredict });
    const parsed = JSON.parse(response.response) as T;
    return { reply: parsed && typeof parsed === "object" ? parsed : null, error: parsed && typeof parsed === "object" ? null : "an empty reply" };
  } catch (error) { return { reply: null, error: error instanceof Error ? error.message : String(error) }; }
}

/** Why a query doesn't fit its angle where code can tell, or null. */
function angleQueryProblem(input: StageInput, category: PriorityTopic, tool: SearchTool, family: AngleFamily, query: string) {
  const { kit, state } = input;
  if (family === "anchor") return null;
  const earlier = nearDuplicate(query, cellQueries(state.searches ?? [], category, tool), [kit.place, kit.parent ?? "", kit.state]);
  if (earlier) return `it is too close to "${earlier}", already run in ${category} × ${tool}: take the ${family} angle with different words and names`;
  if (family === "roles") return roleQueryProblem(query, category, [kit.place, kit.parent ?? "", kit.county ?? "", ...kit.schools.map((school) => school.name), ...kit.institutions.map((item) => item.name), ...kit.venues]);
  if (family === "tool_native") return nativeQueryProblem(tool, query);
  if (family === "more_like_this") {
    const sources = acceptedIn(state, category);
    const named = sources.some((item) => [hostOf(item.url), item.name].some((name) => name && query.toLowerCase().includes(name.toLowerCase())));
    return named ? null : `"more like this" with ${tool} looks for links or resources pages that list an accepted source: name its site, one of ${sources.slice(-4).map((item) => hostOf(item.url)).join(", ")}`;
  }
  return null;
}

const confirmed = (state: AgentState, url: string) => { const host = hostOf(url); return Boolean(host) && state.known_hosts.some((known) => host === known || host.endsWith(`.${known}`)); };

/** One planned search, checked: what it will run, or why it is refused. */
async function checkSearch(input: StageInput, category: PriorityTopic, tool: SearchTool, family: AngleFamily, reason: string, given: { query?: string; url?: string; instruction?: string }, step: number): Promise<PlannedSearch | string> {
  const { kit, state, tools } = input;
  const base = { step, category, tool, family, reason };
  if (family === "more_like_this" && tool === "exa") {
    const sources = acceptedIn(state, category);
    const asked = given.url ? normaliseUrl(httpsLink(given.url) ?? given.url) : null;
    const source = asked ? sources.find((item) => normaliseUrl(item.url!) === asked) : sources.at(-1);
    if (!source) return `more like this builds on a source accepted in ${category} this run: give one of ${sources.slice(-6).map((item) => item.url).join(", ")}`;
    return { ...base, kind: "similar", url: source.url!, query: `similar to ${source.url}` };
  }
  if (family === "tool_native" && tool === "tavily") {
    const url = httpsLink(given.url ?? ""), instruction = oneLine(given.instruction ?? "");
    if (!tools.explore || state.unavailable.explore || state.unavailable.tavily) return `site exploration is unavailable: ${state.unavailable.explore ?? state.unavailable.tavily ?? "this run doesn't enable it"}`;
    if (!url || !instruction) return "tavily's tool-native angle explores a confirmed hub site: give its https address in url and an instruction";
    if (!confirmed(state, url)) return `${hostOf(url)} isn't a confirmed site: explore only a site you have confirmed`;
    return { ...base, kind: "explore", url, instruction: clip(instruction, 300), query: `explore ${hostOf(url)}: ${clip(instruction, 200)}` };
  }
  if (family === "tool_native" && tool === "dork" && given.url && !given.query) {
    const url = httpsLink(given.url);
    if (!url || !confirmed(state, url)) return `${given.url} isn't a confirmed site: open only a confirmed hub page for its links`;
    return { ...base, kind: "hub", url, query: `links on ${url}` };
  }
  const known = new Set(state.known_hosts);
  // The anchor's query is code's, so every tool runs the same one.
  const raw = family === "anchor" ? anchorQuery(kit, category) : oneLine(given.query ?? "");
  const checked = withoutGuessedSites(raw, known);
  const query = checked.query;
  if (checked.guessed.length) await recordDecision({ stage: "query", actor: "rule", subject: raw, decision: "guessed_site_removed", reason: `site: on a site nobody confirmed: ${checked.guessed.join(", ")}`, rule: "query:guessed_site", topic: category });
  if (query.length < QUERY_MIN_CHARS || query.length > QUERY_MAX_CHARS) return `a query must be ${QUERY_MIN_CHARS} to ${QUERY_MAX_CHARS} characters${checked.guessed.length ? ` once the guessed site: (${checked.guessed.join(", ")}) is removed` : ""}`;
  if (BAD_QUERY.test(query)) return "we never search for login or admin pages or exposed files";
  if ((state.searches ?? []).some((row) => row.tool === tool && row.query === query)) return "this exact query already ran with this tool";
  if (!isLocalQuery(kit, query, known)) return `it must name ${kit.parent ? `${kit.place} or ${kit.parent}` : kit.place}, a local institution, or use site: with a confirmed site`;
  const problem = angleQueryProblem(input, category, tool, family, query);
  if (problem) return problem;
  return { ...base, kind: "search", query };
}

/** a. Plan: one model call for every cell whose turn it is, checked by code. */
async function planStage(input: StageInput): Promise<StageResult> {
  const { context, state, tools, topics } = input;
  const round = state.round!;
  const grid = gridOf(state, topics, runToolsOf(tools));
  const turns = eligibleCells(grid).filter((cell) => tools[cell.tool]);
  const started = Date.now();
  const prompt = await planPrompt(context, input.kit, state, topics, tools);
  const { reply, error } = await ask<PlanReply>(context.model!, prompt, PLAN_SCHEMA, 300 + 160 * turns.length);
  round.calls.plan += 1;
  const planStep = nextStep(state);
  if (!reply) {
    state.model_failures += 1;
    logStep(input, { step: planStep, action: "plan", tool: null, query: null, url: null, category: null, reason: "Plan the round", outcome: "invalid", result: `The model call failed: ${clip(error ?? "no reply", 200)}`, ms: Date.now() - started });
    return error && stopsAgent(error) ? { stop: error } : "failed";
  }
  if (!Array.isArray(reply.categories)) {
    state.model_failures += 1;
    logStep(input, { step: planStep, action: "plan", tool: null, query: null, url: null, category: null, reason: "Plan the round", outcome: "invalid", result: "Unusable reply: it needs a list of categories with their searches.", ms: Date.now() - started });
    return "failed";
  }
  const entries = reply.categories;
  const planned: PlannedSearch[] = [], refused: string[] = [];
  const refuse = (category: PriorityTopic | null, tool: string | null, why: string, query: string | null = null, step = nextStep(state)) => {
    refused.push(`${category ?? "?"} × ${tool ?? "?"}: ${why}`);
    logStep(input, { step, action: "search", tool, query, url: null, category, reason: "Refused at the plan", outcome: "refused", result: `Search refused: ${why}.` });
  };
  // A cell whose turn it is and whose search is refused has used its turn: a miss, with why.
  const refuseTurn = (category: PriorityTopic, tool: SearchTool, why: string, query: string | null = null, step = nextStep(state)) => {
    refuse(category, tool, why, query, step);
    (state.searches ??= []).push({ step, at: Date.now() / 1000, category, tool, results: 0, new_sites: 0, overlap: 0, round: round.n, refused: why });
    state.searches.sort((a, b) => a.step - b.step);
  };
  // Searches for cells whose turn it isn't are refused, saying who goes first.
  for (const entry of entries) for (const given of entry.searches ?? []) {
    const category = entry.category as PriorityTopic, tool = given.tool as SearchTool;
    const cell = topics.includes(category) && SEARCH_TOOLS.includes(tool) ? cellOf(grid, category, tool) : null;
    if (!cell) { refuse(topics.includes(category) ? category : null, given.tool ?? null, `no cell ${entry.category ?? "?"} × ${given.tool ?? "?"} in this run`); continue; }
    if (cell.status !== "open") { refuse(category, tool, `${category} × ${tool} is ${cell.status} (${cell.why ?? "no reason"})`, given.query ?? null); continue; }
    if (cell.waiting) {
      const first = grid.cells.filter((other) => other.tool === tool && other.status === "open" && !other.waiting).map((other) => other.category);
      refuse(category, tool, `${tool} must give ${first.join(", ")} their turn first`, given.query ?? null);
    }
  }
  for (const category of topics) {
    const mine = turns.filter((cell) => cell.category === category);
    if (!mine.length) continue;
    const entry = entries.find((item) => item.category === category);
    const sequence = (state.angles ??= {})[category] ??= [];
    for (const cell of mine) {
      const tool = cell.tool;
      const pending = turnAngle(state, category, tool);
      const family = (pending ?? entry?.angle) as AngleFamily | undefined;
      const reason = pending && pending !== "anchor" ? sequence.find((angle) => angle.family === pending)?.reason ?? "" : clip(oneLine(entry?.angle_reason ?? ""), 160);
      const given = entry?.searches?.find((item) => item.tool === tool);
      if (!family) { refuseTurn(category, tool, `pick ${category}'s next angle in "angle", with angle_reason`); continue; }
      if (!given && family !== "anchor") { refuseTurn(category, tool, `no search given for ${tool}, whose turn it is`); continue; }
      const check = checkAngle({ family, reason, tool, sequence, tried: triedAngles(state.searches ?? [], category, tool), context: angleContext(state, category) });
      if (!check.ok) { refuseTurn(category, tool, check.why, given?.query ?? null); continue; }
      const step = nextStep(state);
      const checked = await checkSearch(input, category, tool, check.family, reason, given ?? {}, step);
      if (typeof checked === "string") { refuseTurn(category, tool, checked, given?.query ?? null, step); continue; }
      // A new angle becomes the category's next one, for every tool.
      if (check.fresh) sequence.push({ family: check.family, reason: check.family === "anchor" ? "" : reason, step: checked.step, at: Date.now() / 1000, tool });
      planned.push(checked);
    }
  }
  round.plan_step = planStep;
  logStep(input, { step: planStep, action: "plan", tool: null, query: null, url: null, category: null, reason: `Round ${round.n}: ${turns.length} cells' turn`, outcome: planned.length ? "ok" : "refused",
    result: `${planned.length} searches planned${refused.length ? `; ${refused.length} refused: ${refused.slice(0, 6).join("; ")}` : ""}.`, ms: Date.now() - started });
  // A usable plan, even one whose searches were all refused: those turns are misses, and the round goes on.
  state.model_failures = 0;
  round.planned = planned;
  round.stage = "search";
  return "ok";
}

/** Run one planned search, explore, find-similar or hub opening. */
async function runPlanned(input: StageInput, planned: PlannedSearch, fetcher: Fetcher) {
  const { context, state, tools } = input;
  const started = Date.now();
  const exclude = accessIgnored("never_read") ? [] : [...DO_NOT_SCRAPE];
  const days = DATE_RANGE_DAYS[TOPIC_SECTIONS[planned.category]];
  const since = days ? addDays(context.today, -days) : null;
  const trouble = planned.kind === "explore" ? "explore" : planned.tool;
  let outcome: { results: SearchResult[]; skipped: string | null; error: string | null };
  if (planned.kind === "similar") outcome = await findSimilar({ db: context.db, settings: context.settings, transport: context.transport, url: planned.url!, topic: planned.category, family: "agent:exa", provider: tools.exa, limits: { exclude, since } });
  else if (planned.kind === "explore") outcome = await exploreSite({ db: context.db, settings: context.settings, transport: context.transport, url: planned.url!, instruction: planned.instruction!, topic: planned.category, family: "agent:explore", exclude });
  else if (planned.kind === "hub") outcome = await openHub(input, planned, fetcher);
  else outcome = await search({ db: context.db, settings: context.settings, transport: context.transport, query: planned.query, topic: planned.category, family: `agent:${planned.tool}`, stage: "stage1", origin: "agent", provider: tools[planned.tool], limits: { exclude, since } });
  toolTrouble(state, trouble, outcome.skipped, outcome.error);
  planned.done = true;
  const action = planned.kind === "search" ? "search" : planned.kind === "hub" ? "open_hub" : planned.kind;
  const base = { step: planned.step, action, tool: planned.kind === "explore" ? "explore" : planned.tool, query: planned.query, url: planned.url ?? null, category: planned.category, reason: planned.reason || `${ANGLE_LABELS[planned.family]} angle`, angle: planned.family };
  if (outcome.skipped) { logStep(input, { ...base, outcome: "refused", result: `${planned.tool} refused: ${outcome.skipped}.`, ms: Date.now() - started }); return; }
  if (outcome.error) { logStep(input, { ...base, outcome: "failed", result: `It failed: ${clip(outcome.error, 200)}.`, ms: Date.now() - started }); return; }
  planned.results = outcome.results.map((result) => ({ url: result.url, title: result.title, snippet: result.snippet }));
  const leadTool = planned.kind === "explore" ? "explore" : planned.tool;
  noteLeads(state, outcome.results.map((result) => ({ url: result.url, tool: leadTool, tools: [leadTool], query: planned.query, step: planned.step, title: result.title, snippet: result.snippet, round: state.round!.n })));
  noteSearch(state, planned, outcome.results.map((result) => result.url), state.round!.n);
  logStep(input, { ...base, outcome: "ok", result: outcome.results.length ? `${outcome.results.length} results. ${ANGLE_LABELS[planned.family]} angle.\n${resultLines(outcome.results)}` : `No results. ${ANGLE_LABELS[planned.family]} angle.`, ms: Date.now() - started });
}

/** Dork's tool-native "open a hub page for its links": the page's links are its results, counted against dork's cap like a search. */
async function openHub(input: StageInput, planned: PlannedSearch, fetcher: Fetcher): Promise<{ results: SearchResult[]; skipped: string | null; error: string | null }> {
  const { context, tools } = input;
  const read = async () => {
    const page = await openPage(context, fetcher, planned.url!, "agent");
    if (page.action === "skip") throw new Error("the page opts out of reuse, so we don't read it");
    return pageLinks(page.html, page.url, LINKS_SHOWN).map((link, index) => ({ url: link.url, title: link.text, snippet: "", date: null, position: index + 1 }));
  };
  try {
    if (tools.dork === "fixture") return { results: await read(), skipped: null, error: null };
    const outcome = await paidCall(tools.dork as PaidService, read);
    return { results: outcome.value ?? [], skipped: outcome.refused, error: null };
  } catch (error) { return { results: [], skipped: null, error: error instanceof Error ? error.message : String(error) }; }
}

/** b. Search: the round's searches, the tools side by side and each tool's in turn, until the job's time is nearly up. */
async function searchStage(input: StageInput): Promise<StageResult> {
  const { state, deadline } = input;
  const round = state.round!;
  const fetcher = new Fetcher(publicSourceTransport(input.context.transport, 15_000));
  fetcher.deadline = deadline;
  await Promise.all(SEARCH_TOOLS.map(async (tool) => {
    for (const planned of round.planned.filter((item) => item.tool === tool && !item.done)) {
      if (Date.now() >= deadline - WORK_RESERVE_MS) return;
      if (state.unavailable[tool] || (planned.kind === "explore" && state.unavailable.explore)) {
        planned.done = true;
        logStep(input, { step: planned.step, action: "search", tool, query: planned.query, url: null, category: planned.category, reason: planned.reason, angle: planned.family, outcome: "refused", result: `${tool} is unavailable: ${state.unavailable[tool] ?? state.unavailable.explore}.` });
        continue;
      }
      await runPlanned(input, planned, fetcher);
    }
  }));
  if (round.planned.some((item) => !item.done)) return "more";
  round.stage = "clean";
  return "ok";
}

/** c. Clean up: code drops what tools needn't re-read, merges what several tools found, and splits the rest into small triage chunks. */
export function cleanStage(state: AgentState, topics: PriorityTopic[]) {
  const round = state.round!;
  const free = new Set(state.free_hosts ?? []), accepted = acceptedHosts(state), triaged = new Set(state.triaged ?? []), seen = new Set(state.seen);
  const proposed = new Set(state.sources.map((source) => source.host).filter(Boolean) as string[]);
  const onList = (host: string, list: Set<string>) => [...list].some((item) => host === item || host.endsWith(`.${item}`));
  const items = new Map<string, RoundItem>();
  // Proposals over the last round's cap come first.
  for (const item of state.carry ?? []) if (!accepted.has(item.host) && !proposed.has(item.host)) items.set(item.key, { ...item, carried: true });
  let dropped = 0, index = 0;
  for (const planned of [...round.planned].sort((a, b) => a.step - b.step)) for (const result of planned.results ?? []) {
    const key = normaliseUrl(sourceUrl(result.url)), host = hostOf(result.url);
    const why = !accessIgnored("never_read") && DO_NOT_SCRAPE.some((item) => host === item || host.endsWith(`.${item}`)) ? "on the never-read list"
      : onList(host, free) ? "a site the free readers already found"
      : accepted.has(host) ? "its site already has an accepted source in this run"
      : seen.has(key) || proposed.has(host) ? "its site was already proposed in this run"
      : triaged.has(key) && !items.has(key) ? "already triaged in an earlier round" : null;
    const credit: Credit = { step: planned.step, tool: planned.tool, category: planned.category };
    if (why) {
      dropped += 1;
      const lead = leadOf(state, result.url);
      if (lead && !lead.skipped) lead.skipped = { why, step: planned.step, by: "code" };
      continue;
    }
    const existing = items.get(key);
    if (existing) {
      if (!existing.tools.includes(planned.tool)) existing.tools.push(planned.tool);
      if (!existing.credits.some((item) => item.step === credit.step)) existing.credits.push(credit);
      continue;
    }
    index += 1;
    items.set(key, { id: `r${round.n}-${index}`, url: result.url, key, host, category: planned.category, title: result.title, snippet: result.snippet, tools: [planned.tool], credits: [credit], query: planned.query });
  }
  state.carry = [];
  round.items = [...items.values()];
  round.chunks = triageChunks(round.items, topics);
  round.stage = round.items.length ? "triage" : "score";
  return { kept: round.items.length, dropped };
}

/** Results in triage calls of a few categories, at most `TRIAGE_RESULTS` each; a bigger category is split. Carried results go first. */
export function triageChunks(items: RoundItem[], topics: PriorityTopic[]) {
  const ordered = [...items.filter((item) => item.carried), ...topics.flatMap((topic) => items.filter((item) => !item.carried && item.category === topic)), ...items.filter((item) => !item.carried && !topics.includes(item.category))];
  const chunks: string[][] = [];
  let current: RoundItem[] = [];
  const close = () => { if (current.length) chunks.push(current.map((item) => item.id)); current = []; };
  for (const item of ordered) {
    const categories = new Set(current.map((other) => other.category));
    if (current.length >= TRIAGE_RESULTS || (!categories.has(item.category) && categories.size >= TRIAGE_CATEGORIES)) close();
    current.push(item);
  }
  close();
  return chunks;
}

function triagePrompt(kit: SearchKit, state: AgentState, items: RoundItem[], topics: PriorityTopic[]) {
  const byCategory = [...new Set(items.map((item) => item.category))].map((category) => `${category} (${LABELS[category] ?? category}):\n${items.filter((item) => item.category === category).map((item) =>
    `[${item.id}] ${item.url}${item.title ? ` | ${clip(oneLine(item.title), 100)}` : ""} (found by ${item.tools.join(", ")}${item.carried ? "; carried over from the last round" : ""})${item.snippet ? `\n    ${clip(oneLine(item.snippet), 200)}` : ""}`).join("\n")}`).join("\n\n");
  return fill(template("general.search.agent_round_triage"), {
    where: `${kit.place}${kit.parent ? `, ${kit.parent}` : ""}, ${kit.state}`, topics: topics.join(", "), skip_words: SKIP_WORDS,
    rejected: state.rejected.slice(-12).map((row) => `${row.url}: ${row.reason}`).join("\n") || "none", results: byCategory,
  });
}

/** d. Triage: one chunk a call. Every result gets a decision: the agent's, or code's skip when it gave none. */
async function triageStage(input: StageInput): Promise<StageResult> {
  const { context, state, topics, kit } = input;
  const round = state.round!;
  const ids = round.chunks[round.triaged] ?? [];
  const items = round.items.filter((item) => ids.includes(item.id));
  const started = Date.now();
  const { reply, error } = await ask<TriageReply>(context.model!, triagePrompt(kit, state, items, topics), TRIAGE_SCHEMA, 200 + 40 * items.length);
  round.calls.triage += 1;
  const step = nextStep(state);
  if (!reply) {
    state.model_failures += 1;
    logStep(input, { step, action: "triage", tool: null, query: null, url: null, category: null, reason: `Triage ${items.length} results`, outcome: "invalid", result: `The model call failed: ${clip(error ?? "no reply", 200)}`, ms: Date.now() - started });
    return error && stopsAgent(error) ? { stop: error } : "failed";
  }
  state.model_failures = 0;
  const given = new Map((Array.isArray(reply.decisions) ? reply.decisions : []).map((row) => [row.id, row]));
  let proposed = 0;
  for (const item of items) {
    const row = given.get(item.id);
    const category = topics.includes(row?.category as PriorityTopic) ? row!.category as PriorityTopic : item.category;
    const decision: TriageDecision = row?.action === "propose" ? { action: "propose", why: "", category, by: "agent" }
      : row?.action === "skip" ? { action: "skip", why: words(row.why ?? "", SKIP_WORDS) || "skipped, no reason given", category: item.category, by: "agent" }
      : { action: "skip", why: "no decision from the agent", category: item.category, by: "code" };
    round.decisions[item.id] = decision;
    if (decision.action === "propose") proposed += 1;
    else { const lead = leadOf(state, item.url); if (lead) lead.skipped = { why: decision.why, step, by: decision.by }; }
  }
  logStep(input, { step, action: "triage", tool: null, query: null, url: null, category: items[0]?.category ?? null, reason: `Triage ${items.length} results in ${[...new Set(items.map((item) => item.category))].join(", ")}`, outcome: "ok", result: `${proposed} to propose, ${items.length - proposed} skipped.`, ms: Date.now() - started });
  round.triaged += 1;
  if (round.triaged < round.chunks.length) return "ok";
  // Every chunk is triaged: the round's proposals, up to its cap; the rest go to the next round's triage, first.
  const proposals = round.items.filter((item) => round.decisions[item.id]?.action === "propose");
  round.proposals = proposals.slice(0, ROUND_PROPOSALS).map((item) => item.id);
  state.carry = proposals.slice(ROUND_PROPOSALS).map((item) => ({ ...item, category: round.decisions[item.id].category }));
  state.triaged = [...new Set([...state.triaged ?? [], ...round.items.filter((item) => !state.carry!.some((carried) => carried.id === item.id)).map((item) => item.key)])].slice(-3000);
  round.stage = round.proposals.length ? "open" : "score";
  return "ok";
}

/** e. Open: code opens and checks each proposal, and saves what it keeps to wait for the model check. */
async function openStage(input: StageInput): Promise<StageResult> {
  const { context, state, deadline } = input;
  const round = state.round!;
  const started = Date.now();
  let kept = 0, refused = 0;
  for (const id of round.proposals.filter((item) => !round.opened.includes(item))) {
    if (Date.now() >= deadline - WORK_RESERVE_MS) return "more";
    const item = round.items.find((row) => row.id === id)!;
    const decision = round.decisions[id];
    round.opened.push(id);
    const url = item.url, key = normaliseUrl(sourceUrl(url));
    // The editor's decision stands: don't put a source back that a person has already labelled.
    const labelled = await sourceMap(context.db).findOne({ location_id: context.location.id, url: { $in: [url, sourceUrl(url)] }, "review.decision": { $in: ["accept", "reject"] } }, { projection: { review: 1, name: 1 } });
    const rejected = !labelled ? await pageDecisions(context.db).findOne({ location_id: context.location.id, key: { $in: [normaliseUrl(url), key] }, decision: "reject" }, { projection: { name: 1 } }) : null;
    if (labelled || rejected || state.seen.includes(key)) {
      refused += 1;
      const why = labelled ? `the editor already ${labelled.review?.decision === "accept" ? "accepted" : "rejected"} this source (${labelled.name})` : rejected ? `the editor rejected this page in an earlier run (${rejected.name ?? url})` : "already proposed in this run";
      logStep(input, { step: nextStep(state), action: "propose", tool: item.tools[0], query: item.query, url, category: decision.category, reason: "Triage proposed it", outcome: "refused", result: `Not opened: ${why}.` });
      continue;
    }
    const seen = new Set(state.seen);
    const evaluated = await evaluateLeads(context, [{ url, title: item.title, snippet: item.snippet, topic: decision.category, family: `agent:${item.tools[0]}`, query: item.query, section: TOPIC_SECTIONS[decision.category] }], { method: "agent", seen, origin: "agent", deadline });
    state.seen = [...new Set([...state.seen, ...seen, key])];
    const candidates: SourceCandidate[] = evaluated.candidates;
    const step = nextStep(state);
    for (const candidate of candidates) {
      candidate.found_by = { ...candidate.found_by, method: "agent", tool: item.tools[0], tools: item.tools, step, found_at_step: item.credits[0]?.step ?? step, query: item.query, reason: `Proposed in round ${round.n}'s triage` } as SourceCandidate["found_by"];
      candidate.topics = [...new Set([decision.category, ...(candidate.topics ?? [])])];
    }
    // Saved to wait for the model check, which judges a round's proposals together, 25 a call.
    if (candidates.length) await checkAndSave(context, candidates, { route: "agent", deadline: 1 });
    state.rejected = [...state.rejected, ...evaluated.rejected].slice(-40);
    for (const candidate of candidates) {
      kept += 1;
      const verdict = candidate.gemini?.verdict ?? null;
      const waiting = verdict === null && Boolean(candidate.gemini?.note?.includes(OUT_OF_TIME));
      // With the check off (a local baseline test), a source code kept counts as found.
      const good = verdict === "accept" || (!geminiCheckOn() && verdict === null && !waiting);
      // A hit goes to the category the source is filed under, for every tool whose search returned it.
      const credits = item.credits.map((credit) => ({ ...credit, category: decision.category, ...(credit.category !== decision.category ? { searched: credit.category } : {}) }));
      state.sources.push({
        url: candidate.url ?? candidate.source_id, source_id: candidate.source_id, name: candidate.name, category: decision.category, tool: item.tools[0], tools: item.tools, query: item.query, step, found_at_step: item.credits[0]?.step ?? step,
        opened_with: candidate.found_by.opened_with ?? null, verdict: verdict ?? "not_judged", reason: candidate.gemini?.reason ?? candidate.gemini?.note ?? null,
        host: hostOf(candidate.url ?? url) || null, credits, credit: credits[0] ?? null, good, pending: waiting, ...(item.category !== decision.category ? { searched: item.category } : {}),
      });
    }
    noteLeads(state, evaluated.links.slice(0, 12).map((link) => ({ url: link.url, tool: "propose", query: url, step, title: link.title, snippet: "" })));
  }
  logStep(input, { step: nextStep(state), action: "propose", tool: null, query: null, url: null, category: null, reason: `Round ${round.n}'s proposals`, outcome: "ok", result: `${round.proposals.length} proposed: ${kept} kept by the code checks for the model check, ${refused} not opened.`, ms: Date.now() - started });
  round.stage = "judge";
  return "ok";
}

/** Verdicts the model check has given, on the agent's own proposals and on the checklist. */
function carryVerdicts(state: AgentState, judged: SourceCandidate[], topics: PriorityTopic[]) {
  for (const candidate of judged) {
    const traced = state.sources.find((source) => source.source_id === candidate.source_id);
    const verdict = candidate.gemini?.verdict ?? null;
    if (traced) {
      traced.verdict = verdict ?? traced.verdict; traced.reason = candidate.gemini?.reason ?? candidate.gemini?.note ?? traced.reason;
      // Settled now, accepted or not: the grid counts it as a hit or a miss from here.
      traced.pending = verdict === null && Boolean(candidate.gemini?.note?.includes(OUT_OF_TIME));
      traced.good = verdict === "accept";
    } else if (verdict === "accept" && candidate.url) state.start_hosts = [...new Set([...state.start_hosts ?? [], hostOf(candidate.url)].filter(Boolean))];
    if (verdict !== "accept" || candidate.link_only) continue;
    for (const topic of topics.filter((item) => TOPIC_SECTIONS[item] === candidate.section || candidate.topics?.includes(item))) {
      const check = state.checklist[topic];
      if (!check || check.accepted.some((item) => item.url === candidate.url && item.name === candidate.name)) continue;
      check.accepted.push({ name: candidate.name, url: candidate.url, by: traced ? "agent" : "map" });
      check.status = "covered";
    }
  }
}

/** f. The model check on what the round kept, `CHECK_BATCH` a call, carried on by the next job if this one runs out of time. */
async function judgeStage(input: StageInput): Promise<StageResult> {
  const { context, state, deadline, runId, topics } = input;
  const round = state.round!;
  const started = Date.now();
  const pending = await judgePending(context, runId, deadline - GEMINI_RESERVE_MS);
  round.calls.check += pending.counts?.calls ?? 0;
  carryVerdicts(state, pending.settled, topics);
  if (pending.waiting) return "more";
  const judged = pending.judged.length;
  logStep(input, { step: nextStep(state), action: "check", tool: null, query: null, url: null, category: null, reason: `Round ${round.n}'s model check`, outcome: "ok", result: `${judged} judged in ${pending.counts?.calls ?? 0} calls: ${pending.judged.filter((candidate) => candidate.gemini?.verdict === "accept").length} accepted.`, ms: Date.now() - started, accepted: pending.judged.filter((candidate) => candidate.gemini?.verdict === "accept").map((candidate) => candidate.url ?? candidate.source_id) });
  round.stage = "score";
  return "ok";
}

/** g. Score: hits, streaks and dry cells. A cell a hit reopened rejoins at its tool's current round. */
function scoreStage(input: StageInput): StageResult {
  const { state, tools, topics } = input;
  const round = state.round!;
  const runTools = runToolsOf(tools);
  let grid = gridOf(state, topics, runTools);
  const before = new Set(state.dry_cells ?? []);
  const reopened = grid.cells.filter((cell) => before.has(cellKey(cell.category, cell.tool)) && cell.status === "open");
  for (const cell of reopened) {
    const others = grid.cells.filter((other) => other.tool === cell.tool && other.status === "open" && other !== cell && !reopened.includes(other));
    const level = others.length ? Math.min(...others.map((other) => Math.max(other.searches, state.rejoin?.[cellKey(other.category, other.tool)] ?? 0))) : cell.searches;
    if (level > cell.searches) (state.rejoin ??= {})[cellKey(cell.category, cell.tool)] = level;
  }
  if (reopened.length) grid = gridOf(state, topics, runTools);
  state.dry_cells = grid.cells.filter((cell) => cell.status === "dry").map((cell) => cellKey(cell.category, cell.tool));
  const hits = state.sources.filter((source) => source.good && source.step >= (round.plan_step ?? 0)).length;
  logStep(input, { step: nextStep(state), action: "score", tool: null, query: null, url: null, category: null, reason: `Round ${round.n} scored`, outcome: "ok",
    result: `Round ${round.n}: ${round.planned.length} searches, ${round.items.length} results after clean-up, ${round.proposals.length} proposed, ${hits} accepted. ${grid.open} cells still open, ${grid.cells.filter((cell) => cell.status === "dry").length} dry${reopened.length ? `; reopened by a hit: ${reopened.map((cell) => `${cell.category} × ${cell.tool}`).join(", ")}` : ""}. Calls: 1 plan, ${round.calls.triage} triage, ${round.calls.check} model check.` });
  state.rounds = round.n;
  state.round = null;
  return "ok";
}

/** The model calls a full round needs at most, by budget: its plan and triage chunks (the agent's), and its model check batches. */
export function roundCalls(openCategories: number) {
  const agent = 1 + Math.max(1, Math.ceil(openCategories / TRIAGE_CATEGORIES));
  const judge = Math.ceil(ROUND_PROPOSALS / CHECK_BATCH);
  return { agent, judge, total: agent + judge };
}

/** Whether the model budget left covers another full round; the reason it doesn't, or null. */
async function roundBudget(db: Db, runId: string, grid: Grid) {
  const needs = roundCalls(new Set(eligibleCells(grid).map((cell) => cell.category)).size);
  const left = await modelCallsLeft(db, runId);
  const short = [
    left.agent !== null && left.agent < needs.agent ? `the agent's budget has ${left.agent} calls left` : null,
    left.judge !== null && left.judge < needs.judge ? `the model check's budget has ${left.judge} calls left` : null,
    left.gemini !== null && left.gemini < needs.total ? `Gemini has ${left.gemini} calls left` : null,
  ].filter(Boolean);
  return short.length ? `the model budget left can't cover another full round (about ${needs.total} calls): ${short.join("; ")}` : null;
}

const STAGES: Record<RoundStage, (input: StageInput) => Promise<StageResult> | StageResult> = {
  plan: planStage, search: searchStage, clean: (input) => { cleanStage(input.state, input.topics); return "ok"; }, triage: triageStage, open: openStage, judge: judgeStage, score: scoreStage,
};
/** Whether a step may start with the time left: one that calls the model needs `GEMINI_RESERVE_MS`, a search or page opening `WORK_RESERVE_MS`. */
const fits = (stage: RoundStage, deadline: number) => ["clean", "score"].includes(stage) || Date.now() + (["plan", "triage", "judge"].includes(stage) ? GEMINI_RESERVE_MS : WORK_RESERVE_MS) <= deadline;

/**
 * One job of the agent: round steps until the next won't fit in its time, the run is done or a
 * ceiling is reached. The round is saved after every step; `next` asks for another job to carry on.
 * `limits.steps` ends the job after that many steps, for tests of a job that ends between steps.
 */
export async function agentJob(context: DiscoveryContext, job: number, limits: { steps?: number } = {}) {
  const deadline = Date.now() + JOB_DEADLINE_MS;
  const options = currentOptions();
  const topics = options.topics;
  const runId = runContext()?.runId ?? "none";
  const state: AgentState = { ...emptyState(runId), ...await states(context.db).findOne({ _id: runId }) };
  const save = () => states(context.db).replaceOne({ _id: runId }, state, { upsert: true });
  const summary = (next: boolean) => ({ next, job, steps: state.steps.filter((step) => step.job === job).length, total_steps: state.steps.length, rounds: state.rounds ?? 0, stage: state.round?.stage ?? null, accepted: state.sources.filter((source) => source.verdict === "accept").length, unavailable: Object.keys(state.unavailable), stopped_by: state.stopped_by?.limit ?? null, finished: state.finished?.reason ?? null });
  if (state.finished) return summary(false);
  state.jobs += 1;
  // Every run is exhaustive now; the misses a cell needs are kept on the run, so a past run shows the rules it used.
  state.depth = "exhaustive";
  state.cell_dry ??= CELL_DRY;
  state.cell_dry_dork ??= CELL_DRY_DORK;
  state.angles ??= {};
  const tools = enabledTools(options, context.settings);
  state.explore = Boolean(tools.explore);
  state.caps ??= toolCaps(options, tools);
  if (!context.model) { await finish(context.db, state, topics, "the agent has no model to plan its rounds"); await save(); return summary(false); }
  // The free readers come first: their model checks finish before round 1, and their sites are left out of every round.
  if (!state.free_done) {
    const pending = await judgePending(context, runId, deadline - GEMINI_RESERVE_MS);
    if (pending.waiting) { await save(); return summary(true); }
    state.checklist = await startingChecklist(context.db, context.location.id, topics);
    state.start_hosts = [...new Set(Object.values(state.checklist).flatMap((check) => check.accepted.map((item) => hostOf(item.url))).filter(Boolean))];
    state.free_hosts = [...new Set((await sourceMap(context.db).find({ location_id: context.location.id }, { projection: { url: 1 } }).toArray()).map((row) => hostOf(row.url)).filter(Boolean))];
    state.free_done = true;
  }
  for (const topic of topics) state.checklist[topic] ??= { status: "open", accepted: [], searches: 0, tools: [], note: null };
  const kit = await buildSearchKit(context);
  const mapHosts = (await sourceMap(context.db).find({ location_id: context.location.id, status: { $nin: ["rejected"] } }, { projection: { url: 1 } }).toArray()).map((row) => hostOf(row.url));
  state.known_hosts = [...new Set([...state.known_hosts, kit.cityDomain ?? "", ...mapHosts, ...kit.institutions.map((item) => hostOf(item.website))].filter(Boolean))];
  await save();

  let ran = 0;
  for (;;) {
    const ceiling = await ceilingReached(context.db, runId);
    if (ceiling) { await stopAtCeiling(context.db, state, ceiling, topics, runToolsOf(tools)); break; }
    // A tool whose service reached its own hard limit is out; the others carry on.
    const limited = await unavailableServices(context.db, runId);
    for (const [tool, keys] of Object.entries(LIMIT_KEYS)) {
      const hit = keys.find((key) => limited[key] && (tool !== "dork" || key === tools.dork));
      if (hit && !state.unavailable[tool]) markUnavailable(state, tool, limited[hit]);
    }
    if (!state.round) {
      const grid = gridOf(state, topics, runToolsOf(tools));
      if (grid.done) { await finish(context.db, state, topics, "every cell is dry or unavailable"); break; }
      const short = await roundBudget(context.db, runId, grid);
      if (short) { await stopAtCeiling(context.db, state, { limit: "model_budget", reason: short }, topics, runToolsOf(tools)); break; }
      state.round = { n: (state.rounds ?? 0) + 1, stage: "plan", started_at: Date.now() / 1000, plan_step: null, planned: [], items: [], chunks: [], triaged: 0, decisions: {}, proposals: [], opened: [], calls: { plan: 0, triage: 0, check: 0 } };
    }
    if (limits.steps !== undefined && ran >= limits.steps) { await save(); return summary(true); }
    const stage = state.round.stage;
    if (!fits(stage, deadline)) { await save(); return summary(true); }
    const result = await STAGES[stage]({ context, kit, state, tools, topics, deadline, job, runId });
    ran += 1;
    await save();
    if (result === "more") return summary(true);
    if (typeof result === "object") {
      await stopAtCeiling(context.db, state, await stoppedBy(context.db, runId) ?? { limit: "agent_model", reason: clip(result.stop, 200) }, topics, runToolsOf(tools));
      break;
    }
    if (result === "failed") {
      const stop = await stoppedBy(context.db, runId);
      if (stop) { await stopAtCeiling(context.db, state, stop, topics, runToolsOf(tools)); break; }
      if (state.model_failures >= MODEL_FAILURES) { await finish(context.db, state, topics, `the agent's model gave ${MODEL_FAILURES} unusable replies in a row`); break; }
    }
  }
  await save();
  return summary(false);
}

/** Record how the agent ended, and each category's outcome with what was tried. */
async function finish(db: Db, state: AgentState, topics: PriorityTopic[], reason: string) {
  if (state.finished) return;
  state.finished = { reason, at: Date.now() / 1000 };
  await recordDecision({ stage: "plan", actor: "rule", subject: "agent", decision: "finished", reason: `The agent stopped: ${reason}`, rule: state.stopped_by ? `hard_limit:${state.stopped_by.limit}` : "agent:stop", evidence: { steps: state.steps.length, jobs: state.jobs, rounds: state.rounds ?? 0, unavailable: state.unavailable, accepted: state.sources.filter((source) => source.verdict === "accept").length } });
  for (const topic of topics) {
    const check = state.checklist[topic];
    if (!check) continue;
    const tried = (state.searches ?? []).filter((search) => search.category === topic).map((search) => `${search.tool}: ${search.query ?? ""}`);
    if (check.status === "covered") { await recordDecision({ stage: "topic", actor: "agent", subject: topic, decision: "found", reason: `${check.accepted.length} accepted sources`, topic, evidence: { sources: check.accepted, searches: tried } }); continue; }
    check.note = state.stopped_by ? `Stopped before this category had an accepted source: ${reason}` : "Every search tool went dry or was unavailable with nothing accepted";
    await recordDecision({ stage: "topic", actor: "agent", subject: topic, decision: "not_found", reason: check.note, topic, evidence: { searches: tried, tools: check.tools } });
  }
}

/** Record once which ceiling ended the mapping, and save the agent's progress with it. */
async function stopAtCeiling(db: Db, state: AgentState, limited: { limit: string; reason: string }, topics: PriorityTopic[], tools: SearchTool[]) {
  if (state.stopped_by) return;
  state.stopped_by = limited;
  state.open_cells = gridOf(state, topics, tools).open;
  const resumes = limited.limit === "gemini" && /a day/.test(limited.reason) ? "; it can carry on after the daily reset at midnight Pacific" : "";
  await recordDecision({ stage: "plan", actor: "rule", subject: `agent: ${limited.limit}`, decision: "stopped", reason: `Stopped at a limit: ${limited.reason}${resumes}`, rule: `hard_limit:${limited.limit}`, evidence: { steps: state.steps.length, jobs: state.jobs, rounds: state.rounds ?? 0 } });
  await finish(db, state, topics, `a ceiling was reached (${limited.reason})${state.open_cells ? ` with ${state.open_cells} cell${state.open_cells === 1 ? "" : "s"} still open` : ""}`);
  await states(db).replaceOne({ _id: state._id }, state, { upsert: true });
}
