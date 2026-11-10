/**
 * The mapping agent's grid of category × search tool, its rounds, and when it stops. No server
 * imports, so the Source runs page and the agent read the same rules.
 *
 *   hit        a source the model check accepted (passed code, or kept as link-only) whose site is
 *              new to this run: no earlier accepted source shares its host. It is one new source,
 *              but a hit for every tool whose search returned it, in the category the source is
 *              filed under: a school's page found while searching sports is a hit for schools.
 *   cell       one category and one search tool, with its searches, results, new sites, hits and
 *              its dry streak: its own searches since its last hit. Open; dry once the streak
 *              reaches the tool's value (`cellDry`: 2 for dork, 3 for the others), or once it has
 *              tried every angle that applies to it; or unavailable (the tool reached its cap, has
 *              no key or kept failing). A hit reopens a cell that went dry on its streak.
 *   round      a tool runs in rounds: a cell takes its (k+1)-th search only once every other open
 *              cell of that tool has had k. Dry and unavailable cells leave the round. A reopened
 *              cell rejoins at the current round (`rejoin`), so it doesn't hold the others back. A
 *              turn whose search code refused is used all the same, and is a miss, so a cell whose
 *              queries keep breaking a rule goes dry instead of holding its tool back.
 *   share      each category's even share of a tool's per-run cap: floor(cap / categories). Rounds
 *              give every open category its share before any gets more; what dry cells free goes
 *              to the open ones, round by round.
 *   run        stops when every cell is dry or unavailable, or at a safety cap.
 *
 * A search whose proposals still wait for a verdict is neither a hit nor a miss: the misses that
 * count are the settled ones after it, so a cell can't go dry because its verdicts are late.
 */
import type { PriorityTopic } from "../core/run-values";

export const SEARCH_TOOLS = ["dork", "exa", "tavily"] as const;
export type SearchTool = typeof SEARCH_TOOLS[number];
/** Kept for runs that recorded it: the search depth #134 offered. Every run is exhaustive now. */
export type SearchDepth = "exhaustive" | "enough";

/** One search in a cell, as code ran it: what came back and how much of it was new. */
export type CellSearch = {
  step: number; at: number; category: PriorityTopic; tool: SearchTool; results: number; new_sites: number; overlap: number;
  /** The angle family it took, the query it ran, and the round it was part of (older runs have none of these). */
  angle?: string; query?: string; round?: number;
  /** Why code refused the cell's search this turn. The turn is used, and counts as a miss. */
  refused?: string;
};
/**
 * A search a page is credited to: its step and tool, and the category the source is filed under.
 * `searched` is the category whose search it was, when that differs.
 */
export type Credit = { step: number; tool: SearchTool; category: PriorityTopic; searched?: PriorityTopic };
/** What the grid needs of a proposed source. Older runs have one `credit`; now every tool that returned it is credited. */
export type GridSource = { host?: string | null; credit?: Credit | null; credits?: Credit[] | null; good?: boolean; pending?: boolean; verdict?: string; step?: number };
export type CellStatus = "open" | "dry" | "unavailable";
export type Cell = {
  category: PriorityTopic; tool: SearchTool; searches: number; results: number; new_sites: number; overlap: number;
  hits: number; rejected: number; pending: number; dry_streak: number; status: CellStatus;
  /** When a dry or unavailable cell became so (seconds), the step that made it dry, and why. */
  since: number | null; at_step: number | null; why: string | null;
  /** The angle families it has tried, in order. */
  angles: string[];
  /** Misses in a row that make it dry, for its tool. */
  dry_after: number;
  /** Hits from searches of another category, by the category that searched. */
  found_elsewhere: Partial<Record<string, number>>;
  /** The round its next search belongs to, its even share of the tool's cap (null without a cap), and whether it waits for other cells to have their turn. */
  round: number; share: number | null; waiting: boolean;
  /** Turns whose search code refused, each a miss, and why the latest was refused. */
  refused: number; last_refused: string | null;
};
export type Grid = {
  cells: Cell[]; dry_categories: PriorityTopic[]; open: number; done: boolean;
  /** Hits no cell earned: a page proposed without a search turning it up. */
  uncredited: number; hits: number;
  /** Each tool's current round: the round its open cells are on. */
  rounds: Partial<Record<SearchTool, number>>;
};
export type GridInput = {
  topics: PriorityTopic[]; searches: CellSearch[]; sources: GridSource[];
  /** Hosts already accepted before the tools' own finds: the free readers', in this run. */
  startHosts: string[];
  /** Tools this run has at all; the others' cells are unavailable. */
  enabled: SearchTool[];
  /** Tools that became unavailable during the run, with why and when. */
  unavailable: Partial<Record<string, string>>; unavailableAt?: Partial<Record<string, number>>;
  /** Misses in a row before a cell goes dry: one value, or one per tool. */
  cellDry: number | Partial<Record<SearchTool, number>>;
  /** The angle families that apply to each cell, by `category|tool`; a cell that has tried them all is dry. Left out for runs from before angles. */
  applicable?: Partial<Record<string, string[]>>;
  /** Each tool's per-run cap, for its share per category. */
  caps?: Partial<Record<SearchTool, number | null>>;
  /** Searches a reopened cell counts as having had, by `category|tool`, so it rejoins at the current round. */
  rejoin?: Partial<Record<string, number>>;
};

