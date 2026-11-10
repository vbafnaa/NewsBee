import { describe, expect, it } from "vitest";
import {
  anchorQuery, ANGLE_FAMILIES, ANGLE_LABELS, angleRows, applicableCells, applicableFamilies, checkAngle, nativeQueryProblem, nearDuplicate, roleQueryProblem, VOCABULARY, type AngleStep,
} from "../../agent/search-angles";
import { buildGrid, cellOf, type CellSearch } from "../../agent/search-grid";
import { PRIORITY_TOPICS } from "../../core/run-values";

const OPEN = { accepted: true, explore: true };
const angle = (family: AngleStep["family"], step: number, reason = ""): AngleStep => ({ family, reason, step, at: 1000 + step, tool: "dork" });

describe("the angle catalogue", () => {
  it("comes from the playbook: twelve families, and vocabulary with an anchor term and roles for every category", () => {
    expect(ANGLE_FAMILIES).toHaveLength(12);
    expect(ANGLE_LABELS).toMatchObject({ anchor: "Anchor", item_type: "Item type", more_like_this: "More like this", tool_native: "Tool-native" });
    for (const topic of PRIORITY_TOPICS) expect(VOCABULARY[topic.id]).toMatchObject({ anchor: expect.any(String), terms: expect.arrayContaining([expect.any(String)]), roles: expect.arrayContaining([expect.any(String)]) });
    expect(VOCABULARY.sports.roles).toEqual(["athletic director", "coach"]);
  });

  it("writes the anchor from the place and the category's main term", () => {
    expect(anchorQuery({ place: "Lakeside", parent: null }, "events")).toBe("Lakeside events");
    expect(anchorQuery({ place: "Wedgwood", parent: "Seattle" }, "government")).toBe("Wedgwood Seattle city council");
  });
});

