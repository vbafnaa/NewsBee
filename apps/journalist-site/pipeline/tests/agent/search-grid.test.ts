import { describe, expect, it } from "vitest";
import { buildGrid, cellOf, eligibleCells, hitFlags, weakQueries, yieldCurves, type CellSearch, type GridInput, type GridSource } from "../../agent/search-grid";

const search = (step: number, extra: Partial<CellSearch> = {}): CellSearch => ({ step, at: 1000 + step, category: "events", tool: "dork", results: 10, new_sites: 5, overlap: 0, ...extra });
const found = (step: number, host: string, extra: Partial<GridSource> = {}): GridSource => ({ host, credit: { step, tool: "dork", category: "events" }, good: true, pending: false, verdict: "accept", ...extra });
const grid = (input: Partial<GridInput>) => buildGrid({ topics: ["events"], searches: [], sources: [], startHosts: [], enabled: ["dork", "exa", "tavily"], unavailable: {}, cellDry: 3, ...input });
const dork = (input: Partial<GridInput>) => cellOf(grid(input), "events", "dork")!;

describe("a hit", () => {
  it("is an accepted source on a site new to the run; a second page on that site, or a site already accepted, is not", () => {
    const sources = [found(1, "lib.example.org"), found(2, "lib.example.org"), found(3, "city.example.gov"), found(4, "news.example.com", { good: false, verdict: "reject" }), found(5, "cc.example.org")];
    expect(hitFlags(sources, ["cc.example.org"])).toEqual([true, false, true, false, false]);
    const cells = grid({ searches: [1, 2, 3, 4, 5].map((step) => search(step)), sources, startHosts: ["cc.example.org"] });
    expect(cells.hits).toBe(2);
    expect(cellOf(cells, "events", "dork")).toMatchObject({ hits: 2, rejected: 1 });
  });

  it("goes to the search that first turned the page up, and a page proposed without a search earns no cell a hit", () => {
    const cells = grid({ searches: [search(1), search(2, { tool: "exa" })], sources: [found(2, "lib.example.org", { credit: { step: 2, tool: "exa", category: "events" } }), found(0, "city.example.gov", { credit: null })] });
    expect(cellOf(cells, "events", "exa")?.hits).toBe(1);
    expect(cellOf(cells, "events", "dork")?.hits).toBe(0);
    expect(cells).toMatchObject({ hits: 2, uncredited: 1 });
  });
});

describe("a cell", () => {
  it("goes dry after 3 searches in a row with no hit, saying when and why", () => {
    expect(dork({ searches: [1, 2].map((step) => search(step)) })).toMatchObject({ status: "open", dry_streak: 2 });
    expect(dork({ searches: [1, 2, 3].map((step) => search(step)) })).toMatchObject({ status: "dry", dry_streak: 3, since: 1003, at_step: 3, why: "3 searches in a row found no new accepted site" });
  });

  it("resets its streak on a hit, even one credited later to an earlier search", () => {
    const searches = [1, 2, 3, 4].map((step) => search(step));
    expect(dork({ searches, sources: [found(4, "lib.example.org")] })).toMatchObject({ status: "open", dry_streak: 0, hits: 1 });
    expect(dork({ searches, sources: [found(2, "lib.example.org")] })).toMatchObject({ status: "open", dry_streak: 2 });
  });

  it("doesn't count a search whose verdicts are still pending as a miss", () => {
    const pending = [found(1, "lib.example.org", { good: false, pending: true, verdict: "not_judged" })];
    expect(dork({ searches: [1, 2, 3].map((step) => search(step)), sources: pending })).toMatchObject({ status: "open", dry_streak: 2, pending: 1 });
    // Once settled as a rejection, it is a miss like the others.
    expect(dork({ searches: [1, 2, 3].map((step) => search(step)), sources: [{ ...pending[0], pending: false, verdict: "reject" }] })).toMatchObject({ status: "dry" });
    // Three settled misses after it are three in a row, whatever it turns out to be.
    expect(dork({ searches: [1, 2, 3, 4].map((step) => search(step)), sources: pending })).toMatchObject({ status: "dry", at_step: 4 });
  });

  it("is unavailable when its tool reached its cap, kept failing, or isn't in the run", () => {
    const cells = grid({ enabled: ["dork", "exa"], unavailable: { exa: "Hard limit: Exa: 60 a run was reached" }, unavailableAt: { exa: 1234 } });
    expect(cellOf(cells, "events", "exa")).toMatchObject({ status: "unavailable", why: "Hard limit: Exa: 60 a run was reached", since: 1234 });
    expect(cellOf(cells, "events", "tavily")).toMatchObject({ status: "unavailable", why: expect.stringMatching(/not in this run/) });
    expect(cellOf(cells, "events", "dork")?.status).toBe("open");
  });

  it("warns of weak queries when it turns up mostly new sites that all get rejected", () => {
    const rejected = [found(1, "a.example.org", { good: false, verdict: "reject" }), found(2, "b.example.org", { good: false, verdict: "reject" })];
    expect(weakQueries(dork({ searches: [search(1), search(2)], sources: rejected }))).toBe(true);
    expect(weakQueries(dork({ searches: [search(1), search(2)], sources: [...rejected, found(2, "c.example.org")] }))).toBe(false);
    expect(weakQueries(dork({ searches: [search(1, { new_sites: 1 }), search(2, { new_sites: 1 })], sources: rejected }))).toBe(false);
  });
});