/** Which sources are hits, in the order they were proposed: accepted, and the first accepted on their host. */
export function hitFlags(sources: GridSource[], startHosts: string[]) {
  const seen = new Set(startHosts.filter(Boolean));
  return sources.map((source) => {
    if (!source.good || !source.host) return false;
    const hit = !seen.has(source.host);
    seen.add(source.host);
    return hit;
  });
}

export const cellKey = (category: string, tool: string) => `${category}|${tool}`;
/** Every search a source is credited to. */
export const creditsOf = (source: GridSource) => source.credits?.length ? source.credits : source.credit ? [source.credit] : [];
export const dryAfter = (cellDry: GridInput["cellDry"], tool: SearchTool) => typeof cellDry === "number" ? cellDry : cellDry[tool] ?? 3;

/** `at` is the step from which the mark counts in its cell: its own search's, or, for a find filed under another category than the one that searched, the step it was proposed at, after that round's searches. */
type Mark = { step: number; at: number; category: PriorityTopic; hit: boolean; pending: boolean; rejected: boolean; searched: PriorityTopic };
/** What each cell earned, search by search: a hit, a verdict still waiting, or a rejection, at the step of the search that turned it up. */
export function cellMarks(sources: GridSource[], startHosts: string[]) {
  const flags = hitFlags(sources, startHosts);
  const marks = new Map<string, Mark[]>();
  let uncredited = 0;
  sources.forEach((source, index) => {
    const credits = creditsOf(source);
    if (!credits.length) { if (flags[index]) uncredited += 1; return; }
    for (const credit of credits) {
      const key = cellKey(credit.category, credit.tool);
      marks.set(key, [...marks.get(key) ?? [], { step: credit.step, at: credit.searched && credit.searched !== credit.category ? Math.max(credit.step, source.step ?? credit.step) : credit.step, category: credit.category, hit: flags[index], pending: Boolean(source.pending), rejected: source.verdict === "reject", searched: credit.searched ?? credit.category }]);
    }
  });
  return { marks, uncredited, hits: flags.filter(Boolean).length };
}

/**
 * What each search earned, by step: hits and waiting verdicts in its own category, rejections, and
 * the other categories it found a hit for ("found while searching" this one).
 */
export function searchOutcomes(sources: GridSource[], startHosts: string[]) {
  const { marks, uncredited, hits } = cellMarks(sources, startHosts);
  const byStep = new Map<number, { hits: number; pending: number; rejected: number; elsewhere: PriorityTopic[] }>();
  for (const list of marks.values()) for (const mark of list) {
    const row = byStep.get(mark.step) ?? { hits: 0, pending: 0, rejected: 0, elsewhere: [] };
    if (mark.category === mark.searched) { if (mark.hit) row.hits += 1; if (mark.pending) row.pending += 1; }
    else if (mark.hit) row.elsewhere.push(mark.category);
    if (mark.rejected) row.rejected += 1;
    byStep.set(mark.step, row);
  }
  return { byStep, uncredited, hits };
}