describe("checking an angle", () => {
  const check = (family: string, sequence: AngleStep[], tried: string[], reason = "a reason", tool: "dork" | "exa" | "tavily" = "dork", context = OPEN) => checkAngle({ family, reason, tool, sequence, tried, context });

  it("starts every category with the anchor", () => {
    expect(check("geography", [], [])).toEqual({ ok: false, why: expect.stringMatching(/first angle in every category is the Anchor/) });
    expect(check("anchor", [], [])).toEqual({ ok: true, family: "anchor", fresh: true });
    // Another tool runs the same anchor: it isn't a new angle.
    expect(check("anchor", [angle("anchor", 1)], [], "", "exa")).toEqual({ ok: true, family: "anchor", fresh: false });
  });

  it("makes every tool catch up on the category's angles, in order, before a new one", () => {
    const sequence = [angle("anchor", 1), angle("institutions", 4, "Nathan Hale has teams")];
    expect(check("geography", sequence, ["anchor"], "x", "exa")).toEqual({ ok: false, why: expect.stringMatching(/exa still has to run institutions, this category's angle from step 4 \(Nathan Hale has teams\)/) });
    expect(check("institutions", sequence, ["anchor"], "", "exa")).toEqual({ ok: true, family: "institutions", fresh: false });
    expect(check("geography", sequence, ["anchor", "institutions"], "", "dork")).toEqual({ ok: false, why: expect.stringMatching(/say why in angle_reason/) });
    expect(check("geography", sequence, ["anchor", "institutions"], "ZIP 98115 covers it", "dork")).toEqual({ ok: true, family: "geography", fresh: true });
  });

  it("refuses an angle the cell has already tried, and one that doesn't apply", () => {
    expect(check("anchor", [angle("anchor", 1)], ["anchor"])).toEqual({ ok: false, why: "already tried anchor here; pick another" });
    expect(check("unknown", [angle("anchor", 1)], ["anchor"])).toEqual({ ok: false, why: expect.stringMatching(/declares its angle family/) });
    expect(check("more_like_this", [angle("anchor", 1)], ["anchor"], "x", "exa", { accepted: false, explore: true })).toEqual({ ok: false, why: expect.stringMatching(/nothing is accepted for this category yet/) });
  });

  it("skips an angle that doesn't apply to a tool when it catches up", () => {
    // Tavily can't explore, so the tool-native angle doesn't apply to it and it may move on.
    const sequence = [angle("anchor", 1), angle("tool_native", 2, "inurl:calendar")];
    expect(check("geography", sequence, ["anchor"], "neighbourhood alias", "tavily", { accepted: true, explore: false })).toEqual({ ok: true, family: "geography", fresh: true });
    expect(applicableFamilies("tavily", { accepted: false, explore: false })).not.toEqual(expect.arrayContaining(["more_like_this", "tool_native"]));
    expect(applicableFamilies("dork", { accepted: false, explore: false })).toHaveLength(11);
  });
});

describe("queries", () => {
  it("finds a near-duplicate in the cell by shared words, leaving out the place name, operators and small words", () => {
    expect(nearDuplicate('"Lakeside" "North End" events', ['Lakeside north end events'], ["Lakeside"])).toBe("Lakeside north end events");
    expect(nearDuplicate("site:lib.example.org calendar of library events", ['site:lib.example.org "library events" calendar'], ["Lakeside"])).not.toBeNull();
    // The same words inside another site are a different search.
    expect(nearDuplicate("site:lib.example.org events calendar", ["site:parks.example.gov events calendar"], ["Lakeside"])).toBeNull();
    expect(nearDuplicate('"Lakeside" library events', ["Lakeside events"], ["Lakeside"])).toBeNull();
    expect(nearDuplicate('"Lakeside" farmers market', ['"Lakeside" library events'], ["Lakeside"])).toBeNull();
  });

  it("takes titles, not people, in the Roles angle", () => {
    const known = ["Lakeside", "Nathan Hale High School"];
    expect(roleQueryProblem('"John Smith" Lakeside', "sports", known)).toMatch(/uses a title, like athletic director, coach/);
    expect(roleQueryProblem('Lakeside athletic director "John Smith"', "sports", known)).toMatch(/names a person \(John Smith\)/);
    expect(roleQueryProblem("Nathan Hale athletic director", "sports", known)).toBeNull();
    expect(roleQueryProblem('"Lakeside" PTA president newsletter', "schools", known)).toBeNull();
    expect(roleQueryProblem("Lakeside High School Athletic Director", "sports", known)).toBeNull();
  });

  it("holds a tool-native angle to what only that tool can do", () => {
    expect(nativeQueryProblem("dork", '"Lakeside" events calendar')).toMatch(/site:/);
    expect(nativeQueryProblem("dork", 'intitle:calendar "Lakeside"')).toBeNull();
    expect(nativeQueryProblem("exa", "Lakeside events")).toMatch(/plain-sentence/);
    expect(nativeQueryProblem("exa", "Pages where a Lakeside neighbourhood group posts its upcoming events")).toBeNull();
    expect(nativeQueryProblem("tavily", "anything at all")).toMatch(/explore/);
  });
});

describe("a cell and its angles", () => {
  const search = (step: number, angle: string, tool: CellSearch["tool"] = "dork"): CellSearch => ({ step, at: 1000 + step, category: "events", tool, results: 5, new_sites: 2, overlap: 0, angle, query: `q${step}` });
  const hits = (steps: number[]) => steps.map((step) => ({ host: `site${step}.example.org`, credit: { step, tool: "dork" as const, category: "events" as const }, good: true, verdict: "accept" }));

  it("goes dry once it has tried every angle that applies to it, even with hits and fewer than 3 misses in a row", () => {
    const applicable = applicableCells(["events"], ["dork"], () => ({ accepted: false, explore: false }));
    const families = applicable["events|dork"];
    expect(families).toHaveLength(11);
    const searches = families.map((family, index) => search(index + 1, family));
    const grid = (input: { searches: CellSearch[]; applicable?: Record<string, string[]> }) => buildGrid({ topics: ["events"], sources: hits(input.searches.map((row) => row.step)), startHosts: [], enabled: ["dork"], unavailable: {}, cellDry: 3, ...input });
    expect(cellOf(grid({ searches: searches.slice(0, -1), applicable }), "events", "dork")).toMatchObject({ status: "open", dry_streak: 0 });
    expect(cellOf(grid({ searches, applicable }), "events", "dork")).toMatchObject({ status: "dry", at_step: 11, why: "tried every angle that applies to it (11)", angles: families });
    // A run from before angles has no such rule.
    expect(cellOf(grid({ searches }), "events", "dork")?.status).toBe("open");
  });

  it("lists each category's angles in order, with the reason and each tool's result", () => {
    const rows = angleRows({ events: [angle("anchor", 1), angle("institutions", 4, "Nathan Hale has teams")] }, [search(1, "anchor"), search(2, "anchor", "exa"), search(4, "institutions"), search(5, "institutions", "exa")], hits([4]), [], ["events"]);
    expect(rows).toEqual([{ category: "events", angles: [
      expect.objectContaining({ family: "anchor", label: "Anchor", results: { dork: "miss", exa: "miss", tavily: "not yet" } }),
      expect.objectContaining({ family: "institutions", label: "Institutions", reason: "Nathan Hale has teams", step: 4, results: { dork: "hit", exa: "miss", tavily: "not yet" }, queries: { dork: "q4", exa: "q5" } }),
    ] }]);
  });
});