describe("categories and the run", () => {
  const dry = [1, 2, 3].map((step) => search(step));
  it("a category goes dry when all its cells are dry or unavailable, and the others keep going", () => {
    const cells = grid({ topics: ["events", "crime"], searches: dry, enabled: ["dork", "exa"], unavailable: { exa: "failed 3 times in a row" } });
    expect(cells.dry_categories).toEqual(["events"]);
    expect(cells).toMatchObject({ open: 1, done: false });
  });

  it("the run stops when every cell is dry or unavailable", () => {
    expect(grid({ searches: dry, enabled: ["dork"] })).toMatchObject({ open: 0, done: true, dry_categories: ["events"] });
    expect(grid({ searches: dry.slice(0, 2), enabled: ["dork"] })).toMatchObject({ open: 1, done: false });
    expect(grid({ enabled: [] }).done).toBe(true);
  });
});

it("draws cumulative hits against searches, one line per tool", () => {
  const curves = yieldCurves([search(1), search(2, { tool: "exa" }), search(3), search(4)], [found(1, "a.example.org"), found(3, "b.example.org"), found(4, "b.example.org")], []);
  expect(curves.dork).toEqual([{ searches: 1, hits: 1 }, { searches: 2, hits: 2 }, { searches: 3, hits: 2 }]);
  expect(curves.exa).toEqual([{ searches: 1, hits: 0 }]);
  expect(curves.tavily).toEqual([]);
});

describe("per-tool dry values", () => {
  it("dries a dork cell after 2 misses and an Exa or Tavily cell after 3", () => {
    const misses = (tool: CellSearch["tool"], count: number) => Array.from({ length: count }, (_, index) => search(index + 1 + (tool === "exa" ? 10 : tool === "tavily" ? 20 : 0), { tool }));
    const cells = grid({ searches: [...misses("dork", 2), ...misses("exa", 2), ...misses("tavily", 3)], cellDry: { dork: 2, exa: 3, tavily: 3 } });
    expect(cells.cells.map((cell) => [cell.tool, cell.status, cell.dry_after])).toEqual([["dork", "dry", 2], ["exa", "open", 3], ["tavily", "dry", 3]]);
  });
});