export function buildGrid(input: GridInput): Grid {
  const { marks, uncredited, hits } = cellMarks(input.sources, input.startHosts);
  const searches = new Map<string, CellSearch[]>();
  for (const search of [...input.searches].sort((a, b) => a.step - b.step)) searches.set(cellKey(search.category, search.tool), [...searches.get(cellKey(search.category, search.tool)) ?? [], search]);
  const cells: Cell[] = [];
  for (const category of input.topics) for (const tool of SEARCH_TOOLS) {
    const key = cellKey(category, tool);
    const runs = searches.get(key) ?? [];
    const mine = marks.get(key) ?? [];
    const dry = dryAfter(input.cellDry, tool);
    // The misses that count: its own settled searches after its last hit or waiting verdict, from any category's search.
    const reset = Math.max(-Infinity, ...mine.filter((mark) => mark.hit || mark.pending).map((mark) => mark.at));
    const after = runs.filter((search) => search.step > reset);
    const cap = input.caps?.[tool];
    const found = mine.filter((mark) => mark.hit && mark.searched !== category);
    const cell: Cell = {
      category, tool, searches: runs.length, results: sum(runs.map((row) => row.results)), new_sites: sum(runs.map((row) => row.new_sites)), overlap: sum(runs.map((row) => row.overlap)),
      hits: mine.filter((mark) => mark.hit).length, rejected: mine.filter((mark) => mark.rejected).length, pending: mine.filter((mark) => mark.pending).length,
      dry_streak: after.length, status: "open", since: null, at_step: null, why: null, angles: runs.flatMap((row) => row.angle ? [row.angle] : []),
      dry_after: dry, found_elsewhere: Object.fromEntries([...new Set(found.map((mark) => mark.searched))].map((searched) => [searched, found.filter((mark) => mark.searched === searched).length])),
      round: 0, share: typeof cap === "number" && input.topics.length ? Math.floor(cap / input.topics.length) : null, waiting: false,
      refused: runs.filter((row) => row.refused).length, last_refused: runs.filter((row) => row.refused).at(-1)?.refused ?? null,
    };
    const applicable = input.applicable?.[key];
    if (after.length >= dry) {
      const made = after[dry - 1];
      Object.assign(cell, { status: "dry", since: made.at, at_step: made.step, why: `${dry} searches in a row found no new accepted site` });
    } else if (applicable && runs.length && applicable.every((family) => cell.angles.includes(family))) {
      const made = runs.at(-1)!;
      Object.assign(cell, { status: "dry", since: made.at, at_step: made.step, why: `tried every angle that applies to it (${applicable.length})` });
    } else if (!input.enabled.includes(tool)) Object.assign(cell, { status: "unavailable", why: "not in this run: not ticked, or no key" });
    else if (input.unavailable[tool]) Object.assign(cell, { status: "unavailable", since: input.unavailableAt?.[tool] ?? null, why: input.unavailable[tool] });
    cells.push(cell);
  }
  // Rounds: each tool's open cells are on the round after the fewest searches any of them has had.
  const rounds: Grid["rounds"] = {};
  for (const tool of SEARCH_TOOLS) {
    const open = cells.filter((cell) => cell.tool === tool && cell.status === "open");
    const had = (cell: Cell) => Math.max(cell.searches, input.rejoin?.[cellKey(cell.category, tool)] ?? 0);
    const level = open.length ? Math.min(...open.map(had)) : null;
    if (level !== null) rounds[tool] = level + 1;
    for (const cell of cells.filter((item) => item.tool === tool)) {
      cell.round = had(cell) + 1;
      cell.waiting = level !== null && cell.status === "open" && had(cell) > level;
    }
  }
  const dryCategories = input.topics.filter((category) => cells.filter((cell) => cell.category === category).every((cell) => cell.status !== "open"));
  const open = cells.filter((cell) => cell.status === "open").length;
  return { cells, dry_categories: dryCategories, open, done: open === 0, uncredited, hits, rounds };
}

export function cellOf(grid: Grid, category: PriorityTopic, tool: SearchTool) {
  return grid.cells.find((cell) => cell.category === category && cell.tool === tool) ?? null;
}

/** The cells whose turn it is this round, by tool: open, and not ahead of any other open cell of their tool. */
export function eligibleCells(grid: Grid) {
  return grid.cells.filter((cell) => cell.status === "open" && !cell.waiting);
}

/** A cell that turns up mostly new sites that all get rejected has weak queries, not saturation: rephrase. */
export function weakQueries(cell: Cell) {
  return cell.hits === 0 && cell.rejected >= 2 && cell.new_sites * 2 >= cell.results && cell.results > 0;
}

/** Cumulative hits against searches, one line per tool: point n is after that tool's nth search. */
export function yieldCurves(searches: CellSearch[], sources: GridSource[], startHosts: string[]) {
  const flags = hitFlags(sources, startHosts);
  const hitsAt = new Map<string, number>();
  sources.forEach((source, index) => { if (flags[index]) for (const credit of creditsOf(source)) hitsAt.set(`${credit.tool}:${credit.step}`, (hitsAt.get(`${credit.tool}:${credit.step}`) ?? 0) + 1); });
  return Object.fromEntries(SEARCH_TOOLS.map((tool) => {
    let total = 0;
    // A refused turn ran no search.
    const points = [...searches].filter((search) => search.tool === tool && !search.refused).sort((a, b) => a.step - b.step).map((search, index) => { total += hitsAt.get(`${tool}:${search.step}`) ?? 0; return { searches: index + 1, hits: total }; });
    return [tool, points];
  })) as Record<SearchTool, Array<{ searches: number; hits: number }>>;
}

function sum(values: number[]) { return values.reduce((total, value) => total + value, 0); }
