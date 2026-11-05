import { afterEach, describe, expect, it, vi } from "vitest";
import { logDiscoveredSources, logSourceCollected, logSourceMap, sectionCounts, textTable } from "../../orchestration/source-log";
import { sourceResult } from "../../connectors/types";
import type { SourceCandidate } from "../../sourcemap/store";
import type { RunSourceSnapshot } from "../../orchestration/runs";

function printed() {
  const print = vi.spyOn(console, "log").mockImplementation(() => {});
  return () => print.mock.calls.map((call) => String(call[0])).join("\n");
}

afterEach(() => vi.restoreAllMocks());

const snapshot = (overrides: Partial<RunSourceSnapshot>): RunSourceSnapshot => ({
  source_id: "web:1", name: "Ballard High School", url: "https://school.example/", reader: "web", status: "active", section: "schools",
  found_by: "osm", detail: "school inside Ballard", tier: null, topics: [], collected: true, skip_reason: null, ...overrides,
});

describe("source log", () => {
  it("lines up columns and shortens long cells", () => {
    expect(textTable(["A", "Bee"], [["one", "x".repeat(10)]], 5).split("\n")).toEqual(["A   | Bee", "----+------", "one | xxxx…"]);
  });

  it("counts sources by section in newsletter order", () => {
    expect(sectionCounts([{ section: "schools" }, { section: "events" }, { section: "schools" }, { section: "unknown" }]))
      .toBe("Events and things to do 1, Schools and youth 2, Other local news 1");
  });

  it("prints every source on the map with its section, how it was found and whether this run reads it", () => {
    const output = printed();
    logSourceMap("Ballard, WA", "run-1", [
      snapshot({}),
      snapshot({ source_id: "web:2", name: "Ballard Branch", section: "events", found_by: "library", reader: "library" }),
      snapshot({ source_id: "web:3", name: "Old blog", section: "community", collected: false, status: "dormant", skip_reason: "dormant until 2026-11-20" }),
    ]);
    const text = output();
    expect(text).toContain("run run-1 for Ballard, WA, 2 of 3 sources on the map read");
    expect(text.indexOf("Events and things to do")).toBeLessThan(text.indexOf("Schools and youth"));
    expect(text).toContain("OpenStreetMap place inside the area");
    expect(text).toContain("not read: dormant until 2026-11-20");
    expect(text).toContain("Reading by section: Events and things to do 1, Schools and youth 1");
  });

  it("prints what a discovery method found and one line per collected source", () => {
    const output = printed();
    const candidate = { source_id: "web:1", name: "St. Luke's", url: "https://church.example/", reader: "web", params: {}, section: "community",
      found_by: { method: "osm", detail: "place of worship inside Ballard" }, inside_area: true } as unknown as SourceCandidate;
    logDiscoveredSources("Ballard, WA", "OpenStreetMap places inside the area", [candidate], 1);
    logSourceCollected("Ballard, WA", "community", { source_id: "web:1", name: "St. Luke's", type: "web" }, sourceResult("web:1", "St. Luke's", "ingested", "1 feed"), 4, 2);
    const text = output();
    expect(text).toContain("Ballard, WA: OpenStreetMap places inside the area, 1 found, 1 new on the map");
    expect(text).toContain("Community and neighbours | St. Luke's");
    expect(text).toContain("[newsbee:source] Ballard, WA | Community and neighbours | St. Luke's | ingested | 4 items kept, 2 left out");
  });
});