describe("rounds and shares", () => {
  const ALL = ["crime", "deaths", "events", "home_sales", "sports", "government", "schools", "business", "community", "news"] as const;
  type Topic = typeof ALL[number];
  /** Rounds for one tool: every eligible cell searches, and `hit` says which searches find a new site. */
  function simulate(tool: CellSearch["tool"], cap: number, hit: (category: Topic, round: number) => boolean, rounds: number, extra: Partial<GridInput> = {}) {
    const searches: CellSearch[] = [], sources: GridSource[] = [];
    const counts: Array<Record<string, number>> = [];
    let step = 0;
    const input = () => ({ topics: [...ALL], searches, sources, startHosts: [], enabled: [tool], unavailable: {}, cellDry: { dork: 2, exa: 3, tavily: 3 }, caps: { [tool]: cap }, ...extra });
    for (let round = 1; round <= rounds && searches.length < cap; round += 1) {
      const now = buildGrid(input());
      for (const cell of eligibleCells(now).filter((item) => item.tool === tool)) {
        if (searches.length >= cap) break;
        step += 1;
        searches.push({ step, at: step, category: cell.category, tool, results: 5, new_sites: 1, overlap: 0, round });
        if (hit(cell.category as Topic, round)) sources.push({ host: `${cell.category}-${round}.example.org`, credit: { step, tool, category: cell.category }, good: true, verdict: "accept" });
      }
      counts.push(Object.fromEntries(ALL.map((topic) => [topic, searches.filter((row) => row.category === topic).length])));
    }
    return { grid: buildGrid(input()), counts };
  }

  it("gives every one of 10 categories its 2 dork searches before any gets a 3rd, from a cap of 20", () => {
    const { grid: cells, counts } = simulate("dork", 20, () => true, 10);
    expect(cells.cells.filter((cell) => cell.tool === "dork").map((cell) => cell.share)).toEqual(ALL.map(() => 2));
    expect(counts[0]).toEqual(Object.fromEntries(ALL.map((topic) => [topic, 1])));
    expect(counts[1]).toEqual(Object.fromEntries(ALL.map((topic) => [topic, 2])));
    expect(counts).toHaveLength(2);
  });

  it("does the same for Exa and Tavily with 6 each, from a cap of 60", () => {
    for (const tool of ["exa", "tavily"] as const) {
      const { grid: cells, counts } = simulate(tool, 60, () => true, 20);
      expect(cells.cells.filter((cell) => cell.tool === tool).every((cell) => cell.share === 6 && cell.searches === 6)).toBe(true);
      // After every round all ten have the same number of searches.
      expect(counts.every((round) => new Set(Object.values(round)).size === 1)).toBe(true);
    }
  });

  it("doesn't let a hit jump the round: the cell waits for the others like any other", () => {
    const searches = [search(1), search(2, { category: "crime" })];
    const sources = [found(1, "lib.example.org")];
    const cells = grid({ topics: ["events", "crime"], searches: [...searches, search(3)], sources, enabled: ["dork"], cellDry: 3 });
    // Events had its hit and a second search; crime has had one, so events waits.
    expect(cellOf(cells, "events", "dork")).toMatchObject({ status: "open", dry_streak: 1, waiting: true, round: 3 });
    expect(cellOf(cells, "crime", "dork")).toMatchObject({ waiting: false, round: 2 });
    expect(eligibleCells(cells).map((cell) => cell.category)).toEqual(["crime"]);
  });

  it("gives the budget dry cells free to the open ones, still round by round", () => {
    // Only events and crime keep finding sites; the other eight go dry after 3 misses, and the 30 searches they leave of Exa's 60 go to those two.
    const { grid: cells, counts } = simulate("exa", 60, (category) => category === "events" || category === "crime", 40);
    expect(cells.cells.filter((cell) => cell.tool === "exa" && cell.status === "dry")).toHaveLength(8);
    expect(counts.at(-1)).toMatchObject({ events: 18, crime: 18, deaths: 3 });
    expect(Object.values(counts.at(-1)!).reduce((total, value) => total + value, 0)).toBe(60);
    // Round by round: events and crime stay level all the way.
    expect(counts.every((round) => round.events === round.crime)).toBe(true);
  });

  it("takes dry and unavailable cells out of the round", () => {
    const searches = [search(1), search(2), search(3, { category: "crime" })];
    // Events and crime are dry on 2 misses each, and Exa is unavailable: news is the only dork cell left in the round.
    const cells = grid({ topics: ["events", "crime", "news"], searches: [...searches, search(4, { category: "crime" })], enabled: ["dork", "exa"], unavailable: { exa: "Hard limit" }, cellDry: { dork: 2 } });
    expect(cellOf(cells, "events", "dork")?.status).toBe("dry");
    expect(cellOf(cells, "crime", "dork")).toMatchObject({ status: "dry" });
    expect(eligibleCells(cells).map((cell) => `${cell.category}|${cell.tool}`)).toEqual(["news|dork"]);
    const open = grid({ topics: ["events", "crime"], searches: [search(1), search(2), search(3, { category: "crime" })], enabled: ["dork"], cellDry: { dork: 2 } });
    expect(cellOf(open, "crime", "dork")).toMatchObject({ status: "open", waiting: false });
    expect(eligibleCells(open).map((cell) => cell.category)).toEqual(["crime"]);
  });
});

describe("hits filed under another category", () => {
  const sports = (step: number, extra: Partial<CellSearch> = {}) => search(step, { category: "sports", tool: "exa", ...extra });
  const schools = (step: number) => search(step, { category: "schools", tool: "exa" });
  const school = (step: number, proposed: number): GridSource => ({ host: "hale.example.edu", step: proposed, credit: { step, tool: "exa", category: "schools", searched: "sports" }, good: true, verdict: "accept" });
  const cells = (input: Partial<GridInput>) => buildGrid({ topics: ["sports", "schools"], searches: [], sources: [], startHosts: [], enabled: ["exa"], unavailable: {}, cellDry: 3, ...input });

  it("resets the streak of the category it is filed under, not the one that searched", () => {
    const grid2 = cells({ searches: [sports(1), schools(2)], sources: [school(1, 3)] });
    expect(cellOf(grid2, "schools", "exa")).toMatchObject({ searches: 1, hits: 1, dry_streak: 0, found_elsewhere: { sports: 1 } });
    expect(cellOf(grid2, "sports", "exa")).toMatchObject({ searches: 1, hits: 0, dry_streak: 1 });
  });

  it("reopens a dry cell, which rejoins at the current round", () => {
    // Schools × Exa went dry on its 3 misses while sports kept searching.
    const searches = [schools(1), schools(2), schools(3), sports(4), sports(5), sports(6), sports(8), sports(9)];
    expect(cellOf(cells({ searches }), "schools", "exa")?.status).toBe("dry");
    // Sports' search at step 9 finds a sports page and a school's page, filed under schools at step 10.
    const found = [{ host: "league.example.org", step: 10, credit: { step: 9, tool: "exa" as const, category: "sports" as const }, good: true, verdict: "accept" }, school(9, 10)];
    const reopened = cells({ searches, sources: found });
    expect(cellOf(reopened, "schools", "exa")).toMatchObject({ status: "open", dry_streak: 0, searches: 3 });
    // Left at its 3 searches it would hold sports back; rejoined at sports' 5, neither waits.
    expect(cellOf(reopened, "sports", "exa")?.waiting).toBe(true);
    const rejoined = cells({ searches, sources: found, rejoin: { "schools|exa": 5 } });
    expect([cellOf(rejoined, "schools", "exa")?.waiting, cellOf(rejoined, "sports", "exa")?.waiting, cellOf(rejoined, "schools", "exa")?.round]).toEqual([false, false, 6]);
  });
});

it("counts a refused turn as a used turn and a miss, keeps why, and leaves it off the yield curve", () => {
  const searches = [search(1), search(2, { results: 0, new_sites: 0, refused: "it must name Lakeside" })];
  const cells = grid({ searches, cellDry: { dork: 2 } });
  expect(cellOf(cells, "events", "dork")).toMatchObject({ status: "dry", searches: 2, refused: 1, last_refused: "it must name Lakeside", dry_streak: 2 });
  expect(yieldCurves(searches, [], []).dork).toEqual([{ searches: 1, hits: 0 }]);
});
